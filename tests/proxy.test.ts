import { beforeAll, afterAll, describe, expect, test } from "bun:test";
import { createProxyHandler } from "../index";

type UpstreamState = {
  lastBody: any | null;
};

function json(res: unknown, status = 200): Response {
  return new Response(JSON.stringify(res), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function validateToolOrderingOpenAIStyle(body: any): string | null {
  const messages = body?.messages;
  if (!Array.isArray(messages)) return "messages must be an array";

  const toolResultsById = new Map<string, number[]>();
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m?.role === "tool" && typeof m.tool_call_id === "string") {
      const arr = toolResultsById.get(m.tool_call_id) ?? [];
      arr.push(i);
      toolResultsById.set(m.tool_call_id, arr);
    }
  }

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m?.role !== "assistant") continue;
    if (!Array.isArray(m.tool_calls) || m.tool_calls.length === 0) continue;

    // Enforce Anthropic-like strictness: tool results must follow immediately.
    const next = messages[i + 1];
    const firstId = m.tool_calls[0]?.id;
    if (typeof firstId !== "string") return "tool_calls[0].id missing";
    if (next?.role !== "tool" || next?.tool_call_id !== firstId) {
      return `tool_call ${firstId} missing immediate tool result`;
    }
  }

  // Also reject orphan tool results (tool_call_id that never appears in tool_calls)
  const knownToolCallIds = new Set<string>();
  for (const m of messages) {
    if (m?.role === "assistant" && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        if (typeof tc?.id === "string") knownToolCallIds.add(tc.id);
      }
    }
  }
  for (const [id] of toolResultsById) {
    if (!knownToolCallIds.has(id)) return `orphan tool result: ${id}`;
  }

  return null;
}

describe("proxy normalizes Continue payloads for Anthropic-backed models", () => {
  let upstream: ReturnType<typeof Bun.serve> | null = null;
  let upstreamUrl = "";
  const state: UpstreamState = { lastBody: null };

  beforeAll(() => {
    upstream = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        if (url.pathname === "/v1/models") {
          return json({ object: "list", data: [{ id: "anthropic-claude-4.5-sonnet" }] });
        }
        if (url.pathname === "/v1/chat/completions") {
          const body = await req.json().catch(() => null);
          state.lastBody = body;

          // mimic upstream strictness that historically caused 400s
          const err =
            validateToolOrderingOpenAIStyle(body) ??
            (Array.isArray(body?.messages) &&
            body.messages.some((m: any) => typeof m?.content !== "string")
              ? "content must be string"
              : null);
          if (err) return json({ error: { message: err } }, 400);

          return json({
            id: "test",
            object: "chat.completion",
            created: Date.now() / 1000,
            model: body?.model ?? "unknown",
            choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "OK" } }],
          });
        }
        return json({ error: { message: "not found" } }, 404);
      },
    });

    upstreamUrl = `http://localhost:${upstream.port}`;
  });

  afterAll(() => {
    upstream?.stop();
  });

  test("converts rich content blocks to string and drops empty messages", async () => {
    const handler = createProxyHandler({ inferenceUrl: upstreamUrl, apiKey: "test" });
    const req = new Request("http://proxy.local/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "anthropic-claude-4.5-sonnet",
        stream: false,
        messages: [
          { role: "system", content: [{ type: "text", text: "sys" }] },
          { role: "user", content: "   " },
          { role: "assistant", content: [{ type: "text", text: "" }, { type: "text", text: "A" }] },
          { role: "user", content: "hi" },
        ],
      }),
    });

    const res = await handler(req);
    expect(res.status).toBe(200);
    expect(state.lastBody?.messages?.some((m: any) => typeof m.content !== "string")).toBe(false);
    expect(state.lastBody?.messages?.some((m: any) => m.content.trim().length === 0)).toBe(false);
  });

  test("reorders delayed tool results to follow tool_calls immediately", async () => {
    const handler = createProxyHandler({ inferenceUrl: upstreamUrl, apiKey: "test" });
    const req = new Request("http://proxy.local/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "anthropic-claude-4.5-sonnet",
        stream: false,
        tools: [{ type: "function", function: { name: "Read", parameters: { type: "object" } } }],
        messages: [
          { role: "user", content: "hi" },
          {
            role: "assistant",
            content: "ok",
            tool_calls: [{ id: "toolu_1", type: "function", function: { name: "Read", arguments: "{\"filepath\":\"README.md\"}" } }],
          },
          { role: "user", content: "more" },
          { role: "tool", tool_call_id: "toolu_1", content: "Content of README.md: ..." },
        ],
      }),
    });

    const res = await handler(req);
    expect(res.status).toBe(200);
    // Ensure tool message now comes right after assistant tool_calls
    const msgs = state.lastBody.messages;
    const idx = msgs.findIndex((m: any) => m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls[0]?.id === "toolu_1");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(msgs[idx + 1]?.role).toBe("tool");
    expect(msgs[idx + 1]?.tool_call_id).toBe("toolu_1");
  });

  test("drops tool_calls without tool results (prevents upstream tool pairing errors)", async () => {
    const handler = createProxyHandler({ inferenceUrl: upstreamUrl, apiKey: "test" });
    const req = new Request("http://proxy.local/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "anthropic-claude-4.5-sonnet",
        stream: false,
        tools: [{ type: "function", function: { name: "Read", parameters: { type: "object" } } }],
        messages: [
          { role: "user", content: "hi" },
          {
            role: "assistant",
            content: "ok",
            tool_calls: [{ id: "toolu_missing", type: "function", function: { name: "Read", arguments: "{\"filepath\":\"README.md\"}" } }],
          },
          { role: "user", content: "continue" },
        ],
      }),
    });

    const res = await handler(req);
    expect(res.status).toBe(200);
    const assistant = state.lastBody.messages.find((m: any) => m.role === "assistant");
    expect(assistant?.tool_calls).toBeUndefined();
  });

  test("converts orphan tool results into user messages", async () => {
    const handler = createProxyHandler({ inferenceUrl: upstreamUrl, apiKey: "test" });
    const req = new Request("http://proxy.local/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "anthropic-claude-4.5-sonnet",
        stream: false,
        messages: [
          { role: "user", content: "hi" },
          { role: "tool", tool_call_id: "toolu_orphan", content: "Content of X: ..." },
          { role: "user", content: "ok" },
        ],
      }),
    });

    const res = await handler(req);
    expect(res.status).toBe(200);
    expect(state.lastBody.messages.some((m: any) => m.role === "tool")).toBe(false);
    expect(state.lastBody.messages.some((m: any) => m.role === "user" && typeof m.content === "string" && m.content.includes("Tool output:"))).toBe(true);
  });

  test("normalizes double slashes/trailing slash paths (apiBase ending with /v1/)", async () => {
    const handler = createProxyHandler({ inferenceUrl: upstreamUrl, apiKey: "test" });
    const req = new Request("http://proxy.local/v1//chat/completions/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "anthropic-claude-4.5-sonnet",
        stream: false,
        messages: [
          { role: "user", content: "hi" },
          { role: "tool", tool_call_id: "toolu_orphan", content: "Content of X: ..." },
        ],
      }),
    });

    const res = await handler(req);
    expect(res.status).toBe(200);
    expect(state.lastBody.messages.some((m: any) => m.role === "tool")).toBe(false);
  });
});
