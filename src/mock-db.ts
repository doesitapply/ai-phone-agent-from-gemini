import mockData from "./data/mockDbData.json" with { type: "json" };

type MockCall = (typeof mockData.calls)[number];
type MockContact = (typeof mockData.contacts)[number];
type MockTask = (typeof mockData.tasks)[number];

export function getMockWorkspace() {
  return { ...mockData.workspace };
}

export function getMockWorkspaces() {
  return [getMockWorkspace()];
}

export function getMockCalls() {
  return mockData.calls.map((call) => ({ ...call }));
}

export function getMockActiveCalls() {
  return [];
}

export function getMockCall(callSid: string): MockCall | null {
  return mockData.calls.find((call) => call.call_sid === callSid) || null;
}

export function getMockContacts(includeAnonymous = false) {
  const contacts = mockData.contacts.map((contact) => ({ ...contact }));
  return includeAnonymous ? contacts : contacts.filter((contact) => String(contact.name || "").trim());
}

export function getMockContact(contactId: number): MockContact | null {
  return mockData.contacts.find((contact) => Number(contact.id) === Number(contactId)) || null;
}

export function getMockTasks(status = "all") {
  const tasks = mockData.tasks.map((task) => ({ ...task }));
  return status === "all" ? tasks : tasks.filter((task) => task.status === status);
}

export function getMockMessages(callSid: string) {
  const messages = (mockData.messages as Record<string, any[]>)[callSid] || [];
  return messages.map((message) => ({ ...message }));
}

export function getMockContactDetail(contactId: number) {
  const contact = getMockContact(contactId);
  if (!contact) return null;
  const calls = mockData.calls.filter((call) => call.contact_id === contactId).map((call) => ({ ...call }));
  const tasks = mockData.tasks.filter((task) => task.contact_id === contactId).map((task) => ({ ...task }));
  const summaries = calls.map((call) => ({
    id: call.id,
    call_sid: call.call_sid,
    intent: call.intent,
    outcome: call.outcome,
    sentiment: call.sentiment,
    resolution_score: call.summary_score,
    summary: call.call_summary,
    next_action: call.next_action,
    created_at: call.ended_at,
  }));
  return { contact: { ...contact }, calls, tasks, appointments: [], summaries, customFields: [] };
}

export function getMockStats() {
  const calls = mockData.calls;
  const contacts = mockData.contacts;
  const tasks = mockData.tasks;
  const completedCalls = calls.filter((call) => call.status === "completed").length;
  const callbacksNeeded = calls.filter((call) => call.outcome === "callback_needed").length;
  const leadsBooked = calls.filter((call) => call.outcome === "lead_captured" || call.outcome === "appointment_booked").length;
  const sentiment = calls.reduce<Record<string, number>>((acc, call) => {
    acc[call.sentiment] = (acc[call.sentiment] || 0) + 1;
    return acc;
  }, {});

  return {
    totalCalls: calls.length,
    activeCalls: 0,
    completedCalls,
    totalMessages: Object.values(mockData.messages).reduce((sum, rows) => sum + rows.length, 0),
    totalContacts: contacts.length,
    avgDurationSeconds: Math.round(calls.reduce((sum, call) => sum + call.duration_seconds, 0) / Math.max(calls.length, 1)),
    inboundCalls: calls.length,
    outboundCalls: 0,
    avgAiLatencyMs: 920,
    openTasks: tasks.filter((task) => task.status === "open").length,
    pendingHandoffs: 0,
    avgResolutionScore: 0.91,
    callsToday: calls.length,
    callsThisWeek: calls.length,
    callsThisMonth: calls.length,
    transferRate: 0,
    bookingRate: Math.round((leadsBooked / Math.max(completedCalls, 1)) * 100),
    conversionRate: Math.round((leadsBooked / Math.max(completedCalls, 1)) * 100),
    qualificationRate: 100,
    callbacksNeeded,
    leadsBooked,
    fieldsExtracted: 9,
    summariesGenerated: calls.length,
    callbackTasksCreated: tasks.length,
    ownerEmailAlertsSent: tasks.length,
    completeProofCalls: calls.length,
    proofFreshness: {
      status: "fresh",
      label: "Mock proof loaded",
      latestAt: calls[0]?.started_at || null,
      completeProofCalls: calls.length,
    },
    setupReadiness: {
      ready: true,
      status: "mock-ready",
      checks: [
        { key: "workspace", ok: true, label: "Demo workspace loaded" },
        { key: "alerts", ok: true, label: "Alert routing staged" },
        { key: "proof", ok: true, label: "Proof calls loaded" }
      ],
    },
    dataCaptureCoverage: 100,
    contactsWithEmail: contacts.filter((contact) => contact.email).length,
    contactsWithName: contacts.filter((contact) => contact.name).length,
    avgFieldConfidence: 91,
    sentiment,
    prospectTotalLeads: 0,
    prospectCalled: 0,
    prospectInterested: 0,
    prospectConversionRate: 0,
    dncCount: contacts.filter((contact) => contact.do_not_call).length,
  };
}

export function getMockCallIntelligence() {
  return {
    pendingReview: [
      {
        call_sid: "CA00000000000000000000000000000001",
        contact_name: "Marcus Vance",
        issue: "High-value emergency job needs immediate callback confirmation.",
        confidence: 0.94,
        priority: "high",
      },
      {
        call_sid: "CA00000000000000000000000000000003",
        contact_name: "Dave Miller",
        issue: "DNC flag is set on an inbound commercial estimate lead; manual review required before any outbound follow-up.",
        confidence: 0.72,
        priority: "medium",
      }
    ],
    lowConfidence: [],
    totalPending: 2,
  };
}
