/**
 * OpenAI TTS Module
 * Uses OpenAI's tts-1 model for natural-sounding speech.
 * Primary TTS engine — replaces ElevenLabs free tier (IP-restricted).
 * Voices: alloy, echo, fable, onyx, nova, shimmer
 * nova = warm, natural female voice — best for receptionist use
 * onyx = deep, confident male voice — good for GRIT/FORGE
 */
import OpenAI from "openai";

export type OpenAITTSConfig = {
  apiKey: string;
  voice: "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer";
  model: "tts-1" | "tts-1-hd";
  speed: number; // 0.25 to 4.0, default 1.0
};

export function loadOpenAITTSConfig(): OpenAITTSConfig | null {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  return {
    apiKey,
    voice: (process.env.OPENAI_TTS_VOICE as OpenAITTSConfig["voice"]) || "nova",
    model: (process.env.OPENAI_TTS_MODEL as OpenAITTSConfig["model"]) || "tts-1",
    speed: parseFloat(process.env.OPENAI_TTS_SPEED || "1.0"),
  };
}

/**
 * Generate speech audio buffer from text using OpenAI TTS.
 * Returns a Buffer of MP3 audio, or null on failure.
 */
export async function generateOpenAISpeech(
  text: string,
  config: OpenAITTSConfig
): Promise<Buffer | null> {
  try {
    const client = new OpenAI({ apiKey: config.apiKey });
    const response = await client.audio.speech.create({
      model: config.model,
      voice: config.voice,
      input: text,
      response_format: "mp3",
      speed: config.speed,
    });
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch (err: any) {
    console.error("[OpenAI TTS] Error:", err.message);
    return null;
  }
}

/**
 * Map an agent name to a sensible OpenAI voice.
 * Keeps each agent sounding distinct.
 */
export function getAgentVoice(agentName: string): OpenAITTSConfig["voice"] {
  const voiceMap: Record<string, OpenAITTSConfig["voice"]> = {
    SMIRK:  "nova",    // warm, natural, slightly playful
    FORGE:  "onyx",    // deep, authoritative
    GRIT:   "echo",    // confident, direct
    LEX:    "fable",   // measured, professional
    VELVET: "shimmer", // soft, warm, concierge
    LEDGER: "alloy",   // neutral, precise
    HAVEN:  "nova",    // friendly, approachable
    ATLAS:  "alloy",   // neutral, general purpose
    ECHO:   "nova",    // friendly for follow-ups
  };
  return voiceMap[agentName.toUpperCase()] || "nova";
}
