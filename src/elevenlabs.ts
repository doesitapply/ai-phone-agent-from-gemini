/**
 * ElevenLabs TTS Adapter — Flash v2.5 (Ultra-Low Latency)
 *
 * Uses eleven_flash_v2_5 — 75ms TTFA, optimized for real-time phone calls.
 * Voice settings tuned for maximum naturalness and human-like delivery.
 *
 * Flow:
 *   AI text → ElevenLabs Flash v2.5 → MP3 buffer → /api/tts/:id → Twilio <Play>
 */
import { createHash } from "crypto";

export interface ElevenLabsConfig {
  apiKey: string;
  voiceId: string;
  modelId: string;
}

const audioCache = new Map<string, Buffer>();
const MAX_CACHE_SIZE = 200;

/**
 * Per-agent ElevenLabs voice IDs — curated for phone call quality.
 */
const AGENT_VOICE_MAP: Record<string, string> = {
  SMIRK:  "TX3LPaxmHKxFdv7VOQHJ", // Liam — articulate, direct, energetic American male
  FORGE:  "pNInz6obpgDQGcFmaJgB", // Adam — deep, authoritative American male
  GRIT:   "CwhRBWXzGAHq8TQ4Fs17", // Roger — resonant, laid-back, confident
  LEX:    "TX3LPaxmHKxFdv7VOQHJ", // Liam — clean, professional
  VELVET: "EXAVITQu4vr4xnSDxMaL", // Sarah — warm, mature female
  LEDGER: "JBFqnCBsd6RMkjVDRZzb", // George — warm, British professional
  HAVEN:  "EXAVITQu4vr4xnSDxMaL", // Sarah — warm, approachable female
  ATLAS:  "ErXwobaYiN019PkySvjV", // Antoni — smooth, versatile
  ECHO:   "IKne3meq5aSn9XLyUdCD", // Charlie — natural, conversational Australian
};

const DEFAULT_VOICE_ID = "TX3LPaxmHKxFdv7VOQHJ"; // Liam — SMIRK default

export function loadElevenLabsConfig(): ElevenLabsConfig | null {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) return null;
  return {
    apiKey,
    voiceId: process.env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE_ID,
    modelId: process.env.ELEVENLABS_MODEL_ID || "eleven_flash_v2_5",
  };
}

export function getElevenLabsAgentVoice(agentName: string, config: ElevenLabsConfig): string {
  if (process.env.ELEVENLABS_VOICE_ID) return config.voiceId;
  return AGENT_VOICE_MAP[agentName.toUpperCase()] || DEFAULT_VOICE_ID;
}

/**
 * Generate speech audio from text using ElevenLabs.
 * Voice settings optimized for phone call naturalness.
 */
export async function generateSpeech(
  text: string,
  config: ElevenLabsConfig,
  agentName?: string
): Promise<Buffer | null> {
  const voiceId = agentName ? getElevenLabsAgentVoice(agentName, config) : config.voiceId;
  const cacheKey = createHash("md5").update(`${voiceId}:${config.modelId}:${text}`).digest("hex");
  if (audioCache.has(cacheKey)) return audioCache.get(cacheKey)!;

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`;
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
        stability: parseFloat(process.env.VOICE_STABILITY || "0.20"),
        similarity_boost: parseFloat(process.env.VOICE_SIMILARITY_BOOST || "0.88"),
        style: parseFloat(process.env.VOICE_STYLE || "0.60"),
        use_speaker_boost: (process.env.VOICE_SPEAKER_BOOST || "true") !== "false",
        speed: parseFloat(process.env.VOICE_SPEED || "0.95"),
      },
      output_format: "mp3_44100_128",
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`ElevenLabs API error ${response.status}: ${err}`);
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

export function isElevenLabsConfigured(): boolean {
  return !!process.env.ELEVENLABS_API_KEY;
}
