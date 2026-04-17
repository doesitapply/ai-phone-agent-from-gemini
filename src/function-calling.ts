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
  addNote,
  lookupContact,
  setCallback,
  qualifyLead,
  checkAvailability,
  collectPaymentInfo,
  listOpenTasks,
  completeTask,
  updateTask,
  cancelTask,
  acknowledgeHandoff,
  routeCall,
  type ToolResult,
} from "./tools.js";

// ── Gemini Tool Declarations ──────────────────────────────────────────────────
// These are the function signatures Gemini sees. They must be precise — Gemini
// will choose which one to call (or none) based on the conversation.

export const TOOL_DECLARATIONS = [
  {
    name: "create_lead",
    description:
      "Capture the caller's information as a lead. Use as soon as you have their name AND the service they need (HVAC, plumbing, roofing, electrical, etc.). Do not wait until the end of the call — capture it early so the info is saved even if the call drops.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        name: { type: Type.STRING, description: "Caller's full name" },
        email: { type: Type.STRING, description: "Caller's email address if provided" },
        service_type: { type: Type.STRING, description: "Type of home service needed (e.g. 'HVAC repair', 'plumbing leak', 'roof inspection', 'electrical panel')" },
        notes: { type: Type.STRING, description: "Urgency level, problem description, or any other relevant details" },
      },
      required: ["name", "service_type"],
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
      "Book a service appointment for the caller. Use after you have confirmed: (1) the service type, (2) the preferred day, and (3) the time window (morning 8am-12pm, afternoon 12pm-5pm, or evening 5pm-8pm). Always confirm the booking out loud before calling this tool.",
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
      "Send an SMS confirmation to the caller. Use immediately after booking an appointment if the caller says yes to a text confirmation. The message should include the service type, day, time window, and a note that someone will call to confirm. Keep it under 160 characters.",
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
      "Transfer the caller to a human team member. ONLY use when: (1) the caller explicitly says they want to speak to a human, person, or representative, OR (2) you have failed to help the caller twice in a row. Do NOT use for confusion, slow responses, complex questions, or any other reason. SMIRK handles everything else.",
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
  {
    name: "add_note",
    description:
      "Add a free-form note to the caller's contact record. Use to capture any important information the caller shares that doesn't fit another tool.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        note: { type: Type.STRING, description: "The note to save" },
        category: { type: Type.STRING, description: "Category: 'general', 'preference', 'complaint', 'opportunity', 'follow_up'" },
      },
      required: ["note"],
    },
  },
  {
    name: "lookup_contact",
    description:
      "Look up information about the current caller from the CRM. ALWAYS call this at the start of every call before responding. If the caller is recognized, use their name and reference their history. Do not ask for information you already have.",
    parameters: {
      type: Type.OBJECT,
      properties: {},
      required: [],
    },
  },
  {
    name: "set_callback",
    description:
      "Schedule a callback or take a message. Use when: (a) the caller cannot book now but wants a follow-up call, (b) you cannot fully resolve the issue and need a human to call back, or (c) the caller wants to be contacted at a specific time. This is a valid resolution state — always better than ending the call without a committed next step. After creating a callback, confirm the expected time out loud.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        callback_at: { type: Type.STRING, description: "Preferred callback date/time in ISO 8601 format, if specified" },
        reason: { type: Type.STRING, description: "Why the callback is needed" },
        notes: { type: Type.STRING, description: "Any additional context for the callback" },
      },
      required: [],
    },
  },
  {
    name: "qualify_lead",
    description:
      "Mark the caller as a qualified or disqualified lead based on the conversation. Use after gathering enough information to assess fit.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        qualified: { type: Type.BOOLEAN, description: "True if the lead is qualified, false if disqualified" },
        score: { type: Type.NUMBER, description: "Lead score from 1-10" },
        reason: { type: Type.STRING, description: "Brief reason for the qualification decision" },
        budget: { type: Type.STRING, description: "Budget range if mentioned" },
        timeline: { type: Type.STRING, description: "Purchase/decision timeline if mentioned" },
        decision_maker: { type: Type.BOOLEAN, description: "Whether the caller is the decision maker" },
      },
      required: ["qualified"],
    },
  },
  {
    name: "check_availability",
    description:
      "Check scheduling availability for a service or appointment. Queries both Google Calendar (if configured) and SMIRK's internal appointment database to check for conflicts. Use when the caller asks about available times, wants to know if a specific date/time is open, or wants to book an appointment.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        date: { type: Type.STRING, description: "Requested date in ISO 8601 format" },
        service_type: { type: Type.STRING, description: "Type of service or appointment" },
      },
      required: [],
    },
  },
  {
    name: "collect_payment_info",
    description:
      "Capture payment intent or billing information. Use when the caller wants to make a payment, pay a balance, or discuss billing. Never ask for full card numbers.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        amount: { type: Type.NUMBER, description: "Payment amount" },
        currency: { type: Type.STRING, description: "Currency code (e.g. USD)" },
        description: { type: Type.STRING, description: "What the payment is for" },
        payment_method: { type: Type.STRING, description: "Preferred payment method if mentioned" },
      },
      required: [],
    },
  },
  {
    name: "list_open_tasks",
    description: "List open tasks for the current caller. Call this proactively at call start if lookup_contact returns a record with open tasks. Also use when the caller mentions a previous issue, callback, or follow-up. Do not wait to be asked.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        status: { type: Type.STRING, description: "Task status to filter by: 'open', 'in_progress', 'completed', 'cancelled'. Defaults to 'open'." },
      },
      required: [],
    },
  },
  {
    name: "complete_task",
    description: "Mark a task as completed. Use when: (1) the caller confirms an issue is resolved, (2) you successfully book an appointment that replaces a callback task, (3) you transfer the caller and the task is now owned by the human, or (4) the reason for the task no longer exists. Always complete stale tasks after successful outcomes.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        task_id: { type: Type.NUMBER, description: "The numeric ID of the task to complete" },
        resolution_notes: { type: Type.STRING, description: "Optional notes about how the task was resolved" },
      },
      required: ["task_id"],
    },
  },
  {
    name: "update_task",
    description: "Update a task's status, notes, assignee, or due date.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        task_id: { type: Type.NUMBER, description: "The numeric ID of the task to update" },
        status: { type: Type.STRING, description: "New status: 'open', 'in_progress', 'completed', 'cancelled'" },
        notes: { type: Type.STRING, description: "Updated notes for the task" },
        assigned_to: { type: Type.STRING, description: "Name of person to assign the task to" },
        due_at: { type: Type.STRING, description: "New due date in ISO 8601 format" },
      },
      required: ["task_id"],
    },
  },
  {
    name: "cancel_task",
    description: "Cancel an open task. Use when: (1) the caller says a follow-up is no longer needed, (2) the task is superseded by a new booking or resolution, or (3) the task is a duplicate. Always clean up redundant tasks before ending a call.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        task_id: { type: Type.NUMBER, description: "The numeric ID of the task to cancel" },
        reason: { type: Type.STRING, description: "Reason for cancellation" },
      },
      required: ["task_id"],
    },
  },
  {
    name: "acknowledge_handoff",
    description: "Acknowledge a pending handoff record. Use when a human has resolved a previous handoff and the caller is calling back to confirm or continue. Closes the handoff loop so the record is not left open indefinitely.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        handoff_id: { type: Type.NUMBER, description: "The numeric ID of the handoff to acknowledge" },
        notes: { type: Type.STRING, description: "Optional notes about the handoff resolution" },
      },
      required: ["handoff_id"],
    },
  },
  {
    name: "route_call",
    description: "Analyze the call and decide the best routing action. Use this whenever: the request is ambiguous, the caller is frustrated or angry, the topic is billing/legal/emergency, the issue is beyond your authority, or you are unsure how to proceed. Do not guess — route. The result will tell you exactly what to do next and you must follow it.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        topic: { type: Type.STRING, description: "What the call is about" },
        urgency: { type: Type.STRING, description: "Urgency level: 'low', 'normal', 'high', or 'emergency'" },
        caller_intent: { type: Type.STRING, description: "What the caller wants to accomplish" },
        complexity: { type: Type.STRING, description: "Complexity: 'simple', 'moderate', or 'complex'" },
        sentiment: { type: Type.STRING, description: "Caller sentiment: 'positive', 'neutral', 'frustrated', or 'angry'" },
        preferred_outcome: { type: Type.STRING, description: "What the AI recommends as the best outcome" },
      },
      required: ["topic", "urgency", "caller_intent", "complexity"],
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
      const recentMessages = (await db
        .prepare("SELECT role, text FROM messages WHERE call_sid = ? AND role != 'system' ORDER BY id DESC LIMIT 6")
        .all(callSid)) as unknown as { role: string; text: string }[];
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

    case "add_note":
      return addNote(callSid, contactId, args as any);
    case "lookup_contact":
      return lookupContact(callSid, contactId);
    case "set_callback":
      return setCallback(callSid, contactId, args as any);
    case "qualify_lead":
      return qualifyLead(callSid, contactId, args as any);
    case "check_availability":
      return checkAvailability(callSid, contactId, args as any);
    case "collect_payment_info":
      return collectPaymentInfo(callSid, contactId, args as any);

    case "list_open_tasks":
      return listOpenTasks(callSid, contactId, args as any);
    case "complete_task":
      return completeTask(callSid, contactId, args as any);
    case "update_task":
      return updateTask(callSid, contactId, args as any);
    case "cancel_task":
      return cancelTask(callSid, contactId, args as any);
    case "acknowledge_handoff":
      return acknowledgeHandoff(callSid, contactId, args as any);
    case "route_call":
      return routeCall(callSid, contactId, args as any);
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
  transferPhone?: string | null; // phone number to bridge to on escalation
  transferName?: string | null;  // team member name for logging
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
  let transferPhone: string | null = null;
  let transferName: string | null = null;

  // Build conversation history (exclude system context messages)
  const history = (await db
    .prepare("SELECT role, text FROM messages WHERE call_sid = ? AND role != 'system' ORDER BY id ASC")
    .all(callSid)) as unknown as { role: string; text: string }[];

  const historyText = history
    .map((m) => `${m.role === "user" ? "Caller" : "Assistant"}: ${m.text}`)
    .join("\n");

  // System instruction: combines agent prompt + caller context
  const systemInstruction = [
    systemPrompt,
    callerContext || "",
    "",
    "TOOL USAGE RULES:",
    "- Do not wait to be asked. Use tools proactively when the situation calls for it.",
    "- CALL START: If the caller is recognized, call lookup_contact immediately. If they have open tasks, call list_open_tasks and acknowledge relevant ones.",
    "- BOOKING: Always call check_availability before confirming a time. Never invent open slots.",
    "- TASK CLEANUP: After a successful booking, transfer, or resolution — check if any existing open task for this caller should be completed or cancelled. If yes, do it.",
    "- ROUTING: Call route_call when the request is urgent, ambiguous, emotionally charged, or beyond your authority. Follow the result.",
    "- END OF CALL: Before hanging up, verify the call ended in a clean state: booked, transferred, task created/updated, callback scheduled, or issue resolved. If none of these are true, do not end the call yet.",
    "- After any tool succeeds, confirm the outcome to the caller in one natural sentence.",
    "- After booking, offer SMS confirmation.",
    "- After transfer, say you are connecting them and say goodbye.",
    "- After do-not-call, say goodbye and end the call.",
    "- Never call the same tool twice in one turn.",
    "- Keep all spoken responses concise and natural for phone. No bullet points, no markdown.",
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
      model: process.env.GEMINI_MODEL || "gemini-1.5-flash-latest",
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
        if (name === "escalate_to_human" && result.data) {
          transferPhone = (result.data as any).transfer_phone ?? null;
          transferName = (result.data as any).transfer_name ?? null;
        }
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

  return { text: finalText, latencyMs, toolsInvoked, shouldHangUp, transferPhone, transferName };
};
