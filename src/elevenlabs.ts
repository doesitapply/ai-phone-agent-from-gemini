/**
 * ElevenLabs TTS Adapter
 *
 * Generates natural-sounding speech via ElevenLabs API and serves it
 * as a publicly accessible audio file that Twilio can play via <Play>.
 *
 * Flow:
 *   AI text → ElevenLabs API → MP3 buffer → served at /api/tts/:id → Twilio <Play>
 *
 * Voice selection:
 *   Set ELEVENLABS_VOICE_ID in env (default: Charlie — Deep, Confident, Energetic)
 *   Set ELEVENLABS_MODEL_ID (default: eleven_turbo_v2_5 — lowest latency)
 *
 * Latency: ~300-600ms for short phrases vs ~1-2s for Polly
 */

import { createHash } from "crypto";

export interface ElevenLabsConfig {
  apiKey: string;
  voiceId: string;
  modelId: string;
}

// In-memory audio cache — avoids re-generating identical phrases
const audioCache = new Map<string, Buffer>();
const MAX_CACHE_SIZE = 100;

export function loadElevenLabsConfig(): ElevenLabsConfig | null {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) return null;
  return {
    apiKey,
    voiceId: process.env.ELEVENLABS_VOICE_ID || "IKne3meq5aSn9XLyUdCD", // Charlie — confident, energetic
    modelId: process.env.ELEVENLABS_MODEL_ID || "eleven_turbo_v2_5", // lowest latency model
  };
}

/**
 * Generate speech audio from text using ElevenLabs.
 * Returns an MP3 buffer, or null if ElevenLabs is not configured.
 */
export async function generateSpeech(
  text: string,
  config: ElevenLabsConfig
): Promise<Buffer | null> {
  // Check cache first
  const cacheKey = createHash("md5").update(`${config.voiceId}:${text}`).digest("hex");
  if (audioCache.has(cacheKey)) {
    return audioCache.get(cacheKey)!;
  }

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${config.voiceId}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": config.apiKey,
      "Content-Type": "application/json",
      "Accept": "audio/mpeg",
    },
    body: JSON.stringify({
      text,
      model_id: config.modelId,
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.75,
        style: 0.0,
        use_speaker_boost: true,
      },
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`ElevenLabs API error ${response.status}: ${err}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  // Cache with LRU eviction
  if (audioCache.size >= MAX_CACHE_SIZE) {
    const firstKey = audioCache.keys().next().value;
    if (firstKey) audioCache.delete(firstKey);
  }
  audioCache.set(cacheKey, buffer);

  return buffer;
}

export function isElevenLabsConfigured(): boolean {
  return !!process.env.ELEVENLABS_API_KEY;
}
