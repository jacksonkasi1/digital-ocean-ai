// index.ts
const DO_INFERENCE_URL = process.env.DO_INFERENCE_URL || "https://inference.do-ai.run";
const DO_API_KEY = process.env.DO_API_KEY || "your-digital-ocean-api-key";
const PORT = process.env.PORT || 4005;

// Optional: Remap model names if needed
const MODEL_MAPPING: Record<string, string> = {
  // "gpt-4": "anthropic-claude-haiku-4.5",
  // "my-model": "anthropic-claude-sonnet-4",
  // Back-compat: older local config used a different Sonnet naming convention.
  "anthropic-claude-sonnet-4.5": "anthropic-claude-4.5-sonnet",
};

// Fallback list for /v1/models if DO is unreachable.
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

async function fetchDoModels(): Promise<any[] | null> {
  try {
    const r = await fetch(`${DO_INFERENCE_URL}/v1/models`, {
      method: "GET",
      headers: { "Authorization": `Bearer ${DO_API_KEY}` },
    });
    if (!r.ok) return null;
    const j: any = await r.json().catch(() => null);
    const data = j?.data;
    if (Array.isArray(data)) return data;
    return null;
  } catch {
    return null;
  }
}

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  // CORS headers
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };

  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // Root endpoint
  if (path === "/" && req.method === "GET") {
    return Response.json({
      status: "running",
      message: "Digital Ocean AI Proxy (Bun)",
      usage: "Configure your AI tool to use this URL as the API base",
      target: DO_INFERENCE_URL,
    }, { headers: corsHeaders });
  }

  // Models endpoint (some tools require this)
  if (path === "/v1/models" && req.method === "GET") {
    const remote = await fetchDoModels();
    return Response.json({
      object: "list",
      data: remote ?? FALLBACK_MODELS,
    }, { headers: corsHeaders });
  }

  // Proxy all other requests to Digital Ocean
  try {
    let body: any = null;
    let isStream = false;

    // Parse request body if present
    if (req.method === "POST" || req.method === "PUT" || req.method === "PATCH") {
      const rawBody = await req.text();
      if (rawBody) {
        try {
          body = JSON.parse(rawBody);
          
          // Apply model mapping if exists
          const originalModel = body.model || "";
          if (MODEL_MAPPING[originalModel]) {
            console.log(`🔄 Remapped model: ${originalModel} -> ${MODEL_MAPPING[originalModel]}`);
            body.model = MODEL_MAPPING[originalModel];
          }

          // Anthropic-backed endpoints require max_tokens >= 1. Some OpenAI-compatible
          // clients omit it, so default it to keep the proxy resilient.
          if (path === "/v1/chat/completions") {
            const hasMax =
              (typeof body.max_tokens === "number" && Number.isFinite(body.max_tokens)) ||
              (typeof body.max_completion_tokens === "number" && Number.isFinite(body.max_completion_tokens));
            if (!hasMax) body.max_tokens = 1024;
            if (typeof body.max_tokens === "number" && body.max_tokens < 1) body.max_tokens = 1024;
            if (typeof body.max_completion_tokens === "number" && body.max_completion_tokens < 1) {
              body.max_completion_tokens = 1024;
            }
          }

          // FIX: Strip parallel_tool_calls and problematic tool_choice for compatibility
          if (body.parallel_tool_calls !== undefined) {
             console.log("⚠️ Stripping parallel_tool_calls for compatibility");
             delete body.parallel_tool_calls;
          }
          if (body.tool_choice === "auto") {
             console.log("⚠️ Stripping tool_choice: 'auto' (defaulting) for compatibility");
             delete body.tool_choice;
          }

          isStream = body.stream === true;
          console.log(`📤 Proxying request | Model: ${body.model} | Path: ${path} | Stream: ${isStream}`);
        } catch {
          body = rawBody;
        }
      }
    }

    // Build target URL
    const targetUrl = `${DO_INFERENCE_URL}${path}${url.search}`;

    // Make request to Digital Ocean
    const proxyResponse = await fetch(targetUrl, {
      method: req.method,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${DO_API_KEY}`,
      },
      body: body ? JSON.stringify(body) : null,
    });

    console.log(`📥 Response from DO | Status: ${proxyResponse.status}`);

    // Log error details for debugging
    if (!proxyResponse.ok) {
        const clone = proxyResponse.clone();
        const errorText = await clone.text();
        console.error(`❌ Error Body from DO:`, errorText);
        console.error(`📤 Request Body sent:`, JSON.stringify(body, null, 2));
    }

    // Handle streaming response
    if (isStream && proxyResponse.body) {
      return new Response(proxyResponse.body, {
        status: proxyResponse.status,
        headers: {
          ...corsHeaders,
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        },
      });
    }

    // Handle regular response
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
      { status: 500, headers: corsHeaders }
    );
  }
}

// Start server
console.log(`
🚀 Digital Ocean AI Proxy (Bun) Starting...
📡 Target: ${DO_INFERENCE_URL}
🔑 API Key: ${DO_API_KEY ? DO_API_KEY.slice(0, 10) + "..." : "⚠️ Not set!"}

💡 Configure your AI tool with:
   API Base URL: http://localhost:${PORT}/v1
   API Key: anything (will be replaced)
`);

const server = Bun.serve({
  port: Number(PORT),
  fetch: handleRequest,
});

console.log(`✅ Proxy running at http://localhost:${server.port}`);
