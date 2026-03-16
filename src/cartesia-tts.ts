/**
 * Cartesia Sonic-2 TTS Adapter
 *
 * Cartesia Sonic: 40ms TTFA — fastest TTS on the market.
 * Designed for real-time voice agents and phone calls.
 *
 * Docs: https://docs.cartesia.ai/api-reference/tts/bytes
 */
import { createHash } from "crypto";

export interface CartesiaTTSConfig {
  apiKey: string;
  voiceId: string;
  modelId: string;
}

const audioCache = new Map<string, Buffer>();
const MAX_CACHE_SIZE = 200;

const AGENT_VOICE_MAP: Record<string, string> = {
  SMIRK:  "694f9389-aac1-45b6-b726-9d9369183238",
  FORGE:  "a0e99841-438c-4a64-b679-ae501e7d6091",
  GRIT:   "2ee87190-8f84-4925-97da-e52547f9462c",
  LEX:    "2ee87190-8f84-4925-97da-e52547f9462c",
  VELVET: "79a125e8-cd45-4c13-8a67-188112f4dd22",
  LEDGER: "2ee87190-8f84-4925-97da-e52547f9462c",
  HAVEN:  "79a125e8-cd45-4c13-8a67-188112f4dd22",
  ATLAS:  "a0e99841-438c-4a64-b679-ae501e7d6091",
  ECHO:   "79a125e8-cd45-4c13-8a67-188112f4dd22",
};

const DEFAULT_VOICE_ID = "694f9389-aac1-45b6-b726-9d9369183238";

export function loadCartesiaTTSConfig(): CartesiaTTSConfig | null {
  const apiKey = process.env.CARTESIA_API_KEY;
  if (!apiKey) return null;
  return {
    apiKey,
    voiceId: process.env.CARTESIA_VOICE_ID || DEFAULT_VOICE_ID,
    modelId: process.env.CARTESIA_MODEL_ID || "sonic-2",
  };
}

export function getCartesiaAgentVoice(agentName: string, config: CartesiaTTSConfig): string {
  if (process.env.CARTESIA_VOICE_ID) return config.voiceId;
  return AGENT_VOICE_MAP[agentName.toUpperCase()] || DEFAULT_VOICE_ID;
}

export async function generateCartesiaSpeech(
  text: string,
  config: CartesiaTTSConfig,
  agentName?: string
): Promise<Buffer | null> {
  const voiceId = agentName ? getCartesiaAgentVoice(agentName, config) : config.voiceId;
  const cacheKey = createHash("md5").update(`cartesia:${voiceId}:${text}`).digest("hex");
  if (audioCache.has(cacheKey)) return audioCache.get(cacheKey)!;

  const response = await fetch("https://api.cartesia.ai/tts/bytes", {
    method: "POST",
    headers: {
      "Cartesia-Version": "2024-06-10",
      "X-API-Key": config.apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model_id: config.modelId,
      transcript: text,
      voice: { mode: "id", id: voiceId },
      output_format: { container: "mp3", encoding: "mp3", sample_rate: 44100 },
      language: "en",
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Cartesia API error ${response.status}: ${err}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  if (audioCache.size >= MAX_CACHE_SIZE) {
    const firstKey = audioCache.keys().next().value;
    if (firstKey) audioCache.delete(firstKey);
  }
  audioCache.set(cacheKey, buffer);
  return buffer;
}

export function isCartesiaConfigured(): boolean {
  return !!process.env.CARTESIA_API_KEY;
}
