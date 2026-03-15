/**
 * SMIRK Platform — Dashboard v3.0
 * Industrial dark design system, 9-agent roster, full UX overhaul
 */
import React, { useState, useCallback, useEffect, createContext, useContext, useRef } from "react";
import {
  Phone, PhoneIncoming, PhoneOutgoing, Activity, BarChart3, Bot,
  Settings, Clock, Zap, Users, ListTodo,
  AlertTriangle, User, Calendar, TrendingUp, Wrench,
  Moon, Sun, Eye, EyeOff, Save, X, CheckCircle2, Info, AlertCircle,
  WifiOff, ChevronRight, Loader2, Copy, Shield,
  Database, Globe, Key, Sliders, TestTube,
  Layers, Pencil, Trash2, Check, RefreshCw, Plus,
  ChevronDown, MessageSquare, Tag, Star, ArrowUpRight,
  Building2, Scale, Sparkles, Briefcase, Home, DollarSign,
  Headphones, Radio, Send, PhoneMissed, PhoneCall,
} from "lucide-react";

// ── Theme Context ─────────────────────────────────────────────────────────────
const ThemeContext = createContext<{ dark: boolean; toggle: () => void }>({ dark: true, toggle: () => {} });
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
  display_name?: string;
  tagline?: string;
  system_prompt: string;
  greeting: string;
  voice: string;
  language: string;
  vertical: string;
  tier?: string;
  color?: string;
  max_turns: number;
  is_active: number;
  tool_permissions?: string;
  routing_keywords?: string;
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
      const v = (stats as Record<string, unknown>)[k];
      if (v !== undefined && v !== null) return v as string | number;
    }
    return "—";
  },
};

// ── Agent Metadata ────────────────────────────────────────────────────────────
const AGENT_META: Record<string, { icon: React.ReactElement; accentColor: string; bgGradient: string }> = {
  SMIRK:  { icon: <Sparkles size={20} />, accentColor: "#a78bfa", bgGradient: "from-violet-900/40 to-purple-900/20" },
  FORGE:  { icon: <Wrench size={20} />,   accentColor: "#f97316", bgGradient: "from-orange-900/40 to-amber-900/20" },
  GRIT:   { icon: <Building2 size={20} />, accentColor: "#f59e0b", bgGradient: "from-amber-900/40 to-yellow-900/20" },
  LEX:    { icon: <Scale size={20} />,    accentColor: "#60a5fa", bgGradient: "from-blue-900/40 to-indigo-900/20" },
  VELVET: { icon: <Star size={20} />,     accentColor: "#f472b6", bgGradient: "from-pink-900/40 to-rose-900/20" },
  LEDGER: { icon: <DollarSign size={20} />, accentColor: "#34d399", bgGradient: "from-emerald-900/40 to-green-900/20" },
  HAVEN:  { icon: <Home size={20} />,     accentColor: "#38bdf8", bgGradient: "from-sky-900/40 to-cyan-900/20" },
  ATLAS:  { icon: <Globe size={20} />,    accentColor: "#a3e635", bgGradient: "from-lime-900/40 to-green-900/20" },
  ECHO:   { icon: <Radio size={20} />,    accentColor: "#fb923c", bgGradient: "from-orange-900/40 to-red-900/20" },
};

// ── Toast Component ───────────────────────────────────────────────────────────
function ToastContainer({ toasts, remove }: { toasts: Toast[]; remove: (id: string) => void }) {
  return (
    <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-2 pointer-events-none">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`pointer-events-auto flex items-start gap-3 px-4 py-3 rounded-xl shadow-2xl border max-w-sm backdrop-blur-sm ${
            t.type === "success" ? "bg-emerald-950/90 border-emerald-700 text-emerald-300" :
            t.type === "error"   ? "bg-red-950/90 border-red-700 text-red-300" :
            t.type === "warning" ? "bg-amber-950/90 border-amber-700 text-amber-300" :
                                   "bg-blue-950/90 border-blue-700 text-blue-300"
          }`}
        >
          {t.type === "success" ? <CheckCircle2 size={16} className="mt-0.5 shrink-0" /> :
           t.type === "error"   ? <AlertCircle size={16} className="mt-0.5 shrink-0" /> :
           t.type === "warning" ? <AlertTriangle size={16} className="mt-0.5 shrink-0" /> :
                                  <Info size={16} className="mt-0.5 shrink-0" />}
          <span className="text-sm font-medium flex-1">{t.message}</span>
          <button onClick={() => remove(t.id)} className="shrink-0 opacity-60 hover:opacity-100 transition-opacity">
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

// ── Connection Status Badge ───────────────────────────────────────────────────
function StatusBadge({ activeCalls, apiError, configStatus, onSetupClick }: {
  activeCalls: ActiveCall[];
  apiError: boolean;
  configStatus: ConfigStatus | null;
  onSetupClick: () => void;
}) {
  if (apiError) return (
    <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-red-950 border border-red-800 text-red-400 text-xs font-medium">
      <WifiOff size={12} />
      <span>Offline</span>
    </div>
  );
  if (configStatus && !configStatus.isConfigured) return (
    <button onClick={onSetupClick} className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-amber-950 border border-amber-800 text-amber-400 text-xs font-medium hover:bg-amber-900 transition-colors">
      <AlertTriangle size={12} />
      <span>Setup needed</span>
    </button>
  );
  if (activeCalls.length > 0) return (
    <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-emerald-950 border border-emerald-800 text-emerald-400 text-xs font-medium">
      <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
      <span>{activeCalls.length} live</span>
    </div>
  );
  return (
    <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-gray-900 border border-gray-700 text-gray-500 text-xs font-medium">
      <span className="w-2 h-2 rounded-full bg-gray-600" />
      <span>Ready</span>
    </div>
  );
}

// ── Stat Card ─────────────────────────────────────────────────────────────────
function StatCard({ label, value, icon, accent = "#a78bfa", sub }: {
  label: string;
  value: string | number;
  icon: React.ReactNode;
  accent?: string;
  sub?: string;
}) {
  return (
    <div className="relative overflow-hidden rounded-2xl bg-gray-900 border border-gray-800 p-5 group hover:border-gray-700 transition-all duration-200">
      <div className="absolute top-0 right-0 w-24 h-24 rounded-full opacity-10 blur-2xl" style={{ background: accent, transform: "translate(30%, -30%)" }} />
      <div className="flex items-start justify-between mb-3">
        <div className="p-2 rounded-xl bg-gray-800 border border-gray-700" style={{ color: accent }}>
          {icon}
        </div>
      </div>
      <div className="text-2xl font-bold text-white mb-0.5">{value}</div>
      <div className="text-xs text-gray-500 font-medium uppercase tracking-wider">{label}</div>
      {sub && <div className="text-xs text-gray-600 mt-1">{sub}</div>}
    </div>
  );
}

// ── Active Call Bar ───────────────────────────────────────────────────────────
function ActiveCallBar({ calls }: { calls: ActiveCall[] }) {
  if (calls.length === 0) return null;
  return (
    <div className="mx-4 mb-3 rounded-xl bg-emerald-950/60 border border-emerald-800/60 backdrop-blur-sm overflow-hidden">
      {calls.map((c) => (
        <div key={c.call_sid} className="flex items-center gap-3 px-4 py-2.5">
          <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse shrink-0" />
          <PhoneCall size={14} className="text-emerald-400 shrink-0" />
          <span className="text-emerald-300 text-sm font-medium flex-1">
            {c.contact_name || fmt.phone(c.from_number)} — {c.turn_count} turns
          </span>
          <span className="text-emerald-600 text-xs">{fmt.date(c.started_at)}</span>
        </div>
      ))}
    </div>
  );
}

// ── Dashboard Page ────────────────────────────────────────────────────────────
function DashboardPage({ stats, activeCalls, recentCalls, onCallClick, onTabChange }: {
  stats: Stats | null;
  activeCalls: ActiveCall[];
  recentCalls: Call[];
  onCallClick: (c: Call) => void;
  onTabChange: (t: Tab) => void;
}) {
  const { addToast } = useToast();
  const [dialNumber, setDialNumber] = useState("");
  const [dialing, setDialing] = useState(false);

  const makeCall = async () => {
    if (!dialNumber.trim()) return;
    setDialing(true);
    try {
      await api("/api/calls", { method: "POST", body: JSON.stringify({ to: dialNumber }) });
      addToast({ type: "success", message: `Calling ${fmt.phone(dialNumber)}…` });
      setDialNumber("");
    } catch (e: unknown) {
      addToast({ type: "error", message: e instanceof Error ? e.message : "Call failed" });
    } finally {
      setDialing(false);
    }
  };

  const totalCalls = fmt.stat(stats, "totalCalls", "total_calls");
  const callsToday = fmt.stat(stats, "callsToday", "calls_today");
  const totalContacts = fmt.stat(stats, "totalContacts", "total_contacts");
  const openTasks = fmt.stat(stats, "openTasks", "open_tasks");
  const avgDuration = stats ? (stats.avgDurationSeconds || stats.avg_duration || 0) : 0;

  return (
    <div className="p-6 space-y-6">
      {/* Stats Grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Total Calls" value={totalCalls} icon={<Phone size={16} />} accent="#a78bfa" />
        <StatCard label="Today" value={callsToday} icon={<Activity size={16} />} accent="#34d399" />
        <StatCard label="Contacts" value={totalContacts} icon={<Users size={16} />} accent="#60a5fa" />
        <StatCard label="Open Tasks" value={openTasks} icon={<ListTodo size={16} />} accent="#f97316"
          sub={avgDuration ? `Avg call: ${fmt.duration(avgDuration)}` : undefined} />
      </div>

      {/* Active Calls */}
      {activeCalls.length > 0 && (
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-widest text-gray-500 mb-3">Live Calls</h3>
          <div className="space-y-2">
            {activeCalls.map((c) => (
              <div key={c.call_sid} className="flex items-center gap-3 p-4 rounded-xl bg-emerald-950/40 border border-emerald-800/50">
                <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-white">{c.contact_name || fmt.phone(c.from_number)}</div>
                  <div className="text-xs text-gray-500">{c.turn_count} turns · {fmt.date(c.started_at)}</div>
                </div>
                <span className="text-xs text-emerald-500 font-medium">{c.direction}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Outbound Dialer */}
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-widest text-gray-500 mb-3">Outbound Call</h3>
        <div className="flex gap-2">
          <input
            value={dialNumber}
            onChange={(e) => setDialNumber(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && makeCall()}
            placeholder="+1 (555) 000-0000"
            className="flex-1 bg-gray-900 border border-gray-700 rounded-xl px-4 py-3 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-violet-600 transition-colors"
          />
          <button
            onClick={makeCall}
            disabled={dialing || !dialNumber.trim()}
            className="flex items-center gap-2 px-5 py-3 rounded-xl bg-violet-700 hover:bg-violet-600 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors"
          >
            {dialing ? <Loader2 size={14} className="animate-spin" /> : <PhoneOutgoing size={14} />}
            Call
          </button>
        </div>
      </div>

      {/* Recent Calls */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-xs font-semibold uppercase tracking-widest text-gray-500">Recent Calls</h3>
          <button onClick={() => onTabChange("calls")} className="text-xs text-violet-400 hover:text-violet-300 flex items-center gap-1 transition-colors">
            View all <ArrowUpRight size={12} />
          </button>
        </div>
        {recentCalls.length === 0 ? (
          <div className="text-center py-12 rounded-2xl border border-dashed border-gray-800">
            <Phone size={32} className="mx-auto text-gray-700 mb-3" />
            <p className="text-gray-500 text-sm">No calls yet</p>
            <p className="text-gray-700 text-xs mt-1">Calls will appear here once your Twilio number receives traffic</p>
          </div>
        ) : (
          <div className="space-y-2">
            {recentCalls.slice(0, 5).map((c) => (
              <button
                key={c.id}
                onClick={() => onCallClick(c)}
                className="w-full flex items-center gap-3 p-3.5 rounded-xl bg-gray-900 border border-gray-800 hover:border-gray-700 hover:bg-gray-800/50 transition-all text-left group"
              >
                <div className={`p-2 rounded-lg ${c.direction === "inbound" ? "bg-blue-950 text-blue-400" : "bg-violet-950 text-violet-400"}`}>
                  {c.direction === "inbound" ? <PhoneIncoming size={14} /> : <PhoneOutgoing size={14} />}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-white truncate">{c.contact_name || fmt.phone(c.from_number)}</div>
                  <div className="text-xs text-gray-600">{fmt.date(c.started_at)} · {fmt.duration(c.duration_seconds)}</div>
                </div>
                {c.sentiment && <span className="text-base">{fmt.sentiment(c.sentiment)}</span>}
                <ChevronRight size={14} className="text-gray-700 group-hover:text-gray-500 transition-colors" />
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Call Detail Modal ─────────────────────────────────────────────────────────
function CallDetailModal({ call, onClose }: { call: Call; onClose: () => void }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api<Message[]>(`/api/calls/${call.call_sid}/messages`)
      .then(setMessages)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [call.call_sid]);

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4 bg-black/70 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-full max-w-2xl max-h-[85vh] flex flex-col rounded-2xl bg-gray-950 border border-gray-800 shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between p-5 border-b border-gray-800">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                call.direction === "inbound" ? "bg-blue-950 text-blue-400" : "bg-violet-950 text-violet-400"
              }`}>
                {call.direction}
              </span>
              <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                call.status === "completed" ? "bg-emerald-950 text-emerald-400" :
                call.status === "failed" ? "bg-red-950 text-red-400" : "bg-gray-800 text-gray-400"
              }`}>
                {call.status}
              </span>
              {call.sentiment && <span className="text-base">{fmt.sentiment(call.sentiment)}</span>}
            </div>
            <h2 className="text-lg font-bold text-white">{call.contact_name || fmt.phone(call.from_number)}</h2>
            <p className="text-xs text-gray-500">{fmt.date(call.started_at)} · {fmt.duration(call.duration_seconds)} · {call.agent_name}</p>
          </div>
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-gray-800 text-gray-500 hover:text-white transition-colors">
            <X size={18} />
          </button>
        </div>

        {/* Summary */}
        {call.call_summary && (
          <div className="px-5 py-4 border-b border-gray-800 bg-gray-900/50">
            <p className="text-xs font-semibold uppercase tracking-widest text-gray-500 mb-1.5">Summary</p>
            <p className="text-sm text-gray-300">{call.call_summary}</p>
            {call.intent && (
              <div className="flex items-center gap-3 mt-3">
                <span className="text-xs bg-gray-800 border border-gray-700 text-gray-400 px-2 py-1 rounded-lg">
                  Intent: {call.intent}
                </span>
                {call.summary_score !== null && (
                  <span className={`text-xs px-2 py-1 rounded-lg border ${
                    (call.summary_score || 0) >= 70 ? "bg-emerald-950 border-emerald-800 text-emerald-400" :
                    (call.summary_score || 0) >= 40 ? "bg-amber-950 border-amber-800 text-amber-400" :
                    "bg-red-950 border-red-800 text-red-400"
                  }`}>
                    Score: {call.summary_score}%
                  </span>
                )}
              </div>
            )}
            {call.next_action && (
              <p className="text-xs text-amber-400 mt-2 flex items-center gap-1.5">
                <ArrowUpRight size={12} /> {call.next_action}
              </p>
            )}
          </div>
        )}

        {/* Transcript */}
        <div className="flex-1 overflow-y-auto p-5 space-y-3">
          <p className="text-xs font-semibold uppercase tracking-widest text-gray-500 mb-3">Transcript</p>
          {loading ? (
            <div className="flex justify-center py-8">
              <Loader2 size={24} className="animate-spin text-gray-600" />
            </div>
          ) : messages.length === 0 ? (
            <p className="text-gray-600 text-sm text-center py-8">No transcript available</p>
          ) : (
            messages.map((m) => (
              <div key={m.id} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                <div className={`max-w-[80%] px-4 py-2.5 rounded-2xl text-sm ${
                  m.role === "user"
                    ? "bg-violet-900/60 border border-violet-800/50 text-violet-100 rounded-br-sm"
                    : "bg-gray-800 border border-gray-700 text-gray-200 rounded-bl-sm"
                }`}>
                  <p className="text-[10px] font-semibold uppercase tracking-wider mb-1 opacity-60">
                    {m.role === "user" ? "Caller" : call.agent_name}
                  </p>
                  {m.text}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

// ── Calls Page ────────────────────────────────────────────────────────────────
function CallsPage({ onCallClick }: { onCallClick: (c: Call) => void }) {
  const [calls, setCalls] = useState<Call[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"all" | "inbound" | "outbound">("all");

  useEffect(() => {
    api<{ calls: Call[] }>("/api/calls")
      .then((d) => setCalls(d.calls || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const filtered = filter === "all" ? calls : calls.filter((c) => c.direction === filter);

  return (
    <div className="p-6 space-y-4">
      {/* Filter */}
      <div className="flex gap-2">
        {(["all", "inbound", "outbound"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-4 py-2 rounded-xl text-sm font-medium transition-all ${
              filter === f
                ? "bg-violet-700 text-white"
                : "bg-gray-900 border border-gray-800 text-gray-500 hover:border-gray-700 hover:text-gray-300"
            }`}
          >
            {f.charAt(0).toUpperCase() + f.slice(1)}
          </button>
        ))}
        <span className="ml-auto text-xs text-gray-600 self-center">{filtered.length} calls</span>
      </div>

      {loading ? (
        <div className="flex justify-center py-16">
          <Loader2 size={28} className="animate-spin text-gray-600" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 rounded-2xl border border-dashed border-gray-800">
          <Phone size={36} className="mx-auto text-gray-700 mb-3" />
          <p className="text-gray-500 text-sm">No calls yet</p>
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((c) => (
            <button
              key={c.id}
              onClick={() => onCallClick(c)}
              className="w-full flex items-center gap-3 p-4 rounded-xl bg-gray-900 border border-gray-800 hover:border-gray-700 hover:bg-gray-800/50 transition-all text-left group"
            >
              <div className={`p-2.5 rounded-xl ${c.direction === "inbound" ? "bg-blue-950 text-blue-400" : "bg-violet-950 text-violet-400"}`}>
                {c.direction === "inbound" ? <PhoneIncoming size={16} /> : <PhoneOutgoing size={16} />}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="text-sm font-semibold text-white truncate">{c.contact_name || fmt.phone(c.from_number)}</span>
                  {c.sentiment && <span className="text-sm">{fmt.sentiment(c.sentiment)}</span>}
                </div>
                <div className="text-xs text-gray-600">
                  {fmt.date(c.started_at)} · {fmt.duration(c.duration_seconds)} · {c.agent_name}
                  {c.intent && <span className="ml-2 text-gray-700">· {c.intent}</span>}
                </div>
              </div>
              <div className="text-right shrink-0">
                <span className={`text-xs px-2 py-1 rounded-lg font-medium ${
                  c.status === "completed" ? "bg-emerald-950 text-emerald-500" :
                  c.status === "failed" ? "bg-red-950 text-red-500" : "bg-gray-800 text-gray-500"
                }`}>
                  {c.status}
                </span>
                {c.message_count > 0 && (
                  <div className="text-xs text-gray-700 mt-1 flex items-center gap-1 justify-end">
                    <MessageSquare size={10} /> {c.message_count}
                  </div>
                )}
              </div>
              <ChevronRight size={14} className="text-gray-700 group-hover:text-gray-500 transition-colors shrink-0" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Contacts Page ─────────────────────────────────────────────────────────────
function ContactsPage() {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api<{ contacts: Contact[] }>("/api/contacts")
      .then((d) => setContacts(d.contacts || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-widest text-gray-500">{contacts.length} contacts</h3>
      </div>

      {loading ? (
        <div className="flex justify-center py-16"><Loader2 size={28} className="animate-spin text-gray-600" /></div>
      ) : contacts.length === 0 ? (
        <div className="text-center py-16 rounded-2xl border border-dashed border-gray-800">
          <Users size={36} className="mx-auto text-gray-700 mb-3" />
          <p className="text-gray-500 text-sm">No contacts yet</p>
          <p className="text-gray-700 text-xs mt-1">Contacts are created automatically from incoming calls</p>
        </div>
      ) : (
        <div className="space-y-2">
          {contacts.map((c) => (
            <div key={c.id} className="flex items-center gap-3 p-4 rounded-xl bg-gray-900 border border-gray-800 hover:border-gray-700 transition-colors">
              <div className="w-10 h-10 rounded-full bg-gray-800 border border-gray-700 flex items-center justify-center text-gray-400 shrink-0">
                <User size={16} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-white">{c.name || "Unknown"}</span>
                  {c.do_not_call ? (
                    <span className="text-xs px-1.5 py-0.5 rounded bg-red-950 text-red-500 border border-red-900">DNC</span>
                  ) : null}
                </div>
                <div className="text-xs text-gray-600">{fmt.phone(c.phone_number)} · {c.total_calls} call{c.total_calls !== 1 ? "s" : ""}</div>
                {c.last_summary && <p className="text-xs text-gray-700 mt-0.5 truncate">{c.last_summary}</p>}
              </div>
              <div className="text-right shrink-0">
                <div className="text-xs text-gray-600">{fmt.date(c.last_seen)}</div>
                {c.open_tasks_count > 0 && (
                  <span className="text-xs text-amber-500">{c.open_tasks_count} task{c.open_tasks_count !== 1 ? "s" : ""}</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Tasks Page ────────────────────────────────────────────────────────────────
function TasksPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const { addToast } = useToast();

  const load = () => {
    api<{ tasks: Task[] }>("/api/tasks")
      .then((d) => setTasks(d.tasks || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const complete = async (id: number) => {
    try {
      await api(`/api/tasks/${id}`, { method: "PATCH", body: JSON.stringify({ status: "completed" }) });
      addToast({ type: "success", message: "Task completed" });
      load();
    } catch {
      addToast({ type: "error", message: "Failed to update task" });
    }
  };

  const open = tasks.filter((t) => t.status !== "completed");
  const done = tasks.filter((t) => t.status === "completed");

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-widest text-gray-500">
          {open.length} open · {done.length} completed
        </h3>
      </div>

      {loading ? (
        <div className="flex justify-center py-16"><Loader2 size={28} className="animate-spin text-gray-600" /></div>
      ) : tasks.length === 0 ? (
        <div className="text-center py-16 rounded-2xl border border-dashed border-gray-800">
          <ListTodo size={36} className="mx-auto text-gray-700 mb-3" />
          <p className="text-gray-500 text-sm">No tasks yet</p>
          <p className="text-gray-700 text-xs mt-1">Tasks are created automatically from unresolved calls</p>
        </div>
      ) : (
        <div className="space-y-2">
          {[...open, ...done].map((t) => (
            <div key={t.id} className={`flex items-start gap-3 p-4 rounded-xl border transition-all ${
              t.status === "completed"
                ? "bg-gray-900/50 border-gray-800/50 opacity-50"
                : "bg-gray-900 border-gray-800 hover:border-gray-700"
            }`}>
              <button
                onClick={() => t.status !== "completed" && complete(t.id)}
                className={`mt-0.5 w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0 transition-all ${
                  t.status === "completed"
                    ? "bg-emerald-600 border-emerald-600"
                    : "border-gray-600 hover:border-violet-500"
                }`}
              >
                {t.status === "completed" && <Check size={10} className="text-white" />}
              </button>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="text-sm font-medium text-white">{t.task_type.replace(/_/g, " ")}</span>
                  <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${
                    t.status === "completed" ? "bg-emerald-950 text-emerald-600" :
                    t.status === "pending" ? "bg-amber-950 text-amber-500" : "bg-gray-800 text-gray-500"
                  }`}>{t.status}</span>
                </div>
                {t.contact_name && <div className="text-xs text-gray-600">{t.contact_name} · {t.phone_number && fmt.phone(t.phone_number)}</div>}
                {t.notes && <p className="text-xs text-gray-500 mt-1">{t.notes}</p>}
                <div className="text-xs text-gray-700 mt-1">{fmt.date(t.created_at)}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Agent Card ────────────────────────────────────────────────────────────────
function AgentCard({ agent, onEdit, onActivate }: {
  agent: AgentConfig;
  onEdit: (a: AgentConfig) => void;
  onActivate: (id: number) => void;
}) {
  const meta = AGENT_META[agent.name] || { icon: <Bot size={20} />, accentColor: "#a78bfa", bgGradient: "from-gray-900 to-gray-800" };
  const isActive = agent.is_active === 1;

  return (
    <div className={`relative overflow-hidden rounded-2xl border transition-all duration-200 ${
      isActive
        ? "border-violet-700/60 bg-gradient-to-br from-violet-950/40 to-gray-900"
        : "border-gray-800 bg-gray-900 hover:border-gray-700"
    }`}>
      {/* Accent glow */}
      <div className="absolute top-0 right-0 w-32 h-32 rounded-full opacity-10 blur-3xl pointer-events-none"
        style={{ background: meta.accentColor, transform: "translate(40%, -40%)" }} />

      {/* Corner brackets (industrial aesthetic) */}
      <div className="absolute top-2 left-2 w-3 h-3 border-t border-l opacity-30" style={{ borderColor: meta.accentColor }} />
      <div className="absolute top-2 right-2 w-3 h-3 border-t border-r opacity-30" style={{ borderColor: meta.accentColor }} />
      <div className="absolute bottom-2 left-2 w-3 h-3 border-b border-l opacity-30" style={{ borderColor: meta.accentColor }} />
      <div className="absolute bottom-2 right-2 w-3 h-3 border-b border-r opacity-30" style={{ borderColor: meta.accentColor }} />

      <div className="p-5">
        {/* Header */}
        <div className="flex items-start justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl border" style={{ color: meta.accentColor, borderColor: `${meta.accentColor}30`, background: `${meta.accentColor}15` }}>
              {meta.icon}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base font-bold text-white">{agent.name}</h3>
                {isActive && (
                  <span className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-950 border border-emerald-800 text-emerald-400 font-medium">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                    ACTIVE
                  </span>
                )}
              </div>
              {agent.display_name && <p className="text-xs text-gray-500">{agent.display_name}</p>}
            </div>
          </div>
          <div className="flex gap-1.5">
            <button
              onClick={() => onEdit(agent)}
              className="p-2 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-white transition-colors"
            >
              <Pencil size={13} />
            </button>
          </div>
        </div>

        {/* Tagline */}
        {agent.tagline && (
          <p className="text-xs text-gray-500 mb-3 italic">"{agent.tagline}"</p>
        )}

        {/* Meta */}
        <div className="flex flex-wrap gap-2 mb-4">
          {agent.tier && (
            <span className="text-[10px] px-2 py-0.5 rounded-full border font-medium uppercase tracking-wider"
              style={{ color: meta.accentColor, borderColor: `${meta.accentColor}40`, background: `${meta.accentColor}10` }}>
              {agent.tier}
            </span>
          )}
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-gray-800 border border-gray-700 text-gray-500 font-medium uppercase tracking-wider">
            {agent.vertical}
          </span>
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-gray-800 border border-gray-700 text-gray-500 font-medium uppercase tracking-wider">
            {agent.voice}
          </span>
        </div>

        {/* Greeting preview */}
        <p className="text-xs text-gray-600 line-clamp-2 mb-4">
          {agent.greeting}
        </p>

        {/* Activate button */}
        {!isActive && (
          <button
            onClick={() => onActivate(agent.id)}
            className="w-full py-2 rounded-xl border border-gray-700 text-gray-400 text-xs font-medium hover:border-violet-700 hover:text-violet-400 hover:bg-violet-950/20 transition-all"
          >
            Set as Active
          </button>
        )}
      </div>
    </div>
  );
}

// ── Agent Edit Modal ──────────────────────────────────────────────────────────
function AgentEditModal({ agent, onClose, onSave }: {
  agent: AgentConfig;
  onClose: () => void;
  onSave: (updated: Partial<AgentConfig>) => Promise<void>;
}) {
  const [form, setForm] = useState<Partial<AgentConfig>>({
    name: agent.name,
    display_name: agent.display_name || "",
    tagline: agent.tagline || "",
    greeting: agent.greeting,
    system_prompt: agent.system_prompt,
    voice: agent.voice,
    max_turns: agent.max_turns,
  });
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await onSave(form);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-2xl max-h-[90vh] flex flex-col rounded-2xl bg-gray-950 border border-gray-800 shadow-2xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between p-5 border-b border-gray-800">
          <h2 className="text-lg font-bold text-white">Edit {agent.name}</h2>
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-gray-800 text-gray-500 hover:text-white transition-colors"><X size={18} /></button>
        </div>
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {[
            { key: "display_name", label: "Display Name", type: "text" as const, placeholder: "e.g. Front Desk Specialist" },
            { key: "tagline", label: "Tagline", type: "text" as const, placeholder: "e.g. Sharp intake. No fluff." },
            { key: "greeting", label: "Greeting", type: "textarea" as const, placeholder: "What SMIRK says when the call connects" },
            { key: "system_prompt", label: "System Prompt", type: "textarea" as const, placeholder: "Full instructions for this agent" },
            { key: "voice", label: "Voice ID", type: "text" as const, placeholder: "e.g. nova, alloy, shimmer" },
          ].map(({ key, label, type, placeholder }) => (
            <div key={key}>
              <label className="block text-xs font-semibold uppercase tracking-widest text-gray-500 mb-2">{label}</label>
              {type === "textarea" ? (
                <textarea
                  value={(form as Record<string, string | number | undefined>)[key] as string || ""}
                  onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
                  placeholder={placeholder}
                  rows={key === "system_prompt" ? 8 : 3}
                  className="w-full bg-gray-900 border border-gray-700 rounded-xl px-4 py-3 text-sm text-white placeholder-gray-700 focus:outline-none focus:border-violet-600 transition-colors resize-none"
                />
              ) : (
                <input
                  type="text"
                  value={(form as Record<string, string | number | undefined>)[key] as string || ""}
                  onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
                  placeholder={placeholder}
                  className="w-full bg-gray-900 border border-gray-700 rounded-xl px-4 py-3 text-sm text-white placeholder-gray-700 focus:outline-none focus:border-violet-600 transition-colors"
                />
              )}
            </div>
          ))}
          <div>
            <label className="block text-xs font-semibold uppercase tracking-widest text-gray-500 mb-2">Max Turns</label>
            <input
              type="number"
              value={form.max_turns || 20}
              onChange={(e) => setForm((f) => ({ ...f, max_turns: parseInt(e.target.value) || 20 }))}
              className="w-full bg-gray-900 border border-gray-700 rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-violet-600 transition-colors"
            />
          </div>
        </div>
        <div className="flex gap-3 p-5 border-t border-gray-800">
          <button onClick={onClose} className="flex-1 py-3 rounded-xl border border-gray-700 text-gray-400 text-sm font-medium hover:border-gray-600 hover:text-white transition-colors">
            Cancel
          </button>
          <button onClick={save} disabled={saving} className="flex-1 py-3 rounded-xl bg-violet-700 hover:bg-violet-600 disabled:opacity-40 text-white text-sm font-semibold transition-colors flex items-center justify-center gap-2">
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            Save Changes
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Agents Page ───────────────────────────────────────────────────────────────
function AgentsPage() {
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<AgentConfig | null>(null);
  const { addToast } = useToast();

  const load = () => {
    api<AgentConfig[] | { agents: AgentConfig[] }>("/api/agents")
      .then((d) => setAgents(Array.isArray(d) ? d : (d as { agents: AgentConfig[] }).agents || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const activate = async (id: number) => {
    try {
      await api(`/api/agents/${id}/activate`, { method: "POST" });
      addToast({ type: "success", message: "Agent activated" });
      load();
    } catch {
      addToast({ type: "error", message: "Failed to activate agent" });
    }
  };

  const save = async (id: number, data: Partial<AgentConfig>) => {
    await api(`/api/agents/${id}`, { method: "PUT", body: JSON.stringify(data) });
    addToast({ type: "success", message: "Agent updated" });
    load();
  };

  const tiers = ["brain", "specialist", "support"];
  const tierLabels: Record<string, string> = { brain: "Command Layer", specialist: "Vertical Specialists", support: "Support Roles" };

  return (
    <div className="p-6 space-y-8">
      {loading ? (
        <div className="flex justify-center py-16"><Loader2 size={28} className="animate-spin text-gray-600" /></div>
      ) : (
        tiers.map((tier) => {
          const tierAgents = agents.filter((a) => (a.tier || "specialist") === tier);
          if (tierAgents.length === 0) return null;
          return (
            <div key={tier}>
              <div className="flex items-center gap-3 mb-4">
                <h3 className="text-xs font-bold uppercase tracking-widest text-gray-500">{tierLabels[tier] || tier}</h3>
                <div className="flex-1 h-px bg-gray-800" />
                <span className="text-xs text-gray-700">{tierAgents.length}</span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {tierAgents.map((a) => (
                  <AgentCard key={a.id} agent={a} onEdit={setEditing} onActivate={activate} />
                ))}
              </div>
            </div>
          );
        })
      )}

      {editing && (
        <AgentEditModal
          agent={editing}
          onClose={() => setEditing(null)}
          onSave={(data) => save(editing.id, data)}
        />
      )}
    </div>
  );
}

// ── Settings Page ─────────────────────────────────────────────────────────────
function SettingsPage() {
  const [groups, setGroups] = useState<SettingsGroup[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [show, setShow] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const { addToast } = useToast();

  useEffect(() => {
    Promise.all([
      api<{ groups: SettingsGroup[] }>("/api/settings"),
      api<Record<string, string>>("/api/settings/values"),
    ]).then(([g, v]) => {
      setGroups(g.groups || []);
      setValues(v);
    }).catch(() => {});
  }, []);

  const saveGroup = async (groupId: string) => {
    const group = groups.find((g) => g.id === groupId);
    if (!group) return;
    setSaving(groupId);
    try {
      const payload: Record<string, string> = {};
      group.fields.forEach((f) => {
        if (values[f.key] !== undefined && !values[f.key].includes("•")) {
          payload[f.key] = values[f.key];
        }
      });
      await api("/api/settings", { method: "POST", body: JSON.stringify(payload) });
      addToast({ type: "success", message: `${group.label} saved` });
    } catch (e: unknown) {
      addToast({ type: "error", message: e instanceof Error ? e.message : "Save failed" });
    } finally {
      setSaving(null);
    }
  };

  const testGroup = async (groupId: string) => {
    setTesting(groupId);
    try {
      const result = await api<{ ok: boolean; message?: string; error?: string }>(
        `/api/settings/test/${groupId}`, { method: "POST" }
      );
      addToast({ type: result.ok ? "success" : "error", message: result.message || result.error || "Test complete" });
    } catch (e: unknown) {
      addToast({ type: "error", message: e instanceof Error ? e.message : "Test failed" });
    } finally {
      setTesting(null);
    }
  };

  return (
    <div className="p-6 space-y-6">
      {/* Webhook URL */}
      <WebhookDisplay />

      {groups.map((group) => (
        <div key={group.id} className="rounded-2xl bg-gray-900 border border-gray-800 overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-bold text-white">{group.label}</h3>
                {group.required && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-950 border border-red-900 text-red-500 font-medium">Required</span>
                )}
              </div>
              <p className="text-xs text-gray-600 mt-0.5">{group.description}</p>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => testGroup(group.id)}
                disabled={testing === group.id}
                className="flex items-center gap-1.5 px-3 py-2 rounded-xl border border-gray-700 text-gray-400 text-xs font-medium hover:border-gray-600 hover:text-white transition-colors disabled:opacity-40"
              >
                {testing === group.id ? <Loader2 size={12} className="animate-spin" /> : <TestTube size={12} />}
                Test
              </button>
              <button
                onClick={() => saveGroup(group.id)}
                disabled={saving === group.id}
                className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-violet-700 hover:bg-violet-600 text-white text-xs font-medium transition-colors disabled:opacity-40"
              >
                {saving === group.id ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
                Save
              </button>
            </div>
          </div>

          <div className="p-5 space-y-4">
            {group.fields.map((field) => (
              <div key={field.key}>
                <label className="block text-xs font-semibold uppercase tracking-widest text-gray-500 mb-2">
                  {field.label}
                  {field.required && <span className="text-red-500 ml-1">*</span>}
                </label>
                {field.type === "toggle" ? (
                  <button
                    onClick={() => setValues((v) => ({ ...v, [field.key]: v[field.key] === "true" ? "false" : "true" }))}
                    className={`relative w-11 h-6 rounded-full transition-colors ${values[field.key] === "true" ? "bg-violet-600" : "bg-gray-700"}`}
                  >
                    <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${values[field.key] === "true" ? "translate-x-5" : ""}`} />
                  </button>
                ) : field.type === "textarea" ? (
                  <textarea
                    value={values[field.key] || ""}
                    onChange={(e) => setValues((v) => ({ ...v, [field.key]: e.target.value }))}
                    placeholder={field.placeholder}
                    rows={4}
                    className="w-full bg-gray-950 border border-gray-700 rounded-xl px-4 py-3 text-sm text-white placeholder-gray-700 focus:outline-none focus:border-violet-600 transition-colors resize-none"
                  />
                ) : (
                  <div className="relative">
                    <input
                      type={field.type === "password" && !show[field.key] ? "password" : "text"}
                      value={values[field.key] || ""}
                      onChange={(e) => setValues((v) => ({ ...v, [field.key]: e.target.value }))}
                      placeholder={field.placeholder}
                      className="w-full bg-gray-950 border border-gray-700 rounded-xl px-4 py-3 pr-10 text-sm text-white placeholder-gray-700 focus:outline-none focus:border-violet-600 transition-colors font-mono"
                    />
                    {field.type === "password" && (
                      <button
                        onClick={() => setShow((s) => ({ ...s, [field.key]: !s[field.key] }))}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-600 hover:text-gray-400 transition-colors"
                      >
                        {show[field.key] ? <EyeOff size={14} /> : <Eye size={14} />}
                      </button>
                    )}
                  </div>
                )}
                {field.help && <p className="text-xs text-gray-700 mt-1.5">{field.help}</p>}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Webhook Display ───────────────────────────────────────────────────────────
function WebhookDisplay() {
  const { addToast } = useToast();
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    api<{ incomingUrl: string }>("/api/webhook-url").then((d) => setUrl(d.incomingUrl)).catch(() => {});
  }, []);

  const copy = () => {
    if (!url) return;
    navigator.clipboard.writeText(url);
    addToast({ type: "success", message: "Webhook URL copied!" });
  };

  return (
    <div className="rounded-2xl bg-gray-900 border border-gray-800 p-5">
      <p className="text-xs font-semibold uppercase tracking-widest text-gray-500 mb-3">Twilio Webhook URL</p>
      <div className="flex items-center gap-2">
        <code className="flex-1 text-xs p-3 rounded-xl bg-gray-950 border border-gray-800 text-emerald-400 overflow-x-auto font-mono">
          {url || "Loading…"}
        </code>
        <button onClick={copy} className="p-3 rounded-xl bg-gray-800 border border-gray-700 text-gray-400 hover:text-white hover:border-gray-600 transition-colors shrink-0">
          <Copy size={14} />
        </button>
      </div>
      <p className="text-xs text-gray-700 mt-2">
        Twilio Console → Phone Numbers → Your Number → Voice → "A Call Comes In" → Webhook
      </p>
    </div>
  );
}

// ── Logs Page ─────────────────────────────────────────────────────────────────
function LogsPage() {
  const [logs, setLogs] = useState<RequestLog[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api<{ logs: RequestLog[] }>("/api/logs")
      .then((d) => setLogs(d.logs || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const statusColor = (code: number) => {
    if (code < 300) return "text-emerald-500";
    if (code < 400) return "text-blue-500";
    if (code < 500) return "text-amber-500";
    return "text-red-500";
  };

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-widest text-gray-500">{logs.length} recent requests</h3>
        <button onClick={() => { setLoading(true); api<{ logs: RequestLog[] }>("/api/logs").then((d) => setLogs(d.logs || [])).finally(() => setLoading(false)); }}
          className="p-2 rounded-lg bg-gray-900 border border-gray-800 text-gray-500 hover:text-white hover:border-gray-700 transition-colors">
          <RefreshCw size={13} />
        </button>
      </div>

      {loading ? (
        <div className="flex justify-center py-16"><Loader2 size={28} className="animate-spin text-gray-600" /></div>
      ) : (
        <div className="rounded-2xl border border-gray-800 overflow-hidden">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-gray-800 bg-gray-900/50">
                {["Method", "Path", "Status", "Duration", "Time"].map((h) => (
                  <th key={h} className="text-left px-4 py-3 text-gray-600 font-semibold uppercase tracking-wider">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {logs.map((l, i) => (
                <tr key={l.id} className={`border-b border-gray-800/50 hover:bg-gray-900/50 transition-colors ${i % 2 === 0 ? "bg-gray-950" : "bg-gray-900/20"}`}>
                  <td className="px-4 py-2.5">
                    <span className={`font-mono font-bold ${
                      l.method === "GET" ? "text-blue-400" :
                      l.method === "POST" ? "text-emerald-400" :
                      l.method === "PUT" ? "text-amber-400" :
                      l.method === "DELETE" ? "text-red-400" : "text-gray-400"
                    }`}>{l.method}</span>
                  </td>
                  <td className="px-4 py-2.5 text-gray-400 font-mono max-w-xs truncate">{l.path}</td>
                  <td className={`px-4 py-2.5 font-mono font-bold ${statusColor(l.status_code)}`}>{l.status_code}</td>
                  <td className="px-4 py-2.5 text-gray-500">{l.duration_ms}ms</td>
                  <td className="px-4 py-2.5 text-gray-600">{fmt.date(l.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {logs.length === 0 && (
            <div className="text-center py-12 text-gray-600 text-sm">No logs yet</div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main App ──────────────────────────────────────────────────────────────────
export default function App() {
  const [dark, setDark] = useState(true);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [tab, setTab] = useState<Tab>("dashboard");
  const [activeCalls, setActiveCalls] = useState<ActiveCall[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [recentCalls, setRecentCalls] = useState<Call[]>([]);
  const [configStatus, setConfigStatus] = useState<ConfigStatus | null>(null);
  const [apiError, setApiError] = useState(false);
  const [selectedCall, setSelectedCall] = useState<Call | null>(null);
  const [taskCount, setTaskCount] = useState(0);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const addToast = useCallback((t: Omit<Toast, "id">) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((prev) => [...prev, { ...t, id }]);
    setTimeout(() => setToasts((prev) => prev.filter((x) => x.id !== id)), 5000);
  }, []);

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // Poll active calls and stats
  useEffect(() => {
    const poll = async () => {
      try {
        const [active, s, cs] = await Promise.all([
          api<ActiveCall[]>("/api/calls/active"),
          api<Stats>("/api/stats"),
          api<ConfigStatus>("/api/config-status"),
        ]);
        setActiveCalls(active || []);
        setStats(s);
        setConfigStatus(cs);
        setApiError(false);
      } catch {
        setApiError(true);
      }
    };
    poll();
    const iv = setInterval(poll, 8000);
    return () => clearInterval(iv);
  }, []);

  // Load recent calls for dashboard
  useEffect(() => {
    api<{ calls: Call[] }>("/api/calls")
      .then((d) => setRecentCalls(d.calls || []))
      .catch(() => {});
  }, [tab]);

  // Load task count for badge
  useEffect(() => {
    api<{ tasks: Task[] }>("/api/tasks")
      .then((d) => setTaskCount((d.tasks || []).filter((t) => t.status !== "completed").length))
      .catch(() => {});
  }, [tab]);

  const tabs: { id: Tab; label: string; icon: React.ReactElement }[] = [
    { id: "dashboard", label: "Dashboard", icon: <BarChart3 size={16} /> },
    { id: "calls",     label: "Calls",     icon: <Phone size={16} /> },
    { id: "contacts",  label: "Contacts",  icon: <Users size={16} /> },
    { id: "tasks",     label: "Tasks",     icon: <ListTodo size={16} /> },
    { id: "agents",    label: "Agents",    icon: <Bot size={16} /> },
    { id: "settings",  label: "Settings",  icon: <Settings size={16} /> },
    { id: "logs",      label: "Logs",      icon: <Activity size={16} /> },
  ];

  return (
    <ThemeContext.Provider value={{ dark, toggle: () => setDark((d) => !d) }}>
      <ToastContext.Provider value={{ addToast }}>
        <div className={`min-h-screen flex flex-col ${dark ? "bg-gray-950 text-white" : "bg-gray-50 text-gray-900"}`}
          style={{ fontFamily: "'Inter', system-ui, sans-serif" }}>

          {/* Header */}
          <header className={`sticky top-0 z-40 flex items-center gap-3 px-4 h-14 border-b backdrop-blur-md ${
            dark ? "bg-gray-950/90 border-gray-800" : "bg-white/90 border-gray-200"
          }`}>
            {/* Logo */}
            <div className="flex items-center gap-2 mr-2">
              <div className="w-7 h-7 rounded-lg bg-violet-700 flex items-center justify-center">
                <Sparkles size={14} className="text-white" />
              </div>
              <span className="text-sm font-bold tracking-tight text-white">SMIRK</span>
              <span className="text-xs text-gray-600 hidden sm:block">Platform</span>
            </div>

            {/* Desktop Nav */}
            <nav className="hidden md:flex items-center gap-1 flex-1">
              {tabs.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all relative ${
                    tab === t.id
                      ? "bg-violet-700/20 text-violet-300 border border-violet-700/40"
                      : dark
                        ? "text-gray-500 hover:text-gray-300 hover:bg-gray-800"
                        : "text-gray-500 hover:text-gray-700 hover:bg-gray-100"
                  }`}
                >
                  {t.icon}
                  {t.label}
                  {t.id === "tasks" && taskCount > 0 && (
                    <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-amber-500 text-[9px] font-bold text-white flex items-center justify-center">
                      {taskCount > 9 ? "9+" : taskCount}
                    </span>
                  )}
                </button>
              ))}
            </nav>

            <div className="flex items-center gap-2 ml-auto">
              <StatusBadge
                activeCalls={activeCalls}
                apiError={apiError}
                configStatus={configStatus}
                onSetupClick={() => setTab("settings")}
              />
              <button
                onClick={() => setDark((d) => !d)}
                className={`p-2 rounded-lg transition-colors ${dark ? "text-gray-500 hover:text-gray-300 hover:bg-gray-800" : "text-gray-400 hover:text-gray-600 hover:bg-gray-100"}`}
              >
                {dark ? <Sun size={15} /> : <Moon size={15} />}
              </button>
              {/* Mobile menu button */}
              <button
                onClick={() => setMobileMenuOpen((o) => !o)}
                className="md:hidden p-2 rounded-lg text-gray-500 hover:text-gray-300 hover:bg-gray-800 transition-colors"
              >
                <Layers size={15} />
              </button>
            </div>
          </header>

          {/* Mobile Nav Dropdown */}
          {mobileMenuOpen && (
            <div className={`md:hidden border-b ${dark ? "bg-gray-900 border-gray-800" : "bg-white border-gray-200"}`}>
              {tabs.map((t) => (
                <button
                  key={t.id}
                  onClick={() => { setTab(t.id); setMobileMenuOpen(false); }}
                  className={`w-full flex items-center gap-3 px-5 py-3 text-sm font-medium transition-colors ${
                    tab === t.id
                      ? "text-violet-400 bg-violet-950/30"
                      : dark ? "text-gray-400 hover:text-white hover:bg-gray-800" : "text-gray-600 hover:bg-gray-50"
                  }`}
                >
                  {t.icon}
                  {t.label}
                  {t.id === "tasks" && taskCount > 0 && (
                    <span className="ml-auto text-xs bg-amber-500 text-white rounded-full px-1.5 py-0.5 font-bold">{taskCount}</span>
                  )}
                </button>
              ))}
            </div>
          )}

          {/* Active Call Bar */}
          <div className="pt-2">
            <ActiveCallBar calls={activeCalls} />
          </div>

          {/* Main Content */}
          <main className="flex-1 overflow-y-auto">
            {tab === "dashboard" && (
              <DashboardPage
                stats={stats}
                activeCalls={activeCalls}
                recentCalls={recentCalls}
                onCallClick={setSelectedCall}
                onTabChange={setTab}
              />
            )}
            {tab === "calls" && <CallsPage onCallClick={setSelectedCall} />}
            {tab === "contacts" && <ContactsPage />}
            {tab === "tasks" && <TasksPage />}
            {tab === "agents" && <AgentsPage />}
            {tab === "settings" && <SettingsPage />}
            {tab === "logs" && <LogsPage />}
          </main>

          {/* Call Detail Modal */}
          {selectedCall && (
            <CallDetailModal call={selectedCall} onClose={() => setSelectedCall(null)} />
          )}

          {/* Toasts */}
          <ToastContainer toasts={toasts} remove={removeToast} />
        </div>
      </ToastContext.Provider>
    </ThemeContext.Provider>
  );
}
