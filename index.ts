// index.ts
//
// Digital Ocean AI Proxy — Full Continue Support
//

import { writeFileSync } from "fs";

function getEnv(name: string, fallback: string): string {
  const v = process.env[name];
  return typeof v === "string" && v.length > 0 ? v : fallback;
}

function getConfig() {
  return {
    inferenceUrl: getEnv("DO_INFERENCE_URL", "https://inference.do-ai.run"),
    apiKey: getEnv("DO_API_KEY", "your-digital-ocean-api-key"),
    port: Number(getEnv("PORT", "4005")),
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// MODEL MAPPING
// ══════════════════════════════════════════════════════════════════════════════

const MODEL_MAPPING: Record<string, string> = {
  "anthropic-claude-sonnet-4.5": "anthropic-claude-4.5-sonnet",
  "claude-3.5-sonnet": "anthropic-claude-4.5-sonnet",
  "claude-3-5-sonnet": "anthropic-claude-4.5-sonnet",
  "claude-3.5-haiku": "anthropic-claude-haiku-4.5",
  "claude-3-5-haiku": "anthropic-claude-haiku-4.5",
  "claude-sonnet": "anthropic-claude-4.5-sonnet",
  "claude-haiku": "anthropic-claude-haiku-4.5",
  "claude-opus": "anthropic-claude-opus-4.6",
};

const ANTHROPIC_MODEL_PREFIXES = ["anthropic-"];

function isAnthropicModel(model: string | undefined): boolean {
  if (typeof model !== "string") return false;
  return ANTHROPIC_MODEL_PREFIXES.some((p) => model.startsWith(p));
}

const FALLBACK_MODELS = [
  { id: "anthropic-claude-haiku-4.5", object: "model", owned_by: "anthropic" },
  { id: "anthropic-claude-4.5-sonnet", object: "model", owned_by: "anthropic" },
  { id: "anthropic-claude-opus-4.6", object: "model", owned_by: "anthropic" },
  { id: "openai-gpt-5.1-codex-max", object: "model", owned_by: "openai" },
  { id: "openai-gpt-5-mini", object: "model", owned_by: "openai" },
  { id: "openai-gpt-5.2", object: "model", owned_by: "openai" },
  { id: "openai-gpt-5.2-pro", object: "model", owned_by: "openai" },
  { id: "openai-gpt-oss-120b", object: "model", owned_by: "digitalocean" },
];

// ══════════════════════════════════════════════════════════════════════════════
// CONTENT HELPERS
// ══════════════════════════════════════════════════════════════════════════════

function ensureNonEmpty(s: any, fallback: string = "."): string {
  if (typeof s === "string" && s.trim().length > 0) return s;
  return fallback;
}

function toNonEmptyString(content: any, fallback: string = "."): string {
  if (typeof content === "string") {
    return content.trim().length > 0 ? content : fallback;
  }
  if (content == null) return fallback;
  if (Array.isArray(content)) {
    const text = content
      .map((b: any) => {
        if (typeof b === "string") return b;
        if (b?.type === "text" && typeof b.text === "string") return b.text;
        return "";
      })
      .join("")
      .trim();
    return text.length > 0 ? text : fallback;
  }
  const str = String(content).trim();
  return str.length > 0 ? str : fallback;
}

function convertImageBlock(block: any): any {
  if (!block || block.type !== "image_url") return null;

  const imageUrl = block.image_url;
  const url: string =
    typeof imageUrl === "string"
      ? imageUrl
      : typeof imageUrl?.url === "string"
        ? imageUrl.url
        : "";

  if (!url) return null;

  if (
    url.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,/s) ||
    url.startsWith("http://") ||
    url.startsWith("https://")
  ) {
    return { type: "image_url", image_url: { url } };
  }

  return null;
}

function processUserContent(content: any): string | any[] {
  if (typeof content === "string") {
    return ensureNonEmpty(content);
  }

  if (!Array.isArray(content)) {
    return ensureNonEmpty(toNonEmptyString(content));
  }

  const blocks: any[] = [];
  let hasImage = false;
  const textParts: string[] = [];

  for (const block of content) {
    if (typeof block === "string") {
      if (block.trim().length > 0) textParts.push(block.trim());
      continue;
    }

    if (!block || typeof block !== "object") continue;

    if (block.type === "text") {
      if (typeof block.text === "string" && block.text.trim().length > 0) {
        textParts.push(block.text.trim());
      }
      continue;
    }

    if (block.type === "image_url") {
      const converted = convertImageBlock(block);
      if (converted) {
        hasImage = true;
        blocks.push(converted);
      }
      continue;
    }

    if (block.type === "image") {
      hasImage = true;
      blocks.push(block);
      continue;
    }

    if (block.type === "tool_result" || block.type === "tool_use") continue;
  }

  if (!hasImage) {
    const text = textParts.join("\n").trim();
    return text.length > 0 ? text : ".";
  }

  const result: any[] = [];
  const text = textParts.join("\n").trim();
  result.push({
    type: "text",
    text: text.length > 0 ? text : "See attached image:",
  });
  for (const block of blocks) result.push(block);
  return result;
}

function processAssistantContent(content: any): string {
  // DO requires assistant content to be a plain non-empty string
  if (typeof content === "string") {
    return content.trim().length > 0 ? content : "...";
  }
  if (content == null) return "...";

  if (Array.isArray(content)) {
    // Extract only text, skip tool_use blocks
    const textParts: string[] = [];
    for (const block of content) {
      if (typeof block === "string" && block.trim().length > 0) {
        textParts.push(block);
      } else if (
        block?.type === "text" &&
        typeof block.text === "string" &&
        block.text.trim().length > 0
      ) {
        textParts.push(block.text);
      }
    }
    const joined = textParts.join("\n").trim();
    return joined.length > 0 ? joined : "...";
  }

  const str = String(content).trim();
  return str.length > 0 ? str : "...";
}

function processToolContent(content: any): string {
  if (typeof content === "string" && content.trim().length > 0) return content;
  if (content == null) return "(empty output)";
  if (typeof content === "object") {
    try {
      const json = JSON.stringify(content);
      return json.length > 2 ? json : "(empty output)";
    } catch {
      return "(serialization error)";
    }
  }
  const str = String(content).trim();
  return str.length > 0 ? str : "(empty output)";
}

function normalizeToolCalls(toolCalls: any[]): any[] {
  if (!Array.isArray(toolCalls)) return [];

  return toolCalls
    .filter((tc) => tc && typeof tc === "object")
    .map((tc) => {
      const id =
        typeof tc.id === "string" && tc.id.length > 0
          ? tc.id
          : `tc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      const name = tc.function?.name || tc.name || "unknown_tool";

      let args = tc.function?.arguments ?? tc.arguments ?? "{}";
      if (typeof args === "object" && args !== null) {
        try {
          args = JSON.stringify(args);
        } catch {
          args = "{}";
        }
      }
      if (typeof args !== "string" || args.trim().length === 0) args = "{}";
      try {
        JSON.parse(args);
      } catch {
        args = JSON.stringify({ raw: args });
      }

      return { id, type: "function", function: { name, arguments: args } };
    });
}

// ══════════════════════════════════════════════════════════════════════════════
// MESSAGE NORMALISATION
// ══════════════════════════════════════════════════════════════════════════════

function normalizeChatCompletionsMessages(body: any): { changed: boolean } {
  if (!body || !Array.isArray(body.messages)) return { changed: false };

  let changed = false;
  const input: any[] = body.messages;

  // STEP 1: Separate system messages
  const systemMsgs: any[] = [];
  const nonSystemMsgs: any[] = [];

  for (const m of input) {
    if (!m || typeof m !== "object") continue;
    if (m.role === "system") {
      systemMsgs.push({ role: "system", content: ensureNonEmpty(m.content) });
    } else {
      nonSystemMsgs.push(m);
    }
  }

  // STEP 2: Index all tool results
  const toolResultsById = new Map<string, string>();

  for (const m of nonSystemMsgs) {
    if (
      m.role === "tool" &&
      typeof m.tool_call_id === "string" &&
      m.tool_call_id.length > 0
    ) {
      toolResultsById.set(m.tool_call_id, processToolContent(m.content));
    }
  }

  // STEP 3: Build normalized sequence
  const normalized: any[] = [];
  const usedToolIds = new Set<string>();

  for (const m of nonSystemMsgs) {
    if (m.role === "tool") continue;

    if (m.role === "user") {
      const content = processUserContent(m.content);
      normalized.push({ role: "user", content });
      continue;
    }

    if (m.role === "assistant") {
      const toolCalls = normalizeToolCalls(m.tool_calls);

      // Get text content - ALWAYS non-empty
      let content = processAssistantContent(m.content);

      const assistantMsg: any = { role: "assistant", content };

      if (toolCalls.length > 0) {
        assistantMsg.tool_calls = toolCalls;
      }

      normalized.push(assistantMsg);

      // Place tool results immediately after
      if (toolCalls.length > 0) {
        for (const tc of toolCalls) {
          usedToolIds.add(tc.id);
          const result = toolResultsById.get(tc.id);

          normalized.push({
            role: "tool",
            tool_call_id: tc.id,
            content: result ?? "(tool was not executed or result was lost)",
          });

          if (!result) {
            console.warn(
              `⚠️  Synthetic result for ${tc.id} (${tc.function.name})`,
            );
            changed = true;
          }
        }
      }

      continue;
    }

    console.warn(`⚠️  Skipping unknown role: ${m.role}`);
    changed = true;
  }

  // STEP 4: Orphan tool results
  for (const [id, content] of toolResultsById) {
    if (!usedToolIds.has(id)) {
      console.warn(`⚠️  Orphan tool result ${id} → user message`);
      normalized.push({
        role: "user",
        content: `[Previous tool output for ${id}]:\n${content}`,
      });
      changed = true;
    }
  }

  // STEP 5: Fix alternation
  const alternated: any[] = [];

  function isUserSide(role: string): boolean {
    return role === "user" || role === "tool";
  }

  for (let i = 0; i < normalized.length; i++) {
    const m = normalized[i];

    if (alternated.length === 0) {
      alternated.push(m);
      continue;
    }

    const prev = alternated[alternated.length - 1];

    // tool after assistant with tool_calls = OK
    if (
      m.role === "tool" &&
      prev.role === "assistant" &&
      Array.isArray(prev.tool_calls)
    ) {
      alternated.push(m);
      continue;
    }

    // tool after tool = OK
    if (m.role === "tool" && prev.role === "tool") {
      alternated.push(m);
      continue;
    }

    const prevUserSide = isUserSide(prev.role);
    const currUserSide = isUserSide(m.role);

    if (prevUserSide === currUserSide) {
      if (prevUserSide) {
        if (
          typeof prev.content === "string" &&
          typeof m.content === "string" &&
          prev.role === "user" &&
          m.role === "user"
        ) {
          prev.content = prev.content + "\n\n" + m.content;
          changed = true;
          continue;
        }
        alternated.push({ role: "assistant", content: "Understood." });
        changed = true;
      } else {
        if (
          typeof prev.content === "string" &&
          typeof m.content === "string" &&
          !prev.tool_calls &&
          !m.tool_calls
        ) {
          prev.content = prev.content + "\n\n" + m.content;
          changed = true;
          continue;
        }
        alternated.push({ role: "user", content: "Continue." });
        changed = true;
      }
    }

    alternated.push(m);
  }

  // STEP 6: First message must be user
  if (alternated.length > 0 && !isUserSide(alternated[0].role)) {
    alternated.unshift({ role: "user", content: "Begin." });
    changed = true;
  }

  // ════════════════════════════════════════════════════════════════════════
  // STEP 7: FINAL SWEEP — absolutely guarantee no empty content anywhere
  //
  // This is the LAST LINE OF DEFENCE. Every single message gets checked.
  // ════════════════════════════════════════════════════════════════════════
  for (const m of alternated) {
    // -- SYSTEM --
    if (m.role === "system") {
      if (typeof m.content !== "string") {
        m.content = toNonEmptyString(m.content, "You are a helpful assistant.");
        changed = true;
      } else if (m.content.trim().length === 0) {
        m.content = "You are a helpful assistant.";
        changed = true;
      }
      continue;
    }

    // -- USER --
    if (m.role === "user") {
      if (typeof m.content === "string") {
        if (m.content.trim().length === 0) {
          m.content = ".";
          changed = true;
        }
      } else if (Array.isArray(m.content)) {
        // Remove ALL empty text blocks
        m.content = m.content.filter((b: any) => {
          if (typeof b === "string") return b.trim().length > 0;
          if (b?.type === "text") {
            if (
              !b.text ||
              typeof b.text !== "string" ||
              b.text.trim().length === 0
            ) {
              changed = true;
              return false;
            }
          }
          return true;
        });

        if (m.content.length === 0) {
          m.content = ".";
          changed = true;
        } else {
          // Ensure text block exists (required alongside images)
          const hasText = m.content.some(
            (b: any) =>
              (typeof b === "string" && b.trim().length > 0) ||
              (b?.type === "text" &&
                typeof b.text === "string" &&
                b.text.trim().length > 0),
          );
          if (!hasText) {
            m.content.unshift({ type: "text", text: "." });
            changed = true;
          }
        }
      } else {
        // Unexpected type
        m.content = toNonEmptyString(m.content, ".");
        changed = true;
      }
      continue;
    }

    // -- ASSISTANT --
    if (m.role === "assistant") {
      // DO requires content to be a non-empty string
      if (typeof m.content !== "string") {
        m.content = toNonEmptyString(m.content, "...");
        changed = true;
      }
      if (m.content.trim().length === 0) {
        m.content = "...";
        changed = true;
      }
      continue;
    }

    // -- TOOL --
    if (m.role === "tool") {
      if (typeof m.content !== "string") {
        m.content = processToolContent(m.content);
        changed = true;
      }
      if (m.content.trim().length === 0) {
        m.content = "(empty output)";
        changed = true;
      }
      continue;
    }
  }

  // STEP 8: Combine
  const final = [...systemMsgs, ...alternated];

  if (final.length === 0) {
    final.push({ role: "user", content: "Hello." });
    changed = true;
  }

  // ════════════════════════════════════════════════════════════════════════
  // STEP 9: PARANOIA CHECK — scan everything one more time
  // If ANYTHING is empty, fix it. This catches bugs in Steps 1-8.
  // ════════════════════════════════════════════════════════════════════════
  for (const m of final) {
    if (typeof m.content === "string" && m.content.trim().length === 0) {
      console.error(
        `🚨 PARANOIA: Empty content found in ${m.role} message after all processing!`,
      );
      m.content =
        m.role === "tool" ? "(empty)" : m.role === "assistant" ? "..." : ".";
      changed = true;
    }
    if (m.content === null || m.content === undefined) {
      console.error(
        `🚨 PARANOIA: null/undefined content in ${m.role} message!`,
      );
      m.content =
        m.role === "tool" ? "(empty)" : m.role === "assistant" ? "..." : ".";
      changed = true;
    }
  }

  body.messages = final;

  if (changed) {
    const tc = final.filter((m: any) => Array.isArray(m.tool_calls)).length;
    const tr = final.filter((m: any) => m.role === "tool").length;
    console.log(
      `🧹 Normalised: ${final.length} msgs | ${tc} tool_calls | ${tr} tool_results`,
    );
  }

  return { changed };
}

// ══════════════════════════════════════════════════════════════════════════════
// STRIP UNSUPPORTED FIELDS
// ══════════════════════════════════════════════════════════════════════════════

function stripUnsupportedFields(body: any): void {
  const fieldsToDelete = [
    "parallel_tool_calls",
    "response_format",
    "logprobs",
    "top_logprobs",
    "seed",
    "frequency_penalty",
    "presence_penalty",
    "logit_bias",
    "user",
    "service_tier",
    "store",
    "metadata",
  ];

  for (const field of fieldsToDelete) {
    if (body[field] !== undefined) delete body[field];
  }

  if (typeof body.n === "number" && body.n > 1) body.n = 1;

  if (body.tool_choice === "auto") delete body.tool_choice;
  if (body.tool_choice === "none") {
    delete body.tool_choice;
    delete body.tools;
  }
  if (body.tool_choice === "required") body.tool_choice = { type: "any" };

  if (body.tool_choice && typeof body.tool_choice === "object") {
    const tc = body.tool_choice;
    if (tc.type === "function" && tc.function?.name) {
      body.tool_choice = { type: "tool", name: tc.function.name };
    }
  }

  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) {
      if (tool?.type === "function" && tool.function) {
        if (tool.function.strict !== undefined) delete tool.function.strict;
        if (!tool.function.description) {
          tool.function.description = tool.function.name || "A tool";
        }
      }
    }
    if (body.tools.length === 0) delete body.tools;
  }

  if (body.stop !== undefined) {
    if (Array.isArray(body.stop)) body.stop_sequences = body.stop;
    else if (typeof body.stop === "string") body.stop_sequences = [body.stop];
    delete body.stop;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// FETCH HELPERS
// ══════════════════════════════════════════════════════════════════════════════

async function fetchDoModels(
  inferenceUrl: string,
  apiKey: string,
): Promise<any[] | null> {
  try {
    const r = await fetch(`${inferenceUrl}/v1/models`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!r.ok) return null;
    const j: any = await r.json().catch(() => null);
    return Array.isArray(j?.data) ? j.data : null;
  } catch {
    return null;
  }
}

export function normalizeOpenAIChatCompletionsBody(body: any): {
  changed: boolean;
} {
  return normalizeChatCompletionsMessages(body);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts: { retries: number; baseDelayMs: number; retryStatuses: Set<number> },
): Promise<Response> {
  let lastErr: unknown = null;

  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    try {
      const res = await fetch(url, init);
      if (!opts.retryStatuses.has(res.status) || attempt === opts.retries)
        return res;

      const retryAfter = res.headers.get("retry-after");
      const retryAfterMs =
        retryAfter && /^\d+$/.test(retryAfter)
          ? Number(retryAfter) * 1000
          : null;
      const delay = retryAfterMs ?? opts.baseDelayMs * Math.pow(2, attempt);
      console.warn(
        `⏳ ${res.status} retry in ${delay}ms (${attempt + 1}/${opts.retries})`,
      );
      await sleep(delay);
    } catch (e) {
      lastErr = e;
      if (attempt === opts.retries) break;
      const delay = opts.baseDelayMs * Math.pow(2, attempt);
      console.warn(
        `⏳ Error retry in ${delay}ms (${attempt + 1}/${opts.retries})`,
        e,
      );
      await sleep(delay);
    }
  }

  throw lastErr ?? new Error("fetchWithRetry failed");
}

// ══════════════════════════════════════════════════════════════════════════════
// PROXY HANDLER
// ══════════════════════════════════════════════════════════════════════════════

export function createProxyHandler(config?: {
  inferenceUrl?: string;
  apiKey?: string;
}): (req: Request) => Promise<Response> {
  const { inferenceUrl, apiKey } = {
    inferenceUrl: config?.inferenceUrl ?? getConfig().inferenceUrl,
    apiKey: config?.apiKey ?? getConfig().apiKey,
  };

  return async function handleRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (path === "/" && req.method === "GET") {
      return Response.json(
        { status: "running", target: inferenceUrl },
        { headers: corsHeaders },
      );
    }

    if (path === "/v1/models" && req.method === "GET") {
      const remote = await fetchDoModels(inferenceUrl, apiKey);
      return Response.json(
        { object: "list", data: remote ?? FALLBACK_MODELS },
        { headers: corsHeaders },
      );
    }

    try {
      let body: any = null;
      let isStream = false;

      if (
        req.method === "POST" ||
        req.method === "PUT" ||
        req.method === "PATCH"
      ) {
        const rawBody = await req.text();
        if (rawBody) {
          try {
            body = JSON.parse(rawBody);

            const originalModel = body.model || "";
            if (MODEL_MAPPING[originalModel]) {
              console.log(
                `🔄 ${originalModel} → ${MODEL_MAPPING[originalModel]}`,
              );
              body.model = MODEL_MAPPING[originalModel];
            }

            if (path === "/v1/chat/completions") {
              normalizeChatCompletionsMessages(body);

              const hasMax =
                (typeof body.max_tokens === "number" &&
                  Number.isFinite(body.max_tokens)) ||
                (typeof body.max_completion_tokens === "number" &&
                  Number.isFinite(body.max_completion_tokens));
              if (!hasMax) body.max_tokens = 8192;
            }

            if (isAnthropicModel(body.model)) {
              stripUnsupportedFields(body);
            }

            isStream = body.stream === true;

            const msgCount = body.messages?.length ?? 0;
            const tcCount =
              body.messages?.filter((m: any) => Array.isArray(m.tool_calls))
                .length ?? 0;
            const trCount =
              body.messages?.filter((m: any) => m.role === "tool").length ?? 0;

            console.log(
              `📤 ${body.model} | ${msgCount} msgs | ${tcCount} tc | ${trCount} tr | stream:${isStream}`,
            );
          } catch (e) {
            console.error("❌ Parse error:", e);
            body = rawBody;
          }
        }
      }

      const targetUrl = `${inferenceUrl}${path}${url.search}`;

      const proxyResponse = await fetchWithRetry(
        targetUrl,
        {
          method: req.method,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: body
            ? typeof body === "string"
              ? body
              : JSON.stringify(body)
            : null,
        },
        {
          retries: 2,
          baseDelayMs: 500,
          retryStatuses: new Set([429, 500, 502, 503, 504]),
        },
      );

      console.log(`📥 ${proxyResponse.status}`);

      if (!proxyResponse.ok) {
        const errorText = await proxyResponse.clone().text();
        console.error("❌ Error:", errorText);

        // Dump full request to file for debugging
        if (body?.messages) {
          try {
            const debugPath = `/tmp/do-proxy-debug-${Date.now()}.json`;
            writeFileSync(debugPath, JSON.stringify(body, null, 2));
            console.error(`📝 Full request dumped to: ${debugPath}`);
          } catch {}

          console.error("\n📋 Messages:");
          body.messages.forEach((m: any, i: number) => {
            let info = `  [${i}] ${m.role}`;
            if (m.role === "tool") info += ` (${m.tool_call_id})`;
            if (m.tool_calls) info += ` tool_calls:${m.tool_calls.length}`;

            if (typeof m.content === "string") {
              const empty = m.content.trim().length === 0;
              info += ` len:${m.content.length}${empty ? " ⚠️EMPTY" : ""}`;
              if (!empty) info += ` "${m.content.substring(0, 30)}..."`;
            } else if (Array.isArray(m.content)) {
              info += ` [${m.content.map((b: any) => b?.type || typeof b).join(",")}]`;
            } else {
              info += ` ${typeof m.content} ${m.content === null ? "NULL" : ""}`;
            }
            console.error(info);
          });
        }
      }

      if (isStream && proxyResponse.body) {
        return new Response(proxyResponse.body, {
          status: proxyResponse.status,
          headers: {
            ...corsHeaders,
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        });
      }

      const responseData = await proxyResponse.text();
      let responseBody: any;
      try {
        responseBody = JSON.parse(responseData);
      } catch {
        responseBody = { raw: responseData };
      }

      return Response.json(responseBody, {
        status: proxyResponse.status,
        headers: corsHeaders,
      });
    } catch (error) {
      console.error("❌ Proxy error:", error);
      return Response.json(
        { error: "Proxy error", message: String(error) },
        { status: 500, headers: corsHeaders },
      );
    }
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// SERVER
// ══════════════════════════════════════════════════════════════════════════════

export function startProxyServer() {
  const cfg = getConfig();

  console.log(`
🚀 Digital Ocean AI Proxy
═════════════════════════
📡 ${cfg.inferenceUrl}
🔑 ${cfg.apiKey ? cfg.apiKey.slice(0, 8) + "..." : "NOT SET"}
💡 http://localhost:${cfg.port}/v1
═════════════════════════
`);

  const server = Bun.serve({
    port: cfg.port,
    fetch: createProxyHandler({
      inferenceUrl: cfg.inferenceUrl,
      apiKey: cfg.apiKey,
    }),
  });

  console.log(`✅ Running on port ${server.port}\n`);
  return server;
}

if (import.meta.main) {
  startProxyServer();
}
