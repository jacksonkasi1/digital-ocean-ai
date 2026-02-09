// index.ts

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

// ── Model mapping ────────────────────────────────────────────────────────────
const MODEL_MAPPING: Record<string, string> = {
  "anthropic-claude-sonnet-4.5": "anthropic-claude-4.5-sonnet",
  "claude-3.5-sonnet": "anthropic-claude-4.5-sonnet",
  "claude-3.5-haiku": "anthropic-claude-haiku-4.5",
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

// ── Content helpers ──────────────────────────────────────────────────────────

function contentToString(content: unknown): string {
  if (typeof content === "string") return content;
  if (content == null) return "";
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block === "string") { parts.push(block); continue; }
      if (block && typeof block === "object") {
        if (block.type === "tool_use" || block.type === "tool_result") continue;
        if (typeof block.text === "string") parts.push(block.text);
      }
    }
    return parts.join("");
  }
  try { return String(content); } catch { return ""; }
}

/**
 * Return true when the content value is "effectively empty" — i.e. would cause
 * Anthropic's "text content blocks must be non-empty" validation error.
 */
function isContentEmpty(content: any): boolean {
  if (content == null) return true;
  if (typeof content === "string") return content.trim().length === 0;
  if (Array.isArray(content)) {
    if (content.length === 0) return true;
    // All blocks are empty text?
    return content.every((b: any) => {
      if (typeof b === "string") return b.trim().length === 0;
      if (b?.type === "text") return typeof b.text !== "string" || b.text.trim().length === 0;
      // tool_use / tool_result / image blocks count as non-empty
      return false;
    });
  }
  return true;
}

/**
 * Sanitise a content value so it never contains empty text blocks.
 * Returns the cleaned value (string, array, or null).
 */
function sanitiseContent(content: any): any {
  if (content == null) return null;

  if (typeof content === "string") {
    return content.trim().length > 0 ? content : null;
  }

  if (Array.isArray(content)) {
    const cleaned = content.filter((b: any) => {
      if (typeof b === "string") return b.trim().length > 0;
      if (b?.type === "text") return typeof b.text === "string" && b.text.trim().length > 0;
      return true; // keep tool_use, tool_result, image, etc.
    });
    if (cleaned.length === 0) return null;
    // If it's all simple text blocks, flatten to string
    const allText = cleaned.every(
      (b: any) => typeof b === "string" || b?.type === "text",
    );
    if (allText) {
      return cleaned
        .map((b: any) => (typeof b === "string" ? b : b.text))
        .join("");
    }
    return cleaned;
  }

  return content;
}

// ══════════════════════════════════════════════════════════════════════════════
// CORE: normalizeChatCompletionsMessages
//
// Rewrites body.messages so it satisfies Anthropic's strict requirements:
//   1. Every tool_result must reference a tool_use in the IMMEDIATELY preceding
//      assistant message.
//   2. Every tool_use must have a matching tool_result in the IMMEDIATELY
//      following user/tool message(s).
//   3. Messages alternate: user → assistant → user → assistant …
//   4. First non-system message must be role:user.
//   5. No empty text content anywhere (string "" or { type:"text", text:"" }).
//   6. Assistant messages may have content:null when they have tool_calls.
// ══════════════════════════════════════════════════════════════════════════════

function normalizeChatCompletionsMessages(body: any): { changed: boolean } {
  if (!body || !Array.isArray(body.messages)) return { changed: false };

  let changed = false;

  // ────────────────────────────────────────────────────────────────────────
  // PHASE 1 — Clone messages & normalise content
  // ────────────────────────────────────────────────────────────────────────
  const msgs: any[] = [];
  for (const raw of body.messages) {
    if (!raw || typeof raw !== "object") continue;
    const m = { ...raw };

    if (Array.isArray(m.content)) {
      const hasStructural = m.content.some(
        (b: any) =>
          b?.type === "tool_use" ||
          b?.type === "tool_result" ||
          b?.type === "image" ||
          b?.type === "image_url",
      );
      if (!hasStructural) {
        const flat = contentToString(m.content);
        if (m.content !== flat) changed = true;
        m.content = flat;
      }
    } else if (m.content != null && typeof m.content !== "string") {
      m.content = contentToString(m.content);
      changed = true;
    }

    msgs.push(m);
  }

  // ────────────────────────────────────────────────────────────────────────
  // PHASE 2 — Index ALL tool results by their tool_call_id / tool_use_id
  // ────────────────────────────────────────────────────────────────────────
  const toolResultsById = new Map<string, any[]>();

  function stash(id: string, entry: any) {
    const arr = toolResultsById.get(id) ?? [];
    arr.push(entry);
    toolResultsById.set(id, arr);
  }

  for (const m of msgs) {
    // OpenAI format: role:"tool"
    if (
      m.role === "tool" &&
      typeof m.tool_call_id === "string" &&
      m.tool_call_id.length > 0
    ) {
      stash(m.tool_call_id, m);
      continue;
    }

    // Anthropic format: user message with tool_result content blocks
    if (m.role === "user" && Array.isArray(m.content)) {
      for (const block of m.content) {
        if (
          block?.type === "tool_result" &&
          typeof block.tool_use_id === "string" &&
          block.tool_use_id.length > 0
        ) {
          stash(block.tool_use_id, {
            role: "tool",
            tool_call_id: block.tool_use_id,
            content:
              typeof block.content === "string"
                ? block.content
                : JSON.stringify(block.content ?? ""),
          });
          changed = true;
        }
      }
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // PHASE 3 — Rebuild message sequence with proper tool pairing
  //
  // For each assistant message that has tool_calls:
  //   • Keep only calls whose ID has a stashed result
  //   • Emit the results immediately after
  //   • Drop orphan calls
  //
  // role:"tool" and pure-tool_result user messages are skipped — they were
  // stashed and will be placed by the assistant handler.
  // ────────────────────────────────────────────────────────────────────────
  const reordered: any[] = [];

  for (const m of msgs) {
    // Skip standalone tool results (already stashed)
    if (m.role === "tool") continue;

    // Skip user messages that are entirely tool_result blocks
    if (m.role === "user" && Array.isArray(m.content)) {
      const allToolResult = m.content.every((b: any) => b?.type === "tool_result");
      if (allToolResult) { changed = true; continue; }

      // Strip tool_result blocks from mixed content
      const cleaned = m.content.filter((b: any) => b?.type !== "tool_result");
      if (cleaned.length !== m.content.length) {
        changed = true;
        if (cleaned.length === 0) continue;
        // Flatten to string if only text remains
        const allText = cleaned.every(
          (b: any) => typeof b === "string" || b?.type === "text",
        );
        m.content = allText
          ? cleaned.map((b: any) => (typeof b === "string" ? b : b?.text ?? "")).join("")
          : cleaned;
      }
    }

    // ── Assistant with OpenAI-style tool_calls ────────────────────────────
    if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      const validCalls: any[] = [];
      const paired: any[] = [];

      for (const tc of m.tool_calls) {
        const id = tc?.id;
        if (typeof id !== "string" || id.length === 0) { changed = true; continue; }

        const bucket = toolResultsById.get(id);
        if (!bucket || bucket.length === 0) {
          console.warn(`⚠️  Dropping orphan tool_call ${id} (no result found)`);
          changed = true;
          continue;
        }

        validCalls.push(tc);
        paired.push(bucket.shift()!);
        if (bucket.length === 0) toolResultsById.delete(id);
      }

      const out = { ...m };

      if (validCalls.length > 0) {
        out.tool_calls = validCalls;
        // When tool_calls exist, content may be null/empty — set to null
        // (Anthropic accepts null content on assistant w/ tool_use)
        if (isContentEmpty(out.content)) {
          out.content = null;
          changed = true;
        }
      } else {
        // All calls were orphans — strip tool_calls entirely
        delete out.tool_calls;
        changed = true;
        // Must have content now
        if (isContentEmpty(out.content)) {
          out.content = "(tool calls removed — no matching results)";
          changed = true;
        }
      }

      reordered.push(out);
      for (const tr of paired) reordered.push(tr);
      continue;
    }

    // ── Assistant with Anthropic-style tool_use content blocks ────────────
    if (m.role === "assistant" && Array.isArray(m.content)) {
      const toolUseBlocks = m.content.filter((b: any) => b?.type === "tool_use");
      if (toolUseBlocks.length > 0) {
        const otherBlocks = m.content.filter((b: any) => b?.type !== "tool_use");
        const validBlocks: any[] = [];
        const paired: any[] = [];

        for (const block of toolUseBlocks) {
          const id = block.id;
          const bucket = toolResultsById.get(id);
          if (!bucket || bucket.length === 0) {
            console.warn(`⚠️  Dropping orphan tool_use block ${id}`);
            changed = true;
            continue;
          }
          validBlocks.push(block);
          paired.push(bucket.shift()!);
          if (bucket.length === 0) toolResultsById.delete(id);
        }

        const out = { ...m };
        const newContent = [...otherBlocks, ...validBlocks];
        if (newContent.length === 0) {
          out.content = null;
        } else {
          out.content = newContent;
        }
        if (newContent.length !== m.content.length) changed = true;

        reordered.push(out);
        for (const tr of paired) reordered.push(tr);
        continue;
      }
    }

    reordered.push(m);
  }

  // ────────────────────────────────────────────────────────────────────────
  // PHASE 4 — Convert leftover orphan tool results → user messages
  // ────────────────────────────────────────────────────────────────────────
  for (const [id, bucket] of toolResultsById) {
    for (const orphan of bucket) {
      console.warn(`⚠️  Converting orphan tool result ${id} → user message`);
      const c = typeof orphan?.content === "string" ? orphan.content : "";
      reordered.push({
        role: "user",
        content: c.trim().length > 0 ? `[Tool output for ${id}]:\n${c}` : `[Tool ${id} returned no output]`,
      });
      changed = true;
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // PHASE 5 — Sanitise every message's content (no empty strings/blocks)
  // ────────────────────────────────────────────────────────────────────────
  for (const m of reordered) {
    if (!m || typeof m !== "object") continue;

    if (m.role === "tool") {
      // Tool results: ensure content is non-empty string
      if (typeof m.content !== "string" || m.content.trim().length === 0) {
        m.content = "(empty tool output)";
        changed = true;
      }
      continue;
    }

    if (m.role === "assistant") {
      const hasToolCalls =
        (Array.isArray(m.tool_calls) && m.tool_calls.length > 0);

      if (hasToolCalls) {
        // Assistant + tool_calls: content may be null (OK for Anthropic)
        if (typeof m.content === "string" && m.content.trim().length === 0) {
          m.content = null;
          changed = true;
        } else if (Array.isArray(m.content)) {
          m.content = sanitiseContent(m.content);
          changed = true;
        }
      } else {
        // Assistant without tool_calls: must have non-empty content
        const cleaned = sanitiseContent(m.content);
        if (cleaned == null) {
          m.content = ".";
          changed = true;
        } else {
          m.content = cleaned;
        }
      }
      continue;
    }

    if (m.role === "system") {
      const cleaned = sanitiseContent(m.content);
      if (cleaned == null) {
        m.content = ".";
        changed = true;
      } else {
        m.content = cleaned;
      }
      continue;
    }

    // role: "user" (or anything else)
    const cleaned = sanitiseContent(m.content);
    if (cleaned == null) {
      m.content = ".";
      changed = true;
    } else {
      m.content = cleaned;
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // PHASE 6 — Remove messages that are truly dead weight
  // ────────────────────────────────────────────────────────────────────────
  const filtered = reordered.filter((m: any) => {
    if (!m || typeof m !== "object") return false;
    // Always keep tool results (structurally required)
    if (m.role === "tool") return true;
    // Keep assistant with tool_calls even if content is null
    if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) return true;
    // Keep system messages
    if (m.role === "system") return true;
    // Keep anything with array content (images, etc.)
    if (Array.isArray(m.content) && m.content.length > 0) return true;
    // Keep non-empty string content
    if (typeof m.content === "string" && m.content.trim().length > 0) return true;
    // Drop everything else
    changed = true;
    return false;
  });

  // ────────────────────────────────────────────────────────────────────────
  // PHASE 7 — Merge consecutive same-role messages (alternation fix)
  //
  // Anthropic requires strict user ↔ assistant alternation.
  // role:"tool" is treated as user-side by Anthropic.
  // ────────────────────────────────────────────────────────────────────────
  const merged: any[] = [];
  for (const m of filtered) {
    if (merged.length === 0) { merged.push({ ...m }); continue; }

    const prev = merged[merged.length - 1];

    // Merge consecutive user messages (both string content, no structural blocks)
    if (
      m.role === "user" && prev.role === "user" &&
      typeof m.content === "string" && typeof prev.content === "string"
    ) {
      prev.content = prev.content + "\n\n" + m.content;
      changed = true;
      continue;
    }

    // Merge consecutive assistant (no tool_calls on either, both string)
    if (
      m.role === "assistant" && prev.role === "assistant" &&
      !Array.isArray(m.tool_calls) && !Array.isArray(prev.tool_calls) &&
      typeof m.content === "string" && typeof prev.content === "string"
    ) {
      prev.content = prev.content + "\n\n" + m.content;
      changed = true;
      continue;
    }

    // Consecutive assistant where prev has tool_calls and next doesn't →
    // can't merge, but need to insert a synthetic user message between them
    // to satisfy alternation
    if (m.role === "assistant" && prev.role === "assistant") {
      merged.push({ role: "user", content: "Continue." });
      changed = true;
    }

    // Consecutive tool results are fine (Anthropic groups them as user-side)
    // But if prev is user and current is user with different content types, insert assistant
    if (m.role === "user" && prev.role === "user") {
      // Can't merge (one has array content) → insert synthetic assistant
      merged.push({ role: "assistant", content: "Understood." });
      changed = true;
    }

    // role:"tool" after role:"user" → need assistant between them
    if (m.role === "tool" && prev.role === "user") {
      merged.push({ role: "assistant", content: "Processing..." });
      changed = true;
    }

    // role:"tool" after role:"tool" is OK (both user-side)
    // role:"tool" after role:"assistant" with tool_calls is the expected pattern

    merged.push({ ...m });
  }

  // ────────────────────────────────────────────────────────────────────────
  // PHASE 8 — Ensure first non-system message is user
  // ────────────────────────────────────────────────────────────────────────
  const firstNonSystem = merged.findIndex((m: any) => m.role !== "system");
  if (firstNonSystem >= 0 && merged[firstNonSystem].role !== "user") {
    merged.splice(firstNonSystem, 0, { role: "user", content: "Go ahead." });
    changed = true;
  }

  // ────────────────────────────────────────────────────────────────────────
  // PHASE 9 — Final validation pass
  //
  // Walk the final array and verify every tool result references a tool_use
  // in the immediately preceding assistant message. If not, convert to user.
  // This is the LAST line of defence.
  // ────────────────────────────────────────────────────────────────────────
  const validated: any[] = [];

  for (let i = 0; i < merged.length; i++) {
    const m = merged[i];

    if (m.role === "tool") {
      // Find the nearest preceding assistant message
      let prevAssistant: any = null;
      for (let j = validated.length - 1; j >= 0; j--) {
        if (validated[j].role === "assistant") { prevAssistant = validated[j]; break; }
        if (validated[j].role === "tool") continue; // skip other tool results in same batch
        break; // hit a user/system → no valid assistant
      }

      // Check if the preceding assistant has this tool_call_id
      let hasMatchingCall = false;
      if (prevAssistant) {
        // OpenAI format
        if (Array.isArray(prevAssistant.tool_calls)) {
          hasMatchingCall = prevAssistant.tool_calls.some(
            (tc: any) => tc?.id === m.tool_call_id,
          );
        }
        // Anthropic format
        if (!hasMatchingCall && Array.isArray(prevAssistant.content)) {
          hasMatchingCall = prevAssistant.content.some(
            (b: any) => b?.type === "tool_use" && b.id === m.tool_call_id,
          );
        }
      }

      if (hasMatchingCall) {
        validated.push(m);
      } else {
        // Convert to user message — cannot pair it
        console.warn(
          `⚠️  [Phase 9] tool result ${m.tool_call_id} has no matching tool_use in preceding assistant — converting to user message`,
        );
        const content = typeof m.content === "string" && m.content.trim().length > 0
          ? `[Tool output]: ${m.content}`
          : "[Tool returned no output]";
        validated.push({ role: "user", content });
        changed = true;
      }
      continue;
    }

    validated.push(m);
  }

  // ────────────────────────────────────────────────────────────────────────
  // PHASE 10 — One more merge pass after validation (phase 9 may have
  // created consecutive user messages)
  // ────────────────────────────────────────────────────────────────────────
  const final: any[] = [];
  for (const m of validated) {
    if (final.length === 0) { final.push(m); continue; }
    const prev = final[final.length - 1];

    if (
      m.role === "user" && prev.role === "user" &&
      typeof m.content === "string" && typeof prev.content === "string"
    ) {
      prev.content = prev.content + "\n\n" + m.content;
      changed = true;
      continue;
    }

    if (
      m.role === "assistant" && prev.role === "assistant" &&
      !Array.isArray(m.tool_calls) && !Array.isArray(prev.tool_calls) &&
      typeof m.content === "string" && typeof prev.content === "string"
    ) {
      prev.content = prev.content + "\n\n" + m.content;
      changed = true;
      continue;
    }

    // Still consecutive same-role after merge attempt → insert separator
    if (m.role === prev.role && m.role === "user") {
      final.push({ role: "assistant", content: "Understood." });
      changed = true;
    } else if (m.role === prev.role && m.role === "assistant") {
      final.push({ role: "user", content: "Continue." });
      changed = true;
    }

    final.push(m);
  }

  body.messages = final.length > 0 ? final : [{ role: "user", content: "." }];

  if (changed) {
    console.log(`🧹 Message normalisation complete — ${body.messages.length} messages`);
  }

  return { changed };
}

// ── Strip fields that Anthropic does not support ─────────────────────────────

function stripUnsupportedAnthropicFields(body: any): void {
  if (body.parallel_tool_calls !== undefined) {
    console.log("⚠️  Stripping parallel_tool_calls");
    delete body.parallel_tool_calls;
  }

  if (body.tool_choice === "auto") {
    delete body.tool_choice;
  }

  if (body.tool_choice === "none") {
    delete body.tool_choice;
    delete body.tools;
  }

  if (body.tool_choice && typeof body.tool_choice === "object") {
    const tc = body.tool_choice;
    if (tc.type === "function" && tc.function?.name) {
      body.tool_choice = { type: "tool", name: tc.function.name };
    }
  }

  // "required" → "any" (Anthropic's equivalent)
  if (body.tool_choice === "required") {
    body.tool_choice = { type: "any" };
  }

  if (body.response_format !== undefined) delete body.response_format;
  if (body.logprobs !== undefined) delete body.logprobs;
  if (body.top_logprobs !== undefined) delete body.top_logprobs;
  if (body.seed !== undefined) delete body.seed;
  if (body.frequency_penalty !== undefined) delete body.frequency_penalty;
  if (body.presence_penalty !== undefined) delete body.presence_penalty;

  if (typeof body.n === "number" && body.n > 1) body.n = 1;

  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) {
      if (tool?.type === "function" && tool.function) {
        if (tool.function.strict !== undefined) delete tool.function.strict;
      }
    }
    // Drop tools array entirely if empty
    if (body.tools.length === 0) delete body.tools;
  }

  // Extract system message from messages → body.system (if DO expects it)
  // Actually DO's OpenAI-compat endpoint handles this, so leave it.
}

// ── Fetch helpers ────────────────────────────────────────────────────────────

async function fetchDoModels(inferenceUrl: string, apiKey: string): Promise<any[] | null> {
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

export function normalizeOpenAIChatCompletionsBody(body: any): { changed: boolean } {
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
      if (!opts.retryStatuses.has(res.status) || attempt === opts.retries) return res;

      const retryAfter = res.headers.get("retry-after");
      const retryAfterMs =
        retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : null;
      const delay = retryAfterMs ?? opts.baseDelayMs * Math.pow(2, attempt);
      console.warn(
        `⏳ Upstream ${res.status}; retry in ${delay}ms (${attempt + 1}/${opts.retries})`,
      );
      await sleep(delay);
    } catch (e) {
      lastErr = e;
      if (attempt === opts.retries) break;
      const delay = opts.baseDelayMs * Math.pow(2, attempt);
      console.warn(`⏳ Fetch error; retry in ${delay}ms (${attempt + 1}/${opts.retries})`, e);
      await sleep(delay);
    }
  }

  throw lastErr ?? new Error("fetchWithRetry failed");
}

// ── Proxy handler ────────────────────────────────────────────────────────────

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
        {
          status: "running",
          message: "Digital Ocean AI Proxy (Bun)",
          usage: "Configure your AI tool to use this URL as the API base",
          target: inferenceUrl,
        },
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

      if (req.method === "POST" || req.method === "PUT" || req.method === "PATCH") {
        const rawBody = await req.text();
        if (rawBody) {
          try {
            body = JSON.parse(rawBody);

            // Model mapping
            const originalModel = body.model || "";
            if (MODEL_MAPPING[originalModel]) {
              console.log(`🔄 Model remap: ${originalModel} → ${MODEL_MAPPING[originalModel]}`);
              body.model = MODEL_MAPPING[originalModel];
            }

            const anthropic = isAnthropicModel(body.model);

            if (path === "/v1/chat/completions") {
              const result = normalizeChatCompletionsMessages(body);
              if (result.changed) {
                console.log("🧹 Messages normalised for Anthropic compatibility");
              }

              // Ensure max_tokens
              const hasMax =
                (typeof body.max_tokens === "number" && Number.isFinite(body.max_tokens)) ||
                (typeof body.max_completion_tokens === "number" &&
                  Number.isFinite(body.max_completion_tokens));
              if (!hasMax) body.max_tokens = 4096;
              if (typeof body.max_tokens === "number" && body.max_tokens < 1)
                body.max_tokens = 4096;
              if (
                typeof body.max_completion_tokens === "number" &&
                body.max_completion_tokens < 1
              )
                body.max_completion_tokens = 4096;
            }

            if (anthropic) {
              stripUnsupportedAnthropicFields(body);
            } else {
              if (body.parallel_tool_calls !== undefined) delete body.parallel_tool_calls;
              if (body.tool_choice === "auto") delete body.tool_choice;
            }

            isStream = body.stream === true;
            console.log(
              `📤 ${body.model} | ${path} | stream:${isStream} | msgs:${body.messages?.length ?? "?"}`,
            );
          } catch {
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
          body: body ? (typeof body === "string" ? body : JSON.stringify(body)) : null,
        },
        { retries: 2, baseDelayMs: 500, retryStatuses: new Set([429, 500, 502, 503, 504]) },
      );

      console.log(`📥 DO responded ${proxyResponse.status}`);

      if (!proxyResponse.ok) {
        const clone = proxyResponse.clone();
        const errorText = await clone.text();
        console.error(`❌ DO error:`, errorText);
        console.error(`📤 Sent:`, typeof body === "string" ? body : JSON.stringify(body, null, 2));
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

// ── Server entry point ───────────────────────────────────────────────────────

export function startProxyServer() {
  const cfg = getConfig();

  console.log(`
🚀 Digital Ocean AI Proxy (Bun)
📡 Target: ${cfg.inferenceUrl}
🔑 API Key: ${cfg.apiKey ? cfg.apiKey.slice(0, 10) + "..." : "⚠️ NOT SET"}
💡 Base URL: http://localhost:${cfg.port}/v1
`);

  const server = Bun.serve({
    port: cfg.port,
    fetch: createProxyHandler({ inferenceUrl: cfg.inferenceUrl, apiKey: cfg.apiKey }),
  });

  console.log(`✅ Running at http://localhost:${server.port}`);
  return server;
}

if (import.meta.main) {
  startProxyServer();
}