import type { Express, Request, RequestHandler, Response } from "express";
import twilio from "twilio";

type TwilioOpsRouteDeps = {
  dashboardAuth: RequestHandler;
  requireOperator: RequestHandler;
  env: {
    TWILIO_PHONE_NUMBER?: string;
    GEMINI_API_KEY?: string;
  };
  getTwilioClient: () => any;
  getAppUrl: () => string;
  getActiveAgent: () => Promise<any>;
  resolveContact: (phone: string) => Promise<{ contact: any; isNew: boolean }>;
  buildCallerContext: (contact: any, isNew: boolean) => string;
  generateAiResponse: (
    callSid: string,
    speechText: string,
    requestId: string,
    callerContext: string,
    systemPrompt: string,
    dispatchCtx: any,
    geminiApiKey?: string,
    turnCount?: number,
    callerPhone?: string,
  ) => Promise<{ text: string; latencyMs: number; source?: string }>;
  buildTwimlSay: (
    node: { play: (url: string) => any; say: (opts: any, text?: string) => any },
    text: string,
    voice: string,
    agentName?: string,
  ) => Promise<void>;
  logEvent: (callSid: string, eventType: string, payload?: Record<string, unknown>) => void;
  log: (level: "info" | "warn" | "error" | "debug", message: string, meta?: Record<string, unknown>) => void;
};

export function registerTwilioOpsRoutes(app: Express, deps: TwilioOpsRouteDeps): void {
  const {
    dashboardAuth,
    requireOperator,
    env,
    getTwilioClient,
    getAppUrl,
    getActiveAgent,
    resolveContact,
    buildCallerContext,
    generateAiResponse,
    buildTwimlSay,
    logEvent,
    log,
  } = deps;

  app.post("/api/twilio/amd", async (req: Request, res: Response) => {
    const { CallSid, AnsweredBy } = req.body;
    log("info", "AMD result", { callSid: CallSid, answeredBy: AnsweredBy });
    logEvent(CallSid, "AMD_RESULT", { answeredBy: AnsweredBy });
    if (["machine_start", "machine_end_beep", "machine_end_silence"].includes(AnsweredBy)) {
      try {
        const client = getTwilioClient();
        const agentValue = await getActiveAgent();
        const bizName = agentValue?.name?.replace(" Agent", "") || "our office";
        const vmAudioUrl = `${getAppUrl()}/public/voicemail-drop.mp3`;
        await client.calls(CallSid).update({
          twiml: `<Response><Play>${vmAudioUrl}</Play><Hangup/></Response>`,
        });
        logEvent(CallSid, "VOICEMAIL_DROP_SENT", { bizName, answeredBy: AnsweredBy });
        log("info", "Voicemail drop sent", { callSid: CallSid, answeredBy: AnsweredBy });
      } catch (err: any) {
        log("warn", "Voicemail drop failed", { callSid: CallSid, error: err.message });
      }
    }
    res.sendStatus(200);
  });

  app.post("/api/twilio/test-webhook", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    const testCallSid = `TEST-${Date.now()}`;
    const testFrom = req.body.from || "+15550000001";
    const testTo = env.TWILIO_PHONE_NUMBER || "+15550000000";
    const fakeSpeech = req.body.speech || "Hello, is anyone there?";
    const results: Record<string, any> = {};

    try {
      const agentValue = await getActiveAgent();
      const { contact, isNew } = await resolveContact(testFrom);
      results.step1_caller_resolved = { contactId: contact.id, isNew, agentName: agentValue?.name || "(none)" };

      const systemPrompt = agentValue?.system_prompt || "You are a helpful AI assistant on a phone call.";
      const callerContext = buildCallerContext(contact, isNew);
      const dispatchCtx = { callSid: testCallSid, contactId: contact.id, callerPhone: testFrom, fromPhone: testTo, twilioClient: null, appUrl: getAppUrl() };

      const { text: aiText, latencyMs, source } = await generateAiResponse(
        testCallSid, fakeSpeech, "test", callerContext, systemPrompt,
        dispatchCtx, env.GEMINI_API_KEY, 1, testFrom
      );
      results.step2_ai_response = { text: aiText.slice(0, 200), latencyMs, source };

      const twiml = new twilio.twiml.VoiceResponse();
      await buildTwimlSay(twiml, aiText, agentValue?.voice || "Polly.Matthew-Neural");
      twiml.gather({ input: ["speech"], action: "/api/twilio/process", speechTimeout: 2 as any });
      results.step3_twiml = { valid: true, length: twiml.toString().length };

      results.overall = "PASS — all systems operational";
      res.json({ success: true, testCallSid, results });
    } catch (err: any) {
      results.error = err.message;
      results.overall = "FAIL";
      res.status(500).json({ success: false, testCallSid, results });
    }
  });

  app.post("/api/twilio/test-call", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    try {
      const to = String(req.body?.to || "").trim();
      if (!to) return res.status(400).json({ ok: false, error: "Missing 'to'" });
      const twilioClient = getTwilioClient();
      if (!twilioClient) return res.status(400).json({ ok: false, error: "Twilio not configured" });
      if (!env.TWILIO_PHONE_NUMBER) return res.status(400).json({ ok: false, error: "Missing TWILIO_PHONE_NUMBER" });

      const allow = String(process.env.COMPLIANCE_ALWAYS_ALLOW_NUMBERS || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (allow.length > 0 && !allow.includes(to)) {
        return res.status(403).json({ ok: false, error: "Test call target is not allowlisted (COMPLIANCE_ALWAYS_ALLOW_NUMBERS)" });
      }

      const twiml = new twilio.twiml.VoiceResponse();
      twiml.say({ voice: "Polly.Matthew-Neural" as any }, "This is a test call from your missed-call recovery assistant. If you hear this, your Twilio outbound calling is working.");
      twiml.hangup();

      const call = await twilioClient.calls.create({
        to,
        from: env.TWILIO_PHONE_NUMBER,
        twiml: twiml.toString(),
      });

      return res.json({ ok: true, sid: call.sid });
    } catch (e: any) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });
}
