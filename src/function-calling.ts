/**
 * Live Tool Invocation Engine
 *
 * Wires Gemini's native function-calling API into the real-time call loop.
 *
 * Flow per turn:
 * 1. Build prompt with conversation history + caller context
 * 2. Send to Gemini with tool declarations
 * 3. If Gemini returns a function call → dispatch to the right tool
 * 4. Feed tool result back to Gemini as a function response
 * 5. Get final text response → speak to caller
 *
 * This means the AI can now:
 * - Book/reschedule/cancel appointments DURING the call
 * - Create leads and update contacts in real time
 * - Send SMS confirmations before the call ends
 * - Escalate to a human with full context attached
 * - Mark DNC immediately when requested
 */
import { GoogleGenAI, Type, FunctionCallingConfigMode } from "@google/genai";
import twilio from "twilio";
import { db } from "./db.js";
import { logEvent } from "./events.js";
import {
  createLead,
  updateContact,
  bookAppointment,
  rescheduleAppointment,
  cancelAppointment,
  sendSmsFollowup,
  escalateToHuman,
  createSupportTicket,
  markDoNotCallTool,
  type ToolResult,
} from "./tools.js";

// ── Gemini Tool Declarations ──────────────────────────────────────────────────
// These are the function signatures Gemini sees. They must be precise — Gemini
// will choose which one to call (or none) based on the conversation.

export const TOOL_DECLARATIONS = [
  {
    name: "create_lead",
    description:
      "Capture a caller's information as a lead when they express interest in a service, product, or want to be contacted. Use when the caller wants to learn more, get a quote, or be followed up with.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        name: { type: Type.STRING, description: "Caller's full name if provided" },
        email: { type: Type.STRING, description: "Caller's email address if provided" },
        service_type: { type: Type.STRING, description: "Type of service or product they are interested in" },
        notes: { type: Type.STRING, description: "Any additional details about their needs or situation" },
      },
      required: [],
    },
  },
  {
    name: "update_contact",
    description:
      "Update the caller's contact information during the call when they provide their name, email, or other details.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        name: { type: Type.STRING, description: "Caller's full name" },
        email: { type: Type.STRING, description: "Caller's email address" },
        notes: { type: Type.STRING, description: "Any notes to add to their contact record" },
      },
      required: [],
    },
  },
  {
    name: "book_appointment",
    description:
      "Book a new appointment for the caller. Use when the caller wants to schedule a service, consultation, visit, or any time-based booking.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        service_type: {
          type: Type.STRING,
          description: "Type of service or appointment (e.g. 'HVAC inspection', 'consultation', 'oil change')",
        },
        scheduled_at: {
          type: Type.STRING,
          description: "Date and time of the appointment in ISO 8601 format (e.g. '2026-03-15T10:00:00'). If the caller gives a relative time like 'tomorrow at 2pm', convert it to an absolute datetime.",
        },
        duration_minutes: {
          type: Type.NUMBER,
          description: "Expected duration in minutes. Default to 60 if not specified.",
        },
        location: { type: Type.STRING, description: "Location or address for the appointment if provided" },
        technician: { type: Type.STRING, description: "Preferred technician or staff member if mentioned" },
        notes: { type: Type.STRING, description: "Any special instructions or notes for the appointment" },
      },
      required: ["service_type", "scheduled_at"],
    },
  },
  {
    name: "reschedule_appointment",
    description:
      "Reschedule an existing appointment to a new date and time. Use when the caller wants to change the time of an existing booking.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        new_scheduled_at: {
          type: Type.STRING,
          description: "New date and time in ISO 8601 format (e.g. '2026-03-20T14:00:00')",
        },
        reason: { type: Type.STRING, description: "Reason for rescheduling if provided" },
      },
      required: ["new_scheduled_at"],
    },
  },
  {
    name: "cancel_appointment",
    description:
      "Cancel an existing appointment. Use when the caller explicitly wants to cancel a scheduled booking.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        reason: { type: Type.STRING, description: "Reason for cancellation if provided" },
      },
      required: [],
    },
  },
  {
    name: "send_sms_confirmation",
    description:
      "Send an SMS text message to the caller with confirmation details, a summary, or a follow-up message. Use after booking or rescheduling an appointment, or when the caller asks for a text confirmation.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        message: {
          type: Type.STRING,
          description: "The SMS message to send. Keep it concise and include the key details (e.g. appointment time, address, next steps).",
        },
      },
      required: ["message"],
    },
  },
  {
    name: "escalate_to_human",
    description:
      "Transfer the caller to a human team member. Use when: the caller explicitly asks for a human, the issue is too complex, there is an emergency, the caller is frustrated, or you cannot resolve the issue.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        reason: {
          type: Type.STRING,
          description: "Clear reason why escalation is needed (e.g. 'Caller requested human agent', 'Complex billing dispute', 'Emergency situation')",
        },
        urgency: {
          type: Type.STRING,
          description: "Urgency level: 'low', 'normal', 'high', or 'emergency'",
        },
        recommended_action: {
          type: Type.STRING,
          description: "What the human agent should do when they pick up (e.g. 'Review billing history for past 3 months', 'Dispatch emergency technician')",
        },
      },
      required: ["reason"],
    },
  },
  {
    name: "create_support_ticket",
    description:
      "Create a support ticket for an issue that cannot be resolved immediately. Use for technical problems, complaints, or issues that require follow-up investigation.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        issue: { type: Type.STRING, description: "Brief description of the issue" },
        priority: {
          type: Type.STRING,
          description: "Priority level: 'low', 'normal', or 'high'",
        },
        details: { type: Type.STRING, description: "Additional details about the issue" },
      },
      required: ["issue"],
    },
  },
  {
    name: "mark_do_not_call",
    description:
      "Add the caller to the do-not-call list. Use ONLY when the caller explicitly requests to be removed from call lists or says they do not want to be contacted again.",
    parameters: {
      type: Type.OBJECT,
      properties: {},
      required: [],
    },
  },
];

// ── Tool Dispatcher ───────────────────────────────────────────────────────────
// Maps function names from Gemini to the actual tool implementations.

export type ToolDispatchContext = {
  callSid: string;
  contactId: number;
  callerPhone: string;
  fromPhone: string; // Twilio number to send SMS from
  twilioClient: twilio.Twilio | null;
};

export const dispatchTool = async (
  functionName: string,
  args: Record<string, unknown>,
  ctx: ToolDispatchContext
): Promise<ToolResult> => {
  const { callSid, contactId, callerPhone, fromPhone, twilioClient } = ctx;

  logEvent(callSid, "TOOL_EXECUTED", { tool: functionName, args });

  switch (functionName) {
    case "create_lead":
      return createLead(callSid, contactId, args as any);

    case "update_contact":
      return updateContact(callSid, contactId, args as any);

    case "book_appointment":
      return await bookAppointment(callSid, contactId, args as any);

    case "reschedule_appointment":
      return rescheduleAppointment(callSid, contactId, args as any);

    case "cancel_appointment":
      return cancelAppointment(callSid, contactId, args as any);

    case "send_sms_confirmation":
      if (!twilioClient) {
        return { success: false, message: "SMS is not configured right now.", error: "No Twilio client" };
      }
      return sendSmsFollowup(
        callSid,
        contactId,
        callerPhone,
        fromPhone,
        (args.message as string) || "Thank you for calling. Have a great day!",
        twilioClient
      );

    case "escalate_to_human": {
      // Grab the last 3 turns as a transcript snippet for context
      const recentMessages = db
        .prepare("SELECT role, text FROM messages WHERE call_sid = ? AND role != 'system' ORDER BY id DESC LIMIT 6")
        .all(callSid) as { role: string; text: string }[];
      const snippet = recentMessages
        .reverse()
        .map((m) => `${m.role === "user" ? "Caller" : "Agent"}: ${m.text}`)
        .join("\n");

      return escalateToHuman(callSid, contactId, {
        reason: (args.reason as string) || "Caller requested human agent",
        urgency: (args.urgency as any) || "normal",
        transcript_snippet: snippet,
        recommended_action: (args.recommended_action as string) || undefined,
      });
    }

    case "create_support_ticket":
      return createSupportTicket(callSid, contactId, args as any);

    case "mark_do_not_call":
      return markDoNotCallTool(callSid, contactId);

    default:
      return {
        success: false,
        message: "I'm sorry, I wasn't able to complete that action.",
        error: `Unknown function: ${functionName}`,
      };
  }
};

// ── Main: Generate AI Response with Live Tool Invocation ─────────────────────

export type AiTurnResult = {
  text: string;
  latencyMs: number;
  toolsInvoked: string[];
  shouldHangUp: boolean; // true after DNC or escalation
};

const MAX_TOOL_ROUNDS = 5; // Prevent infinite tool-call loops

export const generateAiResponseWithTools = async (
  callSid: string,
  userSpeech: string,
  requestId: string,
  callerContext: string,
  systemPrompt: string,
  dispatchCtx: ToolDispatchContext,
  apiKey: string
): Promise<AiTurnResult> => {
  const aiStart = Date.now();
  const toolsInvoked: string[] = [];
  let shouldHangUp = false;

  // Build conversation history (exclude system context messages)
  const history = db
    .prepare("SELECT role, text FROM messages WHERE call_sid = ? AND role != 'system' ORDER BY id ASC")
    .all(callSid) as { role: string; text: string }[];

  const historyText = history
    .map((m) => `${m.role === "user" ? "Caller" : "Assistant"}: ${m.text}`)
    .join("\n");

  // System instruction: combines agent prompt + caller context
  const systemInstruction = [
    systemPrompt,
    callerContext || "",
    "",
    "TOOL USAGE RULES:",
    "- Use tools to take real actions when the caller requests them. Do not just say you will do something — actually call the tool.",
    "- After a tool succeeds, confirm the action to the caller naturally (e.g. 'Great, I have you booked for Tuesday at 2pm.').",
    "- After booking an appointment, offer to send an SMS confirmation if the caller would find it useful.",
    "- After escalating to a human, tell the caller you are connecting them and say goodbye warmly.",
    "- After marking do-not-call, say goodbye and end the call.",
    "- Never call the same tool twice in one turn.",
    "- Keep all spoken responses concise and natural for phone conversation. No bullet points, no markdown.",
  ]
    .filter(Boolean)
    .join("\n");

  // Build the prompt for this turn
  const userMessage = historyText
    ? `Conversation so far:\n${historyText}\n\nCaller: ${userSpeech}`
    : `Caller: ${userSpeech}`;

  const ai = new GoogleGenAI({ apiKey });

  // ── Multi-round function calling loop ─────────────────────────────────────
  // Gemini may return multiple sequential tool calls before giving a final text response.
  let currentContents: any[] = [{ role: "user", parts: [{ text: userMessage }] }];
  let finalText = "";

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await ai.models.generateContent({
      model: "gemini-2.0-flash",
      contents: currentContents,
      config: {
        systemInstruction,
        tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
        toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO } },
        temperature: 0.4,
        maxOutputTokens: 512,
      },
    });

    const candidate = response.candidates?.[0];
    if (!candidate) break;

    const parts = candidate.content?.parts || [];
    const functionCallParts = parts.filter((p: any) => p.functionCall);
    const textParts = parts.filter((p: any) => p.text);

    // If there are no function calls, we have the final text response
    if (functionCallParts.length === 0) {
      finalText = textParts.map((p: any) => p.text).join(" ").trim();
      break;
    }

    // Execute all function calls in this round
    const functionResponseParts: any[] = [];

    for (const part of functionCallParts) {
      const { name, args } = part.functionCall;
      toolsInvoked.push(name);

      // Execute the tool
      const result = await dispatchTool(name, args || {}, dispatchCtx);

      // Flag hang-up scenarios
      if (name === "mark_do_not_call" || (name === "escalate_to_human" && result.success)) {
        shouldHangUp = true;
      }

      functionResponseParts.push({
        functionResponse: {
          name,
          response: {
            success: result.success,
            message: result.message,
            data: result.data || {},
          },
        },
      });
    }

    // Add the model's function call turn and our function responses to the conversation
    currentContents = [
      ...currentContents,
      { role: "model", parts: functionCallParts },
      { role: "user", parts: functionResponseParts },
    ];
  }

  // Fallback if we somehow exited the loop without text
  if (!finalText) {
    finalText = "I've taken care of that for you. Is there anything else I can help you with?";
  }

  const latencyMs = Date.now() - aiStart;

  return { text: finalText, latencyMs, toolsInvoked, shouldHangUp };
};
