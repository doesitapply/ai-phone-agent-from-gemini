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
  SMIRK:  "EXAVITQu4vr4xnSDxMaL", // Sarah — warm, natural American female
  FORGE:  "TxGEqnHWrfWFTfGW9XjX", // Josh — deep, confident American male
  GRIT:   "VR6AewLTigWG4xSOukaG", // Arnold — strong, direct
  LEX:    "pNInz6obpgDQGcFmaJgB", // Adam — professional, neutral
  VELVET: "MF3mGyEYCl7XYWbV9V6O", // Elli — warm, friendly female
  LEDGER: "pNInz6obpgDQGcFmaJgB", // Adam — neutral, clear
  HAVEN:  "EXAVITQu4vr4xnSDxMaL", // Sarah — warm, approachable
  ATLAS:  "ErXwobaYiN019PkySvjV", // Antoni — smooth, versatile
  ECHO:   "EXAVITQu4vr4xnSDxMaL", // Sarah — warm, energetic
};

const DEFAULT_VOICE_ID = "EXAVITQu4vr4xnSDxMaL"; // Sarah

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
        stability: 0.40,        // More natural variation (0.5 sounds robotic)
        similarity_boost: 0.85, // Strong voice consistency
        style: 0.15,            // Subtle expressiveness for natural delivery
        use_speaker_boost: true, // Enhances clarity on phone audio
        speed: 0.95,            // Slightly slower for phone call clarity
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
