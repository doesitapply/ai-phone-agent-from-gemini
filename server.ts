import express from "express";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI } from "@google/genai";
import twilio from "twilio";
import cors from "cors";

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());

// In-memory store for call histories
const callHistories: Record<string, { role: string; text: string }[]> = {};

// Helper to get Gemini client
const getAi = () => new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// API: Make outbound call
app.post("/api/calls", async (req, res) => {
  const { to } = req.body;
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_PHONE_NUMBER;
  const appUrl = process.env.APP_URL ? process.env.APP_URL.replace("ais-dev-", "ais-pre-") : "";

  if (!accountSid || !authToken || !from) {
    return res.status(400).json({ error: "Twilio credentials not configured. Please check your AI Studio Secrets." });
  }

  if (!appUrl) {
    return res.status(400).json({ error: "APP_URL is missing. The app cannot receive webhooks." });
  }

  try {
    const client = twilio(accountSid, authToken);
    const call = await client.calls.create({
      url: `${appUrl}/api/twilio/incoming`,
      to,
      from,
    });
    res.json({ success: true, callSid: call.sid });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Twilio Webhook: Incoming Call (or Outbound Call Connected)
app.post("/api/twilio/incoming", (req, res) => {
  const callSid = req.body.CallSid;
  callHistories[callSid] = []; // Initialize history

  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say("Hello! I am your AI assistant. How can I help you today?");
  twiml.gather({
    input: ["speech"],
    action: "/api/twilio/process",
    speechTimeout: "auto",
  });

  res.type("text/xml");
  res.send(twiml.toString());
});

// Twilio Webhook: Process Speech
app.post("/api/twilio/process", async (req, res) => {
  const callSid = req.body.CallSid;
  const userSpeech = req.body.SpeechResult;
  const twiml = new twilio.twiml.VoiceResponse();

  if (!userSpeech) {
    twiml.say("I did not catch that. Could you please repeat?");
    twiml.gather({
      input: ["speech"],
      action: "/api/twilio/process",
      speechTimeout: "auto",
    });
    res.type("text/xml");
    return res.send(twiml.toString());
  }

  if (!callHistories[callSid]) {
    callHistories[callSid] = [];
  }

  callHistories[callSid].push({ role: "user", text: userSpeech });

  try {
    const ai = getAi();
    const historyText = callHistories[callSid]
      .map((msg) => `${msg.role}: ${msg.text}`)
      .join("\n");
    
    const prompt = `You are a helpful AI assistant on a phone call. Keep your answers concise, conversational, and easy to understand when spoken aloud. Do not use markdown or special formatting.
    
Conversation history:
${historyText}

assistant:`;

    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: prompt,
    });

    const aiText = response.text || "I'm sorry, I encountered an error.";
    callHistories[callSid].push({ role: "assistant", text: aiText });

    twiml.say(aiText);
    twiml.gather({
      input: ["speech"],
      action: "/api/twilio/process",
      speechTimeout: "auto",
    });
  } catch (error) {
    console.error("AI Error:", error);
    twiml.say("Sorry, my brain is currently experiencing technical difficulties. Please try again later.");
  }

  res.type("text/xml");
  res.send(twiml.toString());
});

// API: Get call logs
app.get("/api/logs", (req, res) => {
  res.json(callHistories);
});

// Vite middleware setup
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static("dist"));
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
