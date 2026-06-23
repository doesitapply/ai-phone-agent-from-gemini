import type { Express, NextFunction, Request, RequestHandler, Response } from "express";
import twilio from "twilio";
import type { ElevenLabsConfig } from "../elevenlabs.js";

type DebugRouteDeps = {
  dashboardAuth: RequestHandler;
  requireOperator: (req: Request, res: Response, next: NextFunction) => void;
  getElevenLabsConfig: () => ElevenLabsConfig | null;
  buildTwimlSay: (
    node: { play: (url: string) => any; say: (opts: any, text?: string) => any },
    text: string,
    voice: string,
    agentName?: string,
  ) => Promise<void>;
};

export function registerDebugRoutes(app: Express, deps: DebugRouteDeps): void {
  const { dashboardAuth, requireOperator, getElevenLabsConfig, buildTwimlSay } = deps;

  app.post("/api/debug/tts", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    const text = (req.body as any)?.text || "Hello, this is a test of the voice system.";
    const twiml = new twilio.twiml.VoiceResponse();
    const errors: string[] = [];
    const origElevenLabs = getElevenLabsConfig();
    try {
      if (!origElevenLabs) {
        errors.push("elevenLabsConfig is NULL — key not loaded");
      } else {
        errors.push(`elevenLabsConfig loaded: voiceId=${origElevenLabs.voiceId} modelId=${origElevenLabs.modelId} keyConfigured=true`);
        try {
          const { generateSpeech: gs } = await import("../elevenlabs.js");
          const buf = await gs(text, origElevenLabs, "SMIRK");
          if (buf) {
            errors.push(`✅ ElevenLabs TTS SUCCESS — ${buf.length} bytes`);
          } else {
            errors.push("❌ ElevenLabs returned null buffer");
          }
        } catch (e: any) {
          errors.push(`❌ ElevenLabs threw: ${e.message}`);
        }
      }
      await buildTwimlSay(twiml, text, "Polly.Matthew-Neural", "SMIRK");
      res.json({ twiml: twiml.toString(), diagnostics: errors });
    } catch (e: any) {
      res.json({ error: e.message, diagnostics: errors });
    }
  });
}
