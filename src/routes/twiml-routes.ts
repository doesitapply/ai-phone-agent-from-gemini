import type { Express, Request, Response } from "express";
import twilio from "twilio";

type TwimlRouteDeps = {
  sql: any;
  dbEnabled: boolean;
};

export function registerTwimlRoutes(app: Express, deps: TwimlRouteDeps): void {
  const { sql, dbEnabled } = deps;

  app.get("/api/twiml/appointment-confirm", (req: Request, res: Response) => {
    const { service, time, apptId } = req.query as Record<string, string>;
    const twiml = new twilio.twiml.VoiceResponse();
    const gather = twiml.gather({
      numDigits: 1,
      action: `/api/twiml/appointment-confirm-response?apptId=${apptId || ""}`,
      method: "POST",
      timeout: 8,
    });
    gather.say(
      { voice: "Polly.Joanna" },
      `Hi, this is SMIRK calling about your requested ${service || "follow-up"} time for ${time || "tomorrow"}. ` +
      `Press 1 if this time still works, press 2 if you need a different callback window, or press 3 if no follow-up is needed.`
    );
    twiml.say({ voice: "Polly.Joanna" }, "We didn't receive your response. We'll follow up with you shortly. Goodbye.");
    twiml.hangup();
    res.type("text/xml").send(twiml.toString());
  });

  app.post("/api/twiml/appointment-confirm-response", async (req: Request, res: Response) => {
    const { Digits } = req.body as Record<string, string>;
    const { apptId } = req.query as Record<string, string>;
    const twiml = new twilio.twiml.VoiceResponse();
    if (Digits === "1") {
      twiml.say({ voice: "Polly.Joanna" }, "Great, we marked that this follow-up time still works. Goodbye!");
      if (apptId && dbEnabled) {
        await sql`UPDATE appointments SET status = 'confirmed' WHERE id = ${parseInt(apptId)}`.catch(() => {});
      }
    } else if (Digits === "2") {
      twiml.say({ voice: "Polly.Joanna" }, "No problem. Someone will reach out to find a new time that works for you. Goodbye!");
      if (apptId && dbEnabled) {
        await sql`UPDATE appointments SET status = 'reschedule_requested' WHERE id = ${parseInt(apptId)}`.catch(() => {});
      }
    } else if (Digits === "3") {
      twiml.say({ voice: "Polly.Joanna" }, "Understood. We marked that no follow-up is needed. If that changes, just call back. Goodbye!");
      if (apptId && dbEnabled) {
        await sql`UPDATE appointments SET status = 'cancelled' WHERE id = ${parseInt(apptId)}`.catch(() => {});
      }
    } else {
      twiml.say({ voice: "Polly.Joanna" }, "We didn't catch that. Someone will follow up with you. Goodbye!");
    }
    twiml.hangup();
    res.type("text/xml").send(twiml.toString());
  });

  app.get("/api/twiml/inline", (req: Request, res: Response) => {
    const xml = req.query.xml as string;
    if (!xml) return res.status(400).send("<Response><Say>No message configured.</Say></Response>");
    res.set("Content-Type", "text/xml");
    res.send(xml);
  });
}
