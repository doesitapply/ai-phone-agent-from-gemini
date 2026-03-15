/**
 * Google Cloud Text-to-Speech Module
 *
 * Uses Google's Neural2 and WaveNet voices — the highest-quality voices
 * available on Google Cloud TTS. Neural2 voices are trained on large datasets
 * and sound nearly indistinguishable from a real human on a phone call.
 *
 * Authentication:
 *   Option A (recommended): GOOGLE_TTS_API_KEY — a simple API key from
 *     console.cloud.google.com → APIs & Services → Credentials
 *   Option B: GOOGLE_APPLICATION_CREDENTIALS — path to a service account JSON
 *     (same service account used for Google Calendar if already configured)
 *
 * Voice naming convention:
 *   en-US-Neural2-C   → Neural2 female (warm, natural)
 *   en-US-Neural2-D   → Neural2 male (deep, confident)
 *   en-US-Neural2-F   → Neural2 female (bright, energetic)
 *   en-US-Neural2-J   → Neural2 male (measured, professional)
 *   en-US-Wavenet-F   → WaveNet female (fallback if Neural2 unavailable)
 *
 * Agent voice map keeps each SMIRK agent sounding distinct.
 */
import textToSpeech from "@google-cloud/text-to-speech";

export type GoogleTTSConfig = {
  apiKey?: string;           // Simple API key (preferred for Railway)
  voice: string;             // e.g. "en-US-Neural2-C"
  languageCode: string;      // e.g. "en-US"
  speakingRate: number;      // 0.25–4.0, default 1.0
  pitch: number;             // -20.0–20.0 semitones, default 0.0
};

let _client: textToSpeech.TextToSpeechClient | null = null;

function getClient(config: GoogleTTSConfig): textToSpeech.TextToSpeechClient {
  if (!_client) {
    if (config.apiKey) {
      // API key auth — simplest for Railway deployments
      _client = new textToSpeech.TextToSpeechClient({
        apiKey: config.apiKey,
      });
    } else {
      // Service account / ADC auth
      _client = new textToSpeech.TextToSpeechClient();
    }
  }
  return _client;
}

export function loadGoogleTTSConfig(): GoogleTTSConfig | null {
  const apiKey = process.env.GOOGLE_TTS_API_KEY;
  const hasServiceAccount = !!(
    process.env.GOOGLE_APPLICATION_CREDENTIALS ||
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON
  );

  // Require at least one auth method
  if (!apiKey && !hasServiceAccount) return null;

  return {
    apiKey,
    voice: process.env.GOOGLE_TTS_VOICE || "en-US-Neural2-C",
    languageCode: process.env.GOOGLE_TTS_LANGUAGE || "en-US",
    speakingRate: parseFloat(process.env.GOOGLE_TTS_SPEED || "1.0"),
    pitch: parseFloat(process.env.GOOGLE_TTS_PITCH || "0.0"),
  };
}

/**
 * Generate speech audio buffer from text using Google Cloud TTS.
 * Returns a Buffer of MP3 audio, or null on failure.
 */
export async function generateGoogleSpeech(
  text: string,
  config: GoogleTTSConfig
): Promise<Buffer | null> {
  try {
    const client = getClient(config);

    const [response] = await client.synthesizeSpeech({
      input: { text },
      voice: {
        languageCode: config.languageCode,
        name: config.voice,
      },
      audioConfig: {
        audioEncoding: "MP3",
        speakingRate: config.speakingRate,
        pitch: config.pitch,
        // Optimize for phone audio quality
        effectsProfileId: ["telephony-class-application"],
      },
    });

    if (!response.audioContent) return null;
    return Buffer.from(response.audioContent as Uint8Array);
  } catch (err: any) {
    console.error("[Google TTS] Error:", err.message);
    return null;
  }
}

/**
 * Map an agent name to a distinct Google Neural2 voice.
 * Neural2 voices are the highest quality tier on Google Cloud TTS.
 */
export function getGoogleAgentVoice(agentName: string): string {
  const voiceMap: Record<string, string> = {
    SMIRK:  "en-US-Neural2-C",  // warm, natural female — ideal receptionist
    FORGE:  "en-US-Neural2-D",  // deep, authoritative male
    GRIT:   "en-US-Neural2-J",  // confident, direct male
    LEX:    "en-US-Neural2-I",  // measured, professional male
    VELVET: "en-US-Neural2-F",  // soft, warm female — concierge
    LEDGER: "en-US-Neural2-E",  // neutral, precise female
    HAVEN:  "en-US-Neural2-G",  // friendly, approachable female
    ATLAS:  "en-US-Neural2-A",  // neutral, general purpose male
    ECHO:   "en-US-Neural2-H",  // bright, energetic female
  };
  return voiceMap[agentName.toUpperCase()] || "en-US-Neural2-C";
}

export function isGoogleTTSConfigured(): boolean {
  return !!(
    process.env.GOOGLE_TTS_API_KEY ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS ||
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON
  );
}
