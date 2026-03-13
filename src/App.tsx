/**
 * AI Phone Agent — Dashboard v2.0
 * Dark mode, in-app settings, onboarding wizard, connection status, toast notifications
 */
import React, { useState, useCallback, useEffect, createContext, useContext } from "react";
import {
  Phone, PhoneIncoming, PhoneOutgoing, Activity, BarChart3, Bot,
  Settings, Clock, Zap, Users, ListTodo,
  AlertTriangle, User, Calendar, TrendingUp, Wrench,
  Moon, Sun, Eye, EyeOff, Save, X, CheckCircle2, Info, AlertCircle,
  WifiOff, ChevronRight, Loader2, Copy, Shield,
  Database, Globe, Key, Sliders, TestTube,
} from "lucide-react";

// ── Theme Context ─────────────────────────────────────────────────────────────
const ThemeContext = createContext<{ dark: boolean; toggle: () => void }>({ dark: false, toggle: () => {} });
const useTheme = () => useContext(ThemeContext);

// ── Toast Context ─────────────────────────────────────────────────────────────
type Toast = { id: string; type: "success" | "error" | "info" | "warning"; message: string };
const ToastContext = createContext<{ addToast: (t: Omit<Toast, "id">) => void }>({ addToast: () => {} });
const useToast = () => useContext(ToastContext);

// ── Types ─────────────────────────────────────────────────────────────────────
type Tab = "dashboard" | "calls" | "contacts" | "tasks" | "agents" | "settings" | "logs";

type ActiveCall = {
  call_sid: string;
  direction: string;
  from_number: string;
  to_number: string;
  started_at: string;
  turn_count: number;
  contact_name: string | null;
};

type Call = {
  id: number;
  call_sid: string;
  direction: "inbound" | "outbound";
  to_number: string;
  from_number: string;
  status: string;
  started_at: string;
  ended_at: string | null;
  duration_seconds: number | null;
  agent_name: string;
  message_count: number;
  contact_name: string | null;
  intent: string | null;
  outcome: string | null;
  call_summary: string | null;
  summary_score: number | null;
  next_action: string | null;
  sentiment: string | null;
};

type Message = { id: number; role: string; text: string; created_at: string };

type Contact = {
  id: number;
  phone_number: string;
  name: string | null;
  email: string | null;
  last_seen: string;
  last_summary: string | null;
  last_outcome: string | null;
  open_tasks_count: number;
  do_not_call: number;
  total_calls: number;
};

type Task = {
  id: number;
  contact_id: number | null;
  call_sid: string | null;
  task_type: string;
  status: string;
  notes: string | null;
  due_at: string | null;
  contact_name: string | null;
  phone_number: string | null;
  created_at: string;
};

type Stats = {
  total_calls?: number;
  totalCalls?: number;
  calls_today?: number;
  callsToday?: number;
  avg_duration?: number;
  avgDurationSeconds?: number;
  open_tasks?: number;
  openTasks?: number;
  total_contacts?: number;
  totalContacts?: number;
  calls_this_week?: number;
  callsThisWeek?: number;
  activeCalls?: number;
  pendingHandoffs?: number;
  avgAiLatencyMs?: number;
  bookingRate?: number;
};

type AgentConfig = {
  id: number;
  name: string;
  system_prompt: string;
  greeting: string;
  voice: string;
  language: string;
  vertical: string;
  max_turns: number;
  is_active: number;
};

type SettingsGroup = {
  id: string;
  label: string;
  description: string;
  required: boolean;
  fields: SettingsField[];
};

type SettingsField = {
  key: string;
  label: string;
  type: "text" | "password" | "toggle" | "textarea";
  placeholder?: string;
  help?: string;
  required?: boolean;
};

type ConfigStatus = {
  isConfigured: boolean;
  missingRequired: string[];
  warnings: string[];
};

type RequestLog = {
  id: number;
  request_id: string;
  method: string;
  path: string;
  status_code: number;
  duration_ms: number;
  ip: string;
  created_at: string;
};

// ── API Helper ────────────────────────────────────────────────────────────────
const api = async <T,>(path: string, options?: RequestInit): Promise<T> => {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json", ...options?.headers },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
};

// ── Utility Helpers ───────────────────────────────────────────────────────────
const fmt = {
  duration: (s: number | null | undefined) => {
    if (!s) return "—";
    if (s < 60) return `${s}s`;
    return `${Math.floor(s / 60)}m ${s % 60}s`;
  },
  date: (d: string | null | undefined) => {
    if (!d) return "—";
    return new Date(d).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  },
  phone: (p: string) => {
    const d = p.replace(/\D/g, "");
    if (d.length === 11 && d[0] === "1") return `+1 (${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
    return p;
  },
  sentiment: (s: string | null) => {
    if (!s) return null;
    const map: Record<string, string> = { positive: "😊", neutral: "😐", negative: "😟", frustrated: "😤" };
    return map[s.toLowerCase()] || s;
  },
  stat: (stats: Stats | null, ...keys: string[]): string | number => {
    if (!stats) return "—";
    for (const k of keys) {
      const v = (stats as any)[k];
      if (v !== undefined && v !== null) return v;
    }
    return "—";
  },
};

// ── Toast Component ───────────────────────────────────────────────────────────
function ToastContainer({ toasts, remove }: { toasts: Toast[]; remove: (id: string) => void }) {
  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 pointer-events-none">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`pointer-events-auto flex items-start gap-3 px-4 py-3 rounded-xl shadow-lg border max-w-sm ${
            t.type === "success" ? "bg-emerald-50 border-emerald-200 text-emerald-800 dark:bg-emerald-900/30 dark:border-emerald-700 dark:text-emerald-300" :
            t.type === "error" ? "bg-red-50 border-red-200 text-red-800 dark:bg-red-900/30 dark:border-red-700 dark:text-red-300" :
            t.type === "warning" ? "bg-amber-50 border-amber-200 text-amber-800 dark:bg-amber-900/30 dark:border-amber-700 dark:text-amber-300" :
            "bg-blue-50 border-blue-200 text-blue-800 dark:bg-blue-900/30 dark:border-blue-700 dark:text-blue-300"
          }`}
        >
          {t.type === "success" ? <CheckCircle2 size={16} className="mt-0.5 shrink-0" /> :
           t.type === "error" ? <AlertCircle size={16} className="mt-0.5 shrink-0" /> :
           t.type === "warning" ? <AlertTriangle size={16} className="mt-0.5 shrink-0" /> :
           <Info size={16} className="mt-0.5 shrink-0" />}
          <span className="text-sm font-medium flex-1">{t.message}</span>
          <button onClick={() => remove(t.id)} className="shrink-0 opacity-60 hover:opacity-100">
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

// ── Webhook Display ───────────────────────────────────────────────────────────
function WebhookDisplay() {
  const { dark } = useTheme();
  const { addToast } = useToast();
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    api<{ incomingUrl: string }>("/api/webhook-url").then(d => setUrl(d.incomingUrl)).catch(() => {});
  }, []);

  const copy = () => {
    if (!url) return;
    navigator.clipboard.writeText(url);
    addToast({ type: "success", message: "Webhook URL copied!" });
  };

  return (
    <div className={`rounded-xl p-4 ${dark ? "bg-gray-900 border border-gray-700" : "bg-gray-50 border border-gray-200"}`}>
      <p className={`text-xs font-semibold mb-2 uppercase tracking-wide ${dark ? "text-gray-500" : "text-gray-400"}`}>Twilio Webhook URL</p>
      <div className="flex items-center gap-2">
        <code className={`flex-1 text-xs p-2.5 rounded-lg overflow-x-auto ${dark ? "bg-gray-800 text-emerald-400" : "bg-white text-gray-800 border border-gray-200"}`}>
          {url || "Loading..."}
        </code>
        <button onClick={copy} className="p-2.5 rounded-lg bg-indigo-100 text-indigo-600 hover:bg-indigo-200 dark:bg-indigo-900/30 dark:text-indigo-400 transition-colors shrink-0">
          <Copy size={14} />
        </button>
      </div>
      <p className={`text-xs mt-2 ${dark ? "text-gray-600" : "text-gray-400"}`}>
        Paste into: Twilio Console → Phone Numbers → Your Number → Voice → A Call Comes In → Webhook
      </p>
    </div>
  );
}

// ── Onboarding Wizard ─────────────────────────────────────────────────────────
function OnboardingWizard({ onComplete, onSkip }: { onComplete: () => void; onSkip: () => void }) {
  const { dark } = useTheme();
  const { addToast } = useToast();
  const [step, setStep] = useState(0);
  const [values, setValues] = useState<Record<string, string>>({});
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message?: string; error?: string } | null>(null);

  const steps = [
    {
      title: "Welcome to AI Phone Agent",
      subtitle: "Let's get you set up in 3 quick steps. It takes about 2 minutes.",
      icon: <Bot size={40} className="text-indigo-500" />,
      fields: [] as { key: string; label: string; placeholder: string; type: "text" | "password" }[],
      isIntro: true,
    },
    {
      title: "Connect Twilio",
      subtitle: "Twilio handles your phone calls. Get your credentials from twilio.com/console.",
      icon: <Phone size={32} className="text-blue-500" />,
      service: "twilio",
      fields: [
        { key: "TWILIO_ACCOUNT_SID", label: "Account SID", placeholder: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", type: "text" as const },
        { key: "TWILIO_AUTH_TOKEN", label: "Auth Token", placeholder: "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", type: "password" as const },
        { key: "TWILIO_PHONE_NUMBER", label: "Phone Number", placeholder: "+15551234567", type: "text" as const },
      ],
    },
    {
      title: "Connect Gemini AI",
      subtitle: "Gemini powers the AI brain. Get your key from console.cloud.google.com → APIs → Gemini API.",
      icon: <Zap size={32} className="text-amber-500" />,
      service: "gemini",
      fields: [
        { key: "GEMINI_API_KEY", label: "Gemini API Key", placeholder: "AIza...", type: "password" as const },
      ],
    },
    {
      title: "Configure Twilio Webhook",
      subtitle: "Copy this URL into your Twilio phone number settings to start receiving calls.",
      icon: <Globe size={32} className="text-emerald-500" />,
      isWebhook: true,
      fields: [] as { key: string; label: string; placeholder: string; type: "text" | "password" }[],
    },
  ];

  const currentStep = steps[step];

  const handleTest = async () => {
    if (!currentStep.service) return;
    setTesting(true);
    setTestResult(null);
    try {
      const result = await api<{ ok: boolean; message?: string; error?: string }>(
        `/api/settings/test/${currentStep.service}`,
        { method: "POST", body: JSON.stringify(values) }
      );
      setTestResult(result);
    } catch (e: any) {
      setTestResult({ ok: false, error: e.message });
    } finally {
      setTesting(false);
    }
  };

  const handleNext = async () => {
    if (currentStep.fields.length > 0 && Object.keys(values).length > 0) {
      try {
        await api("/api/settings", { method: "POST", body: JSON.stringify(values) });
      } catch (e: any) {
        addToast({ type: "error", message: `Failed to save: ${e.message}` });
        return;
      }
    }
    if (step < steps.length - 1) {
      setStep(s => s + 1);
      setValues({});
      setTestResult(null);
    } else {
      onComplete();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className={`w-full max-w-lg rounded-2xl shadow-2xl border ${dark ? "bg-gray-900 border-gray-700" : "bg-white border-gray-200"}`}>
        <div className="flex gap-1 p-6 pb-0">
          {steps.map((_, i) => (
            <div key={i} className={`h-1 flex-1 rounded-full transition-all duration-300 ${i <= step ? "bg-indigo-500" : dark ? "bg-gray-700" : "bg-gray-200"}`} />
          ))}
        </div>

        <div className="p-6">
          <div className="flex items-center gap-4 mb-6">
            <div className={`p-3 rounded-xl ${dark ? "bg-gray-800" : "bg-gray-50"}`}>{currentStep.icon}</div>
            <div>
              <h2 className={`text-xl font-bold ${dark ? "text-white" : "text-gray-900"}`}>{currentStep.title}</h2>
              <p className={`text-sm mt-0.5 ${dark ? "text-gray-400" : "text-gray-500"}`}>{currentStep.subtitle}</p>
            </div>
          </div>

          {(currentStep as any).isWebhook && <WebhookDisplay />}

          {currentStep.fields.map(f => (
            <div key={f.key} className="mb-4">
              <label className={`block text-sm font-medium mb-1.5 ${dark ? "text-gray-300" : "text-gray-700"}`}>{f.label}</label>
              <input
                type={f.type}
                placeholder={f.placeholder}
                value={values[f.key] || ""}
                onChange={e => setValues(v => ({ ...v, [f.key]: e.target.value }))}
                className={`w-full px-3 py-2.5 rounded-lg border text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-colors ${
                  dark ? "bg-gray-800 border-gray-600 text-gray-100 placeholder-gray-500" : "bg-white border-gray-300 text-gray-900 placeholder-gray-400"
                }`}
              />
            </div>
          ))}

          {currentStep.service && (
            <div className="mb-4">
              <button
                onClick={handleTest}
                disabled={testing || currentStep.fields.some(f => !values[f.key])}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                  testing || currentStep.fields.some(f => !values[f.key])
                    ? "opacity-50 cursor-not-allowed bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-500"
                    : "bg-indigo-100 text-indigo-700 hover:bg-indigo-200 dark:bg-indigo-900/30 dark:text-indigo-400"
                }`}
              >
                {testing ? <Loader2 size={14} className="animate-spin" /> : <TestTube size={14} />}
                Test Connection
              </button>
              {testResult && (
                <div className={`mt-2 flex items-start gap-2 text-sm p-3 rounded-lg ${
                  testResult.ok ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-400" : "bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-400"
                }`}>
                  {testResult.ok ? <CheckCircle2 size={14} className="mt-0.5 shrink-0" /> : <AlertCircle size={14} className="mt-0.5 shrink-0" />}
                  {testResult.ok ? testResult.message : testResult.error}
                </div>
              )}
            </div>
          )}

          <div className="flex items-center justify-between mt-6 pt-4 border-t border-gray-200 dark:border-gray-700">
            <button onClick={onSkip} className={`text-sm ${dark ? "text-gray-500 hover:text-gray-300" : "text-gray-400 hover:text-gray-600"} transition-colors`}>
              Skip setup
            </button>
            <button
              onClick={handleNext}
              className="flex items-center gap-2 px-5 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-sm font-medium transition-colors"
            >
              {step === steps.length - 1 ? "Get Started" : "Continue"}
              <ChevronRight size={16} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Settings Page ─────────────────────────────────────────────────────────────
function SettingsPage() {
  const { dark } = useTheme();
  const { addToast } = useToast();
  const [groups, setGroups] = useState<SettingsGroup[]>([]);
  const [editValues, setEditValues] = useState<Record<string, string>>({});
  const [showSecrets, setShowSecrets] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; message?: string; error?: string }>>({});
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<ConfigStatus | null>(null);

  const serviceTestMap: Record<string, string> = {
    core: "gemini",
    openclaw: "openclaw",
    openrouter: "openrouter",
    google_calendar: "google_calendar",
  };

  useEffect(() => {
    api<{ groups: SettingsGroup[]; values: Record<string, string>; status: ConfigStatus }>("/api/settings")
      .then(d => {
        setGroups(d.groups);
        setEditValues(d.values);
        setStatus(d.status);
      })
      .catch(e => addToast({ type: "error", message: `Failed to load settings: ${e.message}` }))
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async (groupId: string, fields: SettingsField[]) => {
    setSaving(groupId);
    const updates: Record<string, string> = {};
    for (const f of fields) {
      const v = editValues[f.key] || "";
      if (!v.includes("•")) updates[f.key] = v;
    }
    try {
      const result = await api<{ ok: boolean; status: ConfigStatus }>("/api/settings", {
        method: "POST",
        body: JSON.stringify(updates),
      });
      setStatus(result.status);
      const fresh = await api<{ values: Record<string, string> }>("/api/settings");
      setEditValues(fresh.values);
      addToast({ type: "success", message: "Settings saved successfully." });
    } catch (e: any) {
      addToast({ type: "error", message: `Save failed: ${e.message}` });
    } finally {
      setSaving(null);
    }
  };

  const handleTest = async (groupId: string, fields: SettingsField[]) => {
    const service = serviceTestMap[groupId];
    if (!service) return;
    setTesting(groupId);
    const testBody: Record<string, string> = {};
    for (const f of fields) {
      const v = editValues[f.key] || "";
      if (!v.includes("•")) testBody[f.key] = v;
    }
    try {
      const result = await api<{ ok: boolean; message?: string; error?: string }>(
        `/api/settings/test/${service}`,
        { method: "POST", body: JSON.stringify(testBody) }
      );
      setTestResults(r => ({ ...r, [groupId]: result }));
      addToast({ type: result.ok ? "success" : "error", message: result.ok ? (result.message || "Connected!") : (result.error || "Connection failed") });
    } catch (e: any) {
      setTestResults(r => ({ ...r, [groupId]: { ok: false, error: e.message } }));
      addToast({ type: "error", message: e.message });
    } finally {
      setTesting(null);
    }
  };

  if (loading) {
    return <div className="flex items-center justify-center h-64"><Loader2 size={32} className="animate-spin text-indigo-500" /></div>;
  }

  const groupIcon = (id: string) => {
    if (id === "core") return <Key size={18} className="text-indigo-500" />;
    if (id === "deployment") return <Shield size={18} className="text-emerald-500" />;
    if (id === "openclaw") return <Bot size={18} className="text-purple-500" />;
    if (id === "openrouter") return <Zap size={18} className="text-amber-500" />;
    if (id === "google_calendar") return <Calendar size={18} className="text-blue-500" />;
    return <Sliders size={18} className="text-gray-500" />;
  };

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      {status && !status.isConfigured && (
        <div className={`rounded-xl p-4 flex items-start gap-3 ${dark ? "bg-amber-900/20 border border-amber-700/30" : "bg-amber-50 border border-amber-200"}`}>
          <AlertTriangle size={18} className="text-amber-500 mt-0.5 shrink-0" />
          <div>
            <p className={`text-sm font-semibold ${dark ? "text-amber-300" : "text-amber-800"}`}>Setup required</p>
            <p className={`text-sm mt-0.5 ${dark ? "text-amber-400" : "text-amber-700"}`}>Missing: {status.missingRequired.join(", ")}</p>
          </div>
        </div>
      )}

      {status?.warnings.map((w, i) => (
        <div key={i} className={`rounded-xl p-4 flex items-start gap-3 ${dark ? "bg-blue-900/20 border border-blue-700/30" : "bg-blue-50 border border-blue-200"}`}>
          <Info size={18} className="text-blue-500 mt-0.5 shrink-0" />
          <p className={`text-sm ${dark ? "text-blue-300" : "text-blue-700"}`}>{w}</p>
        </div>
      ))}

      {/* Webhook URL */}
      <div className={`rounded-2xl border p-5 ${dark ? "bg-gray-800/50 border-gray-700" : "bg-white border-gray-200"}`}>
        <div className="flex items-center gap-3 mb-4">
          <div className={`p-2 rounded-lg ${dark ? "bg-gray-700" : "bg-gray-100"}`}><Globe size={18} className="text-indigo-500" /></div>
          <div>
            <h3 className={`font-semibold ${dark ? "text-white" : "text-gray-900"}`}>Webhook URL</h3>
            <p className={`text-xs ${dark ? "text-gray-400" : "text-gray-500"}`}>Configure this in your Twilio phone number settings</p>
          </div>
        </div>
        <WebhookDisplay />
      </div>

      {groups.map(group => (
        <div key={group.id} className={`rounded-2xl border ${dark ? "bg-gray-800/50 border-gray-700" : "bg-white border-gray-200"}`}>
          <div className={`p-5 border-b ${dark ? "border-gray-700" : "border-gray-200"}`}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className={`p-2 rounded-lg ${dark ? "bg-gray-700" : "bg-gray-100"}`}>{groupIcon(group.id)}</div>
                <div>
                  <h3 className={`font-semibold ${dark ? "text-white" : "text-gray-900"}`}>
                    {group.label}
                    {group.required && <span className="ml-2 text-xs text-red-500">Required</span>}
                  </h3>
                  <p className={`text-xs ${dark ? "text-gray-400" : "text-gray-500"}`}>{group.description}</p>
                </div>
              </div>
              {testResults[group.id] && (
                <div className={`flex items-center gap-1.5 px-2 py-1 rounded-full text-xs font-medium ${
                  testResults[group.id].ok
                    ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400"
                    : "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
                }`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${testResults[group.id].ok ? "bg-emerald-500" : "bg-red-500"}`} />
                  {testResults[group.id].ok ? "Connected" : "Failed"}
                </div>
              )}
            </div>
          </div>

          <div className="p-5 space-y-4">
            {group.fields.map(field => (
              <div key={field.key}>
                <label className={`block text-sm font-medium mb-1.5 ${dark ? "text-gray-300" : "text-gray-700"}`}>
                  {field.label}
                  {field.required && <span className="text-red-500 ml-1">*</span>}
                </label>

                {field.type === "toggle" ? (
                  <label className="flex items-center gap-3 cursor-pointer">
                    <div
                      onClick={() => setEditValues(v => ({ ...v, [field.key]: v[field.key] === "true" ? "false" : "true" }))}
                      className={`relative w-11 h-6 rounded-full transition-colors cursor-pointer ${
                        editValues[field.key] === "true" ? "bg-indigo-600" : dark ? "bg-gray-600" : "bg-gray-300"
                      }`}
                    >
                      <span className={`absolute top-1 left-1 w-4 h-4 bg-white rounded-full shadow transition-transform ${
                        editValues[field.key] === "true" ? "translate-x-5" : ""
                      }`} />
                    </div>
                    <span className={`text-sm ${dark ? "text-gray-300" : "text-gray-600"}`}>
                      {editValues[field.key] === "true" ? "Enabled" : "Disabled"}
                    </span>
                  </label>
                ) : field.type === "textarea" ? (
                  <textarea
                    rows={4}
                    placeholder={field.placeholder}
                    value={editValues[field.key] || ""}
                    onChange={e => setEditValues(v => ({ ...v, [field.key]: e.target.value }))}
                    className={`w-full px-3 py-2.5 rounded-lg border text-sm font-mono resize-none focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-colors ${
                      dark ? "bg-gray-900 border-gray-600 text-gray-100 placeholder-gray-600" : "bg-white border-gray-300 text-gray-900 placeholder-gray-400"
                    }`}
                  />
                ) : (
                  <div className="relative">
                    <input
                      type={field.type === "password" && !showSecrets[field.key] ? "password" : "text"}
                      placeholder={field.placeholder}
                      value={editValues[field.key] || ""}
                      onChange={e => setEditValues(v => ({ ...v, [field.key]: e.target.value }))}
                      className={`w-full px-3 py-2.5 rounded-lg border text-sm font-mono pr-10 focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-colors ${
                        dark ? "bg-gray-900 border-gray-600 text-gray-100 placeholder-gray-600" : "bg-white border-gray-300 text-gray-900 placeholder-gray-400"
                      }`}
                    />
                    {field.type === "password" && (
                      <button
                        onClick={() => setShowSecrets(s => ({ ...s, [field.key]: !s[field.key] }))}
                        className={`absolute right-3 top-1/2 -translate-y-1/2 ${dark ? "text-gray-500 hover:text-gray-300" : "text-gray-400 hover:text-gray-600"}`}
                      >
                        {showSecrets[field.key] ? <EyeOff size={14} /> : <Eye size={14} />}
                      </button>
                    )}
                  </div>
                )}

                {field.help && (
                  <p className={`text-xs mt-1 ${dark ? "text-gray-500" : "text-gray-400"}`}>{field.help}</p>
                )}
              </div>
            ))}

            <div className="flex items-center gap-3 pt-2">
              <button
                onClick={() => handleSave(group.id, group.fields)}
                disabled={saving === group.id}
                className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-colors"
              >
                {saving === group.id ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                Save
              </button>
              {serviceTestMap[group.id] && (
                <button
                  onClick={() => handleTest(group.id, group.fields)}
                  disabled={testing === group.id}
                  className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                    dark ? "bg-gray-700 hover:bg-gray-600 text-gray-200" : "bg-gray-100 hover:bg-gray-200 text-gray-700"
                  }`}
                >
                  {testing === group.id ? <Loader2 size={14} className="animate-spin" /> : <TestTube size={14} />}
                  Test Connection
                </button>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Stat Card ─────────────────────────────────────────────────────────────────
function StatCard({ icon, label, value, sub, color }: {
  icon: React.ReactElement; label: string; value: string | number; sub?: string; color: string;
}) {
  const { dark } = useTheme();
  return (
    <div className={`rounded-2xl border p-5 ${dark ? "bg-gray-800/50 border-gray-700" : "bg-white border-gray-200"}`}>
      <div className="flex items-start justify-between">
        <div>
          <p className={`text-xs font-medium uppercase tracking-wide ${dark ? "text-gray-400" : "text-gray-500"}`}>{label}</p>
          <p className={`text-3xl font-bold mt-1 ${dark ? "text-white" : "text-gray-900"}`}>{value}</p>
          {sub && <p className={`text-xs mt-1 ${dark ? "text-gray-500" : "text-gray-400"}`}>{sub}</p>}
        </div>
        <div className={`p-3 rounded-xl ${color}`}>{icon}</div>
      </div>
    </div>
  );
}

// ── Call Row ──────────────────────────────────────────────────────────────────
function CallRow({ call, onSelect, selected }: { call: Call; onSelect: () => void; selected: boolean; [key: string]: any }) {
  const { dark } = useTheme();
  return (
    <div
      onClick={onSelect}
      className={`p-4 rounded-xl border cursor-pointer transition-all ${
        selected
          ? "border-indigo-500 bg-indigo-50 dark:bg-indigo-900/20"
          : dark ? "border-gray-700 bg-gray-800/50 hover:border-gray-600" : "border-gray-200 bg-white hover:border-gray-300"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className={`p-2 rounded-lg shrink-0 ${
            call.direction === "inbound"
              ? "bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400"
              : "bg-purple-100 text-purple-600 dark:bg-purple-900/30 dark:text-purple-400"
          }`}>
            {call.direction === "inbound" ? <PhoneIncoming size={14} /> : <PhoneOutgoing size={14} />}
          </div>
          <div className="min-w-0">
            <p className={`font-medium text-sm truncate ${dark ? "text-white" : "text-gray-900"}`}>
              {call.contact_name || fmt.phone(call.direction === "inbound" ? call.from_number : call.to_number)}
            </p>
            <p className={`text-xs ${dark ? "text-gray-400" : "text-gray-500"}`}>{fmt.date(call.started_at)}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {call.sentiment && <span className="text-base">{fmt.sentiment(call.sentiment)}</span>}
          <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
            call.status === "completed" ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400" :
            call.status === "in-progress" ? "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400" :
            "bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400"
          }`}>{call.status}</span>
          <span className={`text-xs ${dark ? "text-gray-400" : "text-gray-500"}`}>{fmt.duration(call.duration_seconds)}</span>
        </div>
      </div>
      {call.call_summary && (
        <p className={`text-xs mt-2 line-clamp-2 ${dark ? "text-gray-400" : "text-gray-500"}`}>{call.call_summary}</p>
      )}
    </div>
  );
}

// ── Call Detail Panel ─────────────────────────────────────────────────────────
function CallDetail({ call, onClose }: { call: Call; onClose: () => void }) {
  const { dark } = useTheme();
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api<Message[] | { messages: Message[] }>(`/api/calls/${call.call_sid}/messages`)
      .then(d => setMessages(Array.isArray(d) ? d : (d as any).messages || []))
      .catch(() => setMessages([]))
      .finally(() => setLoading(false));
  }, [call.call_sid]);

  return (
    <div className={`rounded-2xl border h-full flex flex-col ${dark ? "bg-gray-800/50 border-gray-700" : "bg-white border-gray-200"}`}>
      <div className={`flex items-center justify-between p-4 border-b ${dark ? "border-gray-700" : "border-gray-200"}`}>
        <div>
          <p className={`font-semibold ${dark ? "text-white" : "text-gray-900"}`}>
            {call.contact_name || fmt.phone(call.direction === "inbound" ? call.from_number : call.to_number)}
          </p>
          <p className={`text-xs ${dark ? "text-gray-400" : "text-gray-500"}`}>{fmt.date(call.started_at)} · {fmt.duration(call.duration_seconds)}</p>
        </div>
        <button onClick={onClose} className={`p-1.5 rounded-lg ${dark ? "hover:bg-gray-700 text-gray-400" : "hover:bg-gray-100 text-gray-500"}`}>
          <X size={16} />
        </button>
      </div>

      {call.call_summary && (
        <div className={`mx-4 mt-4 p-3 rounded-xl text-sm ${dark ? "bg-indigo-900/20 border border-indigo-700/30 text-indigo-300" : "bg-indigo-50 border border-indigo-100 text-indigo-700"}`}>
          <p className="font-medium text-xs mb-1 opacity-70">AI SUMMARY</p>
          {call.call_summary}
        </div>
      )}

      <div className="flex gap-2 px-4 py-3 flex-wrap">
        {call.intent && <span className={`text-xs px-2 py-1 rounded-full ${dark ? "bg-gray-700 text-gray-300" : "bg-gray-100 text-gray-600"}`}>Intent: {call.intent}</span>}
        {call.outcome && <span className={`text-xs px-2 py-1 rounded-full ${dark ? "bg-gray-700 text-gray-300" : "bg-gray-100 text-gray-600"}`}>Outcome: {call.outcome}</span>}
        {call.sentiment && <span className={`text-xs px-2 py-1 rounded-full ${dark ? "bg-gray-700 text-gray-300" : "bg-gray-100 text-gray-600"}`}>{fmt.sentiment(call.sentiment)} {call.sentiment}</span>}
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {loading ? (
          <div className="flex items-center justify-center h-20"><Loader2 size={20} className="animate-spin text-indigo-500" /></div>
        ) : messages.length === 0 ? (
          <p className={`text-sm text-center py-8 ${dark ? "text-gray-500" : "text-gray-400"}`}>No transcript available.</p>
        ) : (
          messages.map(m => (
            <div key={m.id} className={`flex ${m.role === "user" ? "justify-start" : "justify-end"}`}>
              <div className={`max-w-xs px-3 py-2 rounded-xl text-sm ${
                m.role === "user"
                  ? dark ? "bg-gray-700 text-gray-200" : "bg-gray-100 text-gray-800"
                  : "bg-indigo-600 text-white"
              }`}>
                <p className="text-xs opacity-60 mb-1">{m.role === "user" ? "Caller" : "AI Agent"}</p>
                {m.text}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ── Active Calls Bar ──────────────────────────────────────────────────────────
function ActiveCallsBar({ calls }: { calls: ActiveCall[] }) {
  const { dark } = useTheme();
  if (calls.length === 0) return null;
  return (
    <div className={`rounded-xl border p-3 mb-4 ${dark ? "bg-emerald-900/20 border-emerald-700/30" : "bg-emerald-50 border-emerald-200"}`}>
      <div className="flex items-center gap-2 mb-2">
        <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
        <span className={`text-sm font-semibold ${dark ? "text-emerald-300" : "text-emerald-800"}`}>{calls.length} Active Call{calls.length > 1 ? "s" : ""}</span>
      </div>
      <div className="flex flex-wrap gap-2">
        {calls.map(c => (
          <div key={c.call_sid} className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs border ${dark ? "bg-gray-800 text-gray-300 border-gray-700" : "bg-white text-gray-700 border-gray-200"}`}>
            <Phone size={12} className="text-emerald-500" />
            <span className="font-medium">{c.contact_name || fmt.phone(c.from_number)}</span>
            <span className={dark ? "text-gray-500" : "text-gray-400"}>Turn {c.turn_count}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Agent Config Page ─────────────────────────────────────────────────────────
function AgentConfigPage() {
  const { dark } = useTheme();
  const { addToast } = useToast();
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const [editing, setEditing] = useState<Partial<AgentConfig> | null>(null);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    api<AgentConfig[]>("/api/agents").then(setAgents).catch(() => {}).finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleSave = async () => {
    if (!editing) return;
    setSaving(true);
    try {
      if (editing.id) {
        await api(`/api/agents/${editing.id}`, { method: "PUT", body: JSON.stringify(editing) });
      } else {
        await api("/api/agents", { method: "POST", body: JSON.stringify(editing) });
      }
      addToast({ type: "success", message: "Agent saved." });
      setEditing(null);
      load();
    } catch (e: any) {
      addToast({ type: "error", message: e.message });
    } finally {
      setSaving(false);
    }
  };

  const handleActivate = async (id: number) => {
    try {
      await api(`/api/agents/${id}/activate`, { method: "PUT" });
      addToast({ type: "success", message: "Agent activated." });
      load();
    } catch (e: any) {
      addToast({ type: "error", message: e.message });
    }
  };

  if (loading) return <div className="flex items-center justify-center h-64"><Loader2 size={32} className="animate-spin text-indigo-500" /></div>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className={`text-lg font-bold ${dark ? "text-white" : "text-gray-900"}`}>Agent Configurations</h2>
        <button
          onClick={() => setEditing({ name: "", system_prompt: "", greeting: "Hello! How can I help you today?", voice: "Polly.Joanna", language: "en-US", max_turns: 20, vertical: "general" })}
          className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-sm font-medium transition-colors"
        >
          <Bot size={14} />
          New Agent
        </button>
      </div>

      {agents.map(agent => (
        <div key={agent.id} className={`rounded-2xl border p-5 ${dark ? "bg-gray-800/50 border-gray-700" : "bg-white border-gray-200"}`}>
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <h3 className={`font-semibold ${dark ? "text-white" : "text-gray-900"}`}>{agent.name}</h3>
                {agent.is_active === 1 && <span className="px-2 py-0.5 text-xs font-medium bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 rounded-full">Active</span>}
              </div>
              <p className={`text-sm ${dark ? "text-gray-400" : "text-gray-500"}`}>{agent.greeting}</p>
              <div className={`flex gap-3 mt-2 text-xs ${dark ? "text-gray-500" : "text-gray-400"}`}>
                <span>Voice: {agent.voice}</span>
                <span>Max turns: {agent.max_turns}</span>
                <span>Vertical: {agent.vertical}</span>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {agent.is_active !== 1 && (
                <button onClick={() => handleActivate(agent.id)} className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${dark ? "bg-gray-700 hover:bg-gray-600 text-gray-200" : "bg-gray-100 hover:bg-gray-200 text-gray-700"}`}>
                  Activate
                </button>
              )}
              <button onClick={() => setEditing(agent)} className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${dark ? "bg-gray-700 hover:bg-gray-600 text-gray-200" : "bg-gray-100 hover:bg-gray-200 text-gray-700"}`}>
                Edit
              </button>
            </div>
          </div>
        </div>
      ))}

      {agents.length === 0 && (
        <div className={`rounded-2xl border-2 border-dashed p-12 text-center ${dark ? "border-gray-700" : "border-gray-200"}`}>
          <Bot size={40} className={`mx-auto mb-3 ${dark ? "text-gray-600" : "text-gray-300"}`} />
          <p className={`font-medium ${dark ? "text-gray-400" : "text-gray-500"}`}>No agents configured yet</p>
          <p className={`text-sm mt-1 ${dark ? "text-gray-600" : "text-gray-400"}`}>Create your first agent to start handling calls</p>
        </div>
      )}

      {editing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className={`w-full max-w-2xl rounded-2xl shadow-2xl border max-h-[90vh] flex flex-col ${dark ? "bg-gray-900 border-gray-700" : "bg-white border-gray-200"}`}>
            <div className={`flex items-center justify-between p-6 border-b ${dark ? "border-gray-700" : "border-gray-200"}`}>
              <h3 className={`text-lg font-bold ${dark ? "text-white" : "text-gray-900"}`}>{editing.id ? "Edit Agent" : "New Agent"}</h3>
              <button onClick={() => setEditing(null)} className={`p-1.5 rounded-lg ${dark ? "hover:bg-gray-800 text-gray-400" : "hover:bg-gray-100 text-gray-500"}`}><X size={18} /></button>
            </div>
            <div className="overflow-y-auto p-6 space-y-4">
              {[
                { key: "name", label: "Agent Name", placeholder: "e.g. Sales Agent" },
                { key: "greeting", label: "Greeting Message", placeholder: "Hello! How can I help you today?" },
                { key: "voice", label: "Voice", placeholder: "Polly.Joanna" },
                { key: "language", label: "Language", placeholder: "en-US" },
                { key: "vertical", label: "Vertical", placeholder: "general, sales, support..." },
              ].map(f => (
                <div key={f.key}>
                  <label className={`block text-sm font-medium mb-1.5 ${dark ? "text-gray-300" : "text-gray-700"}`}>{f.label}</label>
                  <input
                    type="text"
                    placeholder={f.placeholder}
                    value={(editing as any)[f.key] || ""}
                    onChange={e => setEditing(v => ({ ...v!, [f.key]: e.target.value }))}
                    className={`w-full px-3 py-2.5 rounded-lg border text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 ${dark ? "bg-gray-800 border-gray-600 text-gray-100 placeholder-gray-500" : "bg-white border-gray-300 text-gray-900 placeholder-gray-400"}`}
                  />
                </div>
              ))}
              <div>
                <label className={`block text-sm font-medium mb-1.5 ${dark ? "text-gray-300" : "text-gray-700"}`}>Max Turns</label>
                <input
                  type="number" min={3} max={50}
                  value={editing.max_turns || 20}
                  onChange={e => setEditing(v => ({ ...v!, max_turns: parseInt(e.target.value) }))}
                  className={`w-full px-3 py-2.5 rounded-lg border text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 ${dark ? "bg-gray-800 border-gray-600 text-gray-100" : "bg-white border-gray-300 text-gray-900"}`}
                />
              </div>
              <div>
                <label className={`block text-sm font-medium mb-1.5 ${dark ? "text-gray-300" : "text-gray-700"}`}>System Prompt</label>
                <textarea
                  rows={8}
                  placeholder="You are a helpful AI phone agent for..."
                  value={editing.system_prompt || ""}
                  onChange={e => setEditing(v => ({ ...v!, system_prompt: e.target.value }))}
                  className={`w-full px-3 py-2.5 rounded-lg border text-sm resize-none focus:outline-none focus:ring-2 focus:ring-indigo-500 ${dark ? "bg-gray-800 border-gray-600 text-gray-100 placeholder-gray-500" : "bg-white border-gray-300 text-gray-900 placeholder-gray-400"}`}
                />
              </div>
            </div>
            <div className={`flex justify-end gap-3 p-6 border-t ${dark ? "border-gray-700" : "border-gray-200"}`}>
              <button onClick={() => setEditing(null)} className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${dark ? "bg-gray-800 hover:bg-gray-700 text-gray-300" : "bg-gray-100 hover:bg-gray-200 text-gray-700"}`}>Cancel</button>
              <button onClick={handleSave} disabled={saving} className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-colors">
                {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                Save Agent
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Logs Page ─────────────────────────────────────────────────────────────────
function LogsPage() {
  const { dark } = useTheme();
  const [logs, setLogs] = useState<RequestLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    api<RequestLog[]>("/api/logs").then(setLogs).catch(() => {}).finally(() => setLoading(false));
  }, []);

  const filtered = logs.filter(l =>
    !filter || l.path.includes(filter) || l.method.includes(filter.toUpperCase()) || String(l.status_code).includes(filter)
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <h2 className={`text-lg font-bold ${dark ? "text-white" : "text-gray-900"}`}>Request Logs</h2>
        <input
          type="text"
          placeholder="Filter by path, method, status..."
          value={filter}
          onChange={e => setFilter(e.target.value)}
          className={`px-3 py-2 rounded-lg border text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 ${dark ? "bg-gray-800 border-gray-600 text-gray-100 placeholder-gray-500" : "bg-white border-gray-300 text-gray-900 placeholder-gray-400"}`}
        />
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-32"><Loader2 size={24} className="animate-spin text-indigo-500" /></div>
      ) : (
        <div className={`rounded-2xl border overflow-hidden ${dark ? "border-gray-700" : "border-gray-200"}`}>
          <table className="w-full text-sm">
            <thead>
              <tr className={dark ? "bg-gray-800 text-gray-400" : "bg-gray-50 text-gray-500"}>
                {["Method", "Path", "Status", "Duration", "Time"].map(h => (
                  <th key={h} className="px-4 py-3 text-left font-medium">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.slice(0, 100).map((log) => (
                <tr key={log.id} className={`border-t ${dark ? "border-gray-700 hover:bg-gray-800/50" : "border-gray-100 hover:bg-gray-50"} transition-colors`}>
                  <td className="px-4 py-2.5">
                    <span className={`px-2 py-0.5 rounded text-xs font-mono font-bold ${
                      log.method === "GET" ? "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400" :
                      log.method === "POST" ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400" :
                      "bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300"
                    }`}>{log.method}</span>
                  </td>
                  <td className={`px-4 py-2.5 font-mono text-xs ${dark ? "text-gray-300" : "text-gray-700"}`}>{log.path}</td>
                  <td className="px-4 py-2.5">
                    <span className={`text-xs font-mono font-bold ${
                      log.status_code < 300 ? "text-emerald-600 dark:text-emerald-400" :
                      log.status_code < 400 ? "text-blue-600 dark:text-blue-400" :
                      log.status_code < 500 ? "text-amber-600 dark:text-amber-400" :
                      "text-red-600 dark:text-red-400"
                    }`}>{log.status_code}</span>
                  </td>
                  <td className={`px-4 py-2.5 text-xs ${dark ? "text-gray-400" : "text-gray-500"}`}>{log.duration_ms}ms</td>
                  <td className={`px-4 py-2.5 text-xs ${dark ? "text-gray-500" : "text-gray-400"}`}>{fmt.date(log.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {filtered.length === 0 && (
            <div className={`py-12 text-center ${dark ? "text-gray-500" : "text-gray-400"}`}>
              <Database size={32} className="mx-auto mb-2 opacity-30" />
              <p className="text-sm">No logs found</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main App ──────────────────────────────────────────────────────────────────
export default function App() {
  const [dark, setDark] = useState(() => {
    try {
      const stored = localStorage.getItem("theme");
      if (stored) return stored === "dark";
      return window.matchMedia("(prefers-color-scheme: dark)").matches;
    } catch { return false; }
  });

  const toggleDark = useCallback(() => {
    setDark(d => {
      const next = !d;
      try { localStorage.setItem("theme", next ? "dark" : "light"); } catch {}
      return next;
    });
  }, []);

  const [toasts, setToasts] = useState<Toast[]>([]);
  const addToast = useCallback((t: Omit<Toast, "id">) => {
    const id = Math.random().toString(36).slice(2);
    setToasts(ts => [...ts, { ...t, id }]);
    setTimeout(() => setToasts(ts => ts.filter(x => x.id !== id)), 5000);
  }, []);
  const removeToast = useCallback((id: string) => setToasts(ts => ts.filter(t => t.id !== id)), []);

  const [tab, setTab] = useState<Tab>("dashboard");
  const [stats, setStats] = useState<Stats | null>(null);
  const [calls, setCalls] = useState<Call[]>([]);
  const [activeCalls, setActiveCalls] = useState<ActiveCall[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selectedCall, setSelectedCall] = useState<Call | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);
  const [configStatus, setConfigStatus] = useState<ConfigStatus | null>(null);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [outboundNumber, setOutboundNumber] = useState("");
  const [calling, setCalling] = useState(false);
  const [openTaskCount, setOpenTaskCount] = useState(0);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);

  useEffect(() => {
    api<ConfigStatus>("/api/config-status")
      .then(s => {
        setConfigStatus(s);
        try {
          if (!s.isConfigured && !localStorage.getItem("onboarding-dismissed")) {
            setShowOnboarding(true);
          }
        } catch {}
      })
      .catch(() => {});
  }, []);

  const pollData = useCallback(async () => {
    try {
      const [s, c, a] = await Promise.all([
        api<Stats>("/api/stats"),
        api<Call[]>("/api/calls?limit=50"),
        api<ActiveCall[]>("/api/calls/active"),
      ]);
      setStats(s);
      setCalls(c);
      setActiveCalls(a);
      setApiError(null);
      const openCount = Number(s.open_tasks ?? s.openTasks ?? 0);
      setOpenTaskCount(openCount);
    } catch (e: any) {
      setApiError(e.message);
    }
  }, []);

  useEffect(() => {
    pollData();
    const interval = setInterval(pollData, 5000);
    return () => clearInterval(interval);
  }, [pollData]);

  useEffect(() => {
    if (tab === "contacts") {
      api<Contact[] | { contacts: Contact[] }>("/api/contacts")
        .then(d => setContacts(Array.isArray(d) ? d : (d as any).contacts || []))
        .catch(() => {});
    } else if (tab === "tasks") {
      api<Task[]>("/api/tasks").then(setTasks).catch(() => {});
    }
  }, [tab]);

  const makeOutboundCall = async () => {
    if (!outboundNumber) return;
    setCalling(true);
    try {
      await api("/api/calls/outbound", { method: "POST", body: JSON.stringify({ to: outboundNumber }) });
      addToast({ type: "success", message: `Calling ${fmt.phone(outboundNumber)}...` });
      setOutboundNumber("");
    } catch (e: any) {
      addToast({ type: "error", message: e.message });
    } finally {
      setCalling(false);
    }
  };

  const tabs: { id: Tab; label: string; icon: React.ReactElement; badge?: number }[] = [
    { id: "dashboard", label: "Dashboard", icon: <BarChart3 size={16} /> },
    { id: "calls", label: "Calls", icon: <Phone size={16} /> },
    { id: "contacts", label: "Contacts", icon: <Users size={16} /> },
    { id: "tasks", label: "Tasks", icon: <ListTodo size={16} />, badge: openTaskCount > 0 ? openTaskCount : undefined },
    { id: "agents", label: "Agent Config", icon: <Bot size={16} /> },
    { id: "settings", label: "Settings", icon: <Settings size={16} /> },
    { id: "logs", label: "Logs", icon: <Activity size={16} /> },
  ];

  const totalCalls = Number(stats?.total_calls ?? stats?.totalCalls ?? "—");
  const callsToday = Number(stats?.calls_today ?? stats?.callsToday ?? "—");
  const avgDuration = stats?.avg_duration ?? stats?.avgDurationSeconds ?? null;

  return (
    <ThemeContext.Provider value={{ dark, toggle: toggleDark }}>
      <ToastContext.Provider value={{ addToast }}>
        <div className={`min-h-screen ${dark ? "bg-gray-950 text-gray-100" : "bg-gray-50 text-gray-900"}`}>

          {showOnboarding && (
            <OnboardingWizard
              onComplete={() => {
                setShowOnboarding(false);
                try { localStorage.setItem("onboarding-dismissed", "1"); } catch {}
                addToast({ type: "success", message: "Setup complete! Your AI phone agent is ready." });
              }}
              onSkip={() => {
                setShowOnboarding(false);
                try { localStorage.setItem("onboarding-dismissed", "1"); } catch {}
              }}
            />
          )}

          {/* Header */}
          <header className={`sticky top-0 z-40 border-b ${dark ? "bg-gray-900/95 border-gray-800" : "bg-white/95 border-gray-200"} backdrop-blur-sm`}>
            <div className="max-w-7xl mx-auto px-4 sm:px-6">
              <div className="flex items-center justify-between h-14">
                <div className="flex items-center gap-3">
                  <div className="p-1.5 rounded-lg bg-indigo-600">
                    <Phone size={16} className="text-white" />
                  </div>
                  <span className={`font-bold text-sm ${dark ? "text-white" : "text-gray-900"}`}>AI Phone Agent</span>
                  {activeCalls.length > 0 && (
                    <span className="flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                      {activeCalls.length} live
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  {apiError && (
                    <div className="flex items-center gap-1.5 px-2 py-1 rounded-full text-xs font-medium bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400">
                      <WifiOff size={12} />
                      Offline
                    </div>
                  )}
                  {configStatus && !configStatus.isConfigured && (
                    <button
                      onClick={() => setShowOnboarding(true)}
                      className="flex items-center gap-1.5 px-2 py-1 rounded-full text-xs font-medium bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 hover:opacity-80 transition-opacity"
                    >
                      <AlertTriangle size={12} />
                      Setup needed
                    </button>
                  )}
                  <button
                    onClick={toggleDark}
                    className={`p-2 rounded-lg transition-colors ${dark ? "hover:bg-gray-800 text-gray-400 hover:text-gray-200" : "hover:bg-gray-100 text-gray-500 hover:text-gray-700"}`}
                    title={dark ? "Light mode" : "Dark mode"}
                  >
                    {dark ? <Sun size={16} /> : <Moon size={16} />}
                  </button>
                </div>
              </div>

              {/* Tab Navigation */}
              <div className="flex gap-0.5 overflow-x-auto">
                {tabs.map(t => (
                  <button
                    key={t.id}
                    onClick={() => setTab(t.id)}
                    className={`flex items-center gap-1.5 px-3 py-2.5 text-sm font-medium border-b-2 transition-all whitespace-nowrap ${
                      tab === t.id
                        ? "border-indigo-500 text-indigo-600 dark:text-indigo-400"
                        : `border-transparent ${dark ? "text-gray-400 hover:text-gray-200" : "text-gray-500 hover:text-gray-700"}`
                    }`}
                  >
                    {t.icon}
                    {t.label}
                    {t.badge !== undefined && (
                      <span className="px-1.5 py-0.5 rounded-full text-xs bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400">
                        {t.badge}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          </header>

          {/* API Error Banner */}
          {apiError && (
            <div className="bg-red-600 text-white text-sm px-4 py-2 text-center">
              <span className="font-medium">Connection lost:</span> {apiError} — Retrying automatically...
            </div>
          )}

          {/* Main Content */}
          <main className="max-w-7xl mx-auto px-4 sm:px-6 py-6">

            {tab === "dashboard" && (
              <div className="space-y-6">
                <ActiveCallsBar calls={activeCalls} />

                <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                  <StatCard icon={<Phone size={20} className="text-indigo-500" />} label="Total Calls" value={isNaN(totalCalls) ? "—" : totalCalls} color="bg-indigo-100 dark:bg-indigo-900/30" />
                  <StatCard icon={<TrendingUp size={20} className="text-emerald-500" />} label="Calls Today" value={isNaN(callsToday) ? "—" : callsToday} color="bg-emerald-100 dark:bg-emerald-900/30" />
                  <StatCard icon={<Clock size={20} className="text-amber-500" />} label="Avg Duration" value={fmt.duration(avgDuration)} color="bg-amber-100 dark:bg-amber-900/30" />
                  <StatCard icon={<ListTodo size={20} className="text-red-500" />} label="Open Tasks" value={openTaskCount || "—"} color="bg-red-100 dark:bg-red-900/30" />
                </div>

                <div className={`rounded-2xl border p-5 ${dark ? "bg-gray-800/50 border-gray-700" : "bg-white border-gray-200"}`}>
                  <h3 className={`font-semibold mb-3 ${dark ? "text-white" : "text-gray-900"}`}>Make Outbound Call</h3>
                  <div className="flex gap-3">
                    <input
                      type="tel"
                      placeholder="+15551234567"
                      value={outboundNumber}
                      onChange={e => setOutboundNumber(e.target.value)}
                      onKeyDown={e => e.key === "Enter" && makeOutboundCall()}
                      className={`flex-1 px-3 py-2.5 rounded-lg border text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500 ${dark ? "bg-gray-900 border-gray-600 text-gray-100 placeholder-gray-500" : "bg-white border-gray-300 text-gray-900 placeholder-gray-400"}`}
                    />
                    <button
                      onClick={makeOutboundCall}
                      disabled={calling || !outboundNumber}
                      className="flex items-center gap-2 px-5 py-2.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-colors"
                    >
                      {calling ? <Loader2 size={14} className="animate-spin" /> : <Phone size={14} />}
                      Call
                    </button>
                  </div>
                </div>

                <div>
                  <h3 className={`font-semibold mb-3 ${dark ? "text-white" : "text-gray-900"}`}>Recent Calls</h3>
                  <div className="space-y-2">
                    {calls.slice(0, 5).map(c => (
                      <CallRow key={c.id} call={c} onSelect={() => { setSelectedCall(c); setTab("calls"); }} selected={false} />
                    ))}
                    {calls.length === 0 && (
                      <div className={`rounded-2xl border-2 border-dashed p-12 text-center ${dark ? "border-gray-700" : "border-gray-200"}`}>
                        <Phone size={40} className={`mx-auto mb-3 ${dark ? "text-gray-600" : "text-gray-300"}`} />
                        <p className={`font-medium ${dark ? "text-gray-400" : "text-gray-500"}`}>No calls yet</p>
                        <p className={`text-sm mt-1 ${dark ? "text-gray-600" : "text-gray-400"}`}>
                          Configure your Twilio webhook in Settings to start receiving calls
                        </p>
                        <button
                          onClick={() => setTab("settings")}
                          className="mt-4 inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-sm font-medium transition-colors"
                        >
                          <Settings size={14} />
                          Open Settings
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {tab === "calls" && (
              <div className={`grid gap-4 ${selectedCall ? "grid-cols-1 lg:grid-cols-2" : "grid-cols-1"}`}>
                <div className="space-y-2">
                  <ActiveCallsBar calls={activeCalls} />
                  {calls.map(c => (
                    <CallRow key={c.id} call={c} onSelect={() => setSelectedCall(c)} selected={selectedCall?.id === c.id} />
                  ))}
                  {calls.length === 0 && (
                    <div className={`rounded-2xl border-2 border-dashed p-16 text-center ${dark ? "border-gray-700" : "border-gray-200"}`}>
                      <Phone size={48} className={`mx-auto mb-4 ${dark ? "text-gray-600" : "text-gray-300"}`} />
                      <p className={`font-medium text-lg ${dark ? "text-gray-400" : "text-gray-500"}`}>No calls yet</p>
                    </div>
                  )}
                </div>
                {selectedCall && (
                  <div className="lg:sticky lg:top-20 h-fit">
                    <CallDetail call={selectedCall} onClose={() => setSelectedCall(null)} />
                  </div>
                )}
              </div>
            )}

            {tab === "contacts" && (
              <div className="space-y-3">
                {contacts.map(c => (
                  <div key={c.id} className={`rounded-2xl border p-4 ${dark ? "bg-gray-800/50 border-gray-700" : "bg-white border-gray-200"}`}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-center gap-3">
                        <div className={`w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold shrink-0 ${dark ? "bg-gray-700 text-gray-300" : "bg-gray-100 text-gray-600"}`}>
                          {(c.name || c.phone_number)[0].toUpperCase()}
                        </div>
                        <div>
                          <p className={`font-medium ${dark ? "text-white" : "text-gray-900"}`}>{c.name || "Unknown"}</p>
                          <p className={`text-sm font-mono ${dark ? "text-gray-400" : "text-gray-500"}`}>{fmt.phone(c.phone_number)}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 text-xs shrink-0">
                        {c.do_not_call === 1 && <span className="px-2 py-0.5 rounded-full bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400 font-medium">DNC</span>}
                        <span className={dark ? "text-gray-400" : "text-gray-500"}>{c.total_calls} call{c.total_calls !== 1 ? "s" : ""}</span>
                        {c.open_tasks_count > 0 && (
                          <span className="px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 font-medium">{c.open_tasks_count} task{c.open_tasks_count !== 1 ? "s" : ""}</span>
                        )}
                      </div>
                    </div>
                    {c.last_summary && (
                      <p className={`text-xs mt-2 ml-13 ${dark ? "text-gray-500" : "text-gray-400"}`}>{c.last_summary}</p>
                    )}
                  </div>
                ))}
                {contacts.length === 0 && (
                  <div className={`rounded-2xl border-2 border-dashed p-16 text-center ${dark ? "border-gray-700" : "border-gray-200"}`}>
                    <Users size={48} className={`mx-auto mb-4 ${dark ? "text-gray-600" : "text-gray-300"}`} />
                    <p className={`font-medium text-lg ${dark ? "text-gray-400" : "text-gray-500"}`}>No contacts yet</p>
                  </div>
                )}
              </div>
            )}

            {tab === "tasks" && (
              <div className="space-y-3">
                {tasks.map(t => (
                  <div key={t.id} className={`rounded-2xl border p-4 ${dark ? "bg-gray-800/50 border-gray-700" : "bg-white border-gray-200"}`}>
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="flex items-center gap-2 mb-1">
                          <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                            t.status === "open" ? "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400" :
                            t.status === "completed" ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400" :
                            "bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400"
                          }`}>{t.status}</span>
                          <span className={`text-xs font-medium ${dark ? "text-gray-300" : "text-gray-700"}`}>{t.task_type.replace(/_/g, " ")}</span>
                        </div>
                        {t.contact_name && <p className={`text-sm ${dark ? "text-gray-400" : "text-gray-500"}`}>{t.contact_name}{t.phone_number ? ` · ${fmt.phone(t.phone_number)}` : ""}</p>}
                        {t.notes && <p className={`text-sm mt-1 ${dark ? "text-gray-400" : "text-gray-600"}`}>{t.notes}</p>}
                      </div>
                      <div className="text-right shrink-0">
                        {t.due_at && <p className={`text-xs ${dark ? "text-gray-500" : "text-gray-400"}`}>Due {fmt.date(t.due_at)}</p>}
                        <p className={`text-xs ${dark ? "text-gray-600" : "text-gray-400"}`}>{fmt.date(t.created_at)}</p>
                      </div>
                    </div>
                  </div>
                ))}
                {tasks.length === 0 && (
                  <div className={`rounded-2xl border-2 border-dashed p-16 text-center ${dark ? "border-gray-700" : "border-gray-200"}`}>
                    <ListTodo size={48} className={`mx-auto mb-4 ${dark ? "text-gray-600" : "text-gray-300"}`} />
                    <p className={`font-medium text-lg ${dark ? "text-gray-400" : "text-gray-500"}`}>No tasks yet</p>
                  </div>
                )}
              </div>
            )}

            {tab === "agents" && <AgentConfigPage />}
            {tab === "settings" && <SettingsPage />}
            {tab === "logs" && <LogsPage />}

          </main>
        </div>

        <ToastContainer toasts={toasts} remove={removeToast} />
      </ToastContext.Provider>
    </ThemeContext.Provider>
  );
}
