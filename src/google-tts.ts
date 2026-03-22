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
  apiKey?: string;            // Simple API key (preferred for Railway)
  serviceAccountJson?: string; // Raw service account JSON (for TTS auth)
  voice: string;              // e.g. "en-US-Neural2-C"
  languageCode: string;       // e.g. "en-US"
  speakingRate: number;       // 0.25–4.0, default 1.0
  pitch: number;              // -20.0–20.0 semitones, default 0.0
};

let _client: textToSpeech.TextToSpeechClient | null = null;
let _clientError: string | null = null;

function getClient(config: GoogleTTSConfig): textToSpeech.TextToSpeechClient {
  if (_clientError) throw new Error(_clientError);
  if (!_client) {
    try {
      if (config.apiKey) {
        // API key auth — simplest for Railway deployments
        _client = new textToSpeech.TextToSpeechClient({
          apiKey: config.apiKey,
        });
      } else if (config.serviceAccountJson) {
        // Explicit service account JSON — parse and use credentials
        const creds = JSON.parse(config.serviceAccountJson);
        _client = new textToSpeech.TextToSpeechClient({
          credentials: {
            client_email: creds.client_email,
            private_key: creds.private_key,
          },
          projectId: creds.project_id,
        });
      } else {
        // No credentials configured — fail gracefully, do not use ADC
        _clientError = "Google TTS: no credentials configured (set GOOGLE_TTS_API_KEY)";
        throw new Error(_clientError);
      }
    } catch (err: any) {
      if (!_clientError) _clientError = err.message;
      throw err;
    }
  }
  return _client!;
}

export function loadGoogleTTSConfig(): GoogleTTSConfig | null {
  const apiKey = process.env.GOOGLE_TTS_API_KEY;

  // Only use GOOGLE_SERVICE_ACCOUNT_JSON for TTS if it is valid JSON
  // containing a service account (not a Calendar-only credential).
  // This prevents the TTS module from activating when the env var is set
  // only for Calendar, which would cause an ADC crash.
  let serviceAccountJson: string | undefined;
  const rawSa = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (rawSa) {
    try {
      // Support base64-encoded JSON
      const decoded = Buffer.from(rawSa, 'base64').toString('utf8');
      const parsed = JSON.parse(decoded);
      if (parsed.type === 'service_account' && parsed.private_key) {
        serviceAccountJson = decoded;
      }
    } catch {
      try {
        const parsed = JSON.parse(rawSa);
        if (parsed.type === 'service_account' && parsed.private_key) {
          serviceAccountJson = rawSa;
        }
      } catch { /* not valid JSON — ignore */ }
    }
  }

  // Require at least one explicit auth method — never fall through to ADC
  if (!apiKey && !serviceAccountJson) return null;

  return {
    apiKey,
    serviceAccountJson,
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
  return !!loadGoogleTTSConfig();
}
