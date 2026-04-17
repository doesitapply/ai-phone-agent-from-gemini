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
  ShieldOff, Filter, Download, ExternalLink, Link, ToggleLeft, ToggleRight,
  FileText, Cpu, Server, Webhook, CreditCard, Package, MapPin,
  UserPlus, UserCheck, Mail, PhoneForwarded, BellRing, BadgeCheck, RotateCcw,
} from "lucide-react";

import { SetupWizard } from "./components/SetupWizard";

// ── Theme Context ─────────────────────────────────────────────────────────────
const ThemeContext = createContext<{ dark: boolean; toggle: () => void }>({ dark: true, toggle: () => {} });
const useTheme = () => useContext(ThemeContext);

// ── Toast Context ─────────────────────────────────────────────────────────────
type Toast = { id: string; type: "success" | "error" | "info" | "warning"; message: string };
const ToastContext = createContext<{ addToast: (t: Omit<Toast, "id">) => void }>({ addToast: () => {} });
const useToast = () => useContext(ToastContext);

// ── Types ─────────────────────────────────────────────────────────────────────
type Tab = "dashboard" | "calls" | "contacts" | "tasks" | "handoffs" | "recovery" | "identity" | "settings" | "analytics" | "prospecting";

type RecoveryQueueItem = {
  id: string;
  call_sid: string;
  contact_id: number;
  name: string | null;
  phone_number: string;
  reason: string;
  priority: "high" | "medium" | "low";
  last_touch_at: string | null;
  last_sms_preview: string | null;
  status: "needs_reply" | "needs_booking" | "cooldown" | "closed";
};

type BookingWindow = {
  id: string;
  start: string; // ISO
  end: string;   // ISO
  label?: string;
};

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
  // Core (legacy + new field names)
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
  callsThisMonth?: number;
  activeCalls?: number;
  completedCalls?: number;
  inboundCalls?: number;
  outboundCalls?: number;
  pendingHandoffs?: number;
  avgAiLatencyMs?: number;
  avgResolutionScore?: number;
  bookingRate?: number;
  transferRate?: number;
  // Conversion reporting
  conversionRate?: number;       // % calls → booking/lead
  qualificationRate?: number;    // % calls with score >= 70%
  callbacksNeeded?: number;
  leadsBooked?: number;
  fieldsExtracted?: number;
  dataCaptureCoverage?: number;  // % contacts with name
  contactsWithEmail?: number;
  contactsWithName?: number;
  avgFieldConfidence?: number | null;
  sentiment?: Record<string, number>; // { positive, neutral, negative, frustrated }
  // Prospecting
  prospectTotalLeads?: number;
  prospectCalled?: number;
  prospectInterested?: number;
  prospectConversionRate?: number;
  // Compliance
  dncCount?: number;
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
  phone: (p: string | null | undefined) => {
    // Defensive: prod data occasionally contains null/undefined or non-string values.
    if (!p) return "—";
    const s = String(p);
    const d = s.replace(/\D/g, "");
    if (d.length === 11 && d[0] === "1") return `+1 (${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
    return s;
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
function StatCard({ label, value, icon, accent = "#a78bfa", sub, onClick }: {
  label: string;
  value: string | number;
  icon: React.ReactNode;
  accent?: string;
  sub?: string;
  onClick?: () => void;
}) {
  const Wrapper = onClick ? "button" : "div";
  return (
    <Wrapper
      onClick={onClick}
      className={`relative overflow-hidden rounded-2xl bg-gray-900 border border-gray-800 p-5 group transition-all duration-200 text-left w-full ${onClick ? "hover:border-gray-600 hover:scale-[1.02] cursor-pointer active:scale-100" : "hover:border-gray-700"}`}
    >
      <div className="absolute top-0 right-0 w-24 h-24 rounded-full opacity-10 blur-2xl" style={{ background: accent, transform: "translate(30%, -30%)" }} />
      <div className="flex items-start justify-between mb-3">
        <div className="p-2 rounded-xl bg-gray-800 border border-gray-700" style={{ color: accent }}>
          {icon}
        </div>
        {onClick && <ChevronRight size={14} className="text-gray-700 group-hover:text-gray-500 transition-colors mt-1" />}
      </div>
      <div className="text-2xl font-bold text-white mb-0.5">{value}</div>
      <div className="text-xs text-gray-500 font-medium uppercase tracking-wider">{label}</div>
      {sub && <div className="text-xs text-gray-600 mt-1">{sub}</div>}
    </Wrapper>
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
  const [triage, setTriage] = useState<any | null>(null);
  const [triageErr, setTriageErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    api<any>("/api/triage?days=7&limit=80")
      .then((d) => { if (mounted) { setTriage(d); setTriageErr(null); } })
      .catch((e) => { if (mounted) setTriageErr(e instanceof Error ? e.message : "Failed to load triage"); })
      .finally(() => { if (mounted) setLoading(false); });
    return () => { mounted = false; };
  }, []);

  const incidents: any[] = triage?.incidents || [];

  const priTone = (p: string) => {
    if (p === "P0") return "bg-red-500/15 text-red-200 border-red-500/25";
    if (p === "P1") return "bg-amber-500/15 text-amber-200 border-amber-500/25";
    if (p === "P2") return "bg-sky-500/15 text-sky-200 border-sky-500/25";
    return "bg-white/5 text-gray-200 border-white/10";
  };

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      {/* Glass header */}
      <div className="rounded-3xl border border-white/10 bg-gradient-to-br from-white/10 to-white/5 backdrop-blur-xl shadow-[0_20px_80px_-30px_rgba(0,0,0,0.8)] px-6 py-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-[10px] uppercase tracking-widest text-gray-300/70 font-semibold">Dispatch Triage</p>
            <h2 className="text-base font-bold text-white mt-1">Everything that happened</h2>
            <p className="text-xs text-gray-300/80 mt-1">Sorted by urgency. One click to Recovery Desk when needed.</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => onTabChange("recovery")}
              className="px-4 py-2 rounded-2xl bg-white/10 hover:bg-white/15 border border-white/15 text-xs font-semibold text-white transition-colors"
            >
              Open Recovery Desk
            </button>
          </div>
        </div>
      </div>

      {triageErr && (
        <div className="rounded-2xl border border-red-500/25 bg-red-500/10 px-4 py-3 text-xs text-red-200">
          Triage failed: {triageErr}
        </div>
      )}

      {/* KPI strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="rounded-3xl border border-white/10 bg-gradient-to-br from-white/10 to-white/5 backdrop-blur-xl px-5 py-4">
          <div className="text-xs text-gray-300/70">Incidents</div>
          <div className="text-2xl font-bold text-white mt-1">{loading ? "…" : incidents.length}</div>
        </div>
        <div className="rounded-3xl border border-white/10 bg-gradient-to-br from-white/10 to-white/5 backdrop-blur-xl px-5 py-4">
          <div className="text-xs text-gray-300/70">Active calls</div>
          <div className="text-2xl font-bold text-white mt-1">{loading ? "…" : (triage?.activeCalls?.length || 0)}</div>
        </div>
        <div className="rounded-3xl border border-white/10 bg-gradient-to-br from-white/10 to-white/5 backdrop-blur-xl px-5 py-4">
          <div className="text-xs text-gray-300/70">Missed inbound (needs recovery)</div>
          <div className="text-2xl font-bold text-white mt-1">{loading ? "…" : (triage?.recovery?.length || 0)}</div>
        </div>
        <div className="rounded-3xl border border-white/10 bg-gradient-to-br from-white/10 to-white/5 backdrop-blur-xl px-5 py-4">
          <div className="text-xs text-gray-300/70">Inbound SMS (7d)</div>
          <div className="text-2xl font-bold text-white mt-1">{loading ? "…" : (triage?.sms?.length || 0)}</div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 items-start">
        {/* Incident Queue */}
        <div className="lg:col-span-2 rounded-3xl border border-white/10 bg-gradient-to-br from-white/10 to-white/5 backdrop-blur-xl shadow-[0_20px_80px_-30px_rgba(0,0,0,0.8)] overflow-hidden">
          <div className="px-5 py-4 border-b border-white/10">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-white">Incident Queue</h3>
              <span className="text-[10px] uppercase tracking-widest text-gray-300/70 font-semibold">Auto-ranked</span>
            </div>
          </div>
          <div className="divide-y divide-white/10">
            {(incidents.length ? incidents : []).slice(0, 30).map((it, idx) => (
              <button
                key={it.call_sid || it.id || idx}
                onClick={() => it.kind === 'recovery' ? onTabChange('recovery') : onTabChange('recovery')}
                className="w-full text-left px-5 py-4 hover:bg-white/5 transition-colors"
              >
                <div className="flex items-start gap-3">
                  <span className={`shrink-0 mt-0.5 px-2 py-0.5 rounded-full border text-[10px] font-bold ${priTone(it.priority)}`}>{it.priority}</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold text-white truncate">{it.label}</div>
                    <div className="text-xs text-gray-300/70 mt-1 truncate">
                      {it.contact_name ? `${it.contact_name} · ` : ""}{fmt.phone(it.from_number)} · {fmt.date(it.at)}
                    </div>
                    {it.body && <div className="text-xs text-gray-200/80 mt-1 line-clamp-2">“{it.body}”</div>}
                  </div>
                </div>
              </button>
            ))}
            {!loading && incidents.length === 0 && (
              <div className="px-5 py-8 text-sm text-gray-300/70">No incidents in the last 7 days.</div>
            )}
          </div>
        </div>

        {/* Timeline */}
        <div className="rounded-3xl border border-white/10 bg-gradient-to-br from-white/10 to-white/5 backdrop-blur-xl shadow-[0_20px_80px_-30px_rgba(0,0,0,0.8)] overflow-hidden">
          <div className="px-5 py-4 border-b border-white/10">
            <h3 className="text-sm font-bold text-white">Timeline</h3>
            <p className="text-xs text-gray-300/70 mt-1">Recent calls and messages</p>
          </div>
          <div className="p-3 space-y-2 max-h-[60vh] overflow-y-auto">
            {(triage?.recentCalls || recentCalls || []).slice(0, 30).map((c: any) => (
              <button
                key={c.call_sid}
                onClick={() => onCallClick(c as Call)}
                className="w-full text-left px-3 py-2 rounded-2xl hover:bg-white/5 transition-colors"
              >
                <div className="text-xs font-semibold text-white truncate">{c.contact_name || fmt.phone(c.from_number)}</div>
                <div className="text-[11px] text-gray-300/70 truncate">{fmt.date(c.started_at)} · {c.direction} · {c.outcome || "—"}</div>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Call Detail Modal ─────────────────────────────────────────────────────────
function CallDetailModal({ call, onClose }: { call: Call; onClose: () => void }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [recordings, setRecordings] = useState<any[]>([]);
  const [loadingRecordings, setLoadingRecordings] = useState(true);

  useEffect(() => {
    api<{ messages: Message[]; call: any; events: any[]; summary: any }>(`/api/calls/${call.call_sid}/messages`)
      .then((d) => setMessages(Array.isArray(d) ? d : (d.messages || [])))
      .catch(() => {})
      .finally(() => setLoading(false));
    api<any>(`/api/calls/${call.call_sid}/recording`)
      .then((d) => setRecordings(d.recordings || []))
      .catch(() => {})
      .finally(() => setLoadingRecordings(false));
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

        {/* Recording Playback */}
        {!loadingRecordings && recordings.length > 0 && (
          <div className="px-5 py-3 border-b border-gray-800 bg-gray-900/30">
            <p className="text-xs font-semibold uppercase tracking-widest text-gray-500 mb-2">Recording</p>
            {recordings.map((r: any) => (
              <div key={r.sid} className="flex items-center gap-3">
                <audio controls className="flex-1 h-8" style={{ filter: 'invert(0.85) hue-rotate(180deg)' }}
                  src={r.url}>
                  Your browser does not support audio playback.
                </audio>
                <span className="text-xs text-gray-600 shrink-0">{r.duration}s</span>
              </div>
            ))}
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
  const { addToast } = useToast();
  const [calls, setCalls] = useState<Call[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"all" | "inbound" | "outbound">("all");
  const [search, setSearch] = useState("");
  const [sentimentFilter, setSentimentFilter] = useState<"all"|"positive"|"neutral"|"negative">("all");
  const [deleting, setDeleting] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const [showClearMenu, setShowClearMenu] = useState(false);

  const loadCalls = () => {
    setLoading(true);
    api<{ calls: Call[] }>("/api/calls")
      .then((d) => setCalls(d.calls || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => { loadCalls(); }, []);

  const deleteCall = async (sid: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm("Delete this call and all its data?")) return;
    setDeleting(sid);
    try {
      await api(`/api/calls/${sid}`, { method: "DELETE" });
      setCalls((prev) => prev.filter((c) => c.call_sid !== sid));
      addToast({ type: "success", message: "Call deleted" });
    } catch {
      addToast({ type: "error", message: "Failed to delete call" });
    } finally {
      setDeleting(null);
    }
  };

  const fixStaleLive = async () => {
    setClearing(true);
    setShowClearMenu(false);
    try {
      const result = await api<{ fixed: number }>("/api/calls/fix-stale", { method: "PATCH" });
      addToast({ type: "success", message: `Fixed ${result.fixed} stuck live call${result.fixed !== 1 ? "s" : ""}` });
      loadCalls();
    } catch {
      addToast({ type: "error", message: "Failed to fix stale calls" });
    } finally {
      setClearing(false);
    }
  };

  const bulkClear = async (filterType: "stale" | "all") => {
    const msg = filterType === "all"
      ? "Delete ALL calls permanently? This cannot be undone."
      : "Delete all stale/failed calls with no duration?";
    if (!confirm(msg)) return;
    setClearing(true);
    setShowClearMenu(false);
    try {
      const result = await api<{ deleted: number }>(`/api/calls?filter=${filterType}`, { method: "DELETE" });
      addToast({ type: "success", message: `Cleared ${result.deleted} call${result.deleted !== 1 ? "s" : ""}` });
      loadCalls();
    } catch {
      addToast({ type: "error", message: "Failed to clear calls" });
    } finally {
      setClearing(false);
    }
  };

  const filtered = calls.filter((c) => {
    if (filter !== "all" && c.direction !== filter) return false;
    if (sentimentFilter !== "all" && c.sentiment !== sentimentFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      return (c.contact_name || "").toLowerCase().includes(q) ||
             (c.from_number || "").includes(q) ||
             (c.intent || "").toLowerCase().includes(q) ||
             (c.call_summary || "").toLowerCase().includes(q);
    }
    return true;
  });

  return (
    <div className="p-6 space-y-4 max-w-5xl mx-auto">
      {/* Filters */}
      <div className="flex flex-wrap gap-2 items-center">
        {(["all", "inbound", "outbound"] as const).map((f) => (
          <button key={f} onClick={() => setFilter(f)}
            className={`px-4 py-2 rounded-xl text-sm font-medium transition-all ${
              filter === f ? "bg-violet-700 text-white" : "bg-gray-900 border border-gray-800 text-gray-500 hover:border-gray-700 hover:text-gray-300"
            }`}>
            {f.charAt(0).toUpperCase() + f.slice(1)}
          </button>
        ))}
        <div className="h-4 w-px bg-gray-800" />
        {(["all", "positive", "neutral", "negative"] as const).map((s) => (
          <button key={s} onClick={() => setSentimentFilter(s)}
            className={`px-3 py-1.5 rounded-xl text-xs font-medium transition-all ${
              sentimentFilter === s ? "bg-violet-700 text-white" : "bg-gray-900 border border-gray-800 text-gray-500 hover:border-gray-700 hover:text-gray-300"
            }`}>
            {s === "all" ? "All Sentiment" : s === "positive" ? "😊 Positive" : s === "neutral" ? "😐 Neutral" : "😠 Negative"}
          </button>
        ))}
        <input value={search} onChange={(e) => setSearch(e.target.value)}
          placeholder="Search calls…"
          className="ml-auto bg-gray-900 border border-gray-800 rounded-xl px-4 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-violet-600 w-52 transition-colors" />
        <span className="text-xs text-gray-600">{filtered.length} calls</span>
        <div className="relative">
          <button onClick={() => setShowClearMenu((v) => !v)}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium bg-red-950/40 border border-red-900/40 text-red-400 hover:bg-red-950/70 transition-all">
            {clearing ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
            Clear
          </button>
          {showClearMenu && (
            <div className="absolute right-0 top-full mt-1 z-50 bg-gray-900 border border-gray-800 rounded-xl shadow-xl overflow-hidden w-48">
              <button onClick={fixStaleLive}
                className="w-full px-4 py-2.5 text-left text-xs text-blue-400 hover:bg-gray-800 transition-colors">
                Fix stuck live calls
              </button>
              <button onClick={() => bulkClear("stale")}
                className="w-full px-4 py-2.5 text-left text-xs text-yellow-400 hover:bg-gray-800 transition-colors border-t border-gray-800">
                Clear stale/failed calls
              </button>
              <button onClick={() => bulkClear("all")}
                className="w-full px-4 py-2.5 text-left text-xs text-red-400 hover:bg-gray-800 transition-colors border-t border-gray-800">
                Clear ALL calls
              </button>
            </div>
          )}
        </div>
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
              <button
                onClick={(e) => deleteCall(c.call_sid, e)}
                disabled={deleting === c.call_sid}
                className="ml-1 p-1.5 rounded-lg text-gray-700 hover:text-red-400 hover:bg-red-950/40 transition-all opacity-0 group-hover:opacity-100"
              >
                {deleting === c.call_sid ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
              </button>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Contact Detail Modal ─────────────────────────────────────────────────────
function ContactDetailModal({ contactId, onClose }: { contactId: number; onClose: () => void }) {
  const { addToast } = useToast();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [editMode, setEditMode] = useState(false);
  const [form, setForm] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState<'overview'|'calls'|'fields'>('overview');

  const load = () => {
    setLoading(true);
    api<any>(`/api/contacts/${contactId}/detail`)
      .then((d) => {
        setData(d);
        setForm({
          name: d.contact.name || '',
          email: d.contact.email || '',
          company: d.contact.company || d.contact.company_name || '',
          address: d.contact.address || '',
          city: d.contact.city || '',
          state: d.contact.state || '',
          zip: d.contact.zip || '',
          notes: d.contact.notes || '',
        });
      })
      .catch(() => addToast({ type: 'error', message: 'Failed to load contact' }))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, [contactId]);

  const save = async () => {
    setSaving(true);
    try {
      await api(`/api/contacts/${contactId}`, { method: 'PATCH', body: JSON.stringify(form) });
      addToast({ type: 'success', message: 'Contact updated' });
      setEditMode(false);
      load();
    } catch { addToast({ type: 'error', message: 'Failed to save' }); }
    finally { setSaving(false); }
  };

  const c = data?.contact;
  const sentimentColor = (s: string) => s === 'positive' ? 'text-emerald-400' : s === 'negative' ? 'text-red-400' : 'text-gray-400';
  const outcomeColor = (o: string) => o === 'appointment_booked' ? 'text-emerald-400' : o === 'escalated' ? 'text-amber-400' : o === 'incomplete' ? 'text-red-400' : 'text-gray-400';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-2xl max-h-[90vh] flex flex-col rounded-2xl bg-gray-950 border border-gray-800 shadow-2xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-gray-800 shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-violet-900/40 border border-violet-700/40 flex items-center justify-center">
              <User size={18} className="text-violet-400" />
            </div>
            <div>
              <h2 className="text-base font-bold text-white">{c?.name || 'Unknown Caller'}</h2>
              <p className="text-xs text-gray-500">{c?.phone_number} {c?.company ? `· ${c.company}` : ''}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {!editMode && <button onClick={() => setEditMode(true)} className="p-2 rounded-lg hover:bg-gray-800 text-gray-500 hover:text-white transition-colors"><Pencil size={14} /></button>}
            <button onClick={onClose} className="p-2 rounded-lg hover:bg-gray-800 text-gray-500 hover:text-white transition-colors"><X size={18} /></button>
          </div>
        </div>
        {/* Tabs */}
        <div className="flex border-b border-gray-800 shrink-0">
          {(['overview','calls','fields'] as const).map((t) => (
            <button key={t} onClick={() => setActiveTab(t)}
              className={`px-5 py-3 text-xs font-semibold uppercase tracking-widest transition-colors ${activeTab === t ? 'text-violet-400 border-b-2 border-violet-500' : 'text-gray-600 hover:text-gray-400'}`}>{t}</button>
          ))}
        </div>
        {/* Body */}
        <div className="flex-1 overflow-y-auto" style={{ background: 'var(--smirk-black)' }}>
          {loading ? (
            <div className="flex justify-center py-16"><Loader2 size={24} className="animate-spin text-gray-600" /></div>
          ) : activeTab === 'overview' ? (
            <div className="p-5 space-y-5">
              <div className="grid grid-cols-3 gap-3">
                {[{ label: 'Total Calls', value: c?.total_calls || 0 }, { label: 'Open Tasks', value: data?.tasks?.filter((t: any) => t.status === 'open').length || 0 }, { label: 'Appointments', value: data?.appointments?.length || 0 }].map((s) => (
                  <div key={s.label} className="rounded-xl bg-gray-900 border border-gray-800 p-3 text-center">
                    <div className="text-xl font-bold text-white">{s.value}</div>
                    <div className="text-xs text-gray-600 mt-0.5">{s.label}</div>
                  </div>
                ))}
              </div>
              {editMode ? (
                <div className="space-y-3">
                  {[{k:'name',l:'Name'},{k:'email',l:'Email'},{k:'company',l:'Company'},{k:'address',l:'Address'},{k:'city',l:'City'},{k:'state',l:'State'},{k:'zip',l:'Zip'}].map(({k,l}) => (
                    <div key={k}>
                      <label className="block text-xs font-semibold uppercase tracking-widest text-gray-500 mb-1.5">{l}</label>
                      <input value={form[k]||''} onChange={(e)=>setForm(f=>({...f,[k]:e.target.value}))}
                        className="w-full bg-gray-900 border border-gray-700 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-violet-600 transition-colors" />
                    </div>
                  ))}
                  <div>
                    <label className="block text-xs font-semibold uppercase tracking-widest text-gray-500 mb-1.5">Notes</label>
                    <textarea value={form.notes||''} onChange={(e)=>setForm(f=>({...f,notes:e.target.value}))} rows={3}
                      className="w-full bg-gray-900 border border-gray-700 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-violet-600 transition-colors resize-none" />
                  </div>
                  <div className="flex gap-2">
                    <button onClick={()=>setEditMode(false)} className="flex-1 py-2.5 rounded-xl border border-gray-700 text-gray-400 text-sm hover:border-gray-600 hover:text-white transition-colors">Cancel</button>
                    <button onClick={save} disabled={saving} className="flex-1 py-2.5 rounded-xl bg-violet-700 hover:bg-violet-600 text-white text-sm font-semibold transition-colors flex items-center justify-center gap-2 disabled:opacity-40">
                      {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />} Save
                    </button>
                  </div>
                </div>
              ) : (
                <div className="space-y-1">
                  {[
                    ['Phone', c?.phone_number],
                    ['Email', c?.email],
                    ['Company', c?.company_name || c?.company || c?.business_name],
                    ['Address', [c?.address, c?.city, c?.state, c?.zip].filter(Boolean).join(', ')],
                    ['Notes', c?.notes],
                  ].filter(([,v])=>v).map(([l,v]) => (
                    <div key={l as string} className="flex gap-3 py-2 border-b border-gray-900">
                      <span className="text-xs text-gray-600 w-20 shrink-0 pt-0.5">{l}</span>
                      <span className="text-sm text-white break-words">{v as string}</span>
                    </div>
                  ))}
                  {(data?.appointments || []).length > 0 && (
                    <div className="mt-3">
                      <p className="text-xs font-semibold uppercase tracking-widest text-gray-500 mb-2">Appointments</p>
                      {data.appointments.map((a: any) => (
                        <div key={a.id} className="flex items-start gap-3 py-2 border-b border-gray-900">
                          <div className="w-2 h-2 rounded-full mt-1.5 shrink-0 bg-emerald-500" />
                          <div>
                            <p className="text-sm text-white">{a.service_type || 'Appointment'}</p>
                            <p className="text-xs text-gray-500">{a.scheduled_at ? new Date(a.scheduled_at).toLocaleString() : 'Time TBD'}</p>
                            {a.notes && <p className="text-xs text-gray-600 mt-0.5">{a.notes}</p>}
                          </div>
                          <span className={`ml-auto text-xs px-2 py-0.5 rounded-full ${
                            a.status === 'scheduled' ? 'bg-emerald-950 text-emerald-400' :
                            a.status === 'completed' ? 'bg-gray-800 text-gray-500' :
                            'bg-red-950 text-red-400'
                          }`}>{a.status}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {(data?.tasks || []).filter((t: any) => t.status === 'open').length > 0 && (
                    <div className="mt-3">
                      <p className="text-xs font-semibold uppercase tracking-widest text-gray-500 mb-2">Open Tasks</p>
                      {data.tasks.filter((t: any) => t.status === 'open').map((t: any) => (
                        <div key={t.id} className="flex items-start gap-3 py-2 border-b border-gray-900">
                          <div className="w-2 h-2 rounded-full mt-1.5 shrink-0 bg-amber-500" />
                          <div className="flex-1">
                            <p className="text-sm text-white">{t.task_type.replace(/_/g,' ')}</p>
                            {t.notes && <p className="text-xs text-gray-500 mt-0.5">{t.notes}</p>}
                            {t.due_at && <p className="text-xs text-gray-700 mt-0.5">Due {new Date(t.due_at).toLocaleDateString()}</p>}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {data?.summaries?.[0] && (
                <div className="rounded-xl bg-gray-900 border border-gray-800 p-4">
                  <p className="text-xs font-semibold uppercase tracking-widest text-gray-500 mb-2">Last Call Summary</p>
                  <p className="text-sm text-gray-300">{data.summaries[0].summary}</p>
                  <div className="flex gap-4 mt-2">
                    <span className={`text-xs ${sentimentColor(data.summaries[0].sentiment)}`}>{data.summaries[0].sentiment}</span>
                    <span className={`text-xs ${outcomeColor(data.summaries[0].outcome)}`}>{data.summaries[0].outcome?.replace(/_/g,' ')}</span>
                  </div>
                </div>
              )}
            </div>
          ) : activeTab === 'calls' ? (
            <div className="divide-y divide-gray-900">
              {(data?.calls || []).length === 0 ? (
                <p className="text-center text-gray-600 text-sm py-10">No calls recorded</p>
              ) : (data?.calls || []).map((call: any) => (
                <div key={call.call_sid} className="p-4 hover:bg-gray-900/50 transition-colors">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs text-gray-500">{fmt.date(call.started_at)}</span>
                    <div className="flex items-center gap-2">
                      {call.sentiment && <span className={`text-xs ${sentimentColor(call.sentiment)}`}>{call.sentiment}</span>}
                      {call.duration_seconds && <span className="text-xs text-gray-600">{Math.floor(call.duration_seconds/60)}m {call.duration_seconds%60}s</span>}
                    </div>
                  </div>
                  {call.call_summary && <p className="text-sm text-gray-300 leading-relaxed">{call.call_summary}</p>}
                  {call.outcome && <span className={`text-xs mt-1 inline-block ${outcomeColor(call.outcome)}`}>{call.outcome.replace(/_/g,' ')}</span>}
                </div>
              ))}
            </div>
          ) : (
            <div className="p-5">
              <p className="text-xs text-gray-600 mb-4">Fields extracted from calls by AI. Confidence shows how certain the extraction was. Snippet shows the exact quote used.</p>
              <div className="space-y-3">
                {(data?.customFields || []).length === 0 ? (
                  <div className="text-center py-8">
                    <Database size={28} className="mx-auto text-gray-700 mb-2" />
                    <p className="text-sm text-gray-600">No fields captured yet.</p>
                    <p className="text-xs text-gray-700 mt-1">Fields are extracted automatically after each completed call. Requires OpenRouter or Gemini key.</p>
                  </div>
                ) : (data?.customFields || []).map((f: any) => (
                  <div key={f.field_key} className="p-3 rounded-xl bg-gray-900 border border-gray-800 space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-gray-500 uppercase tracking-widest font-semibold">{f.field_key.replace(/_/g,' ')}</span>
                      <div className="flex items-center gap-2">
                        {f.confidence != null && (
                          <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${
                            f.confidence >= 0.85 ? 'bg-emerald-950 text-emerald-400' :
                            f.confidence >= 0.6  ? 'bg-amber-950 text-amber-400' :
                            'bg-red-950 text-red-400'
                          }`}>{Math.round(f.confidence * 100)}%</span>
                        )}
                        <span className="text-xs text-gray-700">{f.source}</span>
                      </div>
                    </div>
                    <div className="text-sm text-white font-medium">{f.field_value}</div>
                    {f.transcript_snippet && (
                      <div className="text-xs text-gray-600 italic border-l-2 border-gray-700 pl-2 mt-1">
                        "{f.transcript_snippet}"
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Contacts Page ─────────────────────────────────────────────────────────────
function ContactsPage() {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<number | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const { addToast } = useToast();

  const load = () => {
    setLoading(true);
    api<{ contacts: Contact[] }>('/api/contacts?limit=200')
      .then((d) => setContacts(d.contacts || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  const filtered = contacts.filter((c) => {
    const q = search.toLowerCase();
    return !q || (c.name||'').toLowerCase().includes(q) || (c.phone_number||'').includes(q) || ((c as any).company||'').toLowerCase().includes(q) || (c.email||'').toLowerCase().includes(q);
  });

  const deleteContact = async (id: number, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm('Delete this contact? This cannot be undone.')) return;
    setDeletingId(id);
    try {
      await api(`/api/contacts/${id}`, { method: 'DELETE' });
      addToast({ type: 'success', message: 'Contact deleted' });
      load();
    } catch { addToast({ type: 'error', message: 'Failed to delete contact' }); }
    finally { setDeletingId(null); }
  };

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center gap-3">
        <div className="relative flex-1">
          <input
            value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name, phone, email, company…"
            className="w-full bg-gray-900 border border-gray-800 rounded-xl px-4 py-2.5 pl-9 text-sm text-white placeholder-gray-700 focus:outline-none focus:border-violet-600 transition-colors"
          />
          <Users size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-600" />
        </div>
        <span className="text-xs text-gray-600 shrink-0">{filtered.length} contacts</span>
        <button onClick={() => setShowAddModal(true)} className="flex items-center gap-1.5 px-3 py-2 bg-violet-700 hover:bg-violet-600 text-white text-xs font-semibold rounded-xl transition-colors shrink-0">
          <UserPlus size={13} /> Add Contact
        </button>
      </div>

      {loading ? (
        <div className="flex justify-center py-16"><Loader2 size={28} className="animate-spin text-gray-600" /></div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 rounded-2xl border border-dashed border-gray-800">
          <Users size={36} className="mx-auto text-gray-700 mb-3" />
          <p className="text-gray-500 text-sm">{search ? 'No contacts match your search' : 'No contacts yet'}</p>
          <p className="text-gray-700 text-xs mt-1">Contacts are created automatically from incoming calls</p>
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((c) => (
            <div key={c.id} className="flex items-center gap-2">
              <button onClick={() => setSelected(c.id)}
                className="flex-1 flex items-center gap-3 p-4 rounded-xl bg-gray-900 border border-gray-800 hover:border-violet-700/50 hover:bg-gray-900/80 transition-colors text-left">
                <div className="w-10 h-10 rounded-full bg-gray-800 border border-gray-700 flex items-center justify-center text-gray-400 shrink-0">
                  <User size={16} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-white">{c.name || 'Unknown'}</span>
                    {c.do_not_call && <span className="text-xs px-1.5 py-0.5 rounded bg-red-950 text-red-500 border border-red-900">DNC</span>}
                    {(c as any).company && <span className="text-xs text-gray-600">{(c as any).company}</span>}
                  </div>
                  <div className="text-xs text-gray-600">{fmt.phone(c.phone_number)}{c.email ? ` · ${c.email}` : ''} · {c.total_calls} call{c.total_calls !== 1 ? 's' : ''}</div>
                  {c.last_summary && <p className="text-xs text-gray-700 mt-0.5 truncate">{c.last_summary}</p>}
                </div>
                <div className="text-right shrink-0">
                  <div className="text-xs text-gray-600">{fmt.date(c.last_seen)}</div>
                  {c.open_tasks_count > 0 && <span className="text-xs text-amber-500">{c.open_tasks_count} task{c.open_tasks_count !== 1 ? 's' : ''}</span>}
                  <ChevronRight size={14} className="text-gray-700 mt-1 ml-auto" />
                </div>
              </button>
              <button onClick={(e) => deleteContact(c.id, e)} disabled={deletingId === c.id}
                className="p-2.5 rounded-xl bg-gray-900 border border-gray-800 hover:border-red-700/60 hover:bg-red-950/30 text-gray-600 hover:text-red-500 transition-colors shrink-0">
                {deletingId === c.id ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
              </button>
            </div>
          ))}
        </div>
      )}

      {selected !== null && (
        <ContactDetailModal contactId={selected} onClose={() => { setSelected(null); load(); }} />
      )}

      {showAddModal && (
        <AddContactModal onClose={() => setShowAddModal(false)} onSaved={() => { setShowAddModal(false); load(); }} />
      )}
    </div>
  );
}

// ── Add Contact Modal ─────────────────────────────────────────────────────────
function AddContactModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({ name: '', phone_number: '', email: '', company: '', notes: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const { addToast } = useToast();

  const save = async () => {
    if (!form.phone_number.trim()) { setError('Phone number is required'); return; }
    setSaving(true); setError('');
    try {
      await api('/api/contacts', { method: 'POST', body: JSON.stringify(form) });
      addToast({ type: 'success', message: 'Contact created' });
      onSaved();
    } catch (e: any) {
      setError(e.message || 'Failed to create contact');
    } finally { setSaving(false); }
  };

  const inputCls = 'w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-violet-500 transition-colors';

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-gray-950 border border-gray-800 rounded-2xl w-full max-w-md shadow-2xl">
        <div className="flex items-center justify-between p-5 border-b border-gray-800">
          <div className="flex items-center gap-2">
            <UserPlus size={16} className="text-violet-400" />
            <span className="font-semibold text-white text-sm">Add Contact</span>
          </div>
          <button onClick={onClose} className="text-gray-600 hover:text-white transition-colors"><X size={16} /></button>
        </div>
        <div className="p-5 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-gray-500 mb-1">Name</label>
              <input value={form.name} onChange={(e) => setForm(f => ({...f, name: e.target.value}))} placeholder="Jane Smith" className={inputCls} />
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-500 mb-1">Phone <span className="text-red-500">*</span></label>
              <input value={form.phone_number} onChange={(e) => setForm(f => ({...f, phone_number: e.target.value}))} placeholder="+1 555 000 0000" className={inputCls} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-gray-500 mb-1">Email</label>
              <input value={form.email} onChange={(e) => setForm(f => ({...f, email: e.target.value}))} placeholder="jane@example.com" className={inputCls} />
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-500 mb-1">Company</label>
              <input value={form.company} onChange={(e) => setForm(f => ({...f, company: e.target.value}))} placeholder="Acme Corp" className={inputCls} />
            </div>
          </div>
          <div>
            <label className="block text-xs font-semibold text-gray-500 mb-1">Notes</label>
            <textarea value={form.notes} onChange={(e) => setForm(f => ({...f, notes: e.target.value}))} placeholder="Any initial notes..." rows={2} className={inputCls + ' resize-none'} />
          </div>
          {error && <p className="text-xs text-red-500">{error}</p>}
        </div>
        <div className="flex gap-2 p-5 pt-0">
          <button onClick={onClose} className="flex-1 px-4 py-2.5 rounded-xl border border-gray-700 text-gray-400 text-sm hover:border-gray-600 transition-colors">Cancel</button>
          <button onClick={save} disabled={saving} className="flex-1 px-4 py-2.5 rounded-xl bg-violet-700 hover:bg-violet-600 text-white text-sm font-semibold transition-colors disabled:opacity-50">
            {saving ? 'Saving...' : 'Create Contact'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Task Detail Modal ─────────────────────────────────────────────────────────
function TaskDetailModal({ task, onClose, onRefresh }: { task: Task; onClose: () => void; onRefresh: () => void }) {
  const [editing, setEditing] = useState(false);
  const [notes, setNotes] = useState(task.notes || "");
  const [dueAt, setDueAt] = useState(task.due_at ? task.due_at.slice(0, 16) : "");
  const [saving, setSaving] = useState(false);
  const [aiQuery, setAiQuery] = useState("");
  const [aiResponse, setAiResponse] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const { addToast } = useToast();

  const updateTask = async (status?: string) => {
    setSaving(true);
    try {
      await api(`/api/tasks/${task.id}`, { method: "PATCH", body: JSON.stringify({
        ...(status ? { status } : {}),
        notes: notes || undefined,
        due_at: dueAt || undefined,
      })});
      addToast({ type: "success", message: status === "cancelled" ? "Task cancelled" : status === "completed" ? "Task completed" : "Task updated" });
      onRefresh();
      if (status) onClose();
      else setEditing(false);
    } catch { addToast({ type: "error", message: "Failed to update task" }); }
    finally { setSaving(false); }
  };

  const askAi = async () => {
    if (!aiQuery.trim()) return;
    setAiLoading(true);
    try {
      const d = await api<{ reply: string }>("/api/chat", { method: "POST", body: JSON.stringify({ message: `Regarding task #${task.id} (${task.task_type.replace(/_/g," ")}) for ${task.contact_name || "unknown"}: ${aiQuery}` }) });
      setAiResponse(d.reply || "");
    } catch { setAiResponse("Failed to get AI response"); }
    finally { setAiLoading(false); }
  };

  const statusColor = task.status === "completed" ? "text-emerald-500" : task.status === "pending" ? "text-amber-500" : task.status === "cancelled" ? "text-red-500" : "text-gray-400";
  const inputCls = "w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-violet-500 transition-colors";

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-gray-950 border border-gray-800 rounded-2xl w-full max-w-lg shadow-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-5 border-b border-gray-800 sticky top-0 bg-gray-950 z-10">
          <div>
            <div className="flex items-center gap-2">
              <ListTodo size={15} className="text-violet-400" />
              <span className="font-semibold text-white text-sm">{task.task_type.replace(/_/g, " ")}</span>
              <span className={`text-xs font-medium ${statusColor}`}>{task.status}</span>
            </div>
            {task.contact_name && <p className="text-xs text-gray-500 mt-0.5">{task.contact_name}{task.phone_number ? ` · ${fmt.phone(task.phone_number)}` : ""}</p>}
          </div>
          <button onClick={onClose} className="text-gray-600 hover:text-white transition-colors"><X size={16} /></button>
        </div>

        <div className="p-5 space-y-4">
          <div className="grid grid-cols-2 gap-3 text-xs">
            <div className="bg-gray-900 rounded-xl p-3">
              <p className="text-gray-500 mb-1">Created</p>
              <p className="text-white">{fmt.date(task.created_at)}</p>
            </div>
            <div className="bg-gray-900 rounded-xl p-3">
              <p className="text-gray-500 mb-1">Due</p>
              <p className="text-white">{task.due_at ? fmt.date(task.due_at) : "No due date"}</p>
            </div>
          </div>

          {editing ? (
            <div className="space-y-2">
              <label className="block text-xs font-semibold text-gray-500">Notes</label>
              <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} className={inputCls + " resize-none"} placeholder="Add notes..." />
              <label className="block text-xs font-semibold text-gray-500">Due Date</label>
              <input type="datetime-local" value={dueAt} onChange={(e) => setDueAt(e.target.value)} className={inputCls} />
            </div>
          ) : (
            task.notes && (
              <div className="bg-gray-900 rounded-xl p-3">
                <p className="text-xs text-gray-500 mb-1">Notes</p>
                <p className="text-sm text-gray-300">{task.notes}</p>
              </div>
            )
          )}

          <div className="border border-gray-800 rounded-xl p-3 space-y-2">
            <p className="text-xs font-semibold text-violet-400 flex items-center gap-1"><Zap size={11} /> Ask SMIRK about this task</p>
            <div className="flex gap-2">
              <input value={aiQuery} onChange={(e) => setAiQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && askAi()}
                placeholder="What should I say when I call them back?" className={inputCls + " flex-1"} />
              <button onClick={askAi} disabled={aiLoading} className="px-3 py-2 bg-violet-700 hover:bg-violet-600 rounded-xl text-white text-xs font-semibold transition-colors disabled:opacity-50">
                {aiLoading ? <Loader2 size={12} className="animate-spin" /> : "Ask"}
              </button>
            </div>
            {aiResponse && <p className="text-xs text-gray-300 bg-gray-900 rounded-lg p-2.5 whitespace-pre-wrap">{aiResponse}</p>}
          </div>
        </div>

        {task.status !== "completed" && task.status !== "cancelled" && (
          <div className="flex gap-2 p-5 pt-0">
            {editing ? (
              <>
                <button onClick={() => setEditing(false)} className="flex-1 px-3 py-2.5 rounded-xl border border-gray-700 text-gray-400 text-sm hover:border-gray-600 transition-colors">Cancel</button>
                <button onClick={() => updateTask()} disabled={saving} className="flex-1 px-3 py-2.5 rounded-xl bg-violet-700 hover:bg-violet-600 text-white text-sm font-semibold transition-colors disabled:opacity-50">
                  {saving ? "Saving..." : "Save Changes"}
                </button>
              </>
            ) : (
              <>
                <button onClick={() => updateTask("cancelled")} disabled={saving} className="px-3 py-2.5 rounded-xl border border-red-900/50 text-red-500 text-sm hover:bg-red-950/30 transition-colors">
                  Cancel Task
                </button>
                <button onClick={() => setEditing(true)} className="flex-1 px-3 py-2.5 rounded-xl border border-gray-700 text-gray-300 text-sm hover:border-gray-600 transition-colors">
                  Edit
                </button>
                <button onClick={() => updateTask("completed")} disabled={saving} className="flex-1 px-3 py-2.5 rounded-xl bg-emerald-700 hover:bg-emerald-600 text-white text-sm font-semibold transition-colors disabled:opacity-50">
                  {saving ? "Saving..." : "✓ Done Now"}
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Tasks Page ────────────────────────────────────────────────────────────────
function TasksPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [filter, setFilter] = useState<"all" | "open" | "completed" | "cancelled">("open");
  const { addToast } = useToast();

  const load = () => {
    api<{ tasks: Task[] }>("/api/tasks")
      .then((d) => setTasks(d.tasks || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const filtered = tasks.filter((t) => {
    if (filter === "open") return t.status !== "completed" && t.status !== "cancelled";
    if (filter === "completed") return t.status === "completed";
    if (filter === "cancelled") return t.status === "cancelled";
    return true;
  });

  const openCount = tasks.filter((t) => t.status !== "completed" && t.status !== "cancelled").length;
  const doneCount = tasks.filter((t) => t.status === "completed").length;

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-widest text-gray-500">
          {openCount} open · {doneCount} completed
        </h3>
        <div className="flex gap-1">
          {(["open","all","completed","cancelled"] as const).map((f) => (
            <button key={f} onClick={() => setFilter(f)}
              className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${filter === f ? "bg-violet-700 text-white" : "text-gray-500 hover:text-gray-300"}`}>
              {f.charAt(0).toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-16"><Loader2 size={28} className="animate-spin text-gray-600" /></div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 rounded-2xl border border-dashed border-gray-800">
          <ListTodo size={36} className="mx-auto text-gray-700 mb-3" />
          <p className="text-gray-500 text-sm">No {filter === "all" ? "" : filter} tasks</p>
          <p className="text-gray-700 text-xs mt-1">Tasks are created automatically from unresolved calls</p>
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((t) => (
            <button key={t.id} onClick={() => setSelectedTask(t)}
              className={`w-full flex items-start gap-3 p-4 rounded-xl border transition-all text-left ${
                t.status === "completed" ? "bg-gray-900/50 border-gray-800/50 opacity-60 hover:opacity-80" :
                t.status === "cancelled" ? "bg-gray-900/30 border-gray-800/30 opacity-50 hover:opacity-70" :
                "bg-gray-900 border-gray-800 hover:border-violet-700/40"
              }`}>
              <div className={`mt-0.5 w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0 ${
                t.status === "completed" ? "bg-emerald-600 border-emerald-600" :
                t.status === "cancelled" ? "bg-red-950 border-red-800" :
                "border-gray-600"
              }`}>
                {t.status === "completed" && <Check size={10} className="text-white" />}
                {t.status === "cancelled" && <X size={9} className="text-red-500" />}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="text-sm font-medium text-white">{t.task_type.replace(/_/g, " ")}</span>
                  <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${
                    t.status === "completed" ? "bg-emerald-950 text-emerald-600" :
                    t.status === "cancelled" ? "bg-red-950 text-red-500" :
                    t.status === "pending" ? "bg-amber-950 text-amber-500" : "bg-gray-800 text-gray-500"
                  }`}>{t.status}</span>
                </div>
                {t.contact_name && <div className="text-xs text-gray-600">{t.contact_name}{t.phone_number ? ` · ${fmt.phone(t.phone_number)}` : ""}</div>}
                {t.notes && <p className="text-xs text-gray-500 mt-1 truncate">{t.notes}</p>}
                <div className="text-xs text-gray-700 mt-1">{fmt.date(t.created_at)}</div>
              </div>
              <ChevronRight size={14} className="text-gray-700 mt-1 shrink-0" />
            </button>
          ))}
        </div>
      )}

      {selectedTask && (
        <TaskDetailModal task={selectedTask} onClose={() => setSelectedTask(null)} onRefresh={() => { load(); setSelectedTask(null); }} />
      )}
    </div>
  );
}

// ── Handoffs Page ───────────────────────────────────────────────────────────
type Handoff = {
  id: number;
  call_sid: string;
  reason: string;
  urgency: string;
  status: string;
  notes?: string;
  contact_name?: string;
  phone_number?: string;
  created_at: string;
  acknowledged_at?: string;
  assigned_to_name?: string;
  assigned_to_phone?: string;
  assigned_to_email?: string;
};

type TeamMember = {
  id: number;
  name: string;
  display_name?: string;
  role: string;
  department?: string;
  phone?: string;
  email?: string;
  avatar_initials: string;
  avatar_color: string;
  is_active: boolean;
  is_on_call: boolean;
  handles_topics?: string[];
  notes?: string;
  priority: number;
  created_at: string;
};

// ── Team Member Form Modal ─────────────────────────────────────────────────────
function TeamMemberModal({ member, onSave, onClose }: {
  member: Partial<TeamMember> | null;
  onSave: (data: Partial<TeamMember>) => Promise<void>;
  onClose: () => void;
}) {
  const { dark } = useTheme();
  const [form, setForm] = useState<Partial<TeamMember>>(member || {
    name: "", role: "", department: "", phone: "", email: "",
    avatar_color: "#6366f1", is_active: true, is_on_call: false,
    handles_topics: [], notes: "", priority: 0,
  });
  const [saving, setSaving] = useState(false);
  const [topicsInput, setTopicsInput] = useState((member?.handles_topics || []).join(", "));

  const AVATAR_COLORS = ["#6366f1","#8b5cf6","#ec4899","#f59e0b","#10b981","#3b82f6","#ef4444","#14b8a6"];
  const COMMON_ROLES = ["Owner","Manager","Sales Rep","Technician","Customer Service","Dispatcher","Scheduler","Admin","Estimator","Field Tech"];

  const card = dark ? "bg-gray-900 border-gray-800" : "bg-white border-gray-200";
  const inputCls = `w-full px-3 py-2 rounded-lg border text-sm outline-none transition-colors ${
    dark ? "bg-gray-800 border-gray-700 text-white placeholder-gray-600 focus:border-violet-500" : "bg-gray-50 border-gray-200 text-gray-900 placeholder-gray-400 focus:border-violet-400"
  }`;
  const labelCls = `block text-xs font-semibold mb-1 ${dark ? "text-gray-400" : "text-gray-600"}`;

  const handleSave = async () => {
    if (!form.name?.trim() || !form.role?.trim()) return;
    setSaving(true);
    try {
      const topics = topicsInput.split(",").map((t) => t.trim()).filter(Boolean);
      await onSave({ ...form, handles_topics: topics });
      onClose();
    } finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.7)" }}>
      <div className={`w-full max-w-lg rounded-2xl border shadow-2xl ${card} overflow-hidden`}>
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-full flex items-center justify-center text-white text-sm font-bold"
              style={{ background: form.avatar_color || "#6366f1" }}>
              {(form.name || "?").split(" ").map((w) => w[0]).join("").toUpperCase().slice(0,2)}
            </div>
            <h3 className="text-sm font-bold">{member?.id ? "Edit Team Member" : "Add Team Member"}</h3>
          </div>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-gray-800 text-gray-500 hover:text-white transition-colors"><X size={16} /></button>
        </div>

        {/* Body */}
        <div className="p-6 space-y-4 overflow-y-auto max-h-[70vh]">
          {/* Name + Role row */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Full Name *</label>
              <input className={inputCls} placeholder="e.g. Marcus Johnson" value={form.name || ""}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
            </div>
            <div>
              <label className={labelCls}>Role *</label>
              <input className={inputCls} list="role-suggestions" placeholder="e.g. Sales Rep" value={form.role || ""}
                onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))} />
              <datalist id="role-suggestions">{COMMON_ROLES.map((r) => <option key={r} value={r} />)}</datalist>
            </div>
          </div>

          {/* Department + Priority */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Department</label>
              <input className={inputCls} placeholder="e.g. Field Ops" value={form.department || ""}
                onChange={(e) => setForm((f) => ({ ...f, department: e.target.value }))} />
            </div>
            <div>
              <label className={labelCls}>Priority (higher = first routed)</label>
              <input type="number" min={0} max={100} className={inputCls} value={form.priority ?? 0}
                onChange={(e) => setForm((f) => ({ ...f, priority: parseInt(e.target.value) || 0 }))} />
            </div>
          </div>

          {/* Phone + Email */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Phone Number</label>
              <input className={inputCls} placeholder="+1 (555) 000-0000" value={form.phone || ""}
                onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} />
            </div>
            <div>
              <label className={labelCls}>Email</label>
              <input type="email" className={inputCls} placeholder="name@company.com" value={form.email || ""}
                onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} />
            </div>
          </div>

          {/* Handles Topics */}
          <div>
            <label className={labelCls}>Handles Topics (comma-separated)</label>
            <input className={inputCls} placeholder="billing, scheduling, complaints, technical, sales..."
              value={topicsInput} onChange={(e) => setTopicsInput(e.target.value)} />
            <p className={`text-xs mt-1 ${dark ? "text-gray-600" : "text-gray-400"}`}>The AI uses these to route the right calls to this person</p>
          </div>

          {/* Notes */}
          <div>
            <label className={labelCls}>Notes</label>
            <textarea className={`${inputCls} resize-none`} rows={2}
              placeholder="e.g. Best for complex billing issues. Available Mon-Fri 9am-5pm."
              value={form.notes || ""} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} />
          </div>

          {/* Avatar color + toggles */}
          <div className="flex items-center gap-6">
            <div>
              <label className={labelCls}>Avatar Color</label>
              <div className="flex gap-2 mt-1">
                {AVATAR_COLORS.map((c) => (
                  <button key={c} onClick={() => setForm((f) => ({ ...f, avatar_color: c }))}
                    className={`w-6 h-6 rounded-full transition-all ${form.avatar_color === c ? "ring-2 ring-white ring-offset-1 ring-offset-gray-900 scale-110" : ""}`}
                    style={{ background: c }} />
                ))}
              </div>
            </div>
            <div className="flex items-center gap-4 ml-auto">
              <label className="flex items-center gap-2 cursor-pointer">
                <span className={`text-xs ${dark ? "text-gray-400" : "text-gray-600"}`}>Active</span>
                <button onClick={() => setForm((f) => ({ ...f, is_active: !f.is_active }))}
                  className={`w-10 h-5 rounded-full transition-colors relative ${form.is_active ? "bg-emerald-600" : "bg-gray-700"}`}>
                  <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${form.is_active ? "left-5" : "left-0.5"}`} />
                </button>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <span className={`text-xs ${dark ? "text-gray-400" : "text-gray-600"}`}>On Call</span>
                <button onClick={() => setForm((f) => ({ ...f, is_on_call: !f.is_on_call }))}
                  className={`w-10 h-5 rounded-full transition-colors relative ${form.is_on_call ? "bg-violet-600" : "bg-gray-700"}`}>
                  <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${form.is_on_call ? "left-5" : "left-0.5"}`} />
                </button>
              </label>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-3 px-6 py-4 border-t border-gray-800">
          <button onClick={onClose} className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
            dark ? "bg-gray-800 hover:bg-gray-700 text-gray-300" : "bg-gray-100 hover:bg-gray-200 text-gray-700"
          }`}>Cancel</button>
          <button onClick={handleSave} disabled={saving || !form.name?.trim() || !form.role?.trim()}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white text-sm font-semibold transition-colors">
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
            {member?.id ? "Save Changes" : "Add Member"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Handoffs Page ─────────────────────────────────────────────────────────────
function HandoffsPage() {
  const { dark } = useTheme();
  const [activeTab, setActiveTab] = useState<"escalations" | "team">("escalations");
  // Escalations state
  const [handoffs, setHandoffs] = useState<Handoff[]>([]);
  const [handoffsLoading, setHandoffsLoading] = useState(true);
  // Team state
  const [team, setTeam] = useState<TeamMember[]>([]);
  const [teamLoading, setTeamLoading] = useState(true);
  const [editingMember, setEditingMember] = useState<Partial<TeamMember> | null | false>(false);
  const { addToast } = useToast();

  const muted = dark ? "text-gray-500" : "text-gray-400";
  const card = dark ? "bg-gray-900 border-gray-800" : "bg-white border-gray-200";

  const loadHandoffs = () => {
    api<{ handoffs: Handoff[] }>("/api/handoffs")
      .then((d) => setHandoffs(d.handoffs || []))
      .catch(() => {})
      .finally(() => setHandoffsLoading(false));
  };

  const loadTeam = () => {
    api<{ members: TeamMember[] }>("/api/team")
      .then((d) => setTeam(d.members || []))
      .catch(() => {})
      .finally(() => setTeamLoading(false));
  };

  useEffect(() => { loadHandoffs(); loadTeam(); }, []);

  const acknowledge = async (id: number) => {
    try {
      await api(`/api/handoffs/${id}/acknowledge`, { method: "POST" });
      addToast({ type: "success", message: "Handoff acknowledged" });
      loadHandoffs();
    } catch {
      addToast({ type: "error", message: "Failed to acknowledge" });
    }
  };

  const saveMember = async (data: Partial<TeamMember>) => {
    if (editingMember && (editingMember as TeamMember).id) {
      await api(`/api/team/${(editingMember as TeamMember).id}`, { method: "PATCH", body: JSON.stringify(data) });
      addToast({ type: "success", message: "Team member updated" });
    } else {
      await api("/api/team", { method: "POST", body: JSON.stringify(data) });
      addToast({ type: "success", message: "Team member added" });
    }
    loadTeam();
  };

  const deleteMember = async (id: number) => {
    if (!confirm("Remove this team member?")) return;
    await api(`/api/team/${id}`, { method: "DELETE" });
    addToast({ type: "success", message: "Team member removed" });
    loadTeam();
  };

  const toggleOnCall = async (member: TeamMember) => {
    await api(`/api/team/${member.id}/oncall`, { method: "PATCH", body: JSON.stringify({ is_on_call: !member.is_on_call }) });
    setTeam((prev) => prev.map((m) => m.id === member.id ? { ...m, is_on_call: !m.is_on_call } : m));
  };

  const urgencyColor = (u: string) => {
    if (u === "high" || u === "urgent") return "bg-red-950 text-red-400 border-red-900";
    if (u === "medium") return "bg-amber-950 text-amber-400 border-amber-900";
    return "bg-gray-800 text-gray-400 border-gray-700";
  };

  const statusColor = (s: string) => {
    if (s === "acknowledged") return "bg-emerald-950 text-emerald-400 border-emerald-900";
    if (s === "pending") return "bg-amber-950 text-amber-400 border-amber-900";
    return "bg-gray-800 text-gray-400 border-gray-700";
  };

  const pending = handoffs.filter((h) => h.status === "pending");
  const acked = handoffs.filter((h) => h.status !== "pending");
  const onCallCount = team.filter((m) => m.is_on_call && m.is_active).length;

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold">Handoffs &amp; Team</h2>
          <p className={`text-xs ${muted} mt-0.5`}>Manage your team roster and AI escalation routing</p>
        </div>
        <div className="flex items-center gap-2">
          {pending.length > 0 && (
            <span className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-950 border border-red-900 text-red-400 text-xs font-semibold">
              <span className="w-1.5 h-1.5 rounded-full bg-red-400 animate-pulse" />
              {pending.length} pending
            </span>
          )}
          {onCallCount > 0 && (
            <span className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-violet-950 border border-violet-900 text-violet-400 text-xs font-semibold">
              <BellRing size={12} />
              {onCallCount} on call
            </span>
          )}
          <button onClick={() => { loadHandoffs(); loadTeam(); }}
            className="p-2 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-white transition-colors">
            <RefreshCw size={14} />
          </button>
        </div>
      </div>

      {/* Tab switcher */}
      <div className="flex gap-1 p-1 rounded-xl bg-gray-900 border border-gray-800 w-fit">
        {(["escalations", "team"] as const).map((t) => (
          <button key={t} onClick={() => setActiveTab(t)}
            className={`px-4 py-1.5 rounded-lg text-xs font-semibold transition-all capitalize ${
              activeTab === t
                ? "bg-violet-700 text-white"
                : `${muted} hover:text-white`
            }`}>
            {t === "escalations" ? `Escalations${pending.length > 0 ? ` (${pending.length})` : ""}` : `Team (${team.length})`}
          </button>
        ))}
      </div>

      {/* ── ESCALATIONS TAB ── */}
      {activeTab === "escalations" && (
        handoffsLoading ? (
          <div className="flex justify-center py-16"><Loader2 size={28} className="animate-spin text-gray-600" /></div>
        ) : handoffs.length === 0 ? (
          <div className="text-center py-16 rounded-2xl border border-dashed border-gray-800">
            <Headphones size={36} className="mx-auto text-gray-700 mb-3" />
            <p className={`text-sm ${muted}`}>No handoffs yet</p>
            <p className="text-gray-700 text-xs mt-1">When the AI escalates a call to a human, it appears here</p>
          </div>
        ) : (
          <div className="space-y-3">
            {[...pending, ...acked].map((h) => (
              <div key={h.id} className={`p-4 rounded-xl border transition-all ${
                h.status === "pending"
                  ? "bg-gray-900 border-red-900/40 hover:border-red-800/60"
                  : "bg-gray-900/50 border-gray-800/50 opacity-60"
              }`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      <span className={`text-xs px-1.5 py-0.5 rounded border font-medium ${urgencyColor(h.urgency)}`}>
                        {h.urgency?.toUpperCase() || "NORMAL"}
                      </span>
                      <span className={`text-xs px-1.5 py-0.5 rounded border font-medium ${statusColor(h.status)}`}>
                        {h.status}
                      </span>
                      {h.contact_name && <span className="text-xs text-gray-400">{h.contact_name}</span>}
                      {h.phone_number && <span className="text-xs text-gray-600">{h.phone_number}</span>}
                    </div>
                    <p className="text-sm text-white font-medium">{h.reason || "Escalation requested"}</p>
                    {h.notes && <p className={`text-xs ${muted} mt-1`}>{h.notes}</p>}
                    {/* Assigned to */}
                    {h.assigned_to_name && (
                      <div className="flex items-center gap-2 mt-2 px-2 py-1 rounded-lg bg-violet-950/40 border border-violet-900/30 w-fit">
                        <PhoneForwarded size={11} className="text-violet-400" />
                        <span className="text-xs text-violet-300 font-medium">Routed to {h.assigned_to_name}</span>
                        {h.assigned_to_phone && (
                          <a href={`tel:${h.assigned_to_phone}`} className="text-xs text-violet-400 hover:text-violet-300">{h.assigned_to_phone}</a>
                        )}
                      </div>
                    )}
                    <div className="flex items-center gap-3 mt-2">
                      <span className={`text-xs ${dark ? "text-gray-700" : "text-gray-400"}`}>{fmt.date(h.created_at)}</span>
                      {h.acknowledged_at && (
                        <span className="text-xs text-emerald-700">Acknowledged {fmt.date(h.acknowledged_at)}</span>
                      )}
                    </div>
                  </div>
                  {h.status === "pending" && (
                    <button onClick={() => acknowledge(h.id)}
                      className="shrink-0 px-3 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-xs font-semibold transition-colors">
                      Acknowledge
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )
      )}

      {/* ── TEAM TAB ── */}
      {activeTab === "team" && (
        <div className="space-y-4">
          {/* Add member button */}
          <div className="flex items-center justify-between">
            <p className={`text-xs ${muted}`}>
              {team.length === 0
                ? "Add your team so the AI knows who to route calls to"
                : `${team.filter((m) => m.is_active).length} active · ${onCallCount} on call`}
            </p>
            <button onClick={() => setEditingMember({})}
              className="flex items-center gap-2 px-4 py-2 rounded-xl bg-violet-700 hover:bg-violet-600 text-white text-sm font-semibold transition-colors">
              <UserPlus size={14} /> Add Team Member
            </button>
          </div>

          {teamLoading ? (
            <div className="flex justify-center py-16"><Loader2 size={28} className="animate-spin text-gray-600" /></div>
          ) : team.length === 0 ? (
            <div className="text-center py-16 rounded-2xl border border-dashed border-gray-800">
              <Users size={36} className="mx-auto text-gray-700 mb-3" />
              <p className={`text-sm ${muted}`}>No team members yet</p>
              <p className="text-gray-700 text-xs mt-1 max-w-xs mx-auto">Add your employees so the AI can route escalations directly to the right person — not just the owner</p>
              <button onClick={() => setEditingMember({})}
                className="mt-4 px-4 py-2 rounded-xl bg-violet-700 hover:bg-violet-600 text-white text-sm font-semibold transition-colors">
                Add First Team Member
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {team.map((member) => (
                <div key={member.id} className={`rounded-2xl border p-4 transition-all ${
                  member.is_active
                    ? `${card} hover:border-violet-800/40`
                    : `${card} opacity-50`
                }`}>
                  {/* Card header */}
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex items-center gap-3">
                      {/* Avatar */}
                      <div className="w-10 h-10 rounded-full flex items-center justify-center text-white text-sm font-bold shrink-0"
                        style={{ background: member.avatar_color }}>
                        {member.avatar_initials || member.name.slice(0,2).toUpperCase()}
                      </div>
                      <div>
                        <div className="flex items-center gap-1.5">
                          <p className="text-sm font-bold">{member.display_name || member.name}</p>
                          {member.is_on_call && (
                            <span className="flex items-center gap-0.5 text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-violet-900/60 text-violet-300 border border-violet-800/50">
                              <BellRing size={9} /> ON CALL
                            </span>
                          )}
                        </div>
                        <p className={`text-xs ${muted}`}>{member.role}{member.department ? ` · ${member.department}` : ""}</p>
                      </div>
                    </div>
                    {/* Actions */}
                    <div className="flex items-center gap-1">
                      <button onClick={() => setEditingMember(member)}
                        className="p-1.5 rounded-lg hover:bg-gray-800 text-gray-600 hover:text-white transition-colors">
                        <Pencil size={12} />
                      </button>
                      <button onClick={() => deleteMember(member.id)}
                        className="p-1.5 rounded-lg hover:bg-red-950 text-gray-600 hover:text-red-400 transition-colors">
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </div>

                  {/* Contact info */}
                  <div className="space-y-1.5 mb-3">
                    {member.phone && (
                      <a href={`tel:${member.phone}`} className={`flex items-center gap-2 text-xs ${muted} hover:text-white transition-colors`}>
                        <Phone size={11} className="shrink-0" />
                        <span className="truncate">{member.phone}</span>
                      </a>
                    )}
                    {member.email && (
                      <a href={`mailto:${member.email}`} className={`flex items-center gap-2 text-xs ${muted} hover:text-white transition-colors`}>
                        <Mail size={11} className="shrink-0" />
                        <span className="truncate">{member.email}</span>
                      </a>
                    )}
                  </div>

                  {/* Topics */}
                  {member.handles_topics && member.handles_topics.length > 0 && (
                    <div className="flex flex-wrap gap-1 mb-3">
                      {member.handles_topics.slice(0, 4).map((t) => (
                        <span key={t} className="text-[10px] px-1.5 py-0.5 rounded-full bg-gray-800 text-gray-400 border border-gray-700">{t}</span>
                      ))}
                      {member.handles_topics.length > 4 && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-gray-800 text-gray-500">+{member.handles_topics.length - 4}</span>
                      )}
                    </div>
                  )}

                  {/* Notes */}
                  {member.notes && (
                    <p className={`text-xs ${muted} mb-3 line-clamp-2`}>{member.notes}</p>
                  )}

                  {/* Footer: on-call toggle + status */}
                  <div className="flex items-center justify-between pt-3 border-t border-gray-800">
                    <span className={`text-[10px] font-semibold uppercase tracking-wider ${
                      member.is_active ? "text-emerald-500" : "text-gray-600"
                    }`}>{member.is_active ? "Active" : "Inactive"}</span>
                    <button onClick={() => toggleOnCall(member)}
                      className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold transition-all ${
                        member.is_on_call
                          ? "bg-violet-700 text-white"
                          : `${dark ? "bg-gray-800 text-gray-500 hover:bg-gray-700 hover:text-white" : "bg-gray-100 text-gray-500 hover:bg-gray-200"}`
                      }`}>
                      <BellRing size={11} />
                      {member.is_on_call ? "On Call" : "Set On Call"}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Routing explanation */}
          {team.length > 0 && (
            <div className={`p-4 rounded-xl border ${dark ? "border-violet-900/30 bg-violet-950/10" : "border-violet-200 bg-violet-50"}`}>
              <div className="flex items-start gap-3">
                <PhoneForwarded size={16} className="text-violet-400 shrink-0 mt-0.5" />
                <div>
                  <p className={`text-xs font-semibold ${dark ? "text-violet-300" : "text-violet-700"} mb-1`}>How AI Routing Works</p>
                  <p className={`text-xs ${muted}`}>
                    When the AI decides to escalate a call, it checks who is <strong className="text-white">On Call</strong> first,
                    then matches the call topic against each person's <strong className="text-white">Handles Topics</strong>.
                    The highest-priority match gets the escalation — their name and number are spoken to the caller,
                    and a notification is logged here. If nobody matches, the escalation is logged as unassigned.
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Team Member Modal */}
      {editingMember !== false && (
        <TeamMemberModal
          member={editingMember || null}
          onSave={saveMember}
          onClose={() => setEditingMember(false)}
        />
      )}
    </div>
  );
}

// ── Agent Card ────────────────────────────────────────────────────────────────
const AgentCard: React.FC<{
  agent: AgentConfig;
  onEdit: (a: AgentConfig) => void;
  onActivate: (id: number) => void;
  onDelete?: (id: number) => void;
}> = ({ agent, onEdit, onActivate, onDelete }) => {
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
};

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

// ── Agent Create Modal ────────────────────────────────────────────────────────
function AgentCreateModal({ onClose, onSave }: {
  onClose: () => void;
  onSave: () => void;
}) {
  const { addToast } = useToast();
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    name: "",
    display_name: "",
    tagline: "",
    greeting: "Thank you for calling. How can I help you today?",
    system_prompt: "",
    voice: "TX3LPaxmHKxFdv7VOQHJ",
    language: "en",
    vertical: "general",
    tier: "specialist",
    max_turns: 20,
    color: "#00FF88",
  });

  const VERTICALS = [
    "general", "hvac", "plumbing", "electrical", "roofing", "landscaping",
    "legal", "medical", "dental", "real-estate", "insurance", "retail",
    "restaurant", "fitness", "auto", "cleaning", "pest-control", "other"
  ];

  const VOICES = [
    { id: "TX3LPaxmHKxFdv7VOQHJ", name: "Liam — Articulate American male" },
    { id: "pNInz6obpgDQGcFmaJgB", name: "Adam — Deep, authoritative" },
    { id: "EXAVITQu4vr4xnSDxMaL", name: "Sarah — Warm, professional female" },
    { id: "JBFqnCBsd6RMkjVDRZzb", name: "George — British professional" },
    { id: "IKne3meq5aSn9XLyUdCD", name: "Charlie — Natural Australian" },
  ];

  const save = async () => {
    if (!form.name.trim()) {
      addToast({ type: "error", message: "Agent name is required" });
      return;
    }
    if (!form.system_prompt.trim()) {
      addToast({ type: "error", message: "System prompt is required" });
      return;
    }
    setSaving(true);
    try {
      await api("/api/agents", {
        method: "POST",
        body: JSON.stringify({
          ...form,
          name: form.name.toUpperCase().replace(/\s+/g, "_"),
          display_name: form.display_name || form.name,
          tool_permissions: [],
          routing_keywords: [],
        }),
      });
      addToast({ type: "success", message: `Agent ${form.name} created and activated` });
      onSave();
      onClose();
    } catch (e: unknown) {
      addToast({ type: "error", message: e instanceof Error ? e.message : "Failed to create agent" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" style={{ maxWidth: 680 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <div className="section-eyebrow">New Agent</div>
            <h2 style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: 18, color: "var(--smirk-text)", textTransform: "uppercase" }}>
              Create AI Agent
            </h2>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "var(--smirk-text-3)", cursor: "pointer", padding: 4 }}>
            <X size={18} />
          </button>
        </div>
        <div className="modal-body" style={{ maxHeight: "60vh", overflowY: "auto" }}>
          <div className="form-row" style={{ marginBottom: 18 }}>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="smirk-label">Agent Name *</label>
              <input
                className="smirk-input"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="e.g. APEX, NOVA, SCOUT"
                style={{ textTransform: "uppercase" }}
              />
              <p style={{ fontSize: 11, color: "var(--smirk-text-3)", marginTop: 4 }}>Short, memorable codename. Will be uppercased.</p>
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="smirk-label">Display Name</label>
              <input
                className="smirk-input"
                value={form.display_name}
                onChange={(e) => setForm((f) => ({ ...f, display_name: e.target.value }))}
                placeholder="e.g. Front Desk Specialist"
              />
            </div>
          </div>

          <div className="form-group">
            <label className="smirk-label">Tagline</label>
            <input
              className="smirk-input"
              value={form.tagline}
              onChange={(e) => setForm((f) => ({ ...f, tagline: e.target.value }))}
              placeholder="e.g. Sharp intake. No fluff."
            />
          </div>

          <div className="form-row" style={{ marginBottom: 18 }}>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="smirk-label">Industry Vertical</label>
              <select
                className="smirk-select"
                value={form.vertical}
                onChange={(e) => setForm((f) => ({ ...f, vertical: e.target.value }))}
              >
                {VERTICALS.map((v) => (
                  <option key={v} value={v}>{v.charAt(0).toUpperCase() + v.slice(1).replace(/-/g, " ")}</option>
                ))}
              </select>
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="smirk-label">Voice</label>
              <select
                className="smirk-select"
                value={form.voice}
                onChange={(e) => setForm((f) => ({ ...f, voice: e.target.value }))}
              >
                {VOICES.map((v) => (
                  <option key={v.id} value={v.id}>{v.name}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="form-group">
            <label className="smirk-label">Greeting</label>
            <textarea
              className="smirk-textarea"
              rows={2}
              value={form.greeting}
              onChange={(e) => setForm((f) => ({ ...f, greeting: e.target.value }))}
              placeholder="What the agent says when the call connects"
            />
          </div>

          <div className="form-group">
            <label className="smirk-label">System Prompt *</label>
            <textarea
              className="smirk-textarea"
              rows={8}
              value={form.system_prompt}
              onChange={(e) => setForm((f) => ({ ...f, system_prompt: e.target.value }))}
              placeholder="Full instructions for this agent. Include: role, tone, what to collect, how to handle objections, when to book, when to escalate."
            />
            <p style={{ fontSize: 11, color: "var(--smirk-text-3)", marginTop: 4 }}>
              Be specific. The more context you give, the better the agent performs.
            </p>
          </div>

          <div className="form-row">
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="smirk-label">Max Turns</label>
              <input
                className="smirk-input"
                type="number"
                min={5}
                max={50}
                value={form.max_turns}
                onChange={(e) => setForm((f) => ({ ...f, max_turns: parseInt(e.target.value) || 20 }))}
              />
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="smirk-label">Accent Color</label>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input
                  type="color"
                  value={form.color}
                  onChange={(e) => setForm((f) => ({ ...f, color: e.target.value }))}
                  style={{ width: 44, height: 44, border: "1px solid var(--smirk-border)", background: "none", cursor: "pointer", padding: 2 }}
                />
                <input
                  className="smirk-input"
                  value={form.color}
                  onChange={(e) => setForm((f) => ({ ...f, color: e.target.value }))}
                  placeholder="#00FF88"
                  style={{ flex: 1 }}
                />
              </div>
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={save} disabled={saving}>
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
            Create Agent
          </button>
        </div>
      </div>
    </div>
  );
}

function AgentsPage() {
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<AgentConfig | null>(null);
  const [creating, setCreating] = useState(false);
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
      await api(`/api/agents/${id}/activate`, { method: "PUT" });
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
  const deleteAgent = async (id: number) => {
    if (!confirm("Delete this agent? This cannot be undone.")) return;
    try {
      await api(`/api/agents/${id}`, { method: "DELETE" });
      addToast({ type: "success", message: "Agent deleted" });
      load();
    } catch {
      addToast({ type: "error", message: "Failed to delete agent" });
    }
  };
  const tiers = ["brain", "specialist", "support"];
  const tierLabels: Record<string, string> = { brain: "Command Layer", specialist: "Vertical Specialists", support: "Support Roles" };
  return (
    <div style={{ padding: "24px 32px" }}>
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", marginBottom: 32 }}>
        <div>
          <div className="section-eyebrow">Agent Roster</div>
          <h2 className="section-title">AI Agents</h2>
          <p style={{ fontSize: 13, color: "var(--smirk-text-3)", marginTop: 6 }}>
            {agents.length} agent{agents.length !== 1 ? "s" : ""} configured
          </p>
        </div>
        <button className="btn-primary" onClick={() => setCreating(true)}>
          <Plus size={14} />
          New Agent
        </button>
      </div>
      {loading ? (
        <div style={{ display: "flex", justifyContent: "center", padding: "60px 0" }}>
          <Loader2 size={28} className="animate-spin" style={{ color: "var(--smirk-text-3)" }} />
        </div>
      ) : agents.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon"><Bot size={40} /></div>
          <div className="empty-state-title">No agents yet</div>
          <div className="empty-state-sub">Create your first AI agent to start handling calls</div>
          <button className="btn-primary" style={{ marginTop: 20 }} onClick={() => setCreating(true)}>
            <Plus size={14} />
            Create First Agent
          </button>
        </div>
      ) : (
        tiers.map((tier) => {
          const tierAgents = agents.filter((a) => (a.tier || "specialist") === tier);
          if (tierAgents.length === 0) return null;
          return (
            <div key={tier} style={{ marginBottom: 40 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
                <span style={{ fontFamily: "var(--font-display)", fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.15em", color: "var(--smirk-text-3)" }}>
                  {tierLabels[tier] || tier}
                </span>
                <div style={{ flex: 1, height: 1, background: "var(--smirk-border)" }} />
                <span style={{ fontSize: 11, color: "var(--smirk-text-3)" }}>{tierAgents.length}</span>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 16 }}>
                {tierAgents.map((a) => (
                  <AgentCard key={a.id} agent={a} onEdit={setEditing} onActivate={activate} onDelete={deleteAgent} />
                ))}
              </div>
            </div>
          );
        })
      )}
      {creating && (
        <AgentCreateModal
          onClose={() => setCreating(false)}
          onSave={load}
        />
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

// ── Voice & AI Settings Page ──────────────────────────────────────────────────
function VoicePage() {
  const { addToast } = useToast();

  // Voice engine settings
  const [voiceEngine, setVoiceEngine] = useState("elevenlabs");
  const [elevenLabsKey, setElevenLabsKey] = useState("");
  const [elevenLabsVoiceId, setElevenLabsVoiceId] = useState("TX3LPaxmHKxFdv7VOQHJ");
  const [elevenLabsModel, setElevenLabsModel] = useState("eleven_flash_v2_5");

  // Voice personality sliders
  const [stability, setStability] = useState(0.20);
  const [similarityBoost, setSimilarityBoost] = useState(0.88);
  const [style, setStyle] = useState(0.60);
  const [speed, setSpeed] = useState(0.95);
  const [speakerBoost, setSpeakerBoost] = useState(true);

  // AI behavior settings
  const [maxTurns, setMaxTurns] = useState(20);
  const [silenceTimeout, setSilenceTimeout] = useState(5);
  const [interruptible, setInterruptible] = useState(true);
  const [openRouterModel, setOpenRouterModel] = useState("openai/gpt-4o-mini");
  const [openRouterKey, setOpenRouterKey] = useState("");

  // Personality / tone
  const [agentTone, setAgentTone] = useState("professional");
  const [callbackPhrase, setCallbackPhrase] = useState("");
  const [holdMusic, setHoldMusic] = useState(false);
  const [transcribeAll, setTranscribeAll] = useState(true);

  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ok: boolean; message: string} | null>(null);

  useEffect(() => {
    api<{values: Record<string, string>}>("/api/settings")
      .then((d) => {
        const v = d.values || {};
        if (v.ELEVENLABS_API_KEY) setElevenLabsKey(v.ELEVENLABS_API_KEY);
        if (v.ELEVENLABS_VOICE_ID) setElevenLabsVoiceId(v.ELEVENLABS_VOICE_ID);
        if (v.ELEVENLABS_MODEL_ID) setElevenLabsModel(v.ELEVENLABS_MODEL_ID);
        if (v.OPENROUTER_API_KEY) setOpenRouterKey(v.OPENROUTER_API_KEY);
        if (v.OPENROUTER_MODEL) setOpenRouterModel(v.OPENROUTER_MODEL);
        if (v.VOICE_STABILITY) setStability(parseFloat(v.VOICE_STABILITY));
        if (v.VOICE_SIMILARITY_BOOST) setSimilarityBoost(parseFloat(v.VOICE_SIMILARITY_BOOST));
        if (v.VOICE_STYLE) setStyle(parseFloat(v.VOICE_STYLE));
        if (v.VOICE_SPEED) setSpeed(parseFloat(v.VOICE_SPEED));
        if (v.VOICE_SPEAKER_BOOST) setSpeakerBoost(v.VOICE_SPEAKER_BOOST === "true");
        if (v.AI_MAX_TURNS) setMaxTurns(parseInt(v.AI_MAX_TURNS) || 20);
        if (v.AI_SILENCE_TIMEOUT) setSilenceTimeout(parseInt(v.AI_SILENCE_TIMEOUT) || 5);
        if (v.AI_INTERRUPTIBLE) setInterruptible(v.AI_INTERRUPTIBLE !== "false");
        if (v.AGENT_TONE) setAgentTone(v.AGENT_TONE);
        if (v.CALLBACK_PHRASE) setCallbackPhrase(v.CALLBACK_PHRASE);
        if (v.HOLD_MUSIC) setHoldMusic(v.HOLD_MUSIC === "true");
        if (v.TRANSCRIBE_ALL) setTranscribeAll(v.TRANSCRIBE_ALL !== "false");
      })
      .catch(() => {});
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      const payload: Record<string, string> = {
        ELEVENLABS_VOICE_ID: elevenLabsVoiceId,
        ELEVENLABS_MODEL_ID: elevenLabsModel,
        VOICE_STABILITY: stability.toString(),
        VOICE_SIMILARITY_BOOST: similarityBoost.toString(),
        VOICE_STYLE: style.toString(),
        VOICE_SPEED: speed.toString(),
        VOICE_SPEAKER_BOOST: speakerBoost.toString(),
        AI_MAX_TURNS: maxTurns.toString(),
        AI_SILENCE_TIMEOUT: silenceTimeout.toString(),
        AI_INTERRUPTIBLE: interruptible.toString(),
        AGENT_TONE: agentTone,
        CALLBACK_PHRASE: callbackPhrase,
        HOLD_MUSIC: holdMusic.toString(),
        TRANSCRIBE_ALL: transcribeAll.toString(),
      };
      // Only include API keys if they were changed (not masked)
      if (elevenLabsKey && !elevenLabsKey.includes("•")) payload.ELEVENLABS_API_KEY = elevenLabsKey;
      if (openRouterKey && !openRouterKey.includes("•")) payload.OPENROUTER_API_KEY = openRouterKey;
      if (openRouterModel) payload.OPENROUTER_MODEL = openRouterModel;
      await api("/api/settings", { method: "POST", body: JSON.stringify(payload) });
      addToast({ type: "success", message: "Voice & AI settings saved" });
    } catch (e: unknown) {
      addToast({ type: "error", message: e instanceof Error ? e.message : "Save failed" });
    } finally {
      setSaving(false);
    }
  };

  const testVoice = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await api<{ok: boolean; message?: string; error?: string}>("/api/settings/test/elevenlabs", { method: "POST" });
      setTestResult({ ok: result.ok, message: result.message || result.error || "Test complete" });
      addToast({ type: result.ok ? "success" : "error", message: result.message || result.error || "Test complete" });
    } catch (e: unknown) {
      setTestResult({ ok: false, message: e instanceof Error ? e.message : "Test failed" });
    } finally {
      setTesting(false);
    }
  };

  const Slider = ({ label, value, onChange, min, max, step, hint }: {
    label: string; value: number; onChange: (v: number) => void;
    min: number; max: number; step: number; hint?: string;
  }) => (
    <div>
      <div className="flex items-center justify-between mb-2">
        <label className="text-xs font-semibold uppercase tracking-widest text-gray-500">{label}</label>
        <span className="text-sm font-mono font-bold text-violet-400">{value.toFixed(2)}</span>
      </div>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full h-1.5 rounded-full appearance-none bg-gray-700 accent-violet-500 cursor-pointer"
      />
      {hint && <p className="text-[11px] text-gray-600 mt-1">{hint}</p>}
    </div>
  );

  const Toggle = ({ label, value, onChange, hint }: { label: string; value: boolean; onChange: (v: boolean) => void; hint?: string }) => (
    <div className="flex items-center justify-between">
      <div>
        <p className="text-sm font-medium text-white">{label}</p>
        {hint && <p className="text-xs text-gray-600 mt-0.5">{hint}</p>}
      </div>
      <button
        onClick={() => onChange(!value)}
        className={`relative w-11 h-6 rounded-full transition-colors shrink-0 ${value ? "bg-violet-600" : "bg-gray-700"}`}
      >
        <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${value ? "translate-x-5" : ""}`} />
      </button>
    </div>
  );

  const ELEVENLABS_VOICES = [
    { id: "TX3LPaxmHKxFdv7VOQHJ", name: "Liam — Articulate, energetic American male (SMIRK default)" },
    { id: "pNInz6obpgDQGcFmaJgB", name: "Adam — Deep, authoritative American male" },
    { id: "CwhRBWXzGAHq8TQ4Fs17", name: "Roger — Resonant, laid-back, confident" },
    { id: "EXAVITQu4vr4xnSDxMaL", name: "Sarah — Warm, mature female" },
    { id: "JBFqnCBsd6RMkjVDRZzb", name: "George — Warm, British professional" },
    { id: "ErXwobaYiN019PkySvjV", name: "Antoni — Smooth, versatile" },
    { id: "IKne3meq5aSn9XLyUdCD", name: "Charlie — Natural, conversational Australian" },
    { id: "custom", name: "Custom Voice ID..." },
  ];

  const OPENROUTER_MODELS = [
    { id: "openai/gpt-4o-mini", name: "GPT-4o Mini — Fast, cheap, smart (recommended)" },
    { id: "openai/gpt-4o", name: "GPT-4o — Most capable OpenAI model" },
    { id: "anthropic/claude-3-5-haiku", name: "Claude 3.5 Haiku — Fast, conversational" },
    { id: "anthropic/claude-3-5-sonnet", name: "Claude 3.5 Sonnet — Best reasoning" },
    { id: "google/gemini-flash-1.5", name: "Gemini Flash 1.5 — Ultra-fast, low cost" },
    { id: "meta-llama/llama-3.1-8b-instruct", name: "Llama 3.1 8B — Open source, very fast" },
    { id: "custom", name: "Custom model ID..." },
  ];

  const TONE_OPTIONS = [
    { id: "professional", label: "Professional", desc: "Polished, business-like, no slang" },
    { id: "friendly", label: "Friendly", desc: "Warm, approachable, conversational" },
    { id: "direct", label: "Direct", desc: "No fluff, gets to the point fast" },
    { id: "empathetic", label: "Empathetic", desc: "Caring, patient, emotionally aware" },
    { id: "energetic", label: "Energetic", desc: "High energy, enthusiastic, upbeat" },
  ];

  const section = (title: string, children: React.ReactNode) => (
    <div className="rounded-2xl bg-gray-900 border border-gray-800 overflow-hidden">
      <div className="px-5 py-4 border-b border-gray-800">
        <h3 className="text-sm font-bold text-white">{title}</h3>
      </div>
      <div className="p-5 space-y-5">{children}</div>
    </div>
  );

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-white">Voice & AI Settings</h2>
          <p className="text-sm text-gray-500 mt-0.5">Control every detail of how your AI sounds and behaves on calls</p>
        </div>
        <button
          onClick={save}
          disabled={saving}
          className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-violet-700 hover:bg-violet-600 disabled:opacity-40 text-white text-sm font-semibold transition-colors"
        >
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
          Save All
        </button>
      </div>

      {/* ElevenLabs API */}
      {section("ElevenLabs — Voice Engine", (
        <>
          <div className="flex items-center gap-3 p-3 rounded-xl bg-amber-950/30 border border-amber-800/40">
            <AlertTriangle size={14} className="text-amber-400 shrink-0" />
            <p className="text-xs text-amber-300">Your current ElevenLabs API key is invalid. Calls are falling back to Twilio Alice (robot voice). Paste a valid key below to fix this.</p>
          </div>
          <div>
            <label className="block text-xs font-semibold uppercase tracking-widest text-gray-500 mb-2">API Key <span className="text-red-500">*</span></label>
            <div className="flex gap-2">
              <input
                type="password"
                value={elevenLabsKey}
                onChange={(e) => setElevenLabsKey(e.target.value)}
                placeholder="sk_..."
                className="flex-1 bg-gray-950 border border-gray-700 rounded-xl px-4 py-3 text-sm text-white placeholder-gray-700 focus:outline-none focus:border-violet-600 transition-colors font-mono"
              />
              <button
                onClick={testVoice}
                disabled={testing}
                className="flex items-center gap-1.5 px-4 py-2 rounded-xl border border-gray-700 text-gray-400 text-xs font-medium hover:border-gray-600 hover:text-white transition-colors disabled:opacity-40"
              >
                {testing ? <Loader2 size={12} className="animate-spin" /> : <TestTube size={12} />}
                Test
              </button>
            </div>
            {testResult && (
              <p className={`text-xs mt-2 ${testResult.ok ? "text-emerald-400" : "text-red-400"}`}>
                {testResult.ok ? "✓" : "✗"} {testResult.message}
              </p>
            )}
          </div>
          <div>
            <label className="block text-xs font-semibold uppercase tracking-widest text-gray-500 mb-2">Voice</label>
            <select
              value={ELEVENLABS_VOICES.find(v => v.id === elevenLabsVoiceId) ? elevenLabsVoiceId : "custom"}
              onChange={(e) => { if (e.target.value !== "custom") setElevenLabsVoiceId(e.target.value); }}
              className="w-full bg-gray-950 border border-gray-700 rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-violet-600 transition-colors"
            >
              {ELEVENLABS_VOICES.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
            {(!ELEVENLABS_VOICES.find(v => v.id === elevenLabsVoiceId) || elevenLabsVoiceId === "custom") && (
              <input
                type="text"
                value={elevenLabsVoiceId}
                onChange={(e) => setElevenLabsVoiceId(e.target.value)}
                placeholder="Paste custom ElevenLabs voice ID"
                className="w-full mt-2 bg-gray-950 border border-gray-700 rounded-xl px-4 py-3 text-sm text-white placeholder-gray-700 focus:outline-none focus:border-violet-600 font-mono"
              />
            )}
          </div>
          <div>
            <label className="block text-xs font-semibold uppercase tracking-widest text-gray-500 mb-2">Model</label>
            <select
              value={elevenLabsModel}
              onChange={(e) => setElevenLabsModel(e.target.value)}
              className="w-full bg-gray-950 border border-gray-700 rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-violet-600 transition-colors"
            >
              <option value="eleven_flash_v2_5">Flash v2.5 — 75ms latency, ultra-low latency (recommended for calls)</option>
              <option value="eleven_turbo_v2_5">Turbo v2.5 — 250ms, higher quality</option>
              <option value="eleven_multilingual_v2">Multilingual v2 — Multi-language support</option>
              <option value="eleven_monolingual_v1">Monolingual v1 — English only, legacy</option>
            </select>
          </div>
        </>
      ))}

      {/* Voice Delivery Sliders */}
      {section("Voice Delivery — Fine-Tune the Sound", (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <Slider
              label="Stability"
              value={stability}
              onChange={setStability}
              min={0} max={1} step={0.01}
              hint="Low = more expressive & varied. High = consistent & robotic. Recommended: 0.15–0.30 for calls."
            />
            <Slider
              label="Similarity Boost"
              value={similarityBoost}
              onChange={setSimilarityBoost}
              min={0} max={1} step={0.01}
              hint="How closely the output matches the original voice. Keep high (0.80+) for consistency."
            />
            <Slider
              label="Style Exaggeration"
              value={style}
              onChange={setStyle}
              min={0} max={1} step={0.01}
              hint="0 = neutral delivery. 1 = maximum expressiveness. 0.50–0.70 is the sweet spot for calls."
            />
            <Slider
              label="Speed"
              value={speed}
              onChange={setSpeed}
              min={0.7} max={1.3} step={0.01}
              hint="1.0 = natural pace. 0.90–0.95 is slightly slower for phone clarity. Don't go below 0.80."
            />
          </div>
          <Toggle
            label="Speaker Boost"
            value={speakerBoost}
            onChange={setSpeakerBoost}
            hint="Enhances voice clarity and presence on phone audio. Recommended: ON."
          />
          <div className="p-3 rounded-xl bg-gray-800/50 border border-gray-700">
            <p className="text-xs text-gray-500 font-semibold uppercase tracking-wider mb-2">Current Profile</p>
            <p className="text-xs text-gray-400">
              Stability {stability.toFixed(2)} · Similarity {similarityBoost.toFixed(2)} · Style {style.toFixed(2)} · Speed {speed.toFixed(2)}x{speakerBoost ? " · Boost ON" : ""}
            </p>
          </div>
        </>
      ))}

      {/* AI Brain */}
      {section("AI Brain — OpenRouter", (
        <>
          <div>
            <label className="block text-xs font-semibold uppercase tracking-widest text-gray-500 mb-2">API Key</label>
            <input
              type="password"
              value={openRouterKey}
              onChange={(e) => setOpenRouterKey(e.target.value)}
              placeholder="sk-or-v1-..."
              className="w-full bg-gray-950 border border-gray-700 rounded-xl px-4 py-3 text-sm text-white placeholder-gray-700 focus:outline-none focus:border-violet-600 font-mono"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold uppercase tracking-widest text-gray-500 mb-2">Model</label>
            <select
              value={OPENROUTER_MODELS.find(m => m.id === openRouterModel) ? openRouterModel : "custom"}
              onChange={(e) => { if (e.target.value !== "custom") setOpenRouterModel(e.target.value); }}
              className="w-full bg-gray-950 border border-gray-700 rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-violet-600 transition-colors"
            >
              {OPENROUTER_MODELS.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
            {(!OPENROUTER_MODELS.find(m => m.id === openRouterModel) || openRouterModel === "custom") && (
              <input
                type="text"
                value={openRouterModel}
                onChange={(e) => setOpenRouterModel(e.target.value)}
                placeholder="e.g. openai/gpt-4o"
                className="w-full mt-2 bg-gray-950 border border-gray-700 rounded-xl px-4 py-3 text-sm text-white placeholder-gray-700 focus:outline-none focus:border-violet-600 font-mono"
              />
            )}
          </div>
        </>
      ))}

      {/* Personality & Tone */}
      {section("Personality & Tone", (
        <>
          <div>
            <label className="block text-xs font-semibold uppercase tracking-widest text-gray-500 mb-3">Default Tone</label>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
              {TONE_OPTIONS.map(t => (
                <button
                  key={t.id}
                  onClick={() => setAgentTone(t.id)}
                  className={`p-3 rounded-xl border text-left transition-all ${
                    agentTone === t.id
                      ? "border-violet-600 bg-violet-950/40 text-white"
                      : "border-gray-700 bg-gray-800/50 text-gray-400 hover:border-gray-600 hover:text-white"
                  }`}
                >
                  <p className="text-xs font-bold">{t.label}</p>
                  <p className="text-[10px] text-gray-500 mt-0.5 leading-tight">{t.desc}</p>
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="block text-xs font-semibold uppercase tracking-widest text-gray-500 mb-2">Custom Callback Phrase</label>
            <input
              type="text"
              value={callbackPhrase}
              onChange={(e) => setCallbackPhrase(e.target.value)}
              placeholder='e.g. "Let me have someone from our team reach out to you directly."'
              className="w-full bg-gray-950 border border-gray-700 rounded-xl px-4 py-3 text-sm text-white placeholder-gray-700 focus:outline-none focus:border-violet-600"
            />
            <p className="text-[11px] text-gray-600 mt-1">What the AI says when it needs to escalate or hand off the call.</p>
          </div>
        </>
      ))}

      {/* Call Behavior */}
      {section("Call Behavior", (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <div>
              <label className="block text-xs font-semibold uppercase tracking-widest text-gray-500 mb-2">Max Turns Per Call</label>
              <input
                type="number"
                value={maxTurns}
                onChange={(e) => setMaxTurns(parseInt(e.target.value) || 20)}
                min={3} max={50}
                className="w-full bg-gray-950 border border-gray-700 rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-violet-600"
              />
              <p className="text-[11px] text-gray-600 mt-1">Max back-and-forth exchanges before the AI wraps up. Default: 20.</p>
            </div>
            <div>
              <label className="block text-xs font-semibold uppercase tracking-widest text-gray-500 mb-2">Silence Timeout (seconds)</label>
              <input
                type="number"
                value={silenceTimeout}
                onChange={(e) => setSilenceTimeout(parseInt(e.target.value) || 5)}
                min={2} max={15}
                className="w-full bg-gray-950 border border-gray-700 rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-violet-600"
              />
              <p className="text-[11px] text-gray-600 mt-1">How long to wait for caller response before prompting again.</p>
            </div>
          </div>
          <Toggle
            label="Interruptible"
            value={interruptible}
            onChange={setInterruptible}
            hint="Allow callers to interrupt the AI mid-sentence. Recommended: ON for natural conversation."
          />
          <Toggle
            label="Transcribe All Calls"
            value={transcribeAll}
            onChange={setTranscribeAll}
            hint="Save full transcripts for every call. Required for AI data extraction and contact enrichment."
          />
          <Toggle
            label="Hold Music"
            value={holdMusic}
            onChange={setHoldMusic}
            hint="Play hold music while the AI is processing a response (adds ~200ms latency)."
          />
        </>
      ))}
    </div>
  );
}

// ── Settings Page ─────────────────────────────────────────────────────────────
// ── Agent Identity Page ────────────────────────────────────────────────────────
function AgentIdentityPage() {
  const { addToast } = useToast();
  const [form, setForm] = useState({
    AGENT_NAME: "",
    AGENT_PERSONA: "",
    BUSINESS_NAME: "",
    BUSINESS_TAGLINE: "",
    BUSINESS_PHONE: "",
    BUSINESS_WEBSITE: "",
    BUSINESS_ADDRESS: "",
    BUSINESS_HOURS: "",
    BUSINESS_TIMEZONE: "",
    BOOKING_LINK: "",
    REVIEW_LINK: "",
    INBOUND_GREETING: "",
    OUTBOUND_GREETING: "",
  });
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [preview, setPreview] = useState("");
  const [activeAgent, setActiveAgent] = useState<{ id: number; name: string; voice?: string; language?: string } | null>(null);
  const [configStatus, setConfigStatus] = useState<{ isConfigured: boolean; missingRequired: string[]; warnings: string[] } | null>(null);
  const [settingsValues, setSettingsValues] = useState<Record<string, string>>({});

  useEffect(() => {
    Promise.all([
      api<Record<string, string>>("/api/agent/identity"),
      api<any>("/api/agents/active").catch(() => null),
      api<any>("/api/config-status").catch(() => null),
      api<any>("/api/settings").catch(() => null),
    ])
      .then(([identity, active, status, settings]) => {
        setForm((f) => ({ ...f, ...identity }));
        buildPreview(identity);
        setActiveAgent(active || null);
        setConfigStatus(status || null);
        setSettingsValues(settings?.values || {});
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const buildPreview = (data: Record<string, string>) => {
    const agentName = data.AGENT_NAME || "SMIRK";
    const bizName = data.BUSINESS_NAME || "";
    const bizTagline = data.BUSINESS_TAGLINE || "";
    const bizHours = data.BUSINESS_HOURS || "";
    const persona = data.AGENT_PERSONA || "";
    const lines: string[] = [];
    if (bizName) lines.push(`You work for ${bizName}.`);
    if (bizTagline) lines.push(`Company specialty: ${bizTagline}`);
    if (bizHours) lines.push(`Business hours: ${bizHours}`);
    if (agentName) lines.push(`Your name is ${agentName}.`);
    if (persona) lines.push(`Your communication style: ${persona}`);
    const inboundTpl = data.INBOUND_GREETING || (bizName
      ? `Thanks for calling ${bizName}! This is ${agentName}, your AI assistant. How can I help you today?`
      : `Hello! This is ${agentName}, your AI assistant. How can I help you today?`);
    const outboundTpl = data.OUTBOUND_GREETING || `Hi, this is ${bizName || agentName}. I’m following up on your request. Is now a good time?`;

    setPreview(lines.length > 0
      ? `=== WHO YOU ARE & WHO YOU WORK FOR ===\n${lines.join("\n")}\n\nInbound opening: "${inboundTpl}"\nOutbound opening: "${outboundTpl}"`
      : `Inbound opening: "${inboundTpl}"\nOutbound opening: "${outboundTpl}"`);
  };

  const handleChange = (key: string, value: string) => {
    const updated = { ...form, [key]: value };
    setForm(updated as typeof form);
    buildPreview(updated);
  };

  const save = async () => {
    setSaving(true);
    try {
      await api("/api/agent/identity", { method: "POST", body: JSON.stringify(form) });
      addToast({ type: "success", message: "Identity saved — takes effect on the next call" });
    } catch (e: unknown) {
      addToast({ type: "error", message: e instanceof Error ? e.message : "Save failed" });
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="p-6 flex items-center justify-center"><Loader2 size={24} className="animate-spin text-violet-500" /></div>;

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      <div>
        <h2 className="text-xl font-bold text-white">Agent Identity</h2>
        <p className="text-sm text-gray-500 mt-1">Set who your AI agent is and who it works for. These fields are injected into every call automatically — no prompt editing needed.</p>
      </div>

      <div className="rounded-2xl bg-gray-900 border border-gray-800 p-5">
        <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
          <h3 className="text-sm font-bold text-white">Live Capability Snapshot</h3>
          <span className="text-xs text-gray-500">Backend-sourced status</span>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3 text-xs">
          <div className="rounded-xl border border-gray-800 bg-gray-950/60 px-3 py-2">
            <div className="text-gray-500">Active Agent</div>
            <div className="text-white font-semibold mt-1">{activeAgent?.name || 'Not set'}</div>
          </div>
          <div className="rounded-xl border border-gray-800 bg-gray-950/60 px-3 py-2">
            <div className="text-gray-500">Voice Profile</div>
            <div className="text-white font-semibold mt-1">{activeAgent?.voice || 'Default / unset'}</div>
          </div>
          <div className="rounded-xl border border-gray-800 bg-gray-950/60 px-3 py-2">
            <div className="text-gray-500">Lead Source</div>
            <div className="text-white font-semibold mt-1">{settingsValues.GOOGLE_PLACES_API_KEY ? 'Configured' : 'Missing key'}</div>
          </div>
          <div className="rounded-xl border border-gray-800 bg-gray-950/60 px-3 py-2">
            <div className="text-gray-500">Call Core</div>
            <div className="text-white font-semibold mt-1">{configStatus?.isConfigured ? 'Ready' : 'Needs setup'}</div>
          </div>
        </div>
        {configStatus && configStatus.missingRequired.length > 0 && (
          <div className="mt-3 text-xs text-amber-400">Missing required: {configStatus.missingRequired.join(' · ')}</div>
        )}
        {configStatus && configStatus.warnings.length > 0 && (
          <div className="mt-1 text-xs text-gray-500">Warnings: {configStatus.warnings.slice(0, 2).join(' · ')}</div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Agent Profile */}
        <div className="rounded-2xl bg-gray-900 border border-gray-800 overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-800 flex items-center gap-2">
            <Bot size={16} className="text-violet-400" />
            <h3 className="text-sm font-bold text-white">Agent Profile</h3>
          </div>
          <div className="p-5 space-y-4">
            <div>
              <label className="block text-xs font-semibold uppercase tracking-widest text-gray-500 mb-2">Agent Name</label>
              <input
                type="text"
                value={form.AGENT_NAME}
                onChange={(e) => handleChange("AGENT_NAME", e.target.value)}
                placeholder="Aria"
                className="w-full bg-gray-950 border border-gray-700 rounded-xl px-4 py-3 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-violet-600 transition-colors"
              />
              <p className="text-xs text-gray-600 mt-1.5">The name your AI uses on calls. Default: SMIRK.</p>
            </div>
            <div>
              <label className="block text-xs font-semibold uppercase tracking-widest text-gray-500 mb-2">Agent Persona</label>
              <textarea
                value={form.AGENT_PERSONA}
                onChange={(e) => handleChange("AGENT_PERSONA", e.target.value)}
                placeholder="Friendly, professional, and concise. Always empathetic with frustrated callers. Never pushy."
                rows={4}
                className="w-full bg-gray-950 border border-gray-700 rounded-xl px-4 py-3 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-violet-600 transition-colors resize-none"
              />
              <p className="text-xs text-gray-600 mt-1.5">Personality and communication style. Shapes every response.</p>
            </div>
          </div>
        </div>

        {/* Company Profile */}
        <div className="rounded-2xl bg-gray-900 border border-gray-800 overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-800 flex items-center gap-2">
            <Building2 size={16} className="text-violet-400" />
            <h3 className="text-sm font-bold text-white">Company Profile</h3>
          </div>
          <div className="p-5 space-y-4">
            {[
              { key: "BUSINESS_NAME", label: "Business Name", placeholder: "Smith HVAC", help: "The agent says this when answering calls." },
              { key: "BUSINESS_TAGLINE", label: "Tagline / Specialty", placeholder: "Fast, honest HVAC service since 2008", help: "One-liner about what you do." },
              { key: "BUSINESS_PHONE", label: "Business Phone", placeholder: "+15551234567", help: "Your main number (may differ from Twilio)." },
              { key: "BUSINESS_WEBSITE", label: "Website", placeholder: "https://smithhvac.com", help: "Shared when callers ask." },
              { key: "BUSINESS_ADDRESS", label: "Address / Service Area", placeholder: "123 Main St, Austin TX 78701", help: "Physical address or service coverage area." },
              { key: "BUSINESS_HOURS", label: "Business Hours", placeholder: "Mon-Fri 8am-6pm, Sat 9am-2pm", help: "Quoted when callers ask about availability." },
            ].map(({ key, label, placeholder, help }) => (
              <div key={key}>
                <label className="block text-xs font-semibold uppercase tracking-widest text-gray-500 mb-2">{label}</label>
                <input
                  type="text"
                  value={(form as Record<string, string>)[key]}
                  onChange={(e) => handleChange(key, e.target.value)}
                  placeholder={placeholder}
                  className="w-full bg-gray-950 border border-gray-700 rounded-xl px-4 py-3 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-violet-600 transition-colors"
                />
                <p className="text-xs text-gray-600 mt-1.5">{help}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Links */}
      <div className="rounded-2xl bg-gray-900 border border-gray-800 overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-800 flex items-center gap-2">
          <Link size={16} className="text-violet-400" />
          <h3 className="text-sm font-bold text-white">Links & Timezone</h3>
        </div>
        <div className="p-5 grid grid-cols-1 md:grid-cols-3 gap-4">
          {[
            { key: "BOOKING_LINK", label: "Booking Link", placeholder: "https://calendly.com/your-business", help: "Used in missed call texts and when callers ask to book." },
            { key: "REVIEW_LINK", label: "Google Review Link", placeholder: "https://g.page/r/YOUR_PLACE_ID/review", help: "Used in review request SMS." },
            { key: "BUSINESS_TIMEZONE", label: "Timezone", placeholder: "America/Los_Angeles", help: "IANA timezone for date/time injection into prompts." },
          ].map(({ key, label, placeholder, help }) => (
            <div key={key}>
              <label className="block text-xs font-semibold uppercase tracking-widest text-gray-500 mb-2">{label}</label>
              <input
                type="text"
                value={(form as Record<string, string>)[key]}
                onChange={(e) => handleChange(key, e.target.value)}
                placeholder={placeholder}
                className="w-full bg-gray-950 border border-gray-700 rounded-xl px-4 py-3 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-violet-600 transition-colors"
              />
              <p className="text-xs text-gray-600 mt-1.5">{help}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Call Openings */}
      <div className="rounded-2xl bg-gray-900 border border-gray-800 overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-800 flex items-center gap-2">
          <PhoneCall size={16} className="text-violet-400" />
          <h3 className="text-sm font-bold text-white">Call Openings</h3>
          <span className="text-xs text-gray-600 ml-1">inbound vs outbound</span>
        </div>
        <div className="p-5 grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-semibold uppercase tracking-widest text-gray-500 mb-2">Inbound Greeting</label>
            <textarea
              value={(form as any).INBOUND_GREETING}
              onChange={(e) => handleChange("INBOUND_GREETING", e.target.value)}
              placeholder="Thanks for calling {business_name}! This is {agent_name}. How can I help you today?"
              rows={4}
              className="w-full bg-gray-950 border border-gray-700 rounded-xl px-4 py-3 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-violet-600 transition-colors resize-none"
            />
            <p className="text-xs text-gray-600 mt-1.5">Placeholders: {"{business_name}"}, {"{agent_name}"}. Leave blank to use the default.</p>
          </div>
          <div>
            <label className="block text-xs font-semibold uppercase tracking-widest text-gray-500 mb-2">Outbound Opening</label>
            <textarea
              value={(form as any).OUTBOUND_GREETING}
              onChange={(e) => handleChange("OUTBOUND_GREETING", e.target.value)}
              placeholder="Hi, this is {business_name}. I’m following up on your request. Is now a good time?"
              rows={4}
              className="w-full bg-gray-950 border border-gray-700 rounded-xl px-4 py-3 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-violet-600 transition-colors resize-none"
            />
            <p className="text-xs text-gray-600 mt-1.5">Keeps outbound from sounding like an inbound call.</p>
          </div>
        </div>
      </div>

      {/* Live Preview */}
      {preview && (
        <div className="rounded-2xl bg-gray-900 border border-gray-800 overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-800 flex items-center gap-2">
            <Eye size={16} className="text-violet-400" />
            <h3 className="text-sm font-bold text-white">Live Preview</h3>
            <span className="text-xs text-gray-600 ml-1">what gets injected into the system prompt</span>
          </div>
          <div className="p-5">
            <pre className="text-xs text-gray-400 whitespace-pre-wrap font-mono leading-relaxed">{preview}</pre>
          </div>
        </div>
      )}

      {/* Save */}
      <div className="flex justify-end">
        <button
          onClick={save}
          disabled={saving}
          className="flex items-center gap-2 px-6 py-3 rounded-xl bg-violet-700 hover:bg-violet-600 disabled:opacity-40 text-white text-sm font-semibold transition-colors"
        >
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
          Save Identity
        </button>
      </div>
    </div>
  );
}

function WorkspaceModeCard() {
  const { addToast } = useToast();
  const [workspaces, setWorkspaces] = useState<any[]>([]);
  const [current, setCurrent] = useState<any>(null);
  const [saving, setSaving] = useState(false);

  const refresh = async () => {
    const d = await api<any>("/api/workspaces");
    const list = d.workspaces || [];
    setWorkspaces(list);
    if (!current && list.length > 0) setCurrent(list[0]);
    if (current) {
      const match = list.find((w: any) => w.id === current.id);
      if (match) setCurrent(match);
    }
  };

  useEffect(() => {
    refresh().catch(() => {});
  }, []);

  const mode = (current?.mode || 'general') as string;

  const setMode = async (m: 'general' | 'missed_call_recovery') => {
    if (!current?.id) return;
    setSaving(true);
    try {
      await api(`/api/workspaces/${current.id}`, { method: 'PATCH', body: JSON.stringify({ mode: m }) });
      addToast({ type: 'success', message: `Workspace mode set to ${m.replace(/_/g,' ')}` });
      await refresh();
    } catch (e: any) {
      addToast({ type: 'error', message: e?.message || 'Failed to update workspace mode' });
    } finally {
      setSaving(false);
    }
  };

  const card = "rounded-3xl border border-white/10 bg-gradient-to-br from-white/10 to-white/5 backdrop-blur-xl shadow-[0_20px_80px_-30px_rgba(0,0,0,0.8)] p-5";

  return (
    <div className={card}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[10px] uppercase tracking-widest text-gray-300/70 font-semibold">Workspace mode</p>
          <p className="text-xs text-gray-300/80 mt-1">Locks the product shape. Missed-Call Recovery is the wedge (fast SMS, recovery desk).</p>
        </div>
        <button
          onClick={() => refresh().catch(() => {})}
          className="px-3 py-2 rounded-2xl bg-white/10 hover:bg-white/15 border border-white/15 text-xs font-semibold text-white transition-colors"
        >
          Refresh
        </button>
      </div>

      <div className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
        <div className="md:col-span-1">
          <label className="block text-xs font-semibold uppercase tracking-widest text-gray-500 mb-2">Workspace</label>
          <select
            value={current?.id || ''}
            onChange={(e) => setCurrent(workspaces.find((w: any) => String(w.id) === e.target.value) || null)}
            className="w-full bg-gray-950 border border-gray-700 rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-violet-600"
          >
            {workspaces.map((w: any) => (
              <option key={w.id} value={w.id}>{w.name} ({(w.plan || 'free')})</option>
            ))}
          </select>
        </div>

        <div className="md:col-span-2">
          <label className="block text-xs font-semibold uppercase tracking-widest text-gray-500 mb-2">Mode</label>
          <div className="flex flex-wrap gap-2">
            <button
              disabled={saving}
              onClick={() => setMode('general')}
              className={`px-4 py-2 rounded-2xl text-xs font-semibold border transition-colors ${mode === 'general' ? 'bg-violet-700/25 border-violet-700/40 text-violet-200' : 'bg-black/20 border-white/10 text-gray-300 hover:text-white hover:border-white/20'}`}
            >
              General
            </button>
            <button
              disabled={saving}
              onClick={() => setMode('missed_call_recovery')}
              className={`px-4 py-2 rounded-2xl text-xs font-semibold border transition-colors ${mode === 'missed_call_recovery' ? 'bg-emerald-700/20 border-emerald-700/40 text-emerald-200' : 'bg-black/20 border-white/10 text-gray-300 hover:text-white hover:border-white/20'}`}
            >
              Missed-Call Recovery
            </button>
          </div>
          <p className="text-xs text-gray-700 mt-2">
            In Missed-Call Recovery: missed inbound calls trigger SMS quickly (idempotent, DNC-safe), and Recovery Desk becomes the primary workflow.
          </p>
        </div>
      </div>
    </div>
  );
}

function SettingsPage() {
  const [groups, setGroups] = useState<SettingsGroup[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [show, setShow] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [activeGroup, setActiveGroup] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  // Per-group connection health: "ok" | "error" | "untested" | "optional"
  const [health, setHealth] = useState<Record<string, "ok" | "error" | "untested" | "optional">>({});
  const { addToast } = useToast();

  const testableGroups = new Set(["core", "openrouter", "openclaw", "google_calendar"]);
  const advancedGroups = new Set(["openclaw", "openai_tts", "elevenlabs", "google_calendar"]);
  const behaviorKeys = new Set(["INBOUND_GREETING","OUTBOUND_GREETING","VOICEMAIL_MESSAGE","SMS_FOLLOWUP_TEMPLATE","INTAKE_FIRST_QUESTION","OBJECTION_STYLE","AGENT_PERSONA","AGENT_NAME","BUSINESS_NAME"]);
  const isBehaviorKey = (k: string) => behaviorKeys.has(k);

  useEffect(() => {
    api<{ groups: SettingsGroup[]; values: Record<string, string>; status: unknown }>("/api/settings")
      .then((d) => {
        setGroups(d.groups || []);
        setValues(d.values || {});
        // Derive initial health from which keys are filled
        const initialHealth: Record<string, "ok" | "error" | "untested" | "optional"> = {};
        for (const g of (d.groups || [])) {
          const requiredFields = g.fields.filter((f: any) => f.required);
          const vals = d.values || {};
          if (requiredFields.length === 0) {
            const anyFilled = g.fields.some((f: any) => vals[f.key] && vals[f.key].length > 4);
            initialHealth[g.id] = anyFilled ? "untested" : "optional";
          } else {
            const allFilled = requiredFields.every((f: any) => vals[f.key] && vals[f.key].length > 0);
            initialHealth[g.id] = allFilled ? "untested" : (g.required ? "error" : "optional");
          }
        }
        setHealth(initialHealth);
        if ((d.groups || []).length > 0) {
          setActiveGroup((d.groups || [])[0].id);
          const initialCollapsed: Record<string, boolean> = {};
          for (const g of (d.groups || [])) initialCollapsed[g.id] = false;
          setCollapsed(initialCollapsed);
        }
      })
      .catch(() => {});
  }, []);


  const validateSetting = (key: string, value: string): string | null => {
    // Light guardrails for templates.
    const trimmed = (value ?? "").trim();
    if (["INBOUND_GREETING", "OUTBOUND_GREETING", "VOICEMAIL_MESSAGE", "SMS_FOLLOWUP_TEMPLATE"].includes(key)) {
      if (trimmed.length === 0) return null; // allow blank to fall back to defaults
      if (trimmed.length > 600) return "Too long (max 600 characters).";
      // prevent obvious multi-line spam
      const lines = trimmed.split("\n");
      if (lines.length > 6) return "Too many lines (max 6).";
    }
    return null;
  };

  const saveGroup = async (groupId: string) => {
    const group = groups.find((g) => g.id === groupId);
    if (!group) return;
    setSaving(groupId);
    try {
      const payload: Record<string, string> = {};
      for (const f of group.fields) {
        const v = values[f.key];
        if (v === undefined) continue;
        if (typeof v === "string" && v.includes("•")) continue; // masked
        const err = validateSetting(f.key, String(v));
        if (err) throw new Error(`${f.label}: ${err}`);
        payload[f.key] = String(v);
      }
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
      setHealth((h) => ({ ...h, [groupId]: result.ok ? "ok" : "error" }));
      addToast({ type: result.ok ? "success" : "error", message: result.message || result.error || "Test complete" });
    } catch (e: unknown) {
      setHealth((h) => ({ ...h, [groupId]: "error" }));
      addToast({ type: "error", message: e instanceof Error ? e.message : "Test failed" });
    } finally {
      setTesting(null);
    }
  };

  return (
    <div className="p-6 space-y-6">
      {/* Glass header */}
      <div className="rounded-3xl border border-white/10 bg-gradient-to-br from-white/10 to-white/5 backdrop-blur-xl shadow-[0_20px_80px_-30px_rgba(0,0,0,0.8)] px-6 py-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-bold text-white">Settings</h2>
            <p className="text-xs text-gray-300/80 mt-1">Fast, clean, dispatcher-safe. Save per section. Test where available.</p>
          </div>
          <div className="text-[10px] uppercase tracking-widest text-gray-300/70 font-semibold px-3 py-1 rounded-full border border-white/10 bg-white/5">
            Glass Mode
          </div>
        </div>
      </div>

      {/* Status strip + Behavior summary */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 rounded-3xl border border-white/10 bg-gradient-to-br from-white/10 to-white/5 backdrop-blur-xl shadow-[0_20px_80px_-30px_rgba(0,0,0,0.8)] p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-[10px] uppercase tracking-widest text-gray-300/70 font-semibold">System status</p>
              <p className="text-xs text-gray-300/80 mt-1">Know what’s alive. Fix what’s not.</p>
            </div>
            <button
              onClick={() => (window as any).dispatchEvent(new CustomEvent('smirk:navigate', { detail: { tab: 'identity' } }))}
              className="px-4 py-2 rounded-2xl bg-white/10 hover:bg-white/15 border border-white/15 text-xs font-semibold text-white transition-colors"
            >
              Edit Behavior
            </button>
          </div>
          <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
            <div className="rounded-2xl border border-white/10 bg-black/20 px-3 py-2">
              <div className="text-gray-300/70">Twilio</div>
              <div className="text-white font-semibold mt-1">{values.TWILIO_ACCOUNT_SID ? 'Present' : 'Missing'}</div>
            </div>
            <div className="rounded-2xl border border-white/10 bg-black/20 px-3 py-2">
              <div className="text-gray-300/70">AI</div>
              <div className="text-white font-semibold mt-1">{values.OPENROUTER_API_KEY || values.GEMINI_API_KEY ? 'Configured' : 'Missing'}</div>
            </div>
            <div className="rounded-2xl border border-white/10 bg-black/20 px-3 py-2">
              <div className="text-gray-300/70">Phone</div>
              <div className="text-white font-semibold mt-1">{values.TWILIO_PHONE_NUMBER ? 'Set' : 'Missing'}</div>
            </div>
            <div className="rounded-2xl border border-white/10 bg-black/20 px-3 py-2">
              <div className="text-gray-300/70">Public URL</div>
              <div className="text-white font-semibold mt-1 truncate">{values.APP_URL ? 'Set' : 'Missing'}</div>
            </div>
          </div>
        </div>

        <div className="rounded-3xl border border-white/10 bg-gradient-to-br from-white/10 to-white/5 backdrop-blur-xl shadow-[0_20px_80px_-30px_rgba(0,0,0,0.8)] p-5">
          <p className="text-[10px] uppercase tracking-widest text-gray-300/70 font-semibold">Behavior (read-only)</p>
          <p className="text-xs text-gray-300/80 mt-1">Edited in Agent. Applied system-wide.</p>
          <div className="mt-4 space-y-2 text-xs">
            <div className="text-gray-300/70">Inbound</div>
            <div className="text-white/90 line-clamp-2">{values.INBOUND_GREETING || 'Default inbound greeting'}</div>
            <div className="text-gray-300/70 mt-2">Outbound</div>
            <div className="text-white/90 line-clamp-2">{values.OUTBOUND_GREETING || 'Default outbound opening'}</div>
            <div className="text-gray-300/70 mt-2">Voicemail</div>
            <div className="text-white/90 line-clamp-2">{values.VOICEMAIL_MESSAGE || 'Default voicemail message'}</div>
            <div className="text-gray-300/70 mt-2">SMS follow-up</div>
            <div className="text-white/90 line-clamp-2">{values.SMS_FOLLOWUP_TEMPLATE || 'Default SMS follow-up'}</div>
          </div>
        </div>
      </div>

      {/* Workspace Mode */}
      <WorkspaceModeCard />

      {/* Webhook URL */}
      <WebhookDisplay />

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-4 items-start">
        <aside className="lg:col-span-1 rounded-3xl border border-white/10 bg-gradient-to-br from-white/10 to-white/5 backdrop-blur-xl shadow-[0_20px_80px_-30px_rgba(0,0,0,0.8)] p-3 sticky top-4">
          <div className="text-[10px] uppercase tracking-widest text-gray-500 font-semibold mb-2">Quick Nav</div>
          <div className="space-y-1 max-h-[60vh] overflow-y-auto pr-1">
            {groups.map((g) => (
              <button
                key={g.id}
                onClick={() => {
                  setActiveGroup(g.id);
                  document.getElementById(`settings-${g.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
                }}
                className={`w-full text-left px-3 py-2 rounded-xl text-xs transition-colors border ${activeGroup === g.id ? 'bg-white/10 text-white border-white/20 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]' : 'text-gray-200/80 border-transparent hover:text-white hover:bg-white/5'}`}
              >
                {g.label}
              </button>
            ))}
          </div>
        </aside>

        <div className="lg:col-span-3 space-y-6">
              {groups.map((group) => (
            <div id={`settings-${group.id}`} key={group.id} className="rounded-3xl border border-white/10 bg-gradient-to-br from-white/10 to-white/5 backdrop-blur-xl shadow-[0_20px_80px_-30px_rgba(0,0,0,0.8)] overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b border-white/10">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="text-sm font-bold text-white">{group.label}</h3>
                {group.required && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-950 border border-red-900 text-red-500 font-medium">Required</span>
                )}
                <span className={`text-[10px] px-1.5 py-0.5 rounded border font-medium ${advancedGroups.has(group.id) ? 'bg-gray-800 border-gray-700 text-gray-400' : 'bg-emerald-950 border-emerald-800 text-emerald-400'}`}>
                  {advancedGroups.has(group.id) ? 'Advanced' : 'Recommended'}
                </span>
                {/* Health indicator dot */}
                {health[group.id] === "ok" && (
                  <span className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-emerald-950 border border-emerald-800 text-emerald-400 font-medium">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 inline-block" /> Connected
                  </span>
                )}
                {health[group.id] === "error" && (
                  <span className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-red-950 border border-red-800 text-red-400 font-medium">
                    <span className="w-1.5 h-1.5 rounded-full bg-red-400 inline-block" /> {group.required ? "Not configured" : "Error"}
                  </span>
                )}
                {health[group.id] === "untested" && (
                  <span className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-amber-950 border border-amber-800 text-amber-400 font-medium">
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-400 inline-block" /> Saved — not tested
                  </span>
                )}
                {health[group.id] === "optional" && (
                  <span className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-gray-800 border border-gray-700 text-gray-500 font-medium">
                    <span className="w-1.5 h-1.5 rounded-full bg-gray-600 inline-block" /> Optional
                  </span>
                )}
              </div>
              <p className="text-xs text-gray-600 mt-0.5">{group.description}</p>
            </div>
            <div className="flex gap-2 ml-3 shrink-0">
              <button
                onClick={() => setCollapsed((c) => ({ ...c, [group.id]: !c[group.id] }))}
                className="px-3 py-2 rounded-xl border border-gray-700 text-gray-400 text-xs font-medium hover:border-gray-600 hover:text-white transition-colors"
              >
                {collapsed[group.id] ? 'Expand' : 'Collapse'}
              </button>
              {testableGroups.has(group.id) && (
                <button
                  onClick={() => testGroup(group.id)}
                  disabled={testing === group.id}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-xl border border-gray-700 text-gray-400 text-xs font-medium hover:border-gray-600 hover:text-white transition-colors disabled:opacity-40"
                >
                  {testing === group.id ? <Loader2 size={12} className="animate-spin" /> : <TestTube size={12} />}
                  Test
                </button>
              )}
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

          {!collapsed[group.id] && (
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
          )}
        </div>
          ))}
        </div>
      </div>
      <BossModePanel />
    </div>
  );
}

// ── Boss Mode Panel ────────────────────────────────────────────────────────────────────────────────────
function BossModePanel() {
  const { addToast } = useToast();
  const [settings, setSettings] = useState({ boss_phone: '', boss_pin: '', twilio_number: '', enabled: false });
  const [briefings, setBriefings] = useState<{ id: number; content: string; category: string; is_permanent: boolean; expires_at: string | null; created_by: string | null; created_at: string; priority?: number }[]>([]);
  const [auditLog, setAuditLog] = useState<{ id: number; caller_name: string | null; raw_transcript: string | null; parsed_intent: string | null; tool_name: string | null; system_action: string | null; response_class: string; confirmed: boolean; created_at: string }[]>([]);
  const [activeTab, setActiveTab] = useState<'briefings' | 'audit' | 'metrics'>('briefings');
  const [metrics, setMetrics] = useState<{ totals: any; by_class: any[]; by_tool: any[]; rollbacks: any; recent_7d: any[] } | null>(null);
  const [saving, setSaving] = useState(false);
  const [newBriefing, setNewBriefing] = useState('');
  const [newCategory, setNewCategory] = useState('briefing');
  const [newPermanent, setNewPermanent] = useState(false);
  const [newExpiryHours, setNewExpiryHours] = useState(24);
  const [addingBriefing, setAddingBriefing] = useState(false);

  const refreshBriefings = () => api<any>('/api/boss/context').then(d => setBriefings(d.entries || [])).catch(() => {});
  const refreshAudit = () => api<any>('/api/boss/audit').then(d => setAuditLog(d.entries || [])).catch(() => {});
  const refreshMetrics = () => api<any>('/api/boss/metrics').then(d => setMetrics(d)).catch(() => {});

  useEffect(() => {
    api<any>('/api/boss/settings').then(d => setSettings({ boss_phone: d.boss_phone || '', boss_pin: '', twilio_number: d.twilio_number || '', enabled: d.enabled || false })).catch(() => {});
    refreshBriefings();
    refreshAudit();
    refreshMetrics();
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      await api('/api/boss/settings', { method: 'POST', body: JSON.stringify(settings) });
      addToast({ type: 'success', message: 'Boss Mode settings saved' });
    } catch { addToast({ type: 'error', message: 'Save failed' }); }
    finally { setSaving(false); }
  };

  const addBriefing = async () => {
    if (!newBriefing.trim()) return;
    setAddingBriefing(true);
    try {
      await api('/api/boss/context', { method: 'POST', body: JSON.stringify({ content: newBriefing, category: newCategory, is_permanent: newPermanent, expires_hours: newExpiryHours }) });
      await refreshBriefings();
      await refreshAudit();
      setNewBriefing('');
      addToast({ type: 'success', message: 'Briefing injected into AI' });
    } catch { addToast({ type: 'error', message: 'Failed to add briefing' }); }
    finally { setAddingBriefing(false); }
  };

  const rollbackBriefing = async (id: number) => {
    try {
      await api(`/api/boss/context/${id}`, { method: 'DELETE' });
      await refreshBriefings();
      await refreshAudit();
      addToast({ type: 'success', message: 'Briefing rolled back' });
    } catch { addToast({ type: 'error', message: 'Failed to roll back briefing' }); }
  };

  const deleteBriefing = async (id: number) => {
    try {
      await api(`/api/boss/context/${id}`, { method: 'DELETE' });
      setBriefings(b => b.filter(x => x.id !== id));
      addToast({ type: 'success', message: 'Briefing removed' });
    } catch { addToast({ type: 'error', message: 'Failed to remove briefing' }); }
  };

  const categoryColors: Record<string, string> = {
    emergency: 'bg-red-600/60 text-red-200 font-bold',
    closure: 'bg-red-900/40 text-red-300',
    policy: 'bg-blue-900/40 text-blue-300',
    pricing: 'bg-amber-900/40 text-amber-300',
    promo: 'bg-emerald-900/40 text-emerald-300',
    briefing: 'bg-violet-900/40 text-violet-300',
    other: 'bg-gray-800 text-gray-400',
  };

  const priorityLabel: Record<string, string> = {
    emergency: 'P1', closure: 'P2', policy: 'P3', pricing: 'P4', promo: 'P5', briefing: 'P6', other: 'P7'
  };

  const responseClassColors: Record<string, string> = {
    STATUS_QUERY: 'bg-blue-900/40 text-blue-300',
    BRIEFING: 'bg-violet-900/40 text-violet-300',
    OPERATIONAL: 'bg-amber-900/40 text-amber-300',
  };

  return (
    <div className="mt-8 border border-violet-800/40 rounded-2xl p-6 bg-gradient-to-br from-violet-950/30 to-gray-900/30">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-violet-900/60 flex items-center justify-center">
            <Zap size={20} className="text-violet-400" />
          </div>
          <div>
            <h2 className="text-lg font-bold text-white">Boss Mode</h2>
            <p className="text-xs text-gray-500">Call your dedicated number to verbally control SMIRK. Parse → Confirm → Apply → Log → Undo.</p>
          </div>
        </div>
        <label className="flex items-center gap-2 cursor-pointer">
          <span className="text-xs text-gray-400">Enabled</span>
          <div onClick={() => setSettings(s => ({ ...s, enabled: !s.enabled }))} className={`w-10 h-5 rounded-full transition-colors cursor-pointer ${settings.enabled ? 'bg-violet-600' : 'bg-gray-700'} relative`}>
            <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${settings.enabled ? 'left-5' : 'left-0.5'}`} />
          </div>
        </label>
      </div>

      {/* Settings */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
        <div>
          <label className="block text-xs font-semibold text-gray-400 mb-1">Boss Phone Number</label>
          <input value={settings.boss_phone} onChange={e => setSettings(s => ({ ...s, boss_phone: e.target.value }))} placeholder="+15551234567" className="w-full bg-gray-950 border border-gray-700 rounded-xl px-4 py-2.5 text-sm text-white placeholder-gray-700 focus:outline-none focus:border-violet-600" />
          <p className="text-xs text-gray-700 mt-1">Only calls from this number are accepted</p>
        </div>
        <div>
          <label className="block text-xs font-semibold text-gray-400 mb-1">4-Digit PIN (optional)</label>
          <input value={settings.boss_pin} onChange={e => setSettings(s => ({ ...s, boss_pin: e.target.value }))} placeholder="1234" maxLength={4} className="w-full bg-gray-950 border border-gray-700 rounded-xl px-4 py-2.5 text-sm text-white placeholder-gray-700 focus:outline-none focus:border-violet-600" />
          <p className="text-xs text-gray-700 mt-1">Extra auth layer after caller ID check</p>
        </div>
        <div>
          <label className="block text-xs font-semibold text-gray-400 mb-1">Boss Mode Twilio Number</label>
          <input value={settings.twilio_number} onChange={e => setSettings(s => ({ ...s, twilio_number: e.target.value }))} placeholder="+15559876543" className="w-full bg-gray-950 border border-gray-700 rounded-xl px-4 py-2.5 text-sm text-white placeholder-gray-700 focus:outline-none focus:border-violet-600" />
          <p className="text-xs text-gray-700 mt-1">Webhook: /api/boss/voice</p>
        </div>
      </div>
      <button onClick={save} disabled={saving} className="mb-6 px-5 py-2 bg-violet-700 hover:bg-violet-600 text-white text-sm font-semibold rounded-xl transition-colors disabled:opacity-50">
        {saving ? 'Saving...' : 'Save Boss Mode Settings'}
      </button>

      {/* Priority legend */}
      <div className="flex items-center gap-2 flex-wrap mb-5 border-t border-gray-800 pt-4">
        <span className="text-xs text-gray-600 mr-1">Priority order:</span>
        {['emergency','closure','policy','pricing','promo','briefing','other'].map(cat => (
          <span key={cat} className={`text-xs px-2 py-0.5 rounded-full ${categoryColors[cat]}`}>{priorityLabel[cat]} {cat}</span>
        ))}
        <span className="text-xs text-gray-600 ml-2">Higher priority wins conflicts</span>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-4">
        <button onClick={() => setActiveTab('briefings')} className={`px-4 py-1.5 rounded-lg text-xs font-semibold transition-colors ${activeTab === 'briefings' ? 'bg-violet-700 text-white' : 'text-gray-500 hover:text-gray-300'}`}>Active Briefings ({briefings.length})</button>
        <button onClick={() => { setActiveTab('audit'); refreshAudit(); }} className={`px-4 py-1.5 rounded-lg text-xs font-semibold transition-colors ${activeTab === 'audit' ? 'bg-violet-700 text-white' : 'text-gray-500 hover:text-gray-300'}`}>Audit Log ({auditLog.length})</button>
        <button onClick={() => { setActiveTab('metrics'); refreshMetrics(); }} className={`px-4 py-1.5 rounded-lg text-xs font-semibold transition-colors ${activeTab === 'metrics' ? 'bg-violet-700 text-white' : 'text-gray-500 hover:text-gray-300'}`}>Metrics</button>
      </div>

      {/* Briefings Tab */}
      {activeTab === 'briefings' && (
        <div>
          <p className="text-xs text-gray-600 mb-3">Injected into AI system prompt on every customer call. Higher priority briefings win conflicts. Emergency beats everything.</p>
          {briefings.length > 0 && (
            <div className="space-y-2 mb-4">
              {briefings.map(b => (
                <div key={b.id} className="flex items-start justify-between gap-3 bg-gray-900 rounded-xl px-4 py-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${categoryColors[b.category] || categoryColors.other}`}>{priorityLabel[b.category] || ''} {b.category}</span>
                      {b.is_permanent && <span className="text-xs px-2 py-0.5 rounded-full bg-amber-900/40 text-amber-300 font-medium">permanent</span>}
                      {b.expires_at && !b.is_permanent && <span className="text-xs text-gray-600">expires {new Date(b.expires_at).toLocaleString()}</span>}
                      {b.created_by && <span className="text-xs text-gray-700">· {b.created_by}</span>}
                    </div>
                    <p className="text-sm text-gray-300">{b.content}</p>
                  </div>
                  <button onClick={() => rollbackBriefing(b.id)} title="Roll back this briefing" className="flex items-center gap-1 text-xs text-gray-600 hover:text-red-400 transition-colors shrink-0 border border-gray-800 hover:border-red-800 rounded-lg px-2 py-1">
                    <RotateCcw size={11} /> Undo
                  </button>
                </div>
              ))}
            </div>
          )}
          {briefings.length === 0 && <p className="text-xs text-gray-700 mb-4">No active briefings. The AI is operating on its base prompt.</p>}

          {/* Manual inject */}
          <div className="bg-gray-900 rounded-xl p-4">
            <p className="text-xs font-semibold text-gray-400 mb-3">Inject Briefing Manually</p>
            <textarea value={newBriefing} onChange={e => setNewBriefing(e.target.value)} placeholder='e.g. "We are running a 20% off special today only."' rows={2} className="w-full bg-gray-950 border border-gray-700 rounded-xl px-4 py-2.5 text-sm text-white placeholder-gray-700 focus:outline-none focus:border-violet-600 resize-none mb-3" />
            <div className="flex items-center gap-3 flex-wrap">
              <select value={newCategory} onChange={e => setNewCategory(e.target.value)} className="bg-gray-950 border border-gray-700 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-violet-600">
                {['emergency','closure','policy','pricing','promo','briefing','other'].map(c => <option key={c} value={c}>{c}</option>)}
              </select>
              {!newPermanent && (
                <select value={newExpiryHours} onChange={e => setNewExpiryHours(Number(e.target.value))} className="bg-gray-950 border border-gray-700 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-violet-600">
                  {[1,2,4,8,12,24,48,72].map(h => <option key={h} value={h}>{h}h</option>)}
                </select>
              )}
              <label className="flex items-center gap-2 text-xs text-gray-400 cursor-pointer">
                <input type="checkbox" checked={newPermanent} onChange={e => setNewPermanent(e.target.checked)} className="accent-violet-600" />
                Permanent
              </label>
              <button onClick={addBriefing} disabled={addingBriefing || !newBriefing.trim()} className="ml-auto px-4 py-2 bg-violet-700 hover:bg-violet-600 text-white text-xs font-semibold rounded-xl transition-colors disabled:opacity-50">
                {addingBriefing ? 'Injecting...' : 'Inject into AI'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Audit Log Tab */}
      {activeTab === 'audit' && (
        <div>
          <p className="text-xs text-gray-600 mb-3">Every Boss Mode action — who triggered it, what was said, what was parsed, whether it was confirmed, and whether it was rolled back.</p>
          {auditLog.length === 0 && <p className="text-xs text-gray-700">No Boss Mode actions recorded yet.</p>}
          <div className="space-y-2">
            {auditLog.map(entry => (
              <div key={entry.id} className="bg-gray-900 rounded-xl px-4 py-3">
                <div className="flex items-center gap-2 mb-1">
                  <span className={`text-xs px-2 py-0.5 rounded-full ${responseClassColors[entry.response_class] || 'bg-gray-800 text-gray-400'}`}>{entry.response_class}</span>
                  <span className={`text-xs px-2 py-0.5 rounded-full ${entry.confirmed ? 'bg-emerald-900/40 text-emerald-300' : 'bg-red-900/40 text-red-400'}`}>{entry.confirmed ? 'Applied' : 'Cancelled'}</span>
                  {entry.tool_name && <span className="text-xs text-gray-600 font-mono">{entry.tool_name}</span>}
                  <span className="text-xs text-gray-700 ml-auto">{new Date(entry.created_at).toLocaleString()}</span>
                </div>
                {entry.raw_transcript && <p className="text-xs text-gray-500 italic mb-1">"{entry.raw_transcript}"</p>}
                {entry.system_action && <p className="text-xs text-gray-400">{entry.system_action}</p>}
                {entry.caller_name && <p className="text-xs text-gray-700 mt-1">By: {entry.caller_name}</p>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Metrics Tab */}
      {activeTab === 'metrics' && (
        <div>
          <p className="text-xs text-gray-600 mb-4">Boss Mode usage analytics — command frequency, confirmation rate, rollback rate, and activity over the last 7 days.</p>
          {!metrics ? (
            <p className="text-xs text-gray-700">Loading metrics...</p>
          ) : (
            <div className="space-y-4">
              {/* Summary stats */}
              <div className="grid grid-cols-3 gap-3">
                <div className="bg-gray-900 rounded-xl px-4 py-3 text-center">
                  <p className="text-2xl font-bold text-white">{metrics.totals?.total ?? 0}</p>
                  <p className="text-xs text-gray-500 mt-1">Total Actions</p>
                </div>
                <div className="bg-gray-900 rounded-xl px-4 py-3 text-center">
                  <p className="text-2xl font-bold text-emerald-400">{metrics.totals?.confirmed_count ?? 0}</p>
                  <p className="text-xs text-gray-500 mt-1">Applied</p>
                </div>
                <div className="bg-gray-900 rounded-xl px-4 py-3 text-center">
                  <p className="text-2xl font-bold text-red-400">{metrics.totals?.cancelled_count ?? 0}</p>
                  <p className="text-xs text-gray-500 mt-1">Cancelled</p>
                </div>
              </div>
              {/* Rollback rate */}
              {metrics.rollbacks && (
                <div className="bg-gray-900 rounded-xl px-4 py-3">
                  <p className="text-xs font-semibold text-gray-400 mb-2">Briefing Rollback Rate</p>
                  <div className="flex items-center gap-3">
                    <div className="flex-1 h-2 bg-gray-800 rounded-full overflow-hidden">
                      <div className="h-full bg-amber-500 rounded-full" style={{ width: metrics.rollbacks.total_briefings > 0 ? `${Math.round((metrics.rollbacks.rolled_back / metrics.rollbacks.total_briefings) * 100)}%` : '0%' }} />
                    </div>
                    <span className="text-xs text-gray-400">{metrics.rollbacks.total_briefings > 0 ? Math.round((metrics.rollbacks.rolled_back / metrics.rollbacks.total_briefings) * 100) : 0}% rolled back ({metrics.rollbacks.rolled_back}/{metrics.rollbacks.total_briefings})</span>
                  </div>
                </div>
              )}
              {/* By tool */}
              {metrics.by_tool?.length > 0 && (
                <div className="bg-gray-900 rounded-xl px-4 py-3">
                  <p className="text-xs font-semibold text-gray-400 mb-2">Commands by Tool</p>
                  <div className="space-y-1.5">
                    {metrics.by_tool.map((t: any) => (
                      <div key={t.tool_name} className="flex items-center gap-3">
                        <span className="text-xs font-mono text-gray-500 w-40 truncate">{t.tool_name}</span>
                        <div className="flex-1 h-1.5 bg-gray-800 rounded-full overflow-hidden">
                          <div className="h-full bg-violet-600 rounded-full" style={{ width: `${Math.round((t.cnt / (metrics.totals?.total || 1)) * 100)}%` }} />
                        </div>
                        <span className="text-xs text-gray-600">{t.cnt}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {/* 7-day activity */}
              {metrics.recent_7d?.length > 0 && (
                <div className="bg-gray-900 rounded-xl px-4 py-3">
                  <p className="text-xs font-semibold text-gray-400 mb-2">Activity — Last 7 Days</p>
                  <div className="flex items-end gap-1 h-12">
                    {metrics.recent_7d.map((d: any) => (
                      <div key={d.day} className="flex-1 flex flex-col items-center gap-1">
                        <div className="w-full bg-violet-700 rounded-sm" style={{ height: `${Math.max(4, Math.round((d.cnt / Math.max(...metrics.recent_7d.map((x: any) => x.cnt))) * 44))}px` }} />
                        <span className="text-xs text-gray-700">{new Date(d.day).toLocaleDateString(undefined, { weekday: 'short' })}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {metrics.recent_7d?.length === 0 && <p className="text-xs text-gray-700">No Boss Mode activity in the last 7 days.</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}


// ── Integrations Page ────────────────────────────────────────────────────
function IntegrationsPage() {
  const { addToast } = useToast();
  const [webhookStatus, setWebhookStatus] = useState<any>(null);
  const [deliveries, setDeliveries] = useState<any[]>([]);
  const [testUrl, setTestUrl] = useState('');
  const [testing, setTesting] = useState(false);
  const [loadingDeliveries, setLoadingDeliveries] = useState(true);
  const [fieldDefs, setFieldDefs] = useState<any[]>([]);
  const [newField, setNewField] = useState({ key: '', label: '', type: 'text' });
  const [addingField, setAddingField] = useState(false);
  const [activeSection, setActiveSection] = useState<'webhook'|'zapier'|'fields'|'crm'|'tools'|'mcp'>('webhook');

  // ── CRM state ──
  const [crmStatus, setCrmStatus] = useState<any>(null);
  const [crmTesting, setCrmTesting] = useState<string | null>(null);
  const [crmResults, setCrmResults] = useState<Record<string, any>>({});

  // ── Plugin Tools state ──
  const [tools, setTools] = useState<any[]>([]);
  const [toolExamples, setToolExamples] = useState<any[]>([]);
  const [editingTool, setEditingTool] = useState<any | null>(null);
  const [showToolForm, setShowToolForm] = useState(false);
  const [toolTestArgs, setToolTestArgs] = useState<Record<number, string>>({});
  const [toolTestResults, setToolTestResults] = useState<Record<number, any>>({});
  const [toolTesting, setToolTesting] = useState<number | null>(null);
  const [savingTool, setSavingTool] = useState(false);
  const blankTool = { name: '', display_name: '', description: '', url: '', method: 'GET', headers: '{}', params: '[]', response_path: '', response_template: '', enabled: true };
  const [toolForm, setToolForm] = useState(blankTool);

  // ── MCP state ──
  const [mcpServers, setMcpServers] = useState<any[]>([]);
  const [mcpPopular, setMcpPopular] = useState<any[]>([]);
  const [mcpTesting, setMcpTesting] = useState<number | null>(null);
  const [mcpTestResults, setMcpTestResults] = useState<Record<number, any>>({});
  const [showMcpForm, setShowMcpForm] = useState(false);
  const [savingMcp, setSavingMcp] = useState(false);
  const blankMcp = { name: '', display_name: '', transport: 'http', url: '', command: 'npx', args: '[]', env: '{}', headers: '{}', enabled: false, tool_prefix: '', description: '' };
  const [mcpForm, setMcpForm] = useState(blankMcp);

  useEffect(() => {
    api<any>('/api/integrations/webhook').then(setWebhookStatus).catch(() => {});
    api<any[]>('/api/integrations/webhook/deliveries').then(setDeliveries).catch(() => {}).finally(() => setLoadingDeliveries(false));
    api<any[]>('/api/field-definitions').then(setFieldDefs).catch(() => {});
    api<any>('/api/integrations/crm').then(setCrmStatus).catch(() => {});
    api<any>('/api/tools').then((d) => { setTools(d.tools || []); setToolExamples(d.examples || []); }).catch(() => {});
    api<any>('/api/mcp').then((d) => { setMcpServers(d.servers || []); setMcpPopular(d.popular || []); }).catch(() => {});
  }, []);

  // ── CRM helpers ──
  const testCrm = async (platform: string) => {
    setCrmTesting(platform);
    try {
      const r = await api<any>('/api/integrations/crm/test', { method: 'POST', body: JSON.stringify({ platform }) });
      setCrmResults((prev) => ({ ...prev, [platform]: r }));
      if (r.success) addToast({ type: 'success', message: `${platform} connected — record ${r.action}` });
      else addToast({ type: 'error', message: r.error || 'Connection failed' });
    } catch (e: any) { addToast({ type: 'error', message: e.message }); }
    finally { setCrmTesting(null); }
  };

  // ── Tool helpers ──
  const saveTool = async () => {
    setSavingTool(true);
    try {
      let params: any[] = [];
      let headers: any = {};
      try { params = JSON.parse(toolForm.params); } catch { addToast({ type: 'error', message: 'Params must be valid JSON array' }); setSavingTool(false); return; }
      try { headers = JSON.parse(toolForm.headers); } catch { addToast({ type: 'error', message: 'Headers must be valid JSON object' }); setSavingTool(false); return; }
      const payload = { ...toolForm, params, headers };
      if (editingTool?.id) {
        await api(`/api/tools/${editingTool.id}`, { method: 'PUT', body: JSON.stringify(payload) });
        addToast({ type: 'success', message: 'Tool updated' });
      } else {
        await api('/api/tools', { method: 'POST', body: JSON.stringify(payload) });
        addToast({ type: 'success', message: 'Tool created' });
      }
      const d = await api<any>('/api/tools');
      setTools(d.tools || []);
      setShowToolForm(false);
      setEditingTool(null);
      setToolForm(blankTool);
    } catch (e: any) { addToast({ type: 'error', message: e.message }); }
    finally { setSavingTool(false); }
  };

  const deleteTool = async (id: number) => {
    try {
      await api(`/api/tools/${id}`, { method: 'DELETE' });
      setTools((t) => t.filter((x) => x.id !== id));
      addToast({ type: 'success', message: 'Tool deleted' });
    } catch { addToast({ type: 'error', message: 'Failed to delete' }); }
  };

  const toggleTool = async (tool: any) => {
    try {
      await api(`/api/tools/${tool.id}`, { method: 'PUT', body: JSON.stringify({ enabled: !tool.enabled }) });
      setTools((t) => t.map((x) => x.id === tool.id ? { ...x, enabled: !x.enabled } : x));
    } catch { addToast({ type: 'error', message: 'Failed to update' }); }
  };

  const testTool = async (id: number) => {
    setToolTesting(id);
    try {
      let args: any = {};
      try { args = JSON.parse(toolTestArgs[id] || '{}'); } catch { addToast({ type: 'error', message: 'Test args must be valid JSON' }); setToolTesting(null); return; }
      const r = await api<any>(`/api/tools/${id}/test`, { method: 'POST', body: JSON.stringify(args) });
      setToolTestResults((prev) => ({ ...prev, [id]: r }));
    } catch (e: any) { setToolTestResults((prev) => ({ ...prev, [id]: { success: false, error: e.message } })); }
    finally { setToolTesting(null); }
  };

  // ── MCP helpers ──
  const saveMcp = async () => {
    setSavingMcp(true);
    try {
      let args: any[] = [];
      let env: any = {};
      let headers: any = {};
      try { args = JSON.parse(mcpForm.args); } catch { addToast({ type: 'error', message: 'Args must be valid JSON array' }); setSavingMcp(false); return; }
      try { env = JSON.parse(mcpForm.env); } catch { addToast({ type: 'error', message: 'Env must be valid JSON object' }); setSavingMcp(false); return; }
      try { headers = JSON.parse(mcpForm.headers); } catch { addToast({ type: 'error', message: 'Headers must be valid JSON object' }); setSavingMcp(false); return; }
      const payload = { ...mcpForm, args, env, headers };
      await api('/api/mcp', { method: 'POST', body: JSON.stringify(payload) });
      const d = await api<any>('/api/mcp');
      setMcpServers(d.servers || []);
      setShowMcpForm(false);
      setMcpForm(blankMcp);
      addToast({ type: 'success', message: 'MCP server added' });
    } catch (e: any) { addToast({ type: 'error', message: e.message }); }
    finally { setSavingMcp(false); }
  };

  const toggleMcp = async (server: any) => {
    try {
      await api(`/api/mcp/${server.id}`, { method: 'PUT', body: JSON.stringify({ enabled: !server.enabled }) });
      setMcpServers((s) => s.map((x) => x.id === server.id ? { ...x, enabled: !x.enabled } : x));
    } catch { addToast({ type: 'error', message: 'Failed to update' }); }
  };

  const deleteMcp = async (id: number) => {
    try {
      await api(`/api/mcp/${id}`, { method: 'DELETE' });
      setMcpServers((s) => s.filter((x) => x.id !== id));
      addToast({ type: 'success', message: 'Server removed' });
    } catch { addToast({ type: 'error', message: 'Failed to delete' }); }
  };

  const testMcp = async (id: number) => {
    setMcpTesting(id);
    try {
      const r = await api<any>(`/api/mcp/${id}/test`, { method: 'POST' });
      setMcpTestResults((prev) => ({ ...prev, [id]: r }));
      if (r.success) addToast({ type: 'success', message: `Connected — ${r.tools?.length || 0} tools available` });
      else addToast({ type: 'error', message: r.error || 'Connection failed' });
    } catch (e: any) { setMcpTestResults((prev) => ({ ...prev, [id]: { success: false, error: e.message } })); }
    finally { setMcpTesting(null); }
  };

  const addPopularMcp = async (template: any) => {
    try {
      const payload = {
        ...template,
        args: JSON.stringify(template.args || []),
        env: JSON.stringify(template.env || {}),
        headers: JSON.stringify(template.headers || {}),
      };
      setMcpForm(payload);
      setShowMcpForm(true);
    } catch { addToast({ type: 'error', message: 'Failed to load template' }); }
  };

  const fireTest = async () => {
    const url = testUrl || (webhookStatus?.url ? undefined : null);
    if (!webhookStatus?.configured && !testUrl) {
      addToast({ type: 'error', message: 'Add WEBHOOK_URL in Settings first, or enter a URL below to test.' });
      return;
    }
    setTesting(true);
    try {
      const result = await api<any>('/api/integrations/webhook/test', { method: 'POST', body: JSON.stringify({ url: testUrl || undefined }) });
      if (result.success) addToast({ type: 'success', message: `Webhook delivered in ${result.durationMs}ms` });
      else addToast({ type: 'error', message: result.error || 'Delivery failed' });
    } catch (e: any) { addToast({ type: 'error', message: e.message }); }
    finally { setTesting(false); }
  };

  const addField = async () => {
    if (!newField.key || !newField.label) { addToast({ type: 'error', message: 'Key and label are required' }); return; }
    setAddingField(true);
    try {
      await api('/api/field-definitions', { method: 'POST', body: JSON.stringify(newField) });
      const updated = await api<any[]>('/api/field-definitions');
      setFieldDefs(updated);
      setNewField({ key: '', label: '', type: 'text' });
      addToast({ type: 'success', message: 'Field added' });
    } catch { addToast({ type: 'error', message: 'Failed to add field' }); }
    finally { setAddingField(false); }
  };

  const deleteField = async (key: string) => {
    try {
      await api(`/api/field-definitions/${key}`, { method: 'DELETE' });
      setFieldDefs((f) => f.filter((x) => x.field_key !== key));
      addToast({ type: 'success', message: 'Field removed' });
    } catch { addToast({ type: 'error', message: 'Failed to delete field' }); }
  };

  const sections = [
    { id: 'webhook' as const, label: 'Webhook' },
    { id: 'crm' as const, label: 'CRM' },
    { id: 'tools' as const, label: 'Tools' },
    { id: 'mcp' as const, label: 'MCP Servers' },
    { id: 'zapier' as const, label: 'Zapier / Make' },
    { id: 'fields' as const, label: 'Fields' },
  ];

  return (
    <div className="p-6 space-y-5">
      <div>
        <h2 className="text-base font-bold text-white mb-1">Integrations</h2>
        <p className="text-xs text-gray-600">Connect SMIRK to your CRM, Zapier, Slack, or any webhook endpoint. Every call fires a structured payload with the caller's info, intent, and extracted data.</p>
      </div>

      {/* Section tabs */}
      <div className="flex gap-1 p-1 rounded-xl bg-gray-900 border border-gray-800 w-fit">
        {sections.map((s) => (
          <button key={s.id} onClick={() => setActiveSection(s.id)}
            className={`px-4 py-2 rounded-lg text-xs font-semibold transition-colors ${activeSection === s.id ? 'bg-violet-700 text-white' : 'text-gray-500 hover:text-gray-300'}`}>{s.label}</button>
        ))}
      </div>

      {activeSection === 'webhook' && (
        <div className="space-y-4">
          {/* Status card */}
          <div className={`rounded-2xl border p-5 ${webhookStatus?.configured ? 'bg-emerald-950/20 border-emerald-800/40' : 'bg-gray-900 border-gray-800'}`}>
            <div className="flex items-center gap-3 mb-3">
              <div className={`w-2.5 h-2.5 rounded-full ${webhookStatus?.configured ? 'bg-emerald-400' : 'bg-gray-600'}`} />
              <span className="text-sm font-semibold text-white">{webhookStatus?.configured ? 'Webhook Active' : 'Webhook Not Configured'}</span>
            </div>
            {webhookStatus?.configured ? (
              <div className="space-y-1.5 text-xs text-gray-500">
                <div>Endpoint: <span className="text-gray-300 font-mono">{webhookStatus.url}</span></div>
                <div>Events: <span className="text-gray-300">{webhookStatus.events?.join(', ')}</span></div>
                <div>Retries: <span className="text-gray-300">{webhookStatus.retryCount}</span> · Signing: <span className={webhookStatus.hasSecret ? 'text-emerald-400' : 'text-gray-600'}>{webhookStatus.hasSecret ? 'HMAC-SHA256 enabled' : 'disabled'}</span></div>
              </div>
            ) : (
              <p className="text-xs text-gray-600">Add <code className="text-violet-400">WEBHOOK_URL</code> in Settings → Integrations to enable. Every completed call will POST a structured JSON payload to that URL.</p>
            )}
          </div>

          {/* Test fire */}
          <div className="rounded-2xl bg-gray-900 border border-gray-800 p-5">
            <p className="text-xs font-semibold uppercase tracking-widest text-gray-500 mb-3">Test Delivery</p>
            <div className="flex gap-2">
              <input value={testUrl} onChange={(e) => setTestUrl(e.target.value)}
                placeholder={webhookStatus?.configured ? 'Leave blank to use configured URL' : 'https://hooks.zapier.com/hooks/catch/…'}
                className="flex-1 bg-gray-950 border border-gray-700 rounded-xl px-4 py-2.5 text-sm text-white placeholder-gray-700 focus:outline-none focus:border-violet-600 transition-colors font-mono text-xs" />
              <button onClick={fireTest} disabled={testing}
                className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-violet-700 hover:bg-violet-600 text-white text-sm font-semibold transition-colors disabled:opacity-40 shrink-0">
                {testing ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />} Fire Test
              </button>
            </div>
            <p className="text-xs text-gray-700 mt-2">Sends a sample payload with realistic call data so you can verify your integration before going live.</p>
          </div>

          {/* Delivery log */}
          <div className="rounded-2xl bg-gray-900 border border-gray-800 overflow-hidden">
            <div className="px-5 py-3 border-b border-gray-800">
              <p className="text-xs font-semibold uppercase tracking-widest text-gray-500">Recent Deliveries</p>
            </div>
            {loadingDeliveries ? (
              <div className="flex justify-center py-8"><Loader2 size={20} className="animate-spin text-gray-600" /></div>
            ) : deliveries.length === 0 ? (
              <p className="text-center text-gray-600 text-sm py-8">No deliveries yet</p>
            ) : (
              <div className="divide-y divide-gray-800">
                {deliveries.slice(0, 20).map((d: any) => (
                  <div key={d.id} className="flex items-center gap-3 px-5 py-3">
                    <div className={`w-2 h-2 rounded-full shrink-0 ${d.success ? 'bg-emerald-400' : 'bg-red-500'}`} />
                    <div className="flex-1 min-w-0">
                      <div className="text-xs text-gray-400 font-mono truncate">{d.event} · {d.call_sid?.slice(0,16)}…</div>
                      {d.error_message && <div className="text-xs text-red-400 truncate">{d.error_message}</div>}
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-xs text-gray-600">{d.status_code ? `HTTP ${d.status_code}` : '—'}</div>
                      <div className="text-xs text-gray-700">{d.duration_ms}ms</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Payload schema */}
          <div className="rounded-2xl bg-gray-900 border border-gray-800 p-5">
            <p className="text-xs font-semibold uppercase tracking-widest text-gray-500 mb-3">Payload Schema</p>
            <pre className="text-xs text-gray-400 overflow-x-auto leading-relaxed font-mono bg-gray-950 rounded-xl p-4 border border-gray-800">{`{
  "event": "call_completed",
  "timestamp": "2026-03-15T12:00:00Z",
  "call": { "sid", "from", "to", "direction", "duration_seconds", "agent_name" },
  "contact": { "id", "name", "phone", "email", "company", "tags", "total_calls" },
  "summary": { "intent", "outcome", "sentiment", "resolution_score", "next_action" },
  "extracted": { "name", "email", "service_type", "preferred_time", ... },
  "transcript_url": "https://your-app.railway.app/api/calls/{sid}/transcript",
  "appointments": [ { "service_type", "scheduled_at", "status" } ],
  "tasks": [ { "task_type", "status", "due_at" } ],
  "handoffs": [ { "reason", "urgency", "status" } ]
}`}</pre>
          </div>
        </div>
      )}

      {activeSection === 'zapier' && (
        <div className="space-y-4">
          <div className="rounded-2xl bg-gray-900 border border-gray-800 p-5 space-y-4">
            <p className="text-sm font-semibold text-white">Connect to Zapier in 3 steps</p>
            {[
              { n: 1, title: 'Create a Zapier Catch Hook', body: 'In Zapier, create a new Zap. Choose "Webhooks by Zapier" as the trigger, then select "Catch Hook". Copy the webhook URL Zapier gives you.' },
              { n: 2, title: 'Add the URL to SMIRK Settings', body: 'Go to Settings → Integrations → Webhook URL. Paste the Zapier URL there and save. Optionally add a signing secret for security.' },
              { n: 3, title: 'Fire a test and build your Zap', body: 'Click "Fire Test" on the Webhook tab. Zapier will receive the sample payload. Use it to map fields to HubSpot, Google Sheets, Slack, or any other app.' },
            ].map((s) => (
              <div key={s.n} className="flex gap-4">
                <div className="w-7 h-7 rounded-full bg-violet-900/40 border border-violet-700/40 flex items-center justify-center text-violet-400 text-xs font-bold shrink-0 mt-0.5">{s.n}</div>
                <div>
                  <p className="text-sm font-semibold text-white mb-1">{s.title}</p>
                  <p className="text-xs text-gray-500 leading-relaxed">{s.body}</p>
                </div>
              </div>
            ))}
          </div>
          <div className="rounded-2xl bg-gray-900 border border-gray-800 p-5">
            <p className="text-xs font-semibold uppercase tracking-widest text-gray-500 mb-3">Popular Zap Templates</p>
            <div className="space-y-2">
              {[
                { name: 'SMIRK → HubSpot', desc: 'Create or update a HubSpot contact from every call. Map extracted.email, extracted.name, summary.intent.' },
                { name: 'SMIRK → Google Sheets', desc: 'Log every call to a spreadsheet row. Great for tracking leads without a CRM.' },
                { name: 'SMIRK → Slack', desc: 'Post a Slack message when a call ends with outcome = appointment_booked or urgency = high.' },
                { name: 'SMIRK → SMS (Twilio)', desc: 'Send a follow-up SMS to the caller after the call using contact.phone.' },
                { name: 'SMIRK → Calendly / Cal.com', desc: 'Create a booking when appointments[0].status = scheduled.' },
              ].map((t) => (
                <div key={t.name} className="p-3 rounded-xl bg-gray-950 border border-gray-800">
                  <p className="text-sm font-semibold text-white">{t.name}</p>
                  <p className="text-xs text-gray-600 mt-0.5">{t.desc}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {activeSection === 'crm' && (
        <div className="space-y-4">
          <div className="rounded-2xl bg-gray-900 border border-gray-800 p-5">
            <p className="text-xs text-gray-600 mb-4">Connect a CRM and SMIRK will automatically upsert the contact and log the call after every conversation — no Zapier needed. Add the API key in Settings to activate.</p>
            <div className="grid grid-cols-1 gap-3">
              {[
                { key: 'hubspot', label: 'HubSpot', desc: 'Upsert contact + log call activity', settingKey: 'HUBSPOT_ACCESS_TOKEN', color: 'orange' },
                { key: 'salesforce', label: 'Salesforce', desc: 'Upsert contact + create Task', settingKey: 'SALESFORCE_ACCESS_TOKEN', color: 'blue' },
                { key: 'airtable', label: 'Airtable', desc: 'Row in Contacts + row in Calls table', settingKey: 'AIRTABLE_API_KEY', color: 'yellow' },
                { key: 'notion', label: 'Notion', desc: 'Page upsert in your contacts database', settingKey: 'NOTION_API_KEY', color: 'gray' },
              ].map((crm) => {
                const configured = crmStatus?.[crm.key]?.configured;
                const result = crmResults[crm.key];
                return (
                  <div key={crm.key} className={`flex items-center gap-4 p-4 rounded-xl border ${configured ? 'bg-emerald-950/20 border-emerald-800/40' : 'bg-gray-950 border-gray-800'}`}>
                    <div className={`w-2.5 h-2.5 rounded-full shrink-0 ${configured ? 'bg-emerald-400' : 'bg-gray-600'}`} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-white">{crm.label}</span>
                        {configured && <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-950 text-emerald-400">Active</span>}
                        {!configured && <span className="text-xs px-2 py-0.5 rounded-full bg-gray-800 text-gray-500">Not configured</span>}
                      </div>
                      <p className="text-xs text-gray-600 mt-0.5">{crm.desc}</p>
                      {!configured && <p className="text-xs text-gray-700 mt-1">Add <code className="text-violet-400">{crm.settingKey}</code> in Settings</p>}
                      {result && (
                        <p className={`text-xs mt-1 ${result.success ? 'text-emerald-400' : 'text-red-400'}`}>
                          {result.success ? `✓ Test record ${result.action} (ID: ${result.recordId})` : `✗ ${result.error}`}
                        </p>
                      )}
                    </div>
                    {configured && (
                      <button onClick={() => testCrm(crm.key)} disabled={crmTesting === crm.key}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 text-xs text-white font-medium transition-colors disabled:opacity-40 shrink-0">
                        {crmTesting === crm.key ? <Loader2 size={11} className="animate-spin" /> : <TestTube size={11} />} Test
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {activeSection === 'tools' && (
        <div className="space-y-4">
          {/* Tool list */}
          <div className="rounded-2xl bg-gray-900 border border-gray-800 p-5">
            <div className="flex items-center justify-between mb-4">
              <div>
                <p className="text-sm font-semibold text-white">Custom HTTP Tools</p>
                <p className="text-xs text-gray-600 mt-0.5">Define any API endpoint as a tool the AI can call live during calls. The AI decides when to use it and maps caller speech to parameters.</p>
              </div>
              <button onClick={() => { setEditingTool(null); setToolForm(blankTool); setShowToolForm(true); }}
                className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-violet-700 hover:bg-violet-600 text-white text-xs font-semibold transition-colors shrink-0">
                <Plus size={13} /> Add Tool
              </button>
            </div>

            {tools.length === 0 && !showToolForm && (
              <div className="text-center py-8">
                <Wrench size={24} className="text-gray-700 mx-auto mb-3" />
                <p className="text-sm text-gray-600 mb-1">No tools yet</p>
                <p className="text-xs text-gray-700 mb-4">Start from an example or build your own</p>
                <div className="grid grid-cols-1 gap-2">
                  {toolExamples.slice(0, 3).map((ex: any, i: number) => (
                    <button key={i} onClick={() => { setToolForm({ ...blankTool, ...ex, params: JSON.stringify(ex.params || [], null, 2), headers: JSON.stringify(ex.headers || {}) }); setEditingTool(null); setShowToolForm(true); }}
                      className="flex items-start gap-3 p-3 rounded-xl bg-gray-950 border border-gray-800 hover:border-violet-700 text-left transition-colors">
                      <Zap size={13} className="text-violet-400 mt-0.5 shrink-0" />
                      <div>
                        <p className="text-xs font-semibold text-white">{ex.display_name}</p>
                        <p className="text-xs text-gray-600">{ex.description.slice(0, 80)}…</p>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {tools.map((tool: any) => (
              <div key={tool.id} className="mb-3 rounded-xl border border-gray-800 bg-gray-950 overflow-hidden">
                <div className="flex items-center gap-3 p-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-white">{tool.display_name}</span>
                      <span className={`text-xs px-1.5 py-0.5 rounded font-mono ${tool.method === 'GET' ? 'bg-emerald-950 text-emerald-400' : 'bg-blue-950 text-blue-400'}`}>{tool.method}</span>
                      <span className={`text-xs px-2 py-0.5 rounded-full ${tool.enabled ? 'bg-violet-950 text-violet-400' : 'bg-gray-800 text-gray-600'}`}>{tool.enabled ? 'Active' : 'Disabled'}</span>
                    </div>
                    <p className="text-xs text-gray-600 mt-0.5 truncate">{tool.url}</p>
                    <p className="text-xs text-gray-700 mt-0.5">{tool.params?.length || 0} params · {tool.description?.slice(0, 60)}…</p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button onClick={() => toggleTool(tool)} className={`p-1.5 rounded-lg text-xs transition-colors ${tool.enabled ? 'bg-violet-950 text-violet-400 hover:bg-violet-900' : 'bg-gray-800 text-gray-600 hover:bg-gray-700'}`}>
                      {tool.enabled ? <Check size={12} /> : <X size={12} />}
                    </button>
                    <button onClick={() => { setEditingTool(tool); setToolForm({ ...blankTool, ...tool, params: JSON.stringify(tool.params || [], null, 2), headers: JSON.stringify(tool.headers || {}) }); setShowToolForm(true); }}
                      className="p-1.5 rounded-lg bg-gray-800 text-gray-500 hover:text-white transition-colors"><Pencil size={12} /></button>
                    <button onClick={() => deleteTool(tool.id)} className="p-1.5 rounded-lg bg-gray-800 text-gray-500 hover:text-red-400 transition-colors"><Trash2 size={12} /></button>
                  </div>
                </div>
                {/* Test panel */}
                <div className="border-t border-gray-800 px-4 py-3 bg-gray-900/50">
                  <p className="text-xs font-semibold text-gray-500 uppercase tracking-widest mb-2">Test</p>
                  <div className="flex gap-2">
                    <input value={toolTestArgs[tool.id] || ''} onChange={(e) => setToolTestArgs((p) => ({ ...p, [tool.id]: e.target.value }))}
                      placeholder='{"param": "value"}'
                      className="flex-1 bg-gray-950 border border-gray-700 rounded-lg px-3 py-1.5 text-xs text-white font-mono placeholder-gray-700 focus:outline-none focus:border-violet-600" />
                    <button onClick={() => testTool(tool.id)} disabled={toolTesting === tool.id}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 text-xs text-white font-medium transition-colors disabled:opacity-40">
                      {toolTesting === tool.id ? <Loader2 size={11} className="animate-spin" /> : <TestTube size={11} />} Run
                    </button>
                  </div>
                  {toolTestResults[tool.id] && (
                    <div className={`mt-2 p-2 rounded-lg text-xs font-mono ${toolTestResults[tool.id].result?.success ? 'bg-emerald-950/30 text-emerald-400' : 'bg-red-950/30 text-red-400'}`}>
                      {toolTestResults[tool.id].result?.success
                        ? `✓ ${toolTestResults[tool.id].result.result?.spoken_response || JSON.stringify(toolTestResults[tool.id].result.result?.data)}`
                        : `✗ ${toolTestResults[tool.id].error || toolTestResults[tool.id].result?.error}`}
                      {toolTestResults[tool.id].result?.result?.durationMs && <span className="text-gray-600 ml-2">{toolTestResults[tool.id].result.result.durationMs}ms</span>}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* Tool form */}
          {showToolForm && (
            <div className="rounded-2xl bg-gray-900 border border-violet-800/40 p-5">
              <div className="flex items-center justify-between mb-4">
                <p className="text-sm font-semibold text-white">{editingTool ? 'Edit Tool' : 'New Tool'}</p>
                <button onClick={() => { setShowToolForm(false); setEditingTool(null); }} className="p-1.5 rounded-lg hover:bg-gray-800 text-gray-500"><X size={14} /></button>
              </div>
              <div className="grid grid-cols-2 gap-3 mb-3">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Function Name <span className="text-gray-700">(snake_case)</span></label>
                  <input value={toolForm.name} onChange={(e) => setToolForm((f) => ({ ...f, name: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g,'_') }))}
                    placeholder="check_availability" className="w-full bg-gray-950 border border-gray-700 rounded-xl px-3 py-2 text-sm text-white font-mono placeholder-gray-700 focus:outline-none focus:border-violet-600" />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Display Name</label>
                  <input value={toolForm.display_name} onChange={(e) => setToolForm((f) => ({ ...f, display_name: e.target.value }))}
                    placeholder="Check Appointment Availability" className="w-full bg-gray-950 border border-gray-700 rounded-xl px-3 py-2 text-sm text-white placeholder-gray-700 focus:outline-none focus:border-violet-600" />
                </div>
              </div>
              <div className="mb-3">
                <label className="block text-xs text-gray-500 mb-1">Description <span className="text-gray-700">(what the AI sees — be specific)</span></label>
                <textarea value={toolForm.description} onChange={(e) => setToolForm((f) => ({ ...f, description: e.target.value }))} rows={2}
                  placeholder="Check if a specific date and time is available for booking. Use when the caller asks about availability."
                  className="w-full bg-gray-950 border border-gray-700 rounded-xl px-3 py-2 text-sm text-white placeholder-gray-700 focus:outline-none focus:border-violet-600 resize-none" />
              </div>
              <div className="grid grid-cols-3 gap-3 mb-3">
                <div className="col-span-2">
                  <label className="block text-xs text-gray-500 mb-1">Endpoint URL</label>
                  <input value={toolForm.url} onChange={(e) => setToolForm((f) => ({ ...f, url: e.target.value }))}
                    placeholder="https://your-api.com/availability" className="w-full bg-gray-950 border border-gray-700 rounded-xl px-3 py-2 text-sm text-white font-mono placeholder-gray-700 focus:outline-none focus:border-violet-600" />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Method</label>
                  <select value={toolForm.method} onChange={(e) => setToolForm((f) => ({ ...f, method: e.target.value }))}
                    className="w-full bg-gray-950 border border-gray-700 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-violet-600">
                    {['GET','POST','PUT','PATCH','DELETE'].map((m) => <option key={m}>{m}</option>)}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3 mb-3">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Response Path <span className="text-gray-700">(dot-notation, e.g. data.status)</span></label>
                  <input value={toolForm.response_path} onChange={(e) => setToolForm((f) => ({ ...f, response_path: e.target.value }))}
                    placeholder="data.status" className="w-full bg-gray-950 border border-gray-700 rounded-xl px-3 py-2 text-sm text-white font-mono placeholder-gray-700 focus:outline-none focus:border-violet-600" />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Response Template <span className="text-gray-700">(use {'{value}'} for extracted data)</span></label>
                  <input value={toolForm.response_template} onChange={(e) => setToolForm((f) => ({ ...f, response_template: e.target.value }))}
                    placeholder="Your order status is {value}." className="w-full bg-gray-950 border border-gray-700 rounded-xl px-3 py-2 text-sm text-white placeholder-gray-700 focus:outline-none focus:border-violet-600" />
                </div>
              </div>
              <div className="mb-3">
                <label className="block text-xs text-gray-500 mb-1">Parameters <span className="text-gray-700">(JSON array — what the AI extracts from conversation)</span></label>
                <textarea value={toolForm.params} onChange={(e) => setToolForm((f) => ({ ...f, params: e.target.value }))} rows={5}
                  className="w-full bg-gray-950 border border-gray-700 rounded-xl px-3 py-2 text-xs text-white font-mono placeholder-gray-700 focus:outline-none focus:border-violet-600 resize-none"
                  placeholder={'[{"name":"date","type":"string","description":"Date in YYYY-MM-DD format","required":true}]'} />
              </div>
              <div className="mb-4">
                <label className="block text-xs text-gray-500 mb-1">Headers <span className="text-gray-700">(JSON object — auth, content-type, etc.)</span></label>
                <textarea value={toolForm.headers} onChange={(e) => setToolForm((f) => ({ ...f, headers: e.target.value }))} rows={2}
                  className="w-full bg-gray-950 border border-gray-700 rounded-xl px-3 py-2 text-xs text-white font-mono placeholder-gray-700 focus:outline-none focus:border-violet-600 resize-none"
                  placeholder='{"Authorization": "Bearer sk-..."}' />
              </div>
              <div className="flex items-center gap-3">
                <button onClick={saveTool} disabled={savingTool}
                  className="flex items-center gap-2 px-4 py-2 rounded-xl bg-violet-700 hover:bg-violet-600 text-white text-sm font-semibold transition-colors disabled:opacity-40">
                  {savingTool ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />} {editingTool ? 'Update Tool' : 'Create Tool'}
                </button>
                <button onClick={() => { setShowToolForm(false); setEditingTool(null); }} className="px-4 py-2 rounded-xl bg-gray-800 hover:bg-gray-700 text-gray-400 text-sm transition-colors">Cancel</button>
              </div>
            </div>
          )}
        </div>
      )}

      {activeSection === 'mcp' && (
        <div className="space-y-4">
          <div className="rounded-2xl bg-gray-900 border border-gray-800 p-5">
            <div className="flex items-center justify-between mb-4">
              <div>
                <p className="text-sm font-semibold text-white">MCP Servers</p>
                <p className="text-xs text-gray-600 mt-0.5">Connect any Model Context Protocol server. Its tools become available to the AI during every call — Stripe, Linear, GitHub, your own database, anything.</p>
              </div>
              <button onClick={() => { setMcpForm(blankMcp); setShowMcpForm(true); }}
                className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-violet-700 hover:bg-violet-600 text-white text-xs font-semibold transition-colors shrink-0">
                <Plus size={13} /> Add Server
              </button>
            </div>

            {/* Popular servers */}
            {mcpServers.length === 0 && !showMcpForm && (
              <div className="mb-4">
                <p className="text-xs font-semibold uppercase tracking-widest text-gray-500 mb-3">Popular Servers</p>
                <div className="grid grid-cols-1 gap-2">
                  {mcpPopular.slice(0, 5).map((s: any, i: number) => (
                    <button key={i} onClick={() => addPopularMcp(s)}
                      className="flex items-center gap-3 p-3 rounded-xl bg-gray-950 border border-gray-800 hover:border-violet-700 text-left transition-colors">
                      <Globe size={13} className="text-violet-400 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-semibold text-white">{s.display_name}</p>
                        <p className="text-xs text-gray-600 truncate">{s.description}</p>
                      </div>
                      <span className="text-xs text-gray-600 shrink-0">{s.transport}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Configured servers */}
            {mcpServers.map((server: any) => (
              <div key={server.id} className="mb-3 rounded-xl border border-gray-800 bg-gray-950 overflow-hidden">
                <div className="flex items-center gap-3 p-4">
                  <div className={`w-2 h-2 rounded-full shrink-0 ${server.enabled ? 'bg-emerald-400' : 'bg-gray-600'}`} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-white">{server.display_name}</span>
                      <span className={`text-xs px-1.5 py-0.5 rounded font-mono ${server.transport === 'http' ? 'bg-blue-950 text-blue-400' : 'bg-orange-950 text-orange-400'}`}>{server.transport}</span>
                      {server.tool_prefix && <span className="text-xs text-gray-600 font-mono">{server.tool_prefix}*</span>}
                    </div>
                    <p className="text-xs text-gray-600 mt-0.5 truncate">{server.url || (server.command + ' ' + (server.args || []).join(' ')).slice(0, 60)}</p>
                    {mcpTestResults[server.id] && (
                      <p className={`text-xs mt-1 ${mcpTestResults[server.id].success ? 'text-emerald-400' : 'text-red-400'}`}>
                        {mcpTestResults[server.id].success
                          ? `✓ ${mcpTestResults[server.id].tools?.length || 0} tools: ${(mcpTestResults[server.id].tools || []).slice(0, 4).join(', ')}${(mcpTestResults[server.id].tools?.length || 0) > 4 ? '…' : ''}`
                          : `✗ ${mcpTestResults[server.id].error}`}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button onClick={() => toggleMcp(server)} className={`p-1.5 rounded-lg text-xs transition-colors ${server.enabled ? 'bg-emerald-950 text-emerald-400 hover:bg-emerald-900' : 'bg-gray-800 text-gray-600 hover:bg-gray-700'}`}>
                      {server.enabled ? <Check size={12} /> : <X size={12} />}
                    </button>
                    <button onClick={() => testMcp(server.id)} disabled={mcpTesting === server.id}
                      className="flex items-center gap-1 p-1.5 rounded-lg bg-gray-800 text-gray-500 hover:text-white transition-colors disabled:opacity-40">
                      {mcpTesting === server.id ? <Loader2 size={12} className="animate-spin" /> : <TestTube size={12} />}
                    </button>
                    <button onClick={() => deleteMcp(server.id)} className="p-1.5 rounded-lg bg-gray-800 text-gray-500 hover:text-red-400 transition-colors"><Trash2 size={12} /></button>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* MCP form */}
          {showMcpForm && (
            <div className="rounded-2xl bg-gray-900 border border-violet-800/40 p-5">
              <div className="flex items-center justify-between mb-4">
                <p className="text-sm font-semibold text-white">Add MCP Server</p>
                <button onClick={() => setShowMcpForm(false)} className="p-1.5 rounded-lg hover:bg-gray-800 text-gray-500"><X size={14} /></button>
              </div>
              <div className="grid grid-cols-2 gap-3 mb-3">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Slug <span className="text-gray-700">(unique, snake_case)</span></label>
                  <input value={mcpForm.name} onChange={(e) => setMcpForm((f) => ({ ...f, name: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g,'_') }))}
                    placeholder="stripe" className="w-full bg-gray-950 border border-gray-700 rounded-xl px-3 py-2 text-sm text-white font-mono placeholder-gray-700 focus:outline-none focus:border-violet-600" />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Display Name</label>
                  <input value={mcpForm.display_name} onChange={(e) => setMcpForm((f) => ({ ...f, display_name: e.target.value }))}
                    placeholder="Stripe" className="w-full bg-gray-950 border border-gray-700 rounded-xl px-3 py-2 text-sm text-white placeholder-gray-700 focus:outline-none focus:border-violet-600" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3 mb-3">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Transport</label>
                  <select value={mcpForm.transport} onChange={(e) => setMcpForm((f) => ({ ...f, transport: e.target.value }))}
                    className="w-full bg-gray-950 border border-gray-700 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-violet-600">
                    <option value="http">HTTP / SSE</option>
                    <option value="stdio">stdio (local process)</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Tool Prefix <span className="text-gray-700">(e.g. stripe_)</span></label>
                  <input value={mcpForm.tool_prefix} onChange={(e) => setMcpForm((f) => ({ ...f, tool_prefix: e.target.value }))}
                    placeholder="stripe_" className="w-full bg-gray-950 border border-gray-700 rounded-xl px-3 py-2 text-sm text-white font-mono placeholder-gray-700 focus:outline-none focus:border-violet-600" />
                </div>
              </div>
              {mcpForm.transport === 'http' ? (
                <div className="mb-3">
                  <label className="block text-xs text-gray-500 mb-1">Server URL</label>
                  <input value={mcpForm.url} onChange={(e) => setMcpForm((f) => ({ ...f, url: e.target.value }))}
                    placeholder="https://mcp.example.com/mcp" className="w-full bg-gray-950 border border-gray-700 rounded-xl px-3 py-2 text-sm text-white font-mono placeholder-gray-700 focus:outline-none focus:border-violet-600" />
                </div>
              ) : (
                <div className="grid grid-cols-3 gap-3 mb-3">
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Command</label>
                    <input value={mcpForm.command} onChange={(e) => setMcpForm((f) => ({ ...f, command: e.target.value }))}
                      placeholder="npx" className="w-full bg-gray-950 border border-gray-700 rounded-xl px-3 py-2 text-sm text-white font-mono placeholder-gray-700 focus:outline-none focus:border-violet-600" />
                  </div>
                  <div className="col-span-2">
                    <label className="block text-xs text-gray-500 mb-1">Args <span className="text-gray-700">(JSON array)</span></label>
                    <input value={mcpForm.args} onChange={(e) => setMcpForm((f) => ({ ...f, args: e.target.value }))}
                      placeholder='["-y", "@stripe/agent-toolkit"]' className="w-full bg-gray-950 border border-gray-700 rounded-xl px-3 py-2 text-sm text-white font-mono placeholder-gray-700 focus:outline-none focus:border-violet-600" />
                  </div>
                </div>
              )}
              <div className="mb-3">
                <label className="block text-xs text-gray-500 mb-1">Environment Variables <span className="text-gray-700">(JSON object — API keys for this server)</span></label>
                <textarea value={mcpForm.env} onChange={(e) => setMcpForm((f) => ({ ...f, env: e.target.value }))} rows={2}
                  className="w-full bg-gray-950 border border-gray-700 rounded-xl px-3 py-2 text-xs text-white font-mono placeholder-gray-700 focus:outline-none focus:border-violet-600 resize-none"
                  placeholder='{"STRIPE_SECRET_KEY": "sk_live_..."}' />
              </div>
              <div className="mb-4">
                <label className="block text-xs text-gray-500 mb-1">Description</label>
                <input value={mcpForm.description} onChange={(e) => setMcpForm((f) => ({ ...f, description: e.target.value }))}
                  placeholder="What this server does" className="w-full bg-gray-950 border border-gray-700 rounded-xl px-3 py-2 text-sm text-white placeholder-gray-700 focus:outline-none focus:border-violet-600" />
              </div>
              <div className="flex items-center gap-3">
                <button onClick={saveMcp} disabled={savingMcp}
                  className="flex items-center gap-2 px-4 py-2 rounded-xl bg-violet-700 hover:bg-violet-600 text-white text-sm font-semibold transition-colors disabled:opacity-40">
                  {savingMcp ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />} Add Server
                </button>
                <button onClick={() => setShowMcpForm(false)} className="px-4 py-2 rounded-xl bg-gray-800 hover:bg-gray-700 text-gray-400 text-sm transition-colors">Cancel</button>
              </div>
            </div>
          )}
        </div>
      )}

      {activeSection === 'fields' && (
        <div className="space-y-4">
          <div className="rounded-2xl bg-gray-900 border border-gray-800 p-5">
            <p className="text-xs text-gray-600 mb-4">These fields are extracted from every call by the AI and included in webhook payloads. Add custom fields to capture industry-specific data.</p>
            <div className="space-y-2 mb-4">
              {fieldDefs.map((f) => (
                <div key={f.field_key} className="flex items-center gap-3 p-3 rounded-xl bg-gray-950 border border-gray-800">
                  <div className="flex-1">
                    <div className="text-sm text-white font-medium">{f.label}</div>
                    <div className="text-xs text-gray-600 font-mono">{f.field_key} · {f.field_type}</div>
                  </div>
                  <span className={`text-xs px-2 py-0.5 rounded-full ${f.capture_via === 'ai' ? 'bg-violet-950 text-violet-400' : 'bg-gray-800 text-gray-500'}`}>{f.capture_via}</span>
                  <button onClick={() => deleteField(f.field_key)} className="p-1.5 rounded-lg hover:bg-gray-800 text-gray-600 hover:text-red-400 transition-colors"><Trash2 size={13} /></button>
                </div>
              ))}
            </div>
            <div className="border-t border-gray-800 pt-4">
              <p className="text-xs font-semibold uppercase tracking-widest text-gray-500 mb-3">Add Custom Field</p>
              <div className="grid grid-cols-3 gap-2 mb-2">
                <input value={newField.key} onChange={(e) => setNewField((f) => ({ ...f, key: e.target.value.toLowerCase().replace(/\s+/g,'_') }))}
                  placeholder="field_key" className="bg-gray-950 border border-gray-700 rounded-xl px-3 py-2 text-sm text-white placeholder-gray-700 focus:outline-none focus:border-violet-600 transition-colors font-mono" />
                <input value={newField.label} onChange={(e) => setNewField((f) => ({ ...f, label: e.target.value }))}
                  placeholder="Display Label" className="bg-gray-950 border border-gray-700 rounded-xl px-3 py-2 text-sm text-white placeholder-gray-700 focus:outline-none focus:border-violet-600 transition-colors" />
                <select value={newField.type} onChange={(e) => setNewField((f) => ({ ...f, type: e.target.value }))}
                  className="bg-gray-950 border border-gray-700 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-violet-600 transition-colors">
                  {['text','email','phone','url','select','boolean'].map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <button onClick={addField} disabled={addingField}
                className="flex items-center gap-2 px-4 py-2 rounded-xl bg-violet-700 hover:bg-violet-600 text-white text-sm font-semibold transition-colors disabled:opacity-40">
                {addingField ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />} Add Field
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Webhook Display ───────────────────────────────────────────────────────────
function WebhookDisplay() {
  const { addToast } = useToast();
  const [urls, setUrls] = useState<{ incomingUrl: string; statusUrl: string } | null>(null);

  useEffect(() => {
    api<{ incomingUrl: string; statusUrl: string }>("/api/webhook-url")
      .then((d) => setUrls({ incomingUrl: d.incomingUrl, statusUrl: d.statusUrl }))
      .catch(() => {});
  }, []);

  const copy = (value: string, label: string) => {
    navigator.clipboard.writeText(value);
    addToast({ type: "success", message: `${label} copied!` });
  };

  return (
    <div className="rounded-2xl bg-gray-900 border border-gray-800 p-5">
      <p className="text-xs font-semibold uppercase tracking-widest text-gray-500 mb-3">Twilio Webhook URLs</p>

      <div className="space-y-3">
        <div>
          <p className="text-[11px] text-gray-600 mb-1">Voice (A call comes in)</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-xs p-3 rounded-xl bg-gray-950 border border-gray-800 text-emerald-400 overflow-x-auto font-mono">
              {urls?.incomingUrl || "Loading…"}
            </code>
            <button
              onClick={() => urls?.incomingUrl && copy(urls.incomingUrl, "Voice webhook URL")}
              className="p-3 rounded-xl bg-gray-800 border border-gray-700 text-gray-400 hover:text-white hover:border-gray-600 transition-colors shrink-0"
              disabled={!urls?.incomingUrl}
            >
              <Copy size={14} />
            </button>
          </div>
        </div>

        <div>
          <p className="text-[11px] text-gray-600 mb-1">Status callback (Call status changes)</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-xs p-3 rounded-xl bg-gray-950 border border-gray-800 text-emerald-400 overflow-x-auto font-mono">
              {urls?.statusUrl || "Loading…"}
            </code>
            <button
              onClick={() => urls?.statusUrl && copy(urls.statusUrl, "Status callback URL")}
              className="p-3 rounded-xl bg-gray-800 border border-gray-700 text-gray-400 hover:text-white hover:border-gray-600 transition-colors shrink-0"
              disabled={!urls?.statusUrl}
            >
              <Copy size={14} />
            </button>
          </div>
        </div>
      </div>

      <p className="text-xs text-gray-700 mt-3">
        Twilio Console → Phone Numbers → Your Number → Voice. Set both the incoming webhook and the status callback.
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

// ── Prospecting Page ─────────────────────────────────────────────────────────
interface Campaign {
  id: number;
  name: string;
  description?: string;
  status: "draft" | "active" | "paused" | "completed";
  agent_name: string;
  pitch_script?: string;
  target_industry?: string;
  target_location?: string;
  max_calls_per_day: number;
  call_window_start: string;
  call_window_end: string;
  total_leads: number;
  called: number;
  interested: number;
  not_interested: number;
  voicemails: number;
  created_at: string;
}

interface ProspectLead {
  id: number;
  campaign_id: number;
  business_name: string;
  phone: string;
  website?: string;
  industry?: string;
  address?: string;
  city?: string;
  state?: string;
  contact_name?: string;
  source: string;
  status: "pending" | "calling" | "interested" | "not_interested" | "voicemail" | "dnc" | "no_answer" | "callback";
  notes?: string;
  called_at?: string;
  created_at: string;
}

// ── Recovery Desk (Queue + SMS slide-over + booking windows picker) ─────────

function RecoveryDeskPage() {
  const { dark } = useTheme();
  const { addToast } = useToast();

  const [items, setItems] = useState<RecoveryQueueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<RecoveryQueueItem | null>(null);
  const [showBooking, setShowBooking] = useState(false);

  const card = dark ? "bg-gray-900 border-gray-800" : "bg-white border-gray-200";
  const muted = dark ? "text-gray-500" : "text-gray-600";

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await api<{ items?: RecoveryQueueItem[]; queue?: RecoveryQueueItem[] }>("/api/recovery/queue");
      setItems(((d as any)?.items || (d as any)?.queue || []) as any);
    } catch {
      // Fallback: derive a queue from contacts when the recovery endpoint is not available.
      try {
        const d = await api<{ contacts: Contact[] }>("/api/contacts?limit=100");
        const derived: RecoveryQueueItem[] = (d.contacts || [])
          .filter((c) => !c.do_not_call)
          .slice(0, 40)
          .map((c) => ({
            id: `contact:${c.id}`,
            call_sid: `contact:${c.id}`,
            contact_id: c.id,
            name: c.name,
            phone_number: c.phone_number,
            reason: c.open_tasks_count > 0 ? "Open task follow-up" : "Recent missed call",
            priority: c.open_tasks_count > 0 ? "high" : "medium",
            last_touch_at: c.last_seen || null,
            last_sms_preview: null,
            status: c.open_tasks_count > 0 ? "needs_reply" : "needs_booking",
          }));
        setItems(derived);
      } catch {
        setItems([]);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const filtered = items.filter((i) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return (
      (i.name || "").toLowerCase().includes(q) ||
      (i.phone_number || "").includes(q) ||
      (i.reason || "").toLowerCase().includes(q)
    );
  });

  const priColor = (p: RecoveryQueueItem["priority"]) =>
    p === "high" ? "text-red-400 bg-red-950/40 border-red-900/40"
    : p === "medium" ? "text-amber-400 bg-amber-950/30 border-amber-900/30"
    : "text-gray-400 bg-gray-950 border-gray-800";

  const statusPill = (s: RecoveryQueueItem["status"]) => {
    if (s === "needs_reply") return "text-blue-300 bg-blue-950/30 border-blue-800/30";
    if (s === "needs_booking") return "text-emerald-300 bg-emerald-950/25 border-emerald-800/25";
    if (s === "cooldown") return "text-gray-400 bg-gray-950 border-gray-800";
    return "text-gray-500 bg-gray-950 border-gray-800";
  };

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-lg font-bold">Recovery Desk</h2>
          <p className={`text-sm ${muted}`}>Work the recovery queue, send SMS follow-ups, and book a time window.</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={load}
            className={`px-3 py-2 rounded-xl text-xs border transition-colors ${dark ? "border-gray-700 text-gray-400 hover:text-white hover:border-gray-600" : "border-gray-200 text-gray-600"}`}>
            <RefreshCw size={12} className="inline mr-1" /> Refresh
          </button>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <div className="relative flex-1">
          <input value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name, phone, reason…"
            className="w-full bg-gray-900 border border-gray-800 rounded-xl px-4 py-2.5 pl-9 text-sm text-white placeholder-gray-700 focus:outline-none focus:border-violet-600 transition-colors" />
          <Filter size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-600" />
        </div>
        <span className="text-xs text-gray-600 shrink-0">{filtered.length} items</span>
      </div>

      <div className={`rounded-2xl border ${card} overflow-hidden`}>
        <div className="px-5 py-3 border-b border-gray-800 flex items-center justify-between">
          <p className="text-xs font-semibold uppercase tracking-widest text-gray-500">Recovery Queue</p>
          <p className="text-xs text-gray-700">Click an item to open SMS</p>
        </div>

        {loading ? (
          <div className="flex justify-center py-10"><Loader2 size={20} className="animate-spin text-gray-600" /></div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-14">
            <RotateCcw size={34} className="mx-auto text-gray-700 mb-3" />
            <p className="text-sm text-gray-500">Nothing in the queue</p>
            <p className="text-xs text-gray-700 mt-1">If this is unexpected, confirm your recovery endpoint or generate queue items from calls.</p>
          </div>
        ) : (
          <div className="divide-y divide-gray-800">
            {filtered.map((i) => (
              <button key={i.id}
                onClick={() => setSelected(i)}
                className="w-full text-left px-5 py-4 hover:bg-gray-900/50 transition-colors flex items-center gap-4">
                <div className={`px-2 py-1 rounded-lg text-[10px] font-bold border ${priColor(i.priority)} shrink-0`}>{i.priority.toUpperCase()}</div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-semibold text-white truncate">{i.name || fmt.phone(i.phone_number)}</p>
                    <span className={`text-[10px] px-2 py-0.5 rounded-full border ${statusPill(i.status)}`}>{i.status.replace(/_/g, " ")}</span>
                  </div>
                  <p className="text-xs text-gray-600 truncate mt-0.5">{i.reason}{i.last_sms_preview ? ` · “${i.last_sms_preview}”` : ""}</p>
                </div>
                <div className="text-right shrink-0">
                  <p className="text-xs text-gray-600">{i.last_touch_at ? fmt.date(i.last_touch_at) : "—"}</p>
                  <p className="text-xs text-gray-700 font-mono">{fmt.phone(i.phone_number)}</p>
                </div>
                <ChevronRight size={14} className="text-gray-700" />
              </button>
            ))}
          </div>
        )}
      </div>

      {selected && (
        <SmsDetailPanel
          item={selected}
          onClose={() => setSelected(null)}
          onBook={() => setShowBooking(true)}
          onUpdated={() => {
            addToast({ type: "success", message: "Updated" });
            load();
          }}
        />
      )}

      {selected && showBooking && (
        <BookingWindowsPicker
          contactId={selected.contact_id}
          contactName={selected.name || fmt.phone(selected.phone_number)}
          onClose={() => setShowBooking(false)}
          onConfirm={async (w) => {
            try {
              await api("/api/recovery/book", { method: "POST", body: JSON.stringify({ call_sid: selected.call_sid, contact_id: selected.contact_id, window: w }) });
              addToast({ type: "success", message: "Booking queued" });
            } catch {
              addToast({ type: "info", message: "Booked (stub). Wire /api/recovery/book to persist." });
            } finally {
              setShowBooking(false);
              load();
            }
          }}
        />
      )}
    </div>
  );
}

function SmsDetailPanel({
  item,
  onClose,
  onBook,
  onUpdated,
}: {
  item: RecoveryQueueItem;
  onClose: () => void;
  onBook: () => void;
  onUpdated: () => void;
}) {
  const { dark } = useTheme();
  const { addToast } = useToast();
  const [sms, setSms] = useState<any[]>([]);
  const [smsLoading, setSmsLoading] = useState(false);
  const [smsBody, setSmsBody] = useState("");
  const [sending, setSending] = useState(false);
  const [contact, setContact] = useState<any>(null);

  const loadSms = useCallback(async () => {
    setSmsLoading(true);
    try {
      const d = await api<{ messages: any[] }>(`/api/contacts/${item.contact_id}/sms?limit=200`);
      setSms((d as any)?.messages || []);
    } catch {
      setSms([]);
    } finally {
      setSmsLoading(false);
    }
  }, [item.contact_id]);

  useEffect(() => {
    api<any>(`/api/contacts/${item.contact_id}/detail`).then((d) => setContact(d?.contact)).catch(() => {});
    loadSms();
  }, [item.contact_id, loadSms]);

  const send = async () => {
    const text = smsBody.trim();
    if (!text || sending) return;
    setSending(true);
    setSmsBody("");
    try {
      await api(`/api/contacts/${item.contact_id}/sms`, { method: "POST", body: JSON.stringify({ body: text }) });
      addToast({ type: "success", message: "SMS sent" });
      await loadSms();
      onUpdated();
    } catch (e: any) {
      addToast({ type: "error", message: e?.message || "Failed to send SMS" });
      setSmsBody(text);
    } finally {
      setSending(false);
    }
  };

  const textBack = async () => {
    try {
      await api(`/api/recovery/${encodeURIComponent(item.call_sid)}/text-back`, { method: "POST" });
      addToast({ type: "success", message: "Text-back sent" });
      await loadSms();
      onUpdated();
    } catch (e: any) {
      addToast({ type: "error", message: e?.message || "Text-back failed" });
    }
  };

  const callBack = async () => {
    try {
      await api(`/api/recovery/${encodeURIComponent(item.call_sid)}/call-back`, { method: "POST" });
      addToast({ type: "success", message: "Callback started" });
      onUpdated();
    } catch (e: any) {
      addToast({ type: "error", message: e?.message || "Callback failed" });
    }
  };

  const closeRecovery = async () => {
    try {
      await api(`/api/recovery/${encodeURIComponent(item.call_sid)}/close`, { method: "POST" });
      addToast({ type: "success", message: "Closed" });
      onUpdated();
      onClose();
    } catch (e: any) {
      addToast({ type: "error", message: e?.message || "Close failed" });
    }
  };

  const card = dark ? "bg-gray-950 border-gray-800" : "bg-white border-gray-200";

  return (
    <div className="fixed inset-0 z-50" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        className={`absolute right-0 top-0 h-full w-full max-w-xl border-l ${card} shadow-2xl flex flex-col`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-5 border-b border-gray-800 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs text-gray-500 uppercase tracking-widest font-semibold">SMS Detail</p>
            <h3 className="text-base font-bold text-white truncate">{contact?.name || item.name || fmt.phone(item.phone_number)}</h3>
            <p className="text-xs text-gray-600 font-mono truncate">{fmt.phone(item.phone_number)}</p>
            <p className="text-xs text-gray-700 mt-1 truncate">{item.reason}</p>
          </div>
          <div className="flex items-center gap-2 shrink-0 flex-wrap justify-end">
            <button
              onClick={textBack}
              className="px-3 py-2 rounded-xl bg-blue-800 hover:bg-blue-700 text-white text-xs font-semibold transition-colors"
              title="Send the default missed-call text-back"
            >
              <MessageSquare size={12} className="inline mr-1" /> Text-back
            </button>
            <button
              onClick={callBack}
              className="px-3 py-2 rounded-xl bg-violet-700 hover:bg-violet-600 text-white text-xs font-semibold transition-colors"
              title="Start an outbound callback"
            >
              <PhoneForwarded size={12} className="inline mr-1" /> Call back
            </button>
            <button
              onClick={onBook}
              className="px-3 py-2 rounded-xl bg-emerald-700 hover:bg-emerald-600 text-white text-xs font-semibold transition-colors"
              title="Send available windows"
            >
              <Calendar size={12} className="inline mr-1" /> Book window
            </button>
            <button
              onClick={closeRecovery}
              className="px-3 py-2 rounded-xl bg-gray-800 hover:bg-gray-700 text-gray-200 text-xs font-semibold transition-colors"
              title="Remove from recovery queue"
            >
              <CheckCircle2 size={12} className="inline mr-1" /> Close
            </button>
            <button onClick={onClose} className="p-2 rounded-lg hover:bg-gray-900 text-gray-500 hover:text-white transition-colors"><X size={18} /></button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          <div className="flex items-center justify-between mb-3">
            <p className="text-xs font-semibold uppercase tracking-widest text-gray-500">Thread</p>
            <button onClick={loadSms} disabled={smsLoading}
              className="text-xs text-violet-400 hover:text-violet-300 flex items-center gap-1">
              <RefreshCw size={12} className={smsLoading ? "animate-spin" : ""} /> Refresh
            </button>
          </div>
          <div className="rounded-xl bg-gray-900 border border-gray-800 p-3 space-y-2">
            {smsLoading ? (
              <div className="flex justify-center py-8"><Loader2 size={18} className="animate-spin text-gray-600" /></div>
            ) : sms.length === 0 ? (
              <p className="text-sm text-gray-600 text-center py-8">No SMS messages yet.</p>
            ) : (
              [...sms].reverse().map((m) => (
                <div key={m.id} className={`flex ${m.direction === "outbound" ? "justify-end" : "justify-start"}`}>
                  <div className={`max-w-[85%] px-3 py-2 rounded-2xl text-sm border ${
                    m.direction === "outbound"
                      ? "bg-violet-900/40 border-violet-800/40 text-violet-100 rounded-br-sm"
                      : "bg-gray-800 border-gray-700 text-gray-200 rounded-bl-sm"
                  }`}>
                    <div className="flex items-center justify-between gap-3 mb-1">
                      <span className="text-[10px] font-semibold uppercase tracking-wider opacity-60">
                        {m.direction === "outbound" ? "You" : "Contact"}
                      </span>
                      <span className="text-[10px] text-gray-500 shrink-0">{new Date(m.created_at).toLocaleString()}</span>
                    </div>
                    <div className="whitespace-pre-wrap break-words">{m.body}</div>
                    {(m.status || m.error_message) && (
                      <div className={`text-[10px] mt-1 ${m.error_message ? "text-red-400" : "text-gray-500"}`}>
                        {m.error_message ? `Error: ${m.error_message}` : `Status: ${m.status}`}
                      </div>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="p-5 border-t border-gray-800 space-y-2">
          <div className="flex flex-wrap gap-2">
            {[
              "Quick check-in: do you still need help getting scheduled?",
              "We can get you in a window today, what time works best?",
              "If you share the address and what’s going on, I’ll line up the right crew.",
            ].map((t) => (
              <button key={t} onClick={() => setSmsBody(t)}
                className="text-xs px-2.5 py-1.5 rounded-lg bg-gray-900 border border-gray-800 text-gray-400 hover:text-white hover:border-gray-700 transition-colors">
                {t}
              </button>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              value={smsBody}
              onChange={(e) => setSmsBody(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && send()}
              placeholder="Type an SMS…"
              className="flex-1 bg-gray-900 border border-gray-800 rounded-xl px-3 py-2.5 text-sm text-white placeholder-gray-700 focus:outline-none focus:border-violet-600"
            />
            <button
              onClick={send}
              disabled={sending || !smsBody.trim()}
              className="px-4 py-2.5 rounded-xl bg-violet-700 hover:bg-violet-600 disabled:opacity-50 text-white text-sm font-semibold flex items-center gap-2"
            >
              {sending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
              Send
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function BookingWindowsPicker({
  contactId,
  contactName,
  onClose,
  onConfirm,
}: {
  contactId: number;
  contactName: string;
  onClose: () => void;
  onConfirm: (w: BookingWindow) => void;
}) {
  const { dark } = useTheme();
  const { addToast } = useToast();
  const [windows, setWindows] = useState<BookingWindow[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string>("");

  useEffect(() => {
    const run = async () => {
      setLoading(true);
      try {
        const d = await api<{ windows: BookingWindow[] }>(`/api/recovery/booking-windows?contact_id=${contactId}&days=7`);
        setWindows((d as any)?.windows || []);
      } catch {
        const out: BookingWindow[] = [];
        const now = new Date();
        let addedDays = 0;
        for (let i = 0; i < 14 && addedDays < 5; i++) {
          const d = new Date(now);
          d.setDate(now.getDate() + i);
          const day = d.getDay();
          if (day === 0 || day === 6) continue;
          addedDays++;
          const start1 = new Date(d); start1.setHours(10, 0, 0, 0);
          const end1 = new Date(d); end1.setHours(12, 0, 0, 0);
          const start2 = new Date(d); start2.setHours(13, 0, 0, 0);
          const end2 = new Date(d); end2.setHours(16, 0, 0, 0);
          out.push({ id: `${contactId}:${start1.toISOString()}`, start: start1.toISOString(), end: end1.toISOString(), label: "AM" });
          out.push({ id: `${contactId}:${start2.toISOString()}`, start: start2.toISOString(), end: end2.toISOString(), label: "PM" });
        }
        setWindows(out);
      } finally {
        setLoading(false);
      }
    };
    run();
  }, [contactId]);

  const grouped = windows.reduce<Record<string, BookingWindow[]>>((acc, w) => {
    const k = new Date(w.start).toDateString();
    (acc[k] ||= []).push(w);
    return acc;
  }, {});

  const keys = Object.keys(grouped);
  const card = dark ? "bg-gray-950 border-gray-800" : "bg-white border-gray-200";

  const chosen = windows.find((w) => w.id === selected);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm" onClick={onClose}>
      <div className={`w-full max-w-2xl rounded-2xl border ${card} shadow-2xl overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        <div className="p-5 border-b border-gray-800 flex items-center justify-between">
          <div>
            <p className="text-xs text-gray-500 uppercase tracking-widest font-semibold">Booking windows</p>
            <h3 className="text-base font-bold text-white">Pick a time for {contactName}</h3>
          </div>
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-gray-900 text-gray-500 hover:text-white transition-colors"><X size={18} /></button>
        </div>

        <div className="p-5">
          {loading ? (
            <div className="flex justify-center py-10"><Loader2 size={20} className="animate-spin text-gray-600" /></div>
          ) : keys.length === 0 ? (
            <div className="text-center py-10">
              <Calendar size={30} className="mx-auto text-gray-700 mb-3" />
              <p className="text-sm text-gray-500">No windows available</p>
              <p className="text-xs text-gray-700 mt-1">Wire /api/recovery/booking-windows to your scheduler to populate this list.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {keys.map((k) => (
                <div key={k} className="rounded-xl bg-gray-900 border border-gray-800 p-4">
                  <p className="text-xs font-semibold uppercase tracking-widest text-gray-500">{k}</p>
                  <div className="mt-3 space-y-2">
                    {grouped[k]
                      .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime())
                      .map((w) => {
                        const start = new Date(w.start);
                        const end = new Date(w.end);
                        const isSel = selected === w.id;
                        return (
                          <button
                            key={w.id}
                            onClick={() => setSelected(w.id)}
                            className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl border text-sm transition-colors ${
                              isSel
                                ? "bg-violet-950/30 border-violet-700/50 text-violet-200"
                                : "bg-gray-950 border-gray-800 text-gray-300 hover:border-gray-700"
                            }`}
                          >
                            <span className="font-medium">{start.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}–{end.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
                            <span className="text-xs text-gray-600">{w.label || "Window"}</span>
                          </button>
                        );
                      })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="p-5 border-t border-gray-800 flex items-center justify-between">
          <div className="text-xs text-gray-600">
            {chosen ? (
              <span>Selected: <span className="text-gray-300 font-mono">{new Date(chosen.start).toLocaleString()}</span></span>
            ) : (
              <span>Select a window to continue</span>
            )}
          </div>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-4 py-2 rounded-xl border border-gray-800 text-gray-400 text-sm hover:text-white hover:border-gray-700 transition-colors">Cancel</button>
            <button
              onClick={() => {
                if (!chosen) return addToast({ type: "warning", message: "Pick a window first" });
                onConfirm(chosen);
              }}
              disabled={!chosen}
              className="px-4 py-2 rounded-xl bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 text-white text-sm font-semibold transition-colors"
            >
              Confirm
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ProspectingPage() {
  const { dark } = useTheme();
  const { addToast } = useToast();
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [selectedCampaign, setSelectedCampaign] = useState<Campaign | null>(null);
  const [leads, setLeads] = useState<ProspectLead[]>([]);
  const [loading, setLoading] = useState(true);
  const [leadsLoading, setLeadsLoading] = useState(false);
  const [dialing, setDialing] = useState(false);
  const [showNewCampaign, setShowNewCampaign] = useState(false);
  const [showScriptEditor, setShowScriptEditor] = useState(false);
  const [showLeadImport, setShowLeadImport] = useState(false);
  const [newCampaign, setNewCampaign] = useState({ name: "", target_industry: "", target_location: "", agent_name: "FORGE", max_calls_per_day: 50, call_window_start: "09:00", call_window_end: "17:00" });
  const [searchQuery, setSearchQuery] = useState("");
  const [searchLoading, setSearchLoading] = useState(false);
  const [csvText, setCsvText] = useState("");
  const [manualLeads, setManualLeads] = useState("");

  const card = dark ? "bg-gray-900 border-gray-800" : "bg-white border-gray-200";
  const muted = dark ? "text-gray-500" : "text-gray-500";
  const sub = dark ? "text-gray-400" : "text-gray-600";

  const loadCampaigns = () => {
    api<{ campaigns: Campaign[] }>("/api/prospecting/campaigns")
      .then((d) => setCampaigns(d.campaigns || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => { loadCampaigns(); }, []);

  const loadLeads = (cid: number) => {
    setLeadsLoading(true);
    api<{ leads: ProspectLead[] }>(`/api/prospecting/campaigns/${cid}`)
      .then((d) => setLeads((d as any).leads || []))
      .catch(() => {})
      .finally(() => setLeadsLoading(false));
  };

  const selectCampaign = (c: Campaign) => {
    setSelectedCampaign(c);
    loadLeads(c.id);
  };

  const createCampaign = async () => {
    if (!newCampaign.name.trim()) return;
    try {
      await api("/api/prospecting/campaigns", { method: "POST", body: JSON.stringify(newCampaign) });
      addToast({ type: "success", message: "Campaign created" });
      setShowNewCampaign(false);
      setNewCampaign({ name: "", target_industry: "", target_location: "", agent_name: "FORGE", max_calls_per_day: 50, call_window_start: "09:00", call_window_end: "17:00" });
      loadCampaigns();
    } catch { addToast({ type: "error", message: "Failed to create campaign" }); }
  };

  const setStatus = async (status: Campaign["status"]) => {
    if (!selectedCampaign) return;
    await api(`/api/prospecting/campaigns/${selectedCampaign.id}/status`, { method: "PATCH", body: JSON.stringify({ status }) });
    setSelectedCampaign({ ...selectedCampaign, status });
    loadCampaigns();
  };

  const dialNext = async () => {
    if (!selectedCampaign) return;
    setDialing(true);
    try {
      const r = await api<{ call_sid: string; lead: ProspectLead }>(`/api/prospecting/campaigns/${selectedCampaign.id}/dial-next`, { method: "POST" });
      addToast({ type: "success", message: `Dialing ${r.lead.business_name}…` });
      loadLeads(selectedCampaign.id);
      loadCampaigns();
    } catch (e: any) {
      addToast({ type: "error", message: e.message || "Dial failed" });
    } finally { setDialing(false); }
  };

  const searchLeads = async () => {
    if (!selectedCampaign || !searchQuery.trim()) return;
    setSearchLoading(true);
    try {
      const r = await api<{ found: number; added: number }>(`/api/prospecting/campaigns/${selectedCampaign.id}/search`, {
        method: "POST",
        body: JSON.stringify({ query: searchQuery, maxResults: 20 }),
      });
      addToast({ type: "success", message: `Found ${r.found} businesses, added ${r.added} new leads` });
      loadLeads(selectedCampaign.id);
      loadCampaigns();
    } catch (e: any) {
      const raw = String(e?.message || "");
      const msg = raw.toLowerCase().includes("legacy api")
        ? "Lead search failed: this campaign is still hitting a legacy Places path. Refresh and retry; if it persists, redeploy latest build."
        : raw.toLowerCase().includes("google_places_api_key")
          ? "Lead search failed: add GOOGLE_PLACES_API_KEY in Settings."
          : raw || "Lead search failed. Check Settings → Lead Source and try again.";
      addToast({ type: "error", message: msg });
    } finally { setSearchLoading(false); }
  };

  const importLeads = async () => {
    if (!selectedCampaign) return;
    try {
      const r = await api<{ added: number }>(`/api/prospecting/campaigns/${selectedCampaign.id}/leads`, {
        method: "POST",
        body: JSON.stringify({ csv: csvText || undefined, leads: manualLeads ? manualLeads.split("\n").filter(Boolean).map((line) => { const [business_name, phone] = line.split(","); return { business_name: business_name?.trim(), phone: phone?.trim(), source: "manual" }; }) : undefined }),
      });
      addToast({ type: "success", message: `Added ${r.added} leads` });
      setShowLeadImport(false);
      setCsvText(""); setManualLeads("");
      loadLeads(selectedCampaign.id);
      loadCampaigns();
    } catch { addToast({ type: "error", message: "Import failed" }); }
  };

  const statusColor: Record<string, string> = {
    pending: "text-gray-400",
    calling: "text-blue-400 animate-pulse",
    interested: "text-emerald-400",
    not_interested: "text-red-400",
    voicemail: "text-amber-400",
    dnc: "text-red-600",
    no_answer: "text-gray-500",
    callback: "text-violet-400",
  };

  const statusLabel: Record<string, string> = {
    pending: "Pending", calling: "Calling…", interested: "Interested",
    not_interested: "Not Interested", voicemail: "Voicemail", dnc: "DNC",
    no_answer: "No Answer", callback: "Callback",
  };

  const campaignStatusColor: Record<string, string> = {
    draft: "text-gray-400 bg-gray-800",
    active: "text-emerald-400 bg-emerald-950",
    paused: "text-amber-400 bg-amber-950",
    completed: "text-blue-400 bg-blue-950",
  };

  const pendingCount = leads.filter((l) => l.status === "pending").length;
  const interestedCount = leads.filter((l) => l.status === "interested").length;
  const calledCount = leads.filter((l) => l.status !== "pending").length;
  const convRate = calledCount > 0 ? Math.round((interestedCount / calledCount) * 100) : 0;

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold">Database Reactivation</h2>
          <p className={`text-sm ${muted}`}>Upload old leads, auto-dial with a personalized pitch, and book appointments from your existing database</p>
        </div>
        <button onClick={() => setShowNewCampaign(true)}
          className="flex items-center gap-2 px-4 py-2 rounded-xl bg-violet-700 hover:bg-violet-600 text-white text-sm font-semibold transition-colors">
          <Plus size={14} /> New Campaign
        </button>
      </div>

      {/* Compliance notice */}
      <div className="flex items-start gap-3 p-4 rounded-xl border border-amber-800/50 bg-amber-950/20">
        <AlertTriangle size={16} className="text-amber-400 shrink-0 mt-0.5" />
        <div className="text-xs text-amber-300/80">
          <span className="font-semibold text-amber-300">TCPA Compliance Required</span> — Only call businesses that have not requested removal. DNC status is enforced across all campaigns. Calls are limited to business hours in the lead's timezone. Recording disclosures are played automatically where required.
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Campaign List */}
        <div className="space-y-3">
          <h3 className={`text-xs font-semibold uppercase tracking-widest ${muted}`}>Campaigns ({campaigns.length})</h3>
          {loading ? (
            <div className="flex justify-center py-8"><Loader2 size={20} className="animate-spin text-gray-600" /></div>
          ) : campaigns.length === 0 ? (
            <div className={`rounded-2xl border ${card} p-8 text-center`}>
              <PhoneOutgoing size={32} className="mx-auto mb-3 text-gray-700" />
              <p className={`text-sm ${muted}`}>No campaigns yet</p>
              <button onClick={() => setShowNewCampaign(true)} className="mt-3 text-xs text-violet-400 hover:text-violet-300">Create your first campaign →</button>
            </div>
          ) : (
            campaigns.map((c) => (
              <button key={c.id} onClick={() => selectCampaign(c)}
                className={`w-full text-left rounded-2xl border p-4 transition-all ${
                  selectedCampaign?.id === c.id
                    ? "border-violet-700/60 bg-violet-950/20"
                    : `${card} hover:border-gray-700`
                }`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold truncate">{c.name}</p>
                    <p className={`text-xs ${muted} truncate`}>{c.target_industry || "General"}{c.target_location ? ` · ${c.target_location}` : ""}</p>
                  </div>
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full shrink-0 ${campaignStatusColor[c.status]}`}>
                    {c.status.toUpperCase()}
                  </span>
                </div>
                <div className="mt-3 grid grid-cols-4 gap-1 text-center">
                  {[{label: "Leads", val: c.total_leads}, {label: "Called", val: c.called}, {label: "Interest", val: c.interested}, {label: "VM", val: c.voicemails}].map((s) => (
                    <div key={s.label}>
                      <p className="text-sm font-bold">{s.val}</p>
                      <p className={`text-[10px] ${muted}`}>{s.label}</p>
                    </div>
                  ))}
                </div>
              </button>
            ))
          )}
        </div>

        {/* Campaign Detail */}
        <div className="lg:col-span-2 space-y-4">
          {!selectedCampaign ? (
            <div className={`rounded-2xl border ${card} p-16 text-center`}>
              <PhoneOutgoing size={40} className="mx-auto mb-4 text-gray-700" />
              <p className={`text-sm ${muted}`}>Select a campaign to view leads and dial</p>
            </div>
          ) : (
            <>
              {/* Campaign header */}
              <div className={`rounded-2xl border ${card} p-5`}>
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h3 className="text-base font-bold">{selectedCampaign.name}</h3>
                    <p className={`text-xs ${muted} mt-0.5`}>
                      Agent: <span className="text-violet-400 font-semibold">{selectedCampaign.agent_name}</span>
                      {" · "}{selectedCampaign.call_window_start}–{selectedCampaign.call_window_end}
                      {" · "}{selectedCampaign.max_calls_per_day} calls/day max
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button onClick={() => setShowScriptEditor(true)}
                      className={`px-3 py-1.5 rounded-lg text-xs border ${dark ? "border-gray-700 text-gray-400 hover:text-white hover:border-gray-600" : "border-gray-200 text-gray-600 hover:border-gray-300"} transition-colors`}>
                      <Pencil size={12} className="inline mr-1" />Script
                    </button>
                    {selectedCampaign.status === "active" ? (
                      <button onClick={() => setStatus("paused")}
                        className="px-3 py-1.5 rounded-lg text-xs bg-amber-900/40 border border-amber-700/50 text-amber-300 hover:bg-amber-900/60 transition-colors">
                        Pause
                      </button>
                    ) : (
                      <button onClick={() => setStatus("active")}
                        className="px-3 py-1.5 rounded-lg text-xs bg-emerald-900/40 border border-emerald-700/50 text-emerald-300 hover:bg-emerald-900/60 transition-colors">
                        Activate
                      </button>
                    )}
                  </div>
                </div>

                {/* Stats row */}
                <div className="mt-4 grid grid-cols-5 gap-3">
                  {[
                    { label: "Total Leads", val: selectedCampaign.total_leads, color: "text-white" },
                    { label: "Pending", val: pendingCount, color: "text-gray-400" },
                    { label: "Called", val: calledCount, color: "text-blue-400" },
                    { label: "Interested", val: interestedCount, color: "text-emerald-400" },
                    { label: "Conv. Rate", val: `${convRate}%`, color: convRate > 10 ? "text-emerald-400" : "text-amber-400" },
                  ].map((s) => (
                    <div key={s.label} className={`rounded-xl p-3 text-center ${dark ? "bg-gray-950" : "bg-gray-50"}`}>
                      <p className={`text-lg font-bold ${s.color}`}>{s.val}</p>
                      <p className={`text-[10px] ${muted}`}>{s.label}</p>
                    </div>
                  ))}
                </div>

                {/* Actions */}
                <div className="mt-4 flex items-center gap-2">
                  <button onClick={dialNext} disabled={dialing || pendingCount === 0}
                    className="flex items-center gap-2 px-4 py-2 rounded-xl bg-violet-700 hover:bg-violet-600 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-semibold transition-colors">
                    {dialing ? <Loader2 size={14} className="animate-spin" /> : <PhoneOutgoing size={14} />}
                    {dialing ? "Dialing…" : `Dial Next (${pendingCount} pending)`}
                  </button>
                  <button onClick={() => setShowLeadImport(true)}
                    className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm border transition-colors ${
                      dark ? "border-gray-700 text-gray-400 hover:text-white hover:border-gray-600" : "border-gray-200 text-gray-600"
                    }`}>
                    <Plus size={14} /> Add Leads
                  </button>
                </div>

                {/* Google Places search */}
                <div className="mt-3 flex items-center gap-2">
                  <input
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && searchLeads()}
                    placeholder='Search Google Places: "plumbers in Miami FL"'
                    className={`flex-1 px-3 py-2 rounded-xl text-xs border ${
                      dark ? "bg-gray-950 border-gray-800 text-white placeholder-gray-600" : "bg-gray-50 border-gray-200"
                    }`}
                  />
                  <button onClick={searchLeads} disabled={searchLoading || !searchQuery.trim()}
                    className="px-3 py-2 rounded-xl bg-blue-800 hover:bg-blue-700 disabled:opacity-40 text-white text-xs font-semibold transition-colors">
                    {searchLoading ? <Loader2 size={12} className="animate-spin" /> : "Find"}
                  </button>
                </div>
              </div>

              {/* Leads table */}
              <div className={`rounded-2xl border ${card} overflow-hidden`}>
                <div className="px-4 py-3 border-b border-gray-800 flex items-center justify-between">
                  <h4 className={`text-xs font-semibold uppercase tracking-widest ${muted}`}>Leads ({leads.length})</h4>
                  <button onClick={() => loadLeads(selectedCampaign.id)}
                    className={`p-1.5 rounded-lg transition-colors ${dark ? "text-gray-600 hover:text-gray-400 hover:bg-gray-800" : "text-gray-400 hover:bg-gray-100"}`}>
                    <RefreshCw size={12} />
                  </button>
                </div>
                {leadsLoading ? (
                  <div className="flex justify-center py-10"><Loader2 size={20} className="animate-spin text-gray-600" /></div>
                ) : leads.length === 0 ? (
                  <div className="text-center py-10">
                    <p className={`text-sm ${muted}`}>No leads yet — use the search above or import a CSV</p>
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className={`border-b ${dark ? "border-gray-800 bg-gray-900/50" : "border-gray-100 bg-gray-50"}`}>
                          {["Business", "Phone", "Industry", "Source", "Status", "Called"].map((h) => (
                            <th key={h} className={`text-left px-4 py-2.5 font-semibold uppercase tracking-wider ${muted}`}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {leads.map((l, i) => (
                          <tr key={l.id} className={`border-b transition-colors ${
                            dark ? `border-gray-800/50 ${i % 2 === 0 ? "bg-gray-950" : "bg-gray-900/20"} hover:bg-gray-900/50`
                                 : `border-gray-100 hover:bg-gray-50`
                          }`}>
                            <td className="px-4 py-2.5">
                              <p className="font-semibold truncate max-w-[140px]">{l.business_name}</p>
                              {l.contact_name && <p className={`text-[10px] ${muted}`}>{l.contact_name}</p>}
                            </td>
                            <td className={`px-4 py-2.5 font-mono ${sub}`}>{l.phone}</td>
                            <td className={`px-4 py-2.5 ${muted} capitalize`}>{l.industry?.replace(/_/g, " ") || "—"}</td>
                            <td className={`px-4 py-2.5 ${muted}`}>
                              <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                                l.source === "google_places" ? "bg-blue-950 text-blue-300" :
                                l.source === "csv" ? "bg-gray-800 text-gray-400" : "bg-gray-800 text-gray-500"
                              }`}>{l.source.replace(/_/g, " ")}</span>
                            </td>
                            <td className={`px-4 py-2.5 font-semibold ${statusColor[l.status] || "text-gray-400"}`}>
                              {statusLabel[l.status] || l.status}
                            </td>
                            <td className={`px-4 py-2.5 ${muted}`}>{l.called_at ? fmt.date(l.called_at) : "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* New Campaign Modal */}
      {showNewCampaign && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
          <div className={`w-full max-w-md rounded-2xl border ${card} p-6 space-y-4`}>
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold">New Campaign</h3>
              <button onClick={() => setShowNewCampaign(false)} className={`p-1.5 rounded-lg ${dark ? "hover:bg-gray-800" : "hover:bg-gray-100"}`}><X size={16} /></button>
            </div>
            {[
              { label: "Campaign Name", key: "name", placeholder: "Miami Plumbers Q2" },
              { label: "Target Industry", key: "target_industry", placeholder: "plumbing, dental, restaurant…" },
              { label: "Target Location", key: "target_location", placeholder: "Miami, FL" },
            ].map(({ label, key, placeholder }) => (
              <div key={key}>
                <label className={`block text-xs font-semibold mb-1 ${muted}`}>{label}</label>
                <input value={(newCampaign as any)[key]} onChange={(e) => setNewCampaign((p) => ({ ...p, [key]: e.target.value }))}
                  placeholder={placeholder}
                  className={`w-full px-3 py-2 rounded-xl text-sm border ${
                    dark ? "bg-gray-950 border-gray-800 text-white placeholder-gray-600" : "bg-gray-50 border-gray-200"
                  }`} />
              </div>
            ))}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={`block text-xs font-semibold mb-1 ${muted}`}>Agent</label>
                <select value={newCampaign.agent_name} onChange={(e) => setNewCampaign((p) => ({ ...p, agent_name: e.target.value }))}
                  className={`w-full px-3 py-2 rounded-xl text-sm border ${
                    dark ? "bg-gray-950 border-gray-800 text-white" : "bg-gray-50 border-gray-200"
                  }`}>
                  {["SMIRK","FORGE","GRIT","LEX","VELVET","LEDGER","HAVEN","ATLAS","ECHO"].map((a) => (
                    <option key={a} value={a}>{a}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className={`block text-xs font-semibold mb-1 ${muted}`}>Max Calls/Day</label>
                <input type="number" value={newCampaign.max_calls_per_day} onChange={(e) => setNewCampaign((p) => ({ ...p, max_calls_per_day: parseInt(e.target.value) || 50 }))}
                  className={`w-full px-3 py-2 rounded-xl text-sm border ${
                    dark ? "bg-gray-950 border-gray-800 text-white" : "bg-gray-50 border-gray-200"
                  }`} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={`block text-xs font-semibold mb-1 ${muted}`}>Call Window Start</label>
                <input type="time" value={newCampaign.call_window_start} onChange={(e) => setNewCampaign((p) => ({ ...p, call_window_start: e.target.value }))}
                  className={`w-full px-3 py-2 rounded-xl text-sm border ${
                    dark ? "bg-gray-950 border-gray-800 text-white" : "bg-gray-50 border-gray-200"
                  }`} />
              </div>
              <div>
                <label className={`block text-xs font-semibold mb-1 ${muted}`}>Call Window End</label>
                <input type="time" value={newCampaign.call_window_end} onChange={(e) => setNewCampaign((p) => ({ ...p, call_window_end: e.target.value }))}
                  className={`w-full px-3 py-2 rounded-xl text-sm border ${
                    dark ? "bg-gray-950 border-gray-800 text-white" : "bg-gray-50 border-gray-200"
                  }`} />
              </div>
            </div>
            <div className="flex gap-2 pt-2">
              <button onClick={() => setShowNewCampaign(false)} className={`flex-1 py-2 rounded-xl text-sm border transition-colors ${
                dark ? "border-gray-700 text-gray-400 hover:text-white" : "border-gray-200 text-gray-600"
              }`}>Cancel</button>
              <button onClick={createCampaign} disabled={!newCampaign.name.trim()}
                className="flex-1 py-2 rounded-xl text-sm bg-violet-700 hover:bg-violet-600 disabled:opacity-40 text-white font-semibold transition-colors">
                Create Campaign
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Script Editor Modal */}
      {showScriptEditor && selectedCampaign && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
          <div className={`w-full max-w-2xl rounded-2xl border ${card} p-6 space-y-4`}>
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold">Pitch Script — {selectedCampaign.name}</h3>
              <button onClick={() => setShowScriptEditor(false)} className={`p-1.5 rounded-lg ${dark ? "hover:bg-gray-800" : "hover:bg-gray-100"}`}><X size={16} /></button>
            </div>
            <p className={`text-xs ${muted}`}>This is the system prompt the agent uses during outbound calls. Leave blank to use the default SMIRK pitch.</p>
            <textarea
              defaultValue={selectedCampaign.pitch_script || ""}
              id="pitch-script-textarea"
              rows={12}
              className={`w-full px-3 py-2 rounded-xl text-xs font-mono border resize-none ${
                dark ? "bg-gray-950 border-gray-800 text-white placeholder-gray-600" : "bg-gray-50 border-gray-200"
              }`}
              placeholder="Leave blank to use the default SMIRK pitch agent script…"
            />
            <div className="flex gap-2">
              <button onClick={() => setShowScriptEditor(false)} className={`flex-1 py-2 rounded-xl text-sm border transition-colors ${
                dark ? "border-gray-700 text-gray-400 hover:text-white" : "border-gray-200 text-gray-600"
              }`}>Cancel</button>
              <button onClick={async () => {
                const script = (document.getElementById("pitch-script-textarea") as HTMLTextAreaElement)?.value || "";
                await api(`/api/prospecting/campaigns/${selectedCampaign.id}/status`, { method: "PATCH", body: JSON.stringify({ status: selectedCampaign.status }) });
                addToast({ type: "success", message: "Script saved" });
                setShowScriptEditor(false);
              }} className="flex-1 py-2 rounded-xl text-sm bg-violet-700 hover:bg-violet-600 text-white font-semibold transition-colors">
                Save Script
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Lead Import Modal */}
      {showLeadImport && selectedCampaign && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
          <div className={`w-full max-w-lg rounded-2xl border ${card} p-6 space-y-4`}>
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold">Add Leads — {selectedCampaign.name}</h3>
              <button onClick={() => setShowLeadImport(false)} className={`p-1.5 rounded-lg ${dark ? "hover:bg-gray-800" : "hover:bg-gray-100"}`}><X size={16} /></button>
            </div>
            <div className="space-y-3">
              <div>
                <label className={`block text-xs font-semibold mb-1 ${muted}`}>Manual Entry (one per line: Business Name, Phone)</label>
                <textarea value={manualLeads} onChange={(e) => setManualLeads(e.target.value)} rows={4}
                  placeholder={"Acme Plumbing, 3055551234\nBest Dental, 3055559876"}
                  className={`w-full px-3 py-2 rounded-xl text-xs font-mono border resize-none ${
                    dark ? "bg-gray-950 border-gray-800 text-white placeholder-gray-600" : "bg-gray-50 border-gray-200"
                  }`} />
              </div>
              <div>
                <label className={`block text-xs font-semibold mb-1 ${muted}`}>CSV Import (paste CSV text — needs business_name and phone columns)</label>
                <textarea value={csvText} onChange={(e) => setCsvText(e.target.value)} rows={4}
                  placeholder={"business_name,phone,industry,city\nAcme Plumbing,3055551234,plumbing,Miami"}
                  className={`w-full px-3 py-2 rounded-xl text-xs font-mono border resize-none ${
                    dark ? "bg-gray-950 border-gray-800 text-white placeholder-gray-600" : "bg-gray-50 border-gray-200"
                  }`} />
              </div>
            </div>
            <div className="flex gap-2">
              <button onClick={() => setShowLeadImport(false)} className={`flex-1 py-2 rounded-xl text-sm border transition-colors ${
                dark ? "border-gray-700 text-gray-400 hover:text-white" : "border-gray-200 text-gray-600"
              }`}>Cancel</button>
              <button onClick={importLeads}
                className="flex-1 py-2 rounded-xl text-sm bg-violet-700 hover:bg-violet-600 text-white font-semibold transition-colors">
                Import Leads
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Analytics Page ──────────────────────────────────────────────────────────
function AnalyticsPage() {
  const [stats, setStats] = useState<any>(null);
  const [agentStats, setAgentStats] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState<'7d'|'30d'|'90d'>('30d');

  useEffect(() => {
    setLoading(true);
    Promise.all([
      api<any>('/api/stats'),
      api<any>('/api/analytics/agents'),
    ]).then(([s, a]) => {
      setStats(s);
      setAgentStats(a.agents || []);
    }).catch(() => {}).finally(() => setLoading(false));
  }, [period]);

  if (loading) return <div className="flex justify-center py-24"><Loader2 size={28} className="animate-spin text-gray-600" /></div>;

  const sentimentTotal = (stats?.sentiment?.positive || 0) + (stats?.sentiment?.neutral || 0) + (stats?.sentiment?.negative || 0) + (stats?.sentiment?.frustrated || 0);
  const sentimentPct = (n: number) => sentimentTotal > 0 ? Math.round((n / sentimentTotal) * 100) : 0;

  return (
    <div className="p-6 space-y-6 max-w-5xl mx-auto">
      {/* Period selector */}
      <div className="flex items-center justify-between">
        <h2 className="text-base font-bold text-white">Analytics</h2>
        <div className="flex gap-1">
          {(['7d','30d','90d'] as const).map((p) => (
            <button key={p} onClick={() => setPeriod(p)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                period === p ? 'bg-violet-700 text-white' : 'bg-gray-900 border border-gray-800 text-gray-500 hover:text-white'
              }`}>{p === '7d' ? '7 Days' : p === '30d' ? '30 Days' : '90 Days'}</button>
          ))}
        </div>
      </div>

      {/* Top metrics */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: 'Total Calls', value: stats?.totalCalls || 0, sub: `${stats?.callsThisMonth || 0} this month`, color: 'text-violet-400' },
          { label: 'Conversion Rate', value: `${stats?.conversionRate || 0}%`, sub: 'calls → booking or lead', color: 'text-emerald-400' },
          { label: 'Qualification Rate', value: `${stats?.qualificationRate || 0}%`, sub: 'score ≥ 70%', color: 'text-blue-400' },
          { label: 'Avg Duration', value: `${Math.floor((stats?.avgDurationSeconds || 0) / 60)}m ${(stats?.avgDurationSeconds || 0) % 60}s`, sub: `${stats?.avgAiLatencyMs || 0}ms AI latency`, color: 'text-amber-400' },
        ].map((m) => (
          <div key={m.label} className="rounded-2xl bg-gray-900 border border-gray-800 p-4">
            <div className={`text-2xl font-bold ${m.color}`}>{m.value}</div>
            <div className="text-xs font-semibold text-white mt-1">{m.label}</div>
            <div className="text-xs text-gray-600 mt-0.5">{m.sub}</div>
          </div>
        ))}
      </div>

      {/* Sentiment breakdown */}
      <div className="rounded-2xl bg-gray-900 border border-gray-800 p-5">
        <p className="text-xs font-semibold uppercase tracking-widest text-gray-500 mb-4">Caller Sentiment</p>
        <div className="space-y-3">
          {[
            { label: 'Positive', value: stats?.sentiment?.positive || 0, color: 'bg-emerald-500', pct: sentimentPct(stats?.sentiment?.positive || 0) },
            { label: 'Neutral', value: stats?.sentiment?.neutral || 0, color: 'bg-blue-500', pct: sentimentPct(stats?.sentiment?.neutral || 0) },
            { label: 'Negative', value: stats?.sentiment?.negative || 0, color: 'bg-amber-500', pct: sentimentPct(stats?.sentiment?.negative || 0) },
            { label: 'Frustrated', value: stats?.sentiment?.frustrated || 0, color: 'bg-red-500', pct: sentimentPct(stats?.sentiment?.frustrated || 0) },
          ].map((s) => (
            <div key={s.label} className="flex items-center gap-3">
              <span className="text-xs text-gray-500 w-20 shrink-0">{s.label}</span>
              <div className="flex-1 h-2 bg-gray-800 rounded-full overflow-hidden">
                <div className={`h-full ${s.color} rounded-full transition-all`} style={{ width: `${s.pct}%` }} />
              </div>
              <span className="text-xs text-gray-400 w-12 text-right">{s.value} ({s.pct}%)</span>
            </div>
          ))}
        </div>
      </div>

      {/* Per-agent performance */}
      <div className="rounded-2xl bg-gray-900 border border-gray-800 p-5">
        <p className="text-xs font-semibold uppercase tracking-widest text-gray-500 mb-4">Agent Performance</p>
        {agentStats.length === 0 ? (
          <p className="text-sm text-gray-600 text-center py-6">No agent data yet. Agent stats populate after calls complete.</p>
        ) : (
          <div className="space-y-3">
            {agentStats.map((a: any) => (
              <div key={a.agent_name} className="flex items-center gap-4 p-3 rounded-xl bg-gray-950 border border-gray-800">
                <div className="w-8 h-8 rounded-lg bg-violet-900/40 border border-violet-700/30 flex items-center justify-center shrink-0">
                  <Bot size={14} className="text-violet-400" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm font-semibold text-white">{a.agent_name}</span>
                    <span className="text-xs text-gray-600">{a.total_calls} calls</span>
                  </div>
                  <div className="flex gap-4 text-xs text-gray-600">
                    <span>Avg score: <span className="text-white">{Math.round(a.avg_score || 0)}%</span></span>
                    <span>Positive: <span className="text-emerald-400">{a.positive_pct || 0}%</span></span>
                    <span>Converted: <span className="text-violet-400">{a.converted || 0}</span></span>
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-lg font-bold text-white">{Math.round(a.avg_score || 0)}</div>
                  <div className="text-xs text-gray-600">avg score</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Data capture quality */}
      <div className="rounded-2xl bg-gray-900 border border-gray-800 p-5">
        <p className="text-xs font-semibold uppercase tracking-widest text-gray-500 mb-4">Data Capture Quality</p>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[
            { label: 'Fields Captured', value: stats?.fieldsExtracted || 0 },
            { label: 'Avg Confidence', value: stats?.avgFieldConfidence != null ? `${stats.avgFieldConfidence}%` : '—' },
            { label: 'Contacts Named', value: `${stats?.dataCaptureCoverage || 0}%` },
            { label: 'With Email', value: stats?.contactsWithEmail || 0 },
          ].map((m) => (
            <div key={m.label} className="rounded-xl bg-gray-950 border border-gray-800 p-3 text-center">
              <div className="text-xl font-bold text-white">{m.value}</div>
              <div className="text-xs text-gray-600 mt-0.5">{m.label}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Pricing / upgrade CTA */}
      <div className="rounded-2xl bg-gradient-to-br from-violet-950/60 to-gray-900 border border-violet-800/40 p-6">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-sm font-bold text-white mb-1">Upgrade to unlock more</p>
            <p className="text-xs text-gray-400">Starter ($49/mo) — 500 calls · Pro ($149/mo) — 2,000 calls · Enterprise — unlimited</p>
          </div>
          <button onClick={() => window.open('/pricing', '_blank')}
            className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-violet-700 hover:bg-violet-600 text-white text-xs font-semibold transition-colors shrink-0 ml-4">
            <CreditCard size={12} /> View Plans
          </button>
        </div>
      </div>
    </div>
  );
}

// ── System Health Page ────────────────────────────────────────────────────────────────────────────────
function SystemHealthPage() {
  const { dark } = useTheme();
  const { addToast } = useToast();
  const [checks, setChecks] = useState<any[]>([]);
  const [summary, setSummary] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [lastRun, setLastRun] = useState<string | null>(null);

  const runChecks = async () => {
    setLoading(true);
    try {
      const d = await api<any>('/api/system-health');
      setChecks(d.checks || []);
      setSummary(d.summary);
      setLastRun(new Date().toLocaleTimeString());
    } catch (e: any) {
      addToast({ type: 'error', message: 'Health check failed: ' + e.message });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { runChecks(); }, []);

  const statusColor = (s: string) => s === 'pass' ? 'text-green-400' : s === 'warn' ? 'text-yellow-400' : 'text-red-400';
  const statusBg = (s: string) => s === 'pass' ? 'bg-green-500/10 border-green-500/30' : s === 'warn' ? 'bg-yellow-500/10 border-yellow-500/30' : 'bg-red-500/10 border-red-500/30';
  const statusIcon = (s: string) => s === 'pass' ? <CheckCircle2 size={18} className="text-green-400" /> : s === 'warn' ? <AlertTriangle size={18} className="text-yellow-400" /> : <AlertCircle size={18} className="text-red-400" />;

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-bold flex items-center gap-2"><Shield size={20} className="text-violet-400" /> System Health</h2>
          <p className={`text-sm mt-1 ${dark ? 'text-gray-400' : 'text-gray-600'}`}>10-point smoke test — runs against your live database and config</p>
        </div>
        <div className="flex items-center gap-3">
          {lastRun && <span className={`text-xs ${dark ? 'text-gray-500' : 'text-gray-400'}`}>Last run: {lastRun}</span>}
          <button onClick={runChecks} disabled={loading}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-700 text-white text-sm font-medium transition-colors disabled:opacity-50">
            {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            {loading ? 'Running...' : 'Run Checks'}
          </button>
        </div>
      </div>

      {summary && (
        <div className={`grid grid-cols-3 gap-4 mb-6 p-4 rounded-xl border ${dark ? 'bg-gray-900 border-gray-800' : 'bg-white border-gray-200'}`}>
          <div className="text-center">
            <div className="text-2xl font-bold text-green-400">{summary.passed}</div>
            <div className={`text-xs mt-1 ${dark ? 'text-gray-400' : 'text-gray-500'}`}>Passed</div>
          </div>
          <div className="text-center">
            <div className="text-2xl font-bold text-yellow-400">{summary.warned}</div>
            <div className={`text-xs mt-1 ${dark ? 'text-gray-400' : 'text-gray-500'}`}>Warnings</div>
          </div>
          <div className="text-center">
            <div className="text-2xl font-bold text-red-400">{summary.failed}</div>
            <div className={`text-xs mt-1 ${dark ? 'text-gray-400' : 'text-gray-500'}`}>Failed</div>
          </div>
        </div>
      )}

      {loading && checks.length === 0 && (
        <div className="flex items-center justify-center py-16">
          <Loader2 size={32} className="animate-spin text-violet-400" />
        </div>
      )}

      <div className="space-y-3">
        {checks.map((c) => (
          <div key={c.id} className={`flex items-start gap-4 p-4 rounded-xl border ${statusBg(c.status)}`}>
            <div className="mt-0.5 flex-shrink-0">{statusIcon(c.status)}</div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold text-sm">{c.label}</span>
                <span className={`text-xs font-mono uppercase ${statusColor(c.status)}`}>{c.status}</span>
              </div>
              <p className={`text-sm mt-1 ${dark ? 'text-gray-400' : 'text-gray-600'}`}>{c.detail}</p>
            </div>
          </div>
        ))}
      </div>

      {checks.length > 0 && summary?.failed === 0 && summary?.warned === 0 && (
        <div className="mt-6 p-4 rounded-xl bg-green-500/10 border border-green-500/30 text-center">
          <CheckCircle2 size={24} className="text-green-400 mx-auto mb-2" />
          <p className="text-green-400 font-semibold">All systems operational</p>
          <p className={`text-sm mt-1 ${dark ? 'text-gray-400' : 'text-gray-600'}`}>Platform is ready to handle calls</p>
        </div>
      )}
    </div>
  );
}

// ── Main App ────────────────────────────────────────────────────────────────────────────────
export default function App() {
  const [dark, setDark] = useState(true);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [tab, setTab] = useState<Tab>("dashboard");

  // Global in-app navigation hook (used by Settings CTA -> Agent)
  useEffect(() => {
    const handler = (e: any) => {
      const t = e?.detail?.tab;
      if (t) setTab(t);
    };
    window.addEventListener('smirk:navigate', handler as any);
    return () => window.removeEventListener('smirk:navigate', handler as any);
  }, []);
  const [activeCalls, setActiveCalls] = useState<ActiveCall[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [recentCalls, setRecentCalls] = useState<Call[]>([]);
  const [configStatus, setConfigStatus] = useState<ConfigStatus | null>(null);
  const [showSetupWizard, setShowSetupWizard] = useState(false);
  const [apiError, setApiError] = useState(false);
  const [selectedCall, setSelectedCall] = useState<Call | null>(null);
  const [taskCount, setTaskCount] = useState(0);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [workspaces, setWorkspaces] = useState<any[]>([]);
  const [currentWorkspace, setCurrentWorkspace] = useState<any>(null);
  const [showWorkspacePicker, setShowWorkspacePicker] = useState(false);

  // Load workspaces
  useEffect(() => {
    api<any>('/api/workspaces').then((d) => {
      setWorkspaces(d.workspaces || []);
      if (d.workspaces?.length > 0 && !currentWorkspace) setCurrentWorkspace(d.workspaces[0]);
    }).catch(() => {});
  }, []);

  // Tell backend which workspace to scope data to.
  useEffect(() => {
    if (!currentWorkspace?.id) return;
    const wsId = String(currentWorkspace.id);
    const origFetch = window.fetch.bind(window);
    // Patch fetch once per workspace change.
    (window as any).fetch = (input: any, init: any = {}) => {
      const headers = new Headers(init.headers || {});
      headers.set('X-Workspace-Id', wsId);
      return origFetch(input, { ...init, headers });
    };
    return () => {
      (window as any).fetch = origFetch;
    };
  }, [currentWorkspace?.id]);

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

        // Auto-open setup wizard for first-time users until configured.
        if (cs?.isConfigured === false) setShowSetupWizard(true);
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

  const missing = new Set<string>(configStatus?.missingRequired ?? []);
  const twilioReady = !Array.from(missing).some((k) => k.includes("TWILIO"));
  const aiReady = !Array.from(missing).some((k) => k.includes("GEMINI") || k.includes("OPENROUTER") || k.includes("OPENAI"));
  const placesReady = !Array.from(missing).some((k) => k.includes("GOOGLE_PLACES"));
  const nowLocal = new Date();
  const day = nowLocal.getDay(); // 0 Sun, 6 Sat
  const hour = nowLocal.getHours();
  const inCallWindow = day >= 1 && day <= 5 && hour >= 10 && hour < 17;

  const tabs: { id: Tab; label: string; icon: React.ReactElement }[] = [
    { id: "dashboard",    label: "Dashboard",     icon: <BarChart3 size={16} /> },
    { id: "calls",        label: "Calls",         icon: <Phone size={16} /> },
    { id: "contacts",     label: "Contacts",      icon: <Users size={16} /> },
    { id: "tasks",        label: "Tasks",         icon: <ListTodo size={16} /> },
    { id: "handoffs",     label: "Handoffs",      icon: <Headphones size={16} /> },
    { id: "recovery",     label: "Recovery Desk", icon: <RotateCcw size={16} /> },
    { id: "identity",     label: "Agent",         icon: <Bot size={16} /> },
    { id: "settings",     label: "Settings",      icon: <Settings size={16} /> },
  ];

  return (
    <ThemeContext.Provider value={{ dark, toggle: () => setDark((d) => !d) }}>
      <ToastContext.Provider value={{ addToast }}>
        <SetupWizard
          open={showSetupWizard}
          onClose={() => setShowSetupWizard(false)}
          configStatus={configStatus}
        />
        <div className="min-h-screen flex flex-col" style={{ background: 'var(--smirk-black)', color: 'var(--smirk-text)', fontFamily: "'Inter', system-ui, sans-serif" }}>

          {/* Header */}
          <header style={{ background: 'var(--smirk-black)', borderBottom: '1px solid var(--smirk-border)', position: 'sticky', top: 0, zIndex: 40, display: 'flex', alignItems: 'center', gap: '8px', padding: '0 16px', height: '52px' }}>
            {/* Logo */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginRight: '12px', flexShrink: 0 }}>
              <div style={{ width: 28, height: 28, background: 'var(--smirk-green)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <span style={{ fontFamily: 'var(--font-display)', fontWeight: 900, fontSize: 14, color: 'var(--smirk-black)', letterSpacing: '-0.05em' }}>S</span>
              </div>
              <span style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 15, color: 'var(--smirk-text)', letterSpacing: '-0.02em', textTransform: 'uppercase' }}>SMIRK</span>
            </div>
            {/* Desktop Nav */}
            <nav style={{ display: 'flex', alignItems: 'stretch', flex: 1, height: '100%', overflow: 'hidden' }}>
              {tabs.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  className={`nav-item ${tab === t.id ? 'active' : ''}`}
                >
                  {t.icon}
                  {t.label}
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
              {/* Workspace Switcher */}
              {workspaces.length > 0 && (
                <div className="relative">
                  <button onClick={() => setShowWorkspacePicker((o) => !o)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-gray-900 border border-gray-800 hover:border-gray-700 text-xs text-gray-400 hover:text-white transition-colors">
                    <Building2 size={12} />
                    <span className="max-w-[100px] truncate">{currentWorkspace?.name || 'Default'}</span>
                    <ChevronDown size={11} />
                  </button>
                  {showWorkspacePicker && (
                    <div className="absolute right-0 top-full mt-1 w-52 rounded-xl bg-gray-900 border border-gray-800 shadow-2xl z-50 overflow-hidden">
                      <div className="px-3 py-2 border-b border-gray-800">
                        <p className="text-xs font-semibold text-gray-500 uppercase tracking-widest">Workspaces</p>
                      </div>
                      {workspaces.map((ws: any) => (
                        <button key={ws.id} onClick={() => { setCurrentWorkspace(ws); setShowWorkspacePicker(false); }}
                          className={`w-full flex items-center gap-2 px-3 py-2.5 text-left text-sm transition-colors hover:bg-gray-800 ${
                            currentWorkspace?.id === ws.id ? 'text-violet-400' : 'text-gray-300'
                          }`}>
                          <div className="w-6 h-6 rounded-md bg-violet-900/40 border border-violet-700/30 flex items-center justify-center shrink-0">
                            <span className="text-[10px] font-bold text-violet-400">{ws.name?.[0]?.toUpperCase() || 'W'}</span>
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-xs font-semibold truncate">{ws.name}</p>
                            <p className="text-[10px] text-gray-600 capitalize">{ws.plan || 'free'} plan</p>
                          </div>
                          {currentWorkspace?.id === ws.id && <Check size={12} className="text-violet-400 shrink-0" />}
                        </button>
                      ))}
                      <div className="border-t border-gray-800 p-2">
                        <button onClick={() => { setShowWorkspacePicker(false); setTab('settings'); }}
                          className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs text-gray-500 hover:text-white hover:bg-gray-800 transition-colors">
                          <Plus size={11} /> New Workspace
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
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

          {/* Operator Preflight */}
          <div style={{ margin: '0 16px 8px', border: '1px solid var(--smirk-border)', background: 'var(--smirk-surface)', padding: '12px 16px' }}>
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="text-xs uppercase tracking-widest text-gray-500 font-semibold">Operator Preflight</div>
              <button onClick={() => setTab("settings")} className="text-xs text-violet-400 hover:text-violet-300 underline">Open Settings</button>
            </div>
            <div className="mt-2 grid grid-cols-2 md:grid-cols-4 gap-2">
              <div className={`rounded-lg px-3 py-2 border text-xs ${twilioReady ? 'border-green-700/50 bg-green-950/30 text-green-300' : 'border-red-700/50 bg-red-950/30 text-red-300'}`}>
                <div className="font-semibold">Twilio</div>
                <div>{twilioReady ? 'Connected' : 'Needs setup'}</div>
              </div>
              <div className={`rounded-lg px-3 py-2 border text-xs ${aiReady ? 'border-green-700/50 bg-green-950/30 text-green-300' : 'border-red-700/50 bg-red-950/30 text-red-300'}`}>
                <div className="font-semibold">AI</div>
                <div>{aiReady ? 'Connected' : 'Needs setup'}</div>
              </div>
              <div className={`rounded-lg px-3 py-2 border text-xs ${placesReady ? 'border-green-700/50 bg-green-950/30 text-green-300' : 'border-red-700/50 bg-red-950/30 text-red-300'}`}>
                <div className="font-semibold">Lead Source</div>
                <div>{placesReady ? 'Places ready' : 'Places key missing'}</div>
              </div>
              <div className={`rounded-lg px-3 py-2 border text-xs ${inCallWindow ? 'border-green-700/50 bg-green-950/30 text-green-300' : 'border-amber-700/50 bg-amber-950/30 text-amber-300'}`}>
                <div className="font-semibold">Call Window</div>
                <div>{inCallWindow ? 'Open now' : 'Closed (10:00–17:00 weekdays)'}</div>
              </div>
            </div>
          </div>

          {/* Setup Status Banner */}
          {configStatus && (configStatus.missingRequired.length > 0 || configStatus.warnings.length > 0) && (
            <div className="mx-4 mb-2">
              {configStatus.missingRequired.length > 0 && (
                <div className="flex items-start gap-3 px-4 py-3 rounded-xl bg-red-950/60 border border-red-800/60 mb-2">
                  <AlertTriangle size={14} className="text-red-400 mt-0.5 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <span className="text-xs font-semibold text-red-300">Required setup missing: </span>
                    <span className="text-xs text-red-400">{configStatus.missingRequired.join(" · ")}</span>
                  </div>
                  <button onClick={() => setTab("settings")} className="text-xs text-red-400 hover:text-red-300 underline shrink-0">Fix in Settings</button>
                </div>
              )}
              {configStatus.warnings.map((w, i) => (
                <div key={i} className="flex items-start gap-3 px-4 py-2.5 rounded-xl bg-amber-950/40 border border-amber-800/40 mb-1">
                  <Info size={13} className="text-amber-400 mt-0.5 shrink-0" />
                  <span className="text-xs text-amber-400 flex-1">{w}</span>
                  <button onClick={() => setTab("settings")} className="text-xs text-amber-500 hover:text-amber-300 underline shrink-0">Settings</button>
                </div>
              ))}
            </div>
          )}

          {/* Main Content */}
          <main className="flex-1 overflow-y-auto" style={{ background: 'var(--smirk-black)' }}>
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
            {tab === "handoffs" && <HandoffsPage />}
            {tab === "recovery" && <RecoveryDeskPage />}
            {tab === "identity" && <AgentIdentityPage />}
            {tab === "settings" && <SettingsPage />}
          </main>

          {/* Call Detail Modal */}
          {selectedCall && (
            <CallDetailModal call={selectedCall} onClose={() => setSelectedCall(null)} />
          )}

          {/* Toasts */}
          <ToastContainer toasts={toasts} remove={removeToast} />

          {/* SMIRK Chat Bubble */}
          <SmirkChatBubble activeCalls={activeCalls} />
        </div>
      </ToastContext.Provider>
    </ThemeContext.Provider>
  );
}

// ── SMIRK Chat Bubble ─────────────────────────────────────────────────────────

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  toolCalls?: { name: string; result: string }[];
};

function SmirkChatBubble({ activeCalls = [] }: { activeCalls?: ActiveCall[] }) {
  const { dark } = useContext(ThemeContext);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'chat' | 'whisper'>('chat');
  const [selectedCallSid, setSelectedCallSid] = useState<string>("");
  const [whisperInput, setWhisperInput] = useState("");
  const [whisperSending, setWhisperSending] = useState(false);
  const [whisperLog, setWhisperLog] = useState<{ text: string; ts: string }[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "welcome",
      role: "assistant",
      content: "Hey — I'm SMIRK. Ask me about your calls, leads, tasks, or I can read and edit the app code.",
    },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-select first active call when switching to whisper mode
  useEffect(() => {
    if (mode === 'whisper' && activeCalls.length > 0 && !selectedCallSid) {
      setSelectedCallSid(activeCalls[0].call_sid);
    }
  }, [mode, activeCalls, selectedCallSid]);

  async function sendWhisper() {
    const text = whisperInput.trim();
    if (!text || whisperSending || !selectedCallSid) return;
    setWhisperSending(true);
    setWhisperInput("");
    try {
      const res = await fetch("/api/openclaw/inject", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ callSid: selectedCallSid, message: text, source: "dashboard" }),
      });
      const data = await res.json();
      if (data.success) {
        setWhisperLog((l) => [...l, { text, ts: new Date().toLocaleTimeString() }]);
      } else {
        setWhisperLog((l) => [...l, { text: `❌ Error: ${data.error || 'Failed'}`, ts: new Date().toLocaleTimeString() }]);
      }
    } catch {
      setWhisperLog((l) => [...l, { text: '❌ Network error', ts: new Date().toLocaleTimeString() }]);
    } finally {
      setWhisperSending(false);
    }
  }

  useEffect(() => {
    if (open) bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, open]);

  async function send() {
    const text = input.trim();
    if (!text || loading) return;
    setInput("");
    const userMsg: ChatMessage = { id: Date.now().toString(), role: "user", content: text };
    setMessages((m) => [...m, userMsg]);
    setLoading(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [...messages, userMsg].map((m) => ({ role: m.role, content: m.content })),
        }),
      });
      const data = await res.json();
      const assistantMsg: ChatMessage = {
        id: (Date.now() + 1).toString(),
        role: "assistant",
        content: data.reply || data.content || data.error || "No response.",
        toolCalls: data.toolsUsed,
      };
      setMessages((m) => [...m, assistantMsg]);
    } catch (e) {
      setMessages((m) => [
        ...m,
        { id: (Date.now() + 1).toString(), role: "assistant", content: "Error reaching SMIRK agent." },
      ]);
    } finally {
      setLoading(false);
    }
  }

  const bg = dark ? "#1a1a2e" : "#ffffff";
  const border = dark ? "#2d2d4e" : "#e5e7eb";
  const textColor = dark ? "#e2e8f0" : "#1e293b";
  const inputBg = dark ? "#0f0f23" : "#f8fafc";
  const userBubble = "#6366f1";
  const aiBubble = dark ? "#2d2d4e" : "#f1f5f9";
  const aiText = dark ? "#e2e8f0" : "#1e293b";

  return (
    <div style={{ position: "fixed", bottom: 24, right: 24, zIndex: 9999 }}>
      {/* Chat Window */}
      {open && (
        <div
          style={{
            width: 380,
            height: 520,
            background: bg,
            border: `1px solid ${border}`,
            borderRadius: 16,
            boxShadow: "0 20px 60px rgba(0,0,0,0.35)",
            display: "flex",
            flexDirection: "column",
            marginBottom: 12,
            overflow: "hidden",
          }}
        >
          {/* Header */}
          <div
            style={{
              padding: "14px 16px",
              borderBottom: `1px solid ${border}`,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              background: dark ? "#0f0f23" : "#f8fafc",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: "50%",
                  background: "linear-gradient(135deg, #6366f1, #8b5cf6)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 14,
                  fontWeight: 700,
                  color: "#fff",
                }}
              >
                S
              </div>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: textColor }}>SMIRK Agent</div>
                <div style={{ fontSize: 11, color: "#6366f1" }}>● Online</div>
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {/* Mode toggle */}
              <div style={{ display: "flex", borderRadius: 8, overflow: "hidden", border: `1px solid ${border}` }}>
                <button
                  onClick={() => setMode('chat')}
                  style={{
                    padding: "4px 10px", fontSize: 11, fontWeight: 600, border: "none", cursor: "pointer",
                    background: mode === 'chat' ? "#6366f1" : "transparent",
                    color: mode === 'chat' ? "#fff" : textColor,
                  }}
                >Chat</button>
                <button
                  onClick={() => setMode('whisper')}
                  style={{
                    padding: "4px 10px", fontSize: 11, fontWeight: 600, border: "none", cursor: "pointer",
                    background: mode === 'whisper' ? "#10b981" : "transparent",
                    color: mode === 'whisper' ? "#fff" : textColor,
                    position: "relative",
                  }}
                >
                  Whisper
                  {activeCalls.length > 0 && (
                    <span style={{ position: "absolute", top: 2, right: 2, width: 6, height: 6, borderRadius: "50%", background: "#ef4444" }} />
                  )}
                </button>
              </div>
              <button
                onClick={() => setOpen(false)}
                style={{
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  color: textColor,
                  fontSize: 18,
                  lineHeight: 1,
                  padding: 4,
                }}
              >
                ×
              </button>
            </div>
          </div>

          {/* Whisper Mode Panel */}
          {mode === 'whisper' && (
            <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
              {/* Call selector */}
              <div style={{ padding: "10px 14px", borderBottom: `1px solid ${border}`, background: dark ? "#0f0f23" : "#f0fdf4" }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: "#10b981", marginBottom: 6 }}>🎙 WHISPER MODE — type to speak through the AI</div>
                {activeCalls.length === 0 ? (
                  <div style={{ fontSize: 12, color: dark ? "#9ca3af" : "#6b7280" }}>No active calls right now. Whisper will activate when a call is in progress.</div>
                ) : (
                  <select
                    value={selectedCallSid}
                    onChange={(e) => setSelectedCallSid(e.target.value)}
                    style={{ width: "100%", padding: "6px 8px", borderRadius: 8, border: `1px solid ${border}`, background: dark ? "#1a1a2e" : "#fff", color: textColor, fontSize: 12 }}
                  >
                    {activeCalls.map((c) => (
                      <option key={c.call_sid} value={c.call_sid}>
                        {c.contact_name || c.from_number} — {c.turn_count} turns
                      </option>
                    ))}
                  </select>
                )}
              </div>
              {/* Whisper log */}
              <div style={{ flex: 1, overflowY: "auto", padding: "10px 14px", display: "flex", flexDirection: "column", gap: 6 }}>
                {whisperLog.length === 0 && (
                  <div style={{ fontSize: 12, color: dark ? "#6b7280" : "#9ca3af", textAlign: "center", marginTop: 20 }}>Messages you type will be spoken by the AI mid-call.</div>
                )}
                {whisperLog.map((entry, i) => (
                  <div key={i} style={{ fontSize: 12, padding: "6px 10px", borderRadius: 8, background: dark ? "#0f2e1a" : "#dcfce7", color: dark ? "#6ee7b7" : "#166534" }}>
                    <span style={{ opacity: 0.6, marginRight: 6 }}>{entry.ts}</span>
                    {entry.text}
                  </div>
                ))}
              </div>
              {/* Whisper input */}
              <div style={{ padding: "10px 12px", borderTop: `1px solid ${border}`, display: "flex", gap: 8, background: dark ? "#0f0f23" : "#f8fafc" }}>
                <input
                  value={whisperInput}
                  onChange={(e) => setWhisperInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && sendWhisper()}
                  placeholder={activeCalls.length === 0 ? "No active call…" : "Type what AI should say…"}
                  disabled={activeCalls.length === 0 || whisperSending}
                  style={{ flex: 1, padding: "8px 12px", borderRadius: 10, border: `1px solid ${border}`, background: inputBg, color: textColor, fontSize: 13, outline: "none" }}
                />
                <button
                  onClick={sendWhisper}
                  disabled={activeCalls.length === 0 || whisperSending || !whisperInput.trim()}
                  style={{ padding: "8px 14px", borderRadius: 10, border: "none", background: (activeCalls.length === 0 || whisperSending || !whisperInput.trim()) ? "#4b5563" : "#10b981", color: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer" }}
                >
                  {whisperSending ? "…" : "Inject"}
                </button>
              </div>
            </div>
          )}

          {/* Messages (Chat Mode) */}
          {mode === 'chat' && <div
            style={{
              flex: 1,
              overflowY: "auto",
              padding: "14px 14px 8px",
              display: "flex",
              flexDirection: "column",
              gap: 10,
            }}
          >
            {messages.map((msg) => (
              <div
                key={msg.id}
                style={{
                  display: "flex",
                  justifyContent: msg.role === "user" ? "flex-end" : "flex-start",
                }}
              >
                <div
                  style={{
                    maxWidth: "82%",
                    padding: "9px 13px",
                    borderRadius: msg.role === "user" ? "16px 16px 4px 16px" : "16px 16px 16px 4px",
                    background: msg.role === "user" ? userBubble : aiBubble,
                    color: msg.role === "user" ? "#fff" : aiText,
                    fontSize: 13,
                    lineHeight: 1.5,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                  }}
                >
                  {msg.content}
                  {msg.toolCalls && msg.toolCalls.length > 0 && (
                    <div style={{ marginTop: 8, borderTop: `1px solid ${border}`, paddingTop: 6 }}>
                      {msg.toolCalls.map((tc, i) => (
                        <div key={i} style={{ fontSize: 11, color: "#6366f1", marginBottom: 2 }}>
                          <span style={{ fontWeight: 600 }}>⚙ {tc.name}</span>
                          {tc.result && (
                            <pre
                              style={{
                                margin: "4px 0 0",
                                fontSize: 10,
                                background: dark ? "#0f0f23" : "#e2e8f0",
                                borderRadius: 6,
                                padding: "4px 6px",
                                overflowX: "auto",
                                color: aiText,
                                whiteSpace: "pre-wrap",
                                wordBreak: "break-all",
                              }}
                            >
                              {tc.result.length > 400 ? tc.result.slice(0, 400) + "…" : tc.result}
                            </pre>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
            {loading && (
              <div style={{ display: "flex", justifyContent: "flex-start" }}>
                <div
                  style={{
                    padding: "9px 13px",
                    borderRadius: "16px 16px 16px 4px",
                    background: aiBubble,
                    color: aiText,
                    fontSize: 13,
                  }}
                >
                  <span style={{ opacity: 0.6 }}>Thinking…</span>
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>}

          {/* Input (Chat Mode only) */}
          {mode === 'chat' && (
          <div
            style={{
              padding: "10px 12px",
              borderTop: `1px solid ${border}`,
              display: "flex",
              gap: 8,
              background: dark ? "#0f0f23" : "#f8fafc",
            }}
          >
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && send()}
              placeholder="Ask about calls, leads, or edit code…"
              style={{
                flex: 1,
                padding: "8px 12px",
                borderRadius: 10,
                border: `1px solid ${border}`,
                background: inputBg,
                color: textColor,
                fontSize: 13,
                outline: "none",
              }}
            />
            <button
              onClick={send}
              disabled={loading || !input.trim()}
              style={{
                padding: "8px 14px",
                borderRadius: 10,
                border: "none",
                background: loading || !input.trim() ? "#4b5563" : "linear-gradient(135deg, #6366f1, #8b5cf6)",
                color: "#fff",
                fontSize: 13,
                fontWeight: 600,
                cursor: loading || !input.trim() ? "not-allowed" : "pointer",
              }}
            >
              Send
            </button>
          </div>
          )}
        </div>
      )}

      {/* Bubble Button */}
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          width: 56,
          height: 56,
          borderRadius: "50%",
          border: "none",
          background: "linear-gradient(135deg, #6366f1, #8b5cf6)",
          boxShadow: "0 4px 20px rgba(99,102,241,0.5)",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 22,
          color: "#fff",
          transition: "transform 0.2s",
        }}
        title="Chat with SMIRK"
      >
        {open ? "×" : "💬"}
      </button>
    </div>
  );
}
