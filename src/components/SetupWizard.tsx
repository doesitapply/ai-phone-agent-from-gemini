import React, { useCallback, useEffect, useRef, useState } from "react";

/**
 * SetupWizard — 5-step onboarding for new workspaces.
 *
 * Steps:
 *   1. Business Profile  — name, industry, timezone, hours, owner phone/email
 *   2. Call Flow         — call instructions, assistant name, greetings, voice
 *   3. Phone Number      — show provisioned Twilio number; trigger inline if missing
 *   4. Owner Alert       — owner email for lead alerts; test email send
 *   5. Proof             — health check summary, mark setup complete
 *
 * All steps save via PATCH /api/workspace/profile.
 * Step 5 sets setup_completed_at, which dismisses the wizard permanently.
 */

// ── Types ──────────────────────────────────────────────────────────────────────

type WorkspaceProfile = {
  id: number;
  name: string;
  owner_email: string;
  timezone: string;
  business_name?: string;
  business_tagline?: string;
  business_phone?: string;
  business_website?: string;
  business_address?: string;
  service_area?: string;
  business_hours?: string;
  escalation_preference?: string;
  proof_call_target?: string;
  agent_name?: string;
  agent_persona?: string;
  inbound_greeting?: string;
  outbound_greeting?: string;
  owner_phone?: string;
  notification_email?: string;
  setup_completed_at?: string;
  twilio_phone_number?: string;
  twilio_account_sid?: string | null;
  has_elevenlabs?: boolean;
  has_gemini?: boolean;
  has_openrouter?: boolean;
};

type Health = {
  ok: boolean;
  summary?: { failed: number; warned: number; passed: number };
  checks?: { id: string; status: "pass" | "warn" | "fail"; message: string }[];
};

// ── API helper ─────────────────────────────────────────────────────────────────

const CUSTOMER_NETWORK_ERROR = "Unable to reach SMIRK right now. Please refresh or contact support if this keeps happening.";
const CUSTOMER_DATA_ERROR = "Unable to load workspace setup right now. Please refresh or contact support if this keeps happening.";
const CUSTOMER_AUTH_ERROR = "This workspace session is not authorized. Sign out and open your latest SMIRK invite, or contact support if this keeps happening.";

function safeSetupError(error: unknown, fallback = CUSTOMER_DATA_ERROR) {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const message = raw.trim() || fallback;
  if (/unauthorized|x-api-key|bearer token|api key|access token|forbidden|401|403/i.test(message)) return CUSTOMER_AUTH_ERROR;
  if (/failed to fetch|fetch failed|networkerror|load failed|network request failed/i.test(message)) return CUSTOMER_NETWORK_ERROR;
  if (/^HTTP 5\d\d\b|^\d{3}:|database|postgres|db-|econn|enotfound|connection refused/i.test(message)) return fallback;
  return message;
}

async function api<T>(path: string, opts?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const operatorRaw = localStorage.getItem("smirk_operator_session");
  const workspaceRaw = localStorage.getItem("smirk_workspace_session");
  try {
    const operator = operatorRaw ? JSON.parse(operatorRaw) : null;
    if (operator?.apiKey) headers["X-Api-Key"] = String(operator.apiKey);
  } catch {}
  try {
    const workspace = workspaceRaw ? JSON.parse(workspaceRaw) : null;
    if (workspace?.apiKey) headers["Authorization"] = `Bearer ${workspace.apiKey}`;
    if (workspace?.workspaceId) headers["X-Workspace-Id"] = String(workspace.workspaceId);
  } catch {}

  let r: Response;
  try {
    r = await fetch(path, { ...opts, headers: { ...headers, ...(opts?.headers || {}) } });
  } catch (error) {
    throw new Error(safeSetupError(error, CUSTOMER_NETWORK_ERROR));
  }
  if (!r.ok) {
    const text = await r.text().catch(() => r.statusText);
    throw new Error(safeSetupError(`${r.status}: ${text}`));
  }
  return r.json();
}

// ── Step definitions ───────────────────────────────────────────────────────────

const STEPS = [
  { id: "business",      label: "Business",      icon: "🏢" },
  { id: "agent",         label: "Call Flow",     icon: "🤖" },
  { id: "phone",         label: "Phone",         icon: "📞" },
  { id: "notifications", label: "Owner Alert",   icon: "🔔" },
  { id: "golive",        label: "Proof",         icon: "🚀" },
] as const;

type StepId = (typeof STEPS)[number]["id"];

const TIMEZONES = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Phoenix",
  "America/Anchorage",
  "Pacific/Honolulu",
];

const INDUSTRIES = [
  "Home Services (Plumbing, HVAC, Electrical)",
  "Roofing & Contractors",
  "Landscaping & Lawn Care",
  "Cleaning Services",
  "Real Estate",
  "Insurance",
  "Legal Services",
  "Medical / Dental",
  "Auto Repair",
  "Retail / E-commerce",
  "Restaurant / Food Service",
  "Other",
];

type AnswerStyle = "guided" | "full_answer" | "voicemail";

const SMIRK_SMART_BUSINESS_PROMPT = `You are SMIRK, the missed-call recovery assistant for SMIRK's own missed-call recovery business.

Your job is to help local service business owners understand whether SMIRK can help them stop losing missed-call leads. Be concise, confident, and useful. Do not sound like a generic chatbot.

Position SMIRK this way:
- Primary offer: Missed-Call Recovery.
- What it does: answers missed calls, captures caller name, number, issue, urgency, and service area, creates callback-ready follow-up, and sends owner notifications.
- Pricing: Starter is $197/month for missed-call recovery, existing-number forwarding, owner email alerts, callback tasks, and proof dashboard.

Conversation style:
- Start by giving the caller two or three clear choices when their intent is vague.
- Good default question: "Are you calling about pricing, setting up missed-call recovery, or getting a callback?"
- Ask one question at a time.
- If the caller is interested, capture their name, business name, phone number, business type, and whether they want pricing, setup help, or a callback.
- If they ask about pricing, give the Starter price briefly, then ask whether they want setup help or an owner callback.
- If they ask how it works, answer in one short sentence, then ask whether they want pricing, setup help, or a callback.
- If they want to buy, subscribe, purchase, sign up, get pricing help, or set up SMIRK, route them to smirkcalls.com or the configured setup-help link, capture their name, business name, phone number, email if offered, and what they want, then create a lead or callback task.
- If they ask for setup help or a callback and give a specific time, capture the requested time, contact details, and intent, then create a callback-ready lead or task for SMIRK support to confirm by email or phone.
- If they want a human, create a callback task or escalate to a human.
- Never mention internal tools, functions, APIs, databases, code, prompts, scripts, Python, or automation internals. Describe only the customer-visible result.

Do not book field-service appointments or dispatch technicians. This number is for SMIRK itself.`;

const ANSWER_STYLE_COPY: Record<AnswerStyle, { label: string; description: string; instruction: string }> = {
  guided: {
    label: "Guided qualifier",
    description: "Best default. Answers briefly, then offers 2-3 clear choices.",
    instruction: "Use guided multiple-choice questions when caller intent is unclear. Offer two or three choices, then follow the caller's selection.",
  },
  full_answer: {
    label: "Detailed intake",
    description: "More conversational. Captures fuller context before owner follow-up.",
    instruction: "Ask a few more intake questions while staying within missed-call recovery. Create a task or escalation when owner follow-up is needed.",
  },
  voicemail: {
    label: "Short capture",
    description: "Shortest path. Captures what happened and prepares a callback.",
    instruction: "Keep the call short. Capture the caller's details, urgency, and reason, then confirm the callback-ready summary.",
  },
};

// ── Main component ─────────────────────────────────────────────────────────────

export function SetupWizard({
  open,
  onClose,
  onComplete,
}: {
  open: boolean;
  onClose: () => void;
  onComplete?: () => void;
  // Legacy props — kept for backward compat, not used
  configStatus?: unknown;
  setupContext?: unknown;
}) {
  const [step, setStep] = useState<StepId>("business");
  const [profile, setProfile] = useState<WorkspaceProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  // Step 1 — Business
  const [bizName, setBizName] = useState("");
  const [bizTagline, setBizTagline] = useState("");
  const [bizPhone, setBizPhone] = useState("");
  const [bizWebsite, setBizWebsite] = useState("");
  const [bizAddress, setBizAddress] = useState("");
  const [serviceArea, setServiceArea] = useState("");
  const [bizHours, setBizHours] = useState("Mon–Fri 8am–6pm");
  const [timezone, setTimezone] = useState("America/Los_Angeles");
  const [industry, setIndustry] = useState("");
  const [ownerPhone, setOwnerPhone] = useState("");
  const [escalationPreference, setEscalationPreference] = useState("Email summary and create callback task; call owner phone for urgent human requests.");
  const [proofCallTarget, setProofCallTarget] = useState("");

  // Step 2 — Agent
  const [agentName, setAgentName] = useState("SMIRK");
  const [agentPersona, setAgentPersona] = useState("");
  const [inboundGreeting, setInboundGreeting] = useState("");
  const [outboundGreeting, setOutboundGreeting] = useState("");
  const [answerStyle, setAnswerStyle] = useState<AnswerStyle>("guided");
  const [generatingPrompt, setGeneratingPrompt] = useState(false);

  // Step 3 — Phone
  const [twilioPhone, setTwilioPhone] = useState<string | null>(null);
  const [provisioningPhone, setProvisioningPhone] = useState(false);
  const [areaCode, setAreaCode] = useState("775");
  const [webhookUrls, setWebhookUrls] = useState<{ incomingUrl: string; statusUrl: string } | null>(null);

  // Step 4 — Notifications
  const [notifEmail, setNotifEmail] = useState("");
  const [testEmailBusy, setTestEmailBusy] = useState(false);

  // Step 5 — Go Live
  const [health, setHealth] = useState<Health | null>(null);
  const [healthBusy, setHealthBusy] = useState(false);
  const [completing, setCompleting] = useState(false);

  const isMounted = useRef(true);
  useEffect(() => { isMounted.current = true; return () => { isMounted.current = false; }; }, []);

  // Load workspace profile on open
  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setErr(null);
    api<WorkspaceProfile>("/api/workspace/profile")
      .then((p) => {
        if (!isMounted.current) return;
        setProfile(p);
        // Pre-fill form fields from DB
        setBizName(p.business_name || p.name || "");
        setBizTagline(p.business_tagline || "");
	        setBizPhone(p.business_phone || "");
	        setBizWebsite(p.business_website || "");
	        setBizAddress(p.business_address || "");
	        setServiceArea(p.service_area || p.business_address || "");
	        setBizHours(p.business_hours || "Mon–Fri 8am–6pm");
	        setTimezone(p.timezone || "America/Los_Angeles");
	        setOwnerPhone(p.owner_phone || "");
	        setEscalationPreference(p.escalation_preference || "Email summary and create callback task; call owner phone for urgent human requests.");
	        setProofCallTarget(p.proof_call_target || p.owner_phone || "");
        setAgentName(p.agent_name || "SMIRK");
        setAgentPersona(p.agent_persona || SMIRK_SMART_BUSINESS_PROMPT);
        setInboundGreeting(p.inbound_greeting || "Thanks for calling SMIRK. I'm the missed-call recovery assistant for local businesses. Are you calling about pricing, setting up missed-call recovery, or getting a callback?");
        setOutboundGreeting(p.outbound_greeting || "Hi, this is SMIRK. I'm following up about missed-call recovery. Is now a good time?");
        setNotifEmail(p.notification_email || p.owner_email || "");
        setTwilioPhone(p.twilio_phone_number || null);
      })
      .catch((e) => { if (isMounted.current) setErr(e.message); })
      .finally(() => { if (isMounted.current) setLoading(false); });

    api<{ incomingUrl: string; statusUrl: string }>("/api/webhook-url")
      .then((u) => { if (isMounted.current) setWebhookUrls(u); })
      .catch(() => {});
  }, [open]);

  const flash = useCallback((msg: string, isErr = false) => {
    if (isErr) setErr(msg); else setOk(msg);
    setTimeout(() => { if (isMounted.current) { setErr(null); setOk(null); } }, 4000);
  }, []);

  // ── Save helpers ─────────────────────────────────────────────────────────────

  const saveProfile = async (patch: Partial<WorkspaceProfile>) => {
    setSaving(true);
    try {
      await api("/api/workspace/profile", { method: "PATCH", body: JSON.stringify(patch) });
      setProfile((prev) => prev ? { ...prev, ...patch } : prev);
    } finally {
      setSaving(false);
    }
  };

  // ── Step 1: Save business profile ────────────────────────────────────────────

  const saveStep1 = async () => {
    if (!bizName.trim()) { flash("Business name is required.", true); return; }
    try {
      await saveProfile({
        name: bizName,
        business_name: bizName,
        business_tagline: bizTagline,
	        business_phone: bizPhone,
	        business_website: bizWebsite,
	        business_address: bizAddress,
	        service_area: serviceArea,
	        business_hours: bizHours,
	        timezone,
	        owner_phone: ownerPhone,
	        escalation_preference: escalationPreference,
	        proof_call_target: proofCallTarget,
	      });
      flash("Business profile saved.");
      setStep("agent");
    } catch (e: any) { flash(e.message, true); }
  };

  // ── Step 2: Generate AI system prompt ────────────────────────────────────────

  const generatePrompt = async () => {
    if (!bizName.trim()) { flash("Save business profile first (Step 1).", true); return; }
    setGeneratingPrompt(true);
    try {
      const res = await api<{ prompt: string }>("/api/workspace/generate-prompt", {
        method: "POST",
        body: JSON.stringify({
          business_name: bizName,
          business_tagline: bizTagline,
          business_hours: bizHours,
          business_phone: bizPhone,
          business_address: bizAddress,
          industry,
          agent_name: agentName,
          answer_style: answerStyle,
        }),
      });
      setAgentPersona(res.prompt);
      flash("AI prompt generated — review and edit before saving.");
    } catch (e: any) {
      flash(e.message, true);
    } finally {
      setGeneratingPrompt(false);
    }
  };

  const saveStep2 = async () => {
    try {
      const personaWithoutStyle = agentPersona.replace(/\n\nANSWER STYLE:\n[\s\S]*$/m, "").trim();
      await saveProfile({
        agent_name: agentName,
        agent_persona: `${personaWithoutStyle}\n\nANSWER STYLE:\n${ANSWER_STYLE_COPY[answerStyle].instruction}`.trim(),
        inbound_greeting: inboundGreeting,
        outbound_greeting: outboundGreeting,
      });
      flash("Call flow saved.");
      setStep("phone");
    } catch (e: any) { flash(e.message, true); }
  };

  const applySmirkDefaults = () => {
    setBizName("SMIRK");
    setBizTagline("Missed-call recovery for lost leads.");
    setIndustry("Home Services (Plumbing, HVAC, Electrical)");
    setBizWebsite("https://smirkcalls.com");
    setAgentName("SMIRK");
    setAnswerStyle("guided");
    setAgentPersona(SMIRK_SMART_BUSINESS_PROMPT);
    setInboundGreeting("Thanks for calling SMIRK. I'm the missed-call recovery assistant for local businesses. Are you calling about pricing, setting up missed-call recovery, or getting a callback?");
    setOutboundGreeting("Hi, this is SMIRK. I'm following up about missed-call recovery. Is now a good time?");
    flash("SMIRK missed-call recovery defaults loaded.");
  };

  // ── Step 3: Phone provisioning ───────────────────────────────────────────────

  const provisionNumber = async () => {
    setProvisioningPhone(true);
    try {
      const res = await api<{ phone_number: string }>("/api/workspace/provision-number", {
        method: "POST",
        body: JSON.stringify({ area_code: areaCode }),
      });
      setTwilioPhone(res.phone_number);
      setProfile((prev) => prev ? { ...prev, twilio_phone_number: res.phone_number } : prev);
      flash(`Number provisioned: ${res.phone_number}`);
    } catch (e: any) {
      flash(e.message, true);
    } finally {
      setProvisioningPhone(false);
    }
  };

  const copyToClipboard = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      flash(`${label} copied`);
    } catch { flash("Copy failed — select and copy manually.", true); }
  };

  // ── Step 4: Notifications ────────────────────────────────────────────────────

  const saveStep4 = async () => {
    if (!notifEmail.trim()) { flash("Notification email is required.", true); return; }
    try {
      await saveProfile({ notification_email: notifEmail });
      flash("Notification email saved.");
      setStep("golive");
    } catch (e: any) { flash(e.message, true); }
  };

  const sendTestEmail = async () => {
    if (!notifEmail.trim()) { flash("Enter an email first.", true); return; }
    setTestEmailBusy(true);
    try {
      await api("/api/settings/test/email", { method: "POST", body: JSON.stringify({ email: notifEmail }) });
      flash("Test email sent — check your inbox.");
    } catch (e: any) { flash(e.message, true); }
    finally { setTestEmailBusy(false); }
  };

  // ── Step 5: Go Live ──────────────────────────────────────────────────────────

  const runHealth = async () => {
    setHealthBusy(true);
    try {
      const h = await api<Health>("/api/system-health");
      setHealth(h);
    } catch (e: any) { flash(e.message, true); }
    finally { setHealthBusy(false); }
  };

  const markComplete = async () => {
    setCompleting(true);
    try {
      await saveProfile({ setup_completed_at: new Date().toISOString() });
      flash("Setup complete! Your agent is live.");
      setTimeout(() => {
        if (isMounted.current) {
          onComplete?.();
          onClose();
        }
      }, 1500);
    } catch (e: any) { flash(e.message, true); }
    finally { setCompleting(false); }
  };

  if (!open) return null;

  // ── Render ───────────────────────────────────────────────────────────────────

  const stepIndex = STEPS.findIndex((s) => s.id === step);
  const assignedTwilioPhone = twilioPhone || profile?.twilio_phone_number || null;

  const inputCls = "w-full rounded-xl bg-black/40 border border-gray-700 px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-violet-500";
  const labelCls = "block text-[11px] text-gray-400 mb-1 uppercase tracking-wide";
  const btnPrimary = "rounded-xl px-4 py-2 text-sm bg-violet-600 hover:bg-violet-500 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed";
  const btnSecondary = "rounded-xl px-4 py-2 text-sm border border-gray-700 text-gray-200 hover:border-gray-500 transition-colors disabled:opacity-50";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
      <div className="w-full max-w-3xl rounded-3xl border border-gray-800 bg-gray-900 shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800 shrink-0">
          <div>
            <div className="text-sm font-semibold text-white">Set up your workspace</div>
            <div className="text-xs text-gray-400">Step {stepIndex + 1} of {STEPS.length} — {STEPS[stepIndex].label}</div>
            <div className="mt-1 text-xs text-emerald-300">
              Workspace Twilio number: <span className="font-mono text-white">{assignedTwilioPhone || "Not provisioned yet"}</span>
            </div>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-lg leading-none">✕</button>
        </div>

        {/* Step tabs */}
        <div className="flex border-b border-gray-800 shrink-0 overflow-x-auto">
          {STEPS.map((s, i) => (
            <button
              key={s.id}
              onClick={() => setStep(s.id)}
              className={`flex items-center gap-1.5 px-4 py-3 text-xs whitespace-nowrap transition-colors border-b-2 ${
                s.id === step
                  ? "border-violet-500 text-white"
                  : i < stepIndex
                  ? "border-transparent text-emerald-400 hover:text-white"
                  : "border-transparent text-gray-500 hover:text-gray-300"
              }`}
            >
              <span>{s.icon}</span>
              <span>{s.label}</span>
              {i < stepIndex && <span className="text-emerald-400">✓</span>}
            </button>
          ))}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6">
          {loading ? (
            <div className="text-sm text-gray-400 text-center py-8">Loading workspace…</div>
          ) : (
            <>
              {/* Flash messages */}
              {ok && <div className="mb-4 rounded-xl bg-emerald-950/40 border border-emerald-700/40 px-4 py-2 text-xs text-emerald-300">{ok}</div>}
              {err && <div className="mb-4 rounded-xl bg-red-950/40 border border-red-700/40 px-4 py-2 text-xs text-red-300">{err}</div>}

              {/* ── Step 1: Business Profile ── */}
              {step === "business" && (
                <div className="space-y-4">
                  <div className="text-sm font-semibold text-white">Business Profile</div>
                  <div className="text-xs text-gray-400">This is what the missed-call assistant knows about your business. It uses this to capture useful callbacks.</div>
                  <div className="rounded-2xl border border-emerald-700/40 bg-emerald-950/20 p-4">
                    <div className="text-xs text-emerald-300 font-semibold">Assigned workspace number</div>
                    <div className="mt-1 text-2xl font-mono text-white">{assignedTwilioPhone || "Not provisioned yet"}</div>
                    <div className="mt-1 text-xs text-gray-400">
                      This is the Twilio number tied to this workspace. Calls to this number route to this workspace's missed-call assistant.
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label className={labelCls}>Business Name *</label>
                      <input className={inputCls} value={bizName} onChange={(e) => setBizName(e.target.value)} placeholder="Acme Plumbing" />
                    </div>
                    <div>
                      <label className={labelCls}>Industry</label>
                      <select className={inputCls} value={industry} onChange={(e) => setIndustry(e.target.value)}>
                        <option value="">Select industry…</option>
                        {INDUSTRIES.map((ind) => <option key={ind} value={ind}>{ind}</option>)}
                      </select>
                    </div>
                    <div className="md:col-span-2">
                      <label className={labelCls}>Tagline / Specialty</label>
                      <input className={inputCls} value={bizTagline} onChange={(e) => setBizTagline(e.target.value)} placeholder="24/7 emergency plumbing for the Reno area" />
                    </div>
                    <div>
                      <label className={labelCls}>Business Phone</label>
                      <input className={inputCls} value={bizPhone} onChange={(e) => setBizPhone(e.target.value)} placeholder="+17754204485" />
                    </div>
                    <div>
                      <label className={labelCls}>Website</label>
                      <input className={inputCls} value={bizWebsite} onChange={(e) => setBizWebsite(e.target.value)} placeholder="https://acmeplumbing.com" />
                    </div>
	                    <div className="md:col-span-2">
	                      <label className={labelCls}>Service Area / Address</label>
	                      <input className={inputCls} value={bizAddress} onChange={(e) => setBizAddress(e.target.value)} placeholder="Reno, NV and surrounding areas" />
	                    </div>
	                    <div className="md:col-span-2">
	                      <label className={labelCls}>Service Area *</label>
	                      <input className={inputCls} value={serviceArea} onChange={(e) => setServiceArea(e.target.value)} placeholder="Reno, Sparks, Carson City, and nearby emergency calls" />
	                    </div>
	                    <div>
	                      <label className={labelCls}>Business Hours</label>
	                      <input className={inputCls} value={bizHours} onChange={(e) => setBizHours(e.target.value)} placeholder="Mon–Fri 8am–6pm, Sat 9am–2pm" />
                    </div>
                    <div>
                      <label className={labelCls}>Timezone</label>
                      <select className={inputCls} value={timezone} onChange={(e) => setTimezone(e.target.value)}>
                        {TIMEZONES.map((tz) => <option key={tz} value={tz}>{tz}</option>)}
                      </select>
                    </div>
	                    <div>
	                      <label className={labelCls}>Owner Phone (for escalations)</label>
	                      <input className={inputCls} value={ownerPhone} onChange={(e) => setOwnerPhone(e.target.value)} placeholder="+17754204485" />
	                    </div>
	                    <div>
	                      <label className={labelCls}>Proof-call target *</label>
	                      <input className={inputCls} value={proofCallTarget} onChange={(e) => setProofCallTarget(e.target.value)} placeholder="+17754204485" />
	                    </div>
	                    <div className="md:col-span-2">
	                      <label className={labelCls}>Escalation Preference *</label>
	                      <textarea
	                        className={`${inputCls} min-h-[74px] resize-y`}
	                        value={escalationPreference}
	                        onChange={(e) => setEscalationPreference(e.target.value)}
	                        placeholder="Email summary and create callback task; call owner phone for urgent human requests."
	                      />
	                    </div>
	                  </div>

                  <div className="flex justify-end pt-2">
                    <button className={btnPrimary} onClick={saveStep1} disabled={saving}>
                      {saving ? "Saving…" : "Save & Continue →"}
                    </button>
                  </div>
                </div>
              )}

              {/* ── Step 2: Call Flow ── */}
              {step === "agent" && (
                <div className="space-y-4">
                  <div className="text-sm font-semibold text-white">Call Flow</div>
                  <div className="text-xs text-gray-400">Set how missed calls are answered, what details get captured, and how owner follow-up is prepared.</div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className={labelCls}>Assistant Name</label>
                    <input className={inputCls} value={agentName} onChange={(e) => setAgentName(e.target.value)} placeholder="SMIRK" />
                  </div>
                    <div>
                      <label className={labelCls}>Answer Style</label>
                      <select className={inputCls} value={answerStyle} onChange={(e) => setAnswerStyle(e.target.value as AnswerStyle)}>
                        {(Object.keys(ANSWER_STYLE_COPY) as AnswerStyle[]).map((key) => (
                          <option key={key} value={key}>{ANSWER_STYLE_COPY[key].label}</option>
                        ))}
                      </select>
                      <div className="text-[11px] text-gray-500 mt-1">{ANSWER_STYLE_COPY[answerStyle].description}</div>
                    </div>
                  </div>

                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className={labelCls}>Call Instructions</label>
                      <div className="flex items-center gap-3">
                        <button
                          className="text-[11px] text-emerald-400 hover:text-emerald-300 transition-colors"
                          onClick={applySmirkDefaults}
                        >
                          Use SMIRK defaults
                        </button>
                        <button
                          className="text-[11px] text-violet-400 hover:text-violet-300 transition-colors disabled:opacity-50"
                          onClick={generatePrompt}
                          disabled={generatingPrompt}
                        >
                          {generatingPrompt ? "Generating…" : "✨ Generate from business profile"}
                        </button>
                      </div>
                    </div>
                    <textarea
                      className={`${inputCls} min-h-[160px] resize-y font-mono text-xs`}
                      value={agentPersona}
                      onChange={(e) => setAgentPersona(e.target.value)}
                      placeholder="You are a missed-call recovery assistant for [business name]..."
                    />
                    <div className="text-[11px] text-gray-500 mt-1">These instructions keep the call focused on capture, owner alerting, callback task creation, and proof.</div>
                  </div>

                  <div>
                    <label className={labelCls}>Inbound Greeting</label>
                    <input
                      className={inputCls}
                      value={inboundGreeting}
                      onChange={(e) => setInboundGreeting(e.target.value)}
                      placeholder={`Thanks for calling ${bizName || "us"}! This is ${agentName}, your AI assistant. This call may be recorded for quality and follow-up. How can I help?`}
                    />
                    <div className="text-[11px] text-gray-500 mt-1">Leave blank to use the auto-generated greeting. Include recording disclosure for TCPA compliance.</div>
                  </div>

                  <div>
                    <label className={labelCls}>Outbound Greeting</label>
                    <input
                      className={inputCls}
                      value={outboundGreeting}
                      onChange={(e) => setOutboundGreeting(e.target.value)}
                      placeholder={`Hi, this is ${agentName} from ${bizName || "your business"}. I'm following up on your request. Is now a good time?`}
                    />
                  </div>

                  <div className="flex justify-between pt-2">
                    <button className={btnSecondary} onClick={() => setStep("business")}>← Back</button>
                    <button className={btnPrimary} onClick={saveStep2} disabled={saving}>
                      {saving ? "Saving…" : "Save & Continue →"}
                    </button>
                  </div>
                </div>
              )}

              {/* ── Step 3: Phone Number ── */}
              {step === "phone" && (
                <div className="space-y-4">
                  <div className="text-sm font-semibold text-white">Phone Number</div>
                  <div className="text-xs text-gray-400">Your workspace needs a dedicated phone number. Calls to this number go directly to your AI agent.</div>

                  {assignedTwilioPhone ? (
                    <div className="rounded-2xl border border-emerald-700/40 bg-emerald-950/20 p-4">
                      <div className="text-xs text-emerald-300 font-semibold mb-1">✓ Number provisioned</div>
                      <div className="text-2xl font-mono text-white">{assignedTwilioPhone}</div>
                      <div className="text-xs text-gray-400 mt-1">This number is live. Calls to it will reach your AI agent.</div>
                    </div>
                  ) : (
                    <div className="rounded-2xl border border-gray-700 bg-gray-800/40 p-4 space-y-3">
                      <div className="text-xs text-yellow-300">⚠ No phone number provisioned yet.</div>
                      <div className="flex gap-2">
                        <div className="w-32">
                          <label className={labelCls}>Area Code</label>
                          <input className={inputCls} value={areaCode} onChange={(e) => setAreaCode(e.target.value)} placeholder="775" maxLength={3} />
                        </div>
                        <div className="flex items-end">
                          <button className={btnPrimary} onClick={provisionNumber} disabled={provisioningPhone}>
                            {provisioningPhone ? "Provisioning…" : "Provision Number"}
                          </button>
                        </div>
                      </div>
                    </div>
                  )}

                  {webhookUrls && (
                    <div className="space-y-3">
                      <div className="text-xs text-gray-400 font-semibold">Twilio Webhook URLs (auto-configured for provisioned numbers)</div>
                      {[
                        { label: "Voice Webhook", url: webhookUrls.incomingUrl },
                        { label: "Status Callback", url: webhookUrls.statusUrl },
                      ].map(({ label, url }) => (
                        <div key={label}>
                          <div className="text-[11px] text-gray-500 mb-1">{label}</div>
                          <div className="flex gap-2">
                            <code className="flex-1 text-xs p-2 rounded-xl bg-black/40 border border-gray-800 text-emerald-300 overflow-x-auto">{url}</code>
                            <button className={btnSecondary} onClick={() => copyToClipboard(url, label)}>Copy</button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="flex justify-between pt-2">
                    <button className={btnSecondary} onClick={() => setStep("agent")}>← Back</button>
                    <button className={btnPrimary} onClick={() => setStep("notifications")}>
                      Continue →
                    </button>
                  </div>
                </div>
              )}

              {/* ── Step 4: Owner Alert ── */}
              {step === "notifications" && (
                <div className="space-y-4">
                  <div className="text-sm font-semibold text-white">Owner Alert</div>
                  <div className="text-xs text-gray-400">Where should callback-ready lead emails and call summaries go? This is the owner inbox notified after a missed call is captured.</div>

                  <div>
                    <label className={labelCls}>Notification Email *</label>
                    <input
                      type="email"
                      className={inputCls}
                      value={notifEmail}
                      onChange={(e) => setNotifEmail(e.target.value)}
                      placeholder="owner@yourbusiness.com"
                    />
                  </div>

                  <div className="flex gap-2">
                    <button
                      className={btnSecondary}
                      onClick={sendTestEmail}
                      disabled={testEmailBusy || !notifEmail.trim()}
                    >
                      {testEmailBusy ? "Sending…" : "Send test email"}
                    </button>
                    <div className="text-[11px] text-gray-500 self-center">Verify delivery before going live.</div>
                  </div>

                  <div className="flex justify-between pt-2">
                    <button className={btnSecondary} onClick={() => setStep("phone")}>← Back</button>
                    <button className={btnPrimary} onClick={saveStep4} disabled={saving}>
                      {saving ? "Saving…" : "Save & Continue →"}
                    </button>
                  </div>
                </div>
              )}

              {/* ── Step 5: Proof ── */}
              {step === "golive" && (
                <div className="space-y-4">
                  <div className="text-sm font-semibold text-white">Proof</div>
                  <div className="text-xs text-gray-400">Run a final health check, then activate missed-call recovery. Once live, the workspace should capture calls, send owner alerts, create callback tasks, and show proof.</div>

                  <div className="flex gap-2">
                    <button className={btnSecondary} onClick={runHealth} disabled={healthBusy}>
                      {healthBusy ? "Running…" : "Run health check"}
                    </button>
                  </div>

                  {health && (
                    <div className="rounded-2xl border border-gray-700 bg-gray-800/40 p-4 space-y-2">
                      <div className={`text-xs font-semibold ${health.ok ? "text-emerald-300" : "text-yellow-300"}`}>
                        {health.ok ? "✓ All systems go" : `⚠ ${health.summary?.failed ?? 0} failed, ${health.summary?.warned ?? 0} warned`}
                      </div>
                      <div className="space-y-1">
                        {(health.checks || []).map((c) => (
                          <div key={c.id} className="flex gap-2 text-[11px]">
                            <span className={`w-10 ${c.status === "pass" ? "text-emerald-400" : c.status === "warn" ? "text-yellow-400" : "text-red-400"}`}>
                              {c.status.toUpperCase()}
                            </span>
                            <span className="text-gray-300"><b>{c.id}</b>: {c.message}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Summary of what was configured */}
                  <div className="rounded-2xl border border-gray-700 bg-gray-800/20 p-4 space-y-2">
                    <div className="text-xs text-gray-400 font-semibold">Setup summary</div>
                    {[
                      { label: "Business", value: bizName || profile?.business_name || "—" },
                      { label: "Assistant", value: agentName || profile?.agent_name || "—" },
                      { label: "Phone", value: assignedTwilioPhone || "Not provisioned" },
                      { label: "Owner alert", value: notifEmail || profile?.notification_email || "—" },
                    ].map(({ label, value }) => (
                      <div key={label} className="flex gap-2 text-xs">
                        <span className="text-gray-500 w-28">{label}</span>
                        <span className="text-white">{value}</span>
                      </div>
                    ))}
                  </div>

                  <div className="flex justify-between pt-2">
                    <button className={btnSecondary} onClick={() => setStep("notifications")}>← Back</button>
                    <button
                      className="rounded-xl px-6 py-2 text-sm bg-emerald-600 hover:bg-emerald-500 text-white font-semibold transition-colors disabled:opacity-50"
                      onClick={markComplete}
                      disabled={completing}
                    >
                      {completing ? "Activating…" : "🚀 Activate Recovery"}
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
