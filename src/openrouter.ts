/**
 * OpenRouter Omni-Brain Adapter
 *
 * Routes AI calls through OpenRouter.ai — a universal gateway that supports
 * GPT-4o, Claude, Gemini, Llama, Mistral, and 100+ models via a single API key.
 *
 * Benefits:
 *   - Single point of failure eliminated: if one model is down, swap the env var
 *   - Cost optimization: route to cheapest model that meets quality bar
 *   - No SDK changes: uses OpenAI-compatible REST API
 *
 * Setup:
 *   OPENROUTER_API_KEY=sk-or-...
 *   OPENROUTER_MODEL=google/gemini-2.0-flash-001   (or any OpenRouter model ID)
 *   OPENROUTER_ENABLED=true
 *
 * Model recommendations for phone agents (balance speed + quality):
 *   - google/gemini-2.0-flash-001       (fast, cheap, good)
 *   - openai/gpt-4o-mini                (reliable, cheap)
 *   - anthropic/claude-3-haiku          (best instruction following)
 *   - meta-llama/llama-3.1-8b-instruct  (free tier, fast)
 */
import OpenAI from "openai";

export interface OpenRouterConfig {
  apiKey: string;
  model: string;
  enabled: boolean;
  timeoutMs: number;
}

export interface OpenRouterResult {
  text: string;
  latencyMs: number;
  model: string;
  tokensUsed?: number;
}

let _client: OpenAI | null = null;

function getClient(apiKey: string): OpenAI {
  if (!_client) {
    _client = new OpenAI({
      apiKey,
      baseURL: "https://openrouter.ai/api/v1",
      defaultHeaders: {
        "HTTP-Referer": process.env.APP_URL || "https://ai-phone-agent.railway.app",
        "X-Title": "AI Phone Agent",
      },
    });
  }
  return _client;
}

export function loadOpenRouterConfig(): OpenRouterConfig | null {
  const apiKey = process.env.OPENROUTER_API_KEY;
  const enabled = process.env.OPENROUTER_ENABLED === "true";
  if (!apiKey || !enabled) return null;
  return {
    apiKey,
    model: process.env.OPENROUTER_MODEL || "google/gemini-2.0-flash-001",
    enabled: true,
    timeoutMs: parseInt(process.env.OPENROUTER_TIMEOUT_MS || "8000", 10),
  };
}

export async function queryOpenRouter(
  config: OpenRouterConfig,
  systemPrompt: string,
  conversationHistory: Array<{ role: "user" | "assistant"; content: string }>,
  userMessage: string
): Promise<OpenRouterResult> {
  const start = Date.now();
  const client = getClient(config.apiKey);

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    ...conversationHistory.slice(-10), // last 10 turns for context
    { role: "user", content: userMessage },
  ];

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await client.chat.completions.create(
      {
        model: config.model,
        messages,
        max_tokens: 200,
        temperature: 0.7,
      },
      { signal: controller.signal }
    );

    clearTimeout(timeout);
    const text = response.choices[0]?.message?.content?.trim() || "I'm sorry, I didn't get a response. Could you repeat that?";
    return {
      text,
      latencyMs: Date.now() - start,
      model: config.model,
      tokensUsed: response.usage?.total_tokens,
    };
  } catch (err: any) {
    clearTimeout(timeout);
    throw new Error(`OpenRouter error (${config.model}): ${err.message}`);
  }
}

export function isOpenRouterConfigured(): boolean {
  return !!(process.env.OPENROUTER_API_KEY && process.env.OPENROUTER_ENABLED === "true");
}
