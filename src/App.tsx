import { useState, useCallback, useEffect } from "react";
import {
  Phone, PhoneIncoming, PhoneOutgoing, Activity, BarChart3, Bot,
  Settings, MessageSquare, Clock, CheckCircle, Zap, Users, ListTodo,
  AlertTriangle, ChevronDown, ChevronUp, User, Calendar, ArrowRight,
  RefreshCw, TrendingUp, ShieldAlert, Wrench,
} from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────
type Tab = "dashboard" | "calls" | "contacts" | "tasks" | "agents" | "setup";

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

type Handoff = {
  id: number;
  call_sid: string;
  contact_name: string | null;
  phone_number: string | null;
  reason: string;
  urgency: string;
  transcript_snippet: string | null;
  recommended_action: string | null;
  created_at: string;
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
  created_at: string;
};

type Stats = {
  totalCalls: number;
  activeCalls: number;
  completedCalls: number;
  totalMessages: number;
  totalContacts: number;
  avgDurationSeconds: number;
  inboundCalls: number;
  outboundCalls: number;
  avgAiLatencyMs: number;
  openTasks: number;
  pendingHandoffs: number;
  avgResolutionScore: number;
  callsToday: number;
  callsThisWeek: number;
  transferRate: number;
  bookingRate: number;
};

type WebhookUrls = { incomingUrl: string; statusUrl: string };

// ── Helpers ───────────────────────────────────────────────────────────────────
const formatDuration = (seconds: number | null) => {
  if (!seconds) return "—";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
};

const formatDate = (iso: string | null) => {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
};

const formatRelative = (iso: string) => {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
};

const sentimentColor = (s: string | null) => {
  if (s === "positive") return "text-emerald-600";
  if (s === "negative" || s === "frustrated") return "text-red-500";
  return "text-zinc-500";
};

const urgencyColor = (u: string) => {
  if (u === "emergency") return "bg-red-100 text-red-700";
  if (u === "high") return "bg-orange-100 text-orange-700";
  if (u === "normal") return "bg-blue-100 text-blue-700";
  return "bg-zinc-100 text-zinc-600";
};

const resolutionColor = (score: number | null) => {
  if (score === null) return "text-zinc-400";
  if (score >= 0.8) return "text-emerald-600";
  if (score >= 0.5) return "text-amber-500";
  return "text-red-500";
};

// ── Sub-components ────────────────────────────────────────────────────────────
const StatCard = ({
  icon: Icon,
  label,
  value,
  sub,
  color,
  alert,
}: {
  icon: any;
  label: string;
  value: string | number;
  sub?: string;
  color: string;
  alert?: boolean;
}) => (
  <div className={`bg-white rounded-xl border ${alert ? "border-red-200" : "border-zinc-100"} p-4 shadow-sm`}>
    <div className="flex items-center gap-2 mb-2">
      <div className={`p-1.5 rounded-lg ${color}`}>
        <Icon size={16} />
      </div>
      <span className="text-xs font-medium text-zinc-500 uppercase tracking-wide">{label}</span>
      {alert && <span className="ml-auto w-2 h-2 rounded-full bg-red-500 animate-pulse" />}
    </div>
    <div className="text-2xl font-bold text-zinc-900">{value}</div>
    {sub && <div className="text-xs text-zinc-400 mt-0.5">{sub}</div>}
  </div>
);

const Badge2 = ({ label, color }: { label: string; color: string }) => (
  <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${color}`}>{label}</span>
);

// ── Main App ──────────────────────────────────────────────────────────────────
export default function App() {
  const [tab, setTab] = useState<Tab>("dashboard");
  const [calls, setCalls] = useState<Call[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [handoffs, setHandoffs] = useState<Handoff[]>([]);
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [webhookUrls, setWebhookUrls] = useState<WebhookUrls | null>(null);
  const [expandedCall, setExpandedCall] = useState<string | null>(null);
  const [callDetail, setCallDetail] = useState<{ messages: Message[]; events: any[]; summary: any } | null>(null);
  const [toNumber, setToNumber] = useState("");
  const [calling, setCalling] = useState(false);
  const [editingAgent, setEditingAgent] = useState<Partial<AgentConfig> | null>(null);
  const [lastRefresh, setLastRefresh] = useState(new Date());

  const fetchData = useCallback(async () => {
    try {
      const [callsRes, statsRes, agentsRes, contactsRes, tasksRes, handoffsRes, webhookRes] = await Promise.all([
        fetch("/api/calls"),
        fetch("/api/stats"),
        fetch("/api/agents"),
        fetch("/api/contacts"),
        fetch("/api/tasks?status=open"),
        fetch("/api/handoffs"),
        fetch("/api/webhook-url"),
      ]);
      if (callsRes.ok) setCalls(await callsRes.json());
      if (statsRes.ok) setStats(await statsRes.json());
      if (agentsRes.ok) setAgents(await agentsRes.json());
      if (contactsRes.ok) { const d = await contactsRes.json(); setContacts(d.contacts || []); }
      if (tasksRes.ok) setTasks(await tasksRes.json());
      if (handoffsRes.ok) setHandoffs(await handoffsRes.json());
      if (webhookRes.ok) setWebhookUrls(await webhookRes.json());
      setLastRefresh(new Date());
    } catch { /* silent — polling will retry */ }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 3000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const loadCallDetail = async (callSid: string) => {
    if (expandedCall === callSid) { setExpandedCall(null); setCallDetail(null); return; }
    setExpandedCall(callSid);
    const res = await fetch(`/api/calls/${callSid}/messages`);
    if (res.ok) setCallDetail(await res.json());
  };

  const makeCall = async () => {
    if (!toNumber.trim()) return;
    setCalling(true);
    try {
      const res = await fetch("/api/calls", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: toNumber }),
      });
      const data = await res.json();
      if (data.success) { setToNumber(""); fetchData(); }
      else alert(data.error || "Call failed");
    } finally { setCalling(false); }
  };

  const saveAgent = async () => {
    if (!editingAgent) return;
    const method = editingAgent.id ? "PUT" : "POST";
    const url = editingAgent.id ? `/api/agents/${editingAgent.id}` : "/api/agents";
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(editingAgent),
    });
    if (res.ok) { setEditingAgent(null); fetchData(); }
  };

  const activateAgent = async (id: number) => {
    await fetch(`/api/agents/${id}/activate`, { method: "PUT" });
    fetchData();
  };

  const deleteAgent = async (id: number) => {
    if (!confirm("Delete this agent?")) return;
    await fetch(`/api/agents/${id}`, { method: "DELETE" });
    fetchData();
  };

  const completeTask = async (id: number) => {
    await fetch(`/api/tasks/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "completed" }),
    });
    fetchData();
  };

  const acknowledgeHandoff = async (id: number) => {
    await fetch(`/api/handoffs/${id}/acknowledge`, { method: "PUT" });
    fetchData();
  };

  const tabs = [
    { id: "dashboard" as Tab, label: "Dashboard", icon: BarChart3 },
    { id: "calls" as Tab, label: "Call History", icon: Activity },
    { id: "contacts" as Tab, label: "Contacts", icon: Users },
    { id: "tasks" as Tab, label: `Tasks${stats?.openTasks ? ` (${stats.openTasks})` : ""}`, icon: ListTodo, alert: (stats?.openTasks || 0) > 0 },
    { id: "agents" as Tab, label: "Agent Config", icon: Bot },
    { id: "setup" as Tab, label: "Setup", icon: Settings },
  ];

  return (
    <div className="min-h-screen bg-zinc-50 font-sans">
      {/* Header */}
      <header className="bg-white border-b border-zinc-200 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-indigo-600 rounded-xl">
            <Phone size={20} className="text-white" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-zinc-900">AI Phone Agent</h1>
            <p className="text-xs text-zinc-400">Operational Memory Platform</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {stats?.activeCalls ? (
            <div className="flex items-center gap-1.5 bg-emerald-50 text-emerald-700 px-3 py-1.5 rounded-full text-sm font-medium">
              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
              {stats.activeCalls} active
            </div>
          ) : null}
          {(stats?.pendingHandoffs || 0) > 0 && (
            <div className="flex items-center gap-1.5 bg-red-50 text-red-700 px-3 py-1.5 rounded-full text-sm font-medium">
              <AlertTriangle size={14} />
              {stats?.pendingHandoffs} handoff{stats?.pendingHandoffs !== 1 ? "s" : ""}
            </div>
          )}
          <button onClick={fetchData} className="p-2 text-zinc-400 hover:text-zinc-600 rounded-lg hover:bg-zinc-100 transition-colors" title="Refresh">
            <RefreshCw size={16} />
          </button>
          <span className="text-xs text-zinc-400">Updated {formatRelative(lastRefresh.toISOString())}</span>
        </div>
      </header>

      {/* Tabs */}
      <nav className="bg-white border-b border-zinc-200 px-6">
        <div className="flex gap-1">
          {tabs.map(({ id, label, icon: Icon, alert }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
                tab === id
                  ? "border-indigo-600 text-indigo-600"
                  : "border-transparent text-zinc-500 hover:text-zinc-700"
              }`}
            >
              <Icon size={15} />
              {label}
              {alert && <span className="w-2 h-2 rounded-full bg-red-500" />}
            </button>
          ))}
        </div>
      </nav>

      <main className="max-w-7xl mx-auto px-6 py-8">

        {/* ── Dashboard Tab ── */}
        {tab === "dashboard" && (
          <div className="space-y-8">
            {/* Operational Alerts */}
            {((stats?.pendingHandoffs || 0) > 0 || (stats?.openTasks || 0) > 0) && (
              <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex items-center gap-4">
                <AlertTriangle size={20} className="text-amber-600 flex-shrink-0" />
                <div className="flex-1">
                  <p className="text-sm font-semibold text-amber-800">Action Required</p>
                  <p className="text-sm text-amber-700">
                    {stats?.pendingHandoffs ? `${stats.pendingHandoffs} pending handoff${stats.pendingHandoffs !== 1 ? "s" : ""} waiting for human review. ` : ""}
                    {stats?.openTasks ? `${stats.openTasks} open task${stats.openTasks !== 1 ? "s" : ""} need attention.` : ""}
                  </p>
                </div>
                <button onClick={() => setTab("tasks")} className="text-sm font-medium text-amber-700 hover:text-amber-900 flex items-center gap-1">
                  View Tasks <ArrowRight size={14} />
                </button>
              </div>
            )}

            {/* Stats Grid */}
            {stats && (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <StatCard icon={Phone} label="Total Calls" value={stats.totalCalls} sub={`${stats.callsToday} today`} color="bg-indigo-50 text-indigo-600" />
                <StatCard icon={Zap} label="Active Now" value={stats.activeCalls} color="bg-blue-50 text-blue-600" />
                <StatCard icon={CheckCircle} label="Completed" value={stats.completedCalls} color="bg-emerald-50 text-emerald-600" />
                <StatCard icon={Users} label="Contacts" value={stats.totalContacts} color="bg-violet-50 text-violet-600" />
                <StatCard icon={PhoneIncoming} label="Inbound" value={stats.inboundCalls} color="bg-amber-50 text-amber-600" />
                <StatCard icon={PhoneOutgoing} label="Outbound" value={stats.outboundCalls} color="bg-cyan-50 text-cyan-600" />
                <StatCard icon={Clock} label="Avg Duration" value={formatDuration(stats.avgDurationSeconds)} color="bg-rose-50 text-rose-600" />
                <StatCard icon={Zap} label="Avg AI Latency" value={stats.avgAiLatencyMs > 0 ? `${stats.avgAiLatencyMs}ms` : "—"} sub="Gemini response time" color="bg-orange-50 text-orange-600" />
                <StatCard icon={TrendingUp} label="Booking Rate" value={`${stats.bookingRate}%`} sub="calls → appointments" color="bg-teal-50 text-teal-600" />
                <StatCard icon={ArrowRight} label="Transfer Rate" value={`${stats.transferRate}%`} sub="calls escalated" color="bg-pink-50 text-pink-600" />
                <StatCard icon={CheckCircle} label="Avg Resolution" value={stats.avgResolutionScore > 0 ? `${Math.round(stats.avgResolutionScore * 100)}%` : "—"} sub="resolution score" color="bg-lime-50 text-lime-600" />
                <StatCard icon={ListTodo} label="Open Tasks" value={stats.openTasks} alert={stats.openTasks > 0} color="bg-red-50 text-red-600" />
              </div>
            )}

            {/* Make a Call */}
            <div className="bg-white rounded-xl border border-zinc-100 p-6 shadow-sm">
              <h2 className="text-base font-semibold text-zinc-900 mb-4">Make Outbound Call</h2>
              <div className="flex gap-3">
                <input
                  type="tel"
                  placeholder="+15551234567"
                  value={toNumber}
                  onChange={(e) => setToNumber(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && makeCall()}
                  className="flex-1 border border-zinc-200 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
                <button
                  onClick={makeCall}
                  disabled={calling || !toNumber.trim()}
                  className="bg-indigo-600 text-white px-5 py-2.5 rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:opacity-50 transition-colors flex items-center gap-2"
                >
                  <Phone size={15} />
                  {calling ? "Calling…" : "Call"}
                </button>
              </div>
            </div>

            {/* Recent Calls */}
            <div className="bg-white rounded-xl border border-zinc-100 shadow-sm">
              <div className="px-6 py-4 border-b border-zinc-100 flex items-center justify-between">
                <h2 className="text-base font-semibold text-zinc-900">Recent Calls</h2>
                <button onClick={() => setTab("calls")} className="text-sm text-indigo-600 hover:text-indigo-800 flex items-center gap-1">
                  View all <ArrowRight size={14} />
                </button>
              </div>
              <div className="divide-y divide-zinc-50">
                {calls.slice(0, 5).map((call) => (
                  <div key={call.call_sid} className="px-6 py-3 flex items-center gap-4">
                    <div className={`p-1.5 rounded-lg ${call.direction === "inbound" ? "bg-amber-50 text-amber-600" : "bg-cyan-50 text-cyan-600"}`}>
                      {call.direction === "inbound" ? <PhoneIncoming size={14} /> : <PhoneOutgoing size={14} />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-zinc-900 truncate">
                        {call.contact_name || (call.direction === "inbound" ? call.from_number : call.to_number)}
                      </p>
                      {call.call_summary && <p className="text-xs text-zinc-400 truncate">{call.call_summary}</p>}
                    </div>
                    {call.outcome && <Badge2 label={call.outcome.replace(/_/g, " ")} color="bg-zinc-100 text-zinc-600" />}
                    <span className="text-xs text-zinc-400 flex-shrink-0">{formatRelative(call.started_at)}</span>
                  </div>
                ))}
                {calls.length === 0 && <p className="px-6 py-8 text-sm text-zinc-400 text-center">No calls yet</p>}
              </div>
            </div>
          </div>
        )}

        {/* ── Call History Tab ── */}
        {tab === "calls" && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-bold text-zinc-900">Call History</h2>
              <span className="text-sm text-zinc-400">{calls.length} calls</span>
            </div>
            {calls.map((call) => (
              <div key={call.call_sid} className="bg-white rounded-xl border border-zinc-100 shadow-sm overflow-hidden">
                <button
                  onClick={() => loadCallDetail(call.call_sid)}
                  className="w-full px-6 py-4 flex items-center gap-4 hover:bg-zinc-50 transition-colors text-left"
                >
                  <div className={`p-2 rounded-lg flex-shrink-0 ${call.direction === "inbound" ? "bg-amber-50 text-amber-600" : "bg-cyan-50 text-cyan-600"}`}>
                    {call.direction === "inbound" ? <PhoneIncoming size={16} /> : <PhoneOutgoing size={16} />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="font-semibold text-zinc-900 text-sm">
                        {call.contact_name || (call.direction === "inbound" ? call.from_number : call.to_number)}
                      </span>
                      {call.intent && <Badge2 label={call.intent.replace(/_/g, " ")} color="bg-indigo-50 text-indigo-600" />}
                      {call.outcome && <Badge2 label={call.outcome.replace(/_/g, " ")} color="bg-zinc-100 text-zinc-600" />}
                      {call.sentiment && <span className={`text-xs ${sentimentColor(call.sentiment)}`}>{call.sentiment}</span>}
                    </div>
                    {call.call_summary && <p className="text-xs text-zinc-500 truncate">{call.call_summary}</p>}
                    {call.next_action && <p className="text-xs text-amber-600 mt-0.5">→ {call.next_action}</p>}
                  </div>
                  <div className="text-right flex-shrink-0 space-y-1">
                    <div className="flex items-center gap-2 justify-end">
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                        call.status === "in-progress" ? "bg-emerald-100 text-emerald-700" :
                        call.status === "completed" ? "bg-zinc-100 text-zinc-600" :
                        "bg-red-100 text-red-600"
                      }`}>{call.status}</span>
                      {call.summary_score !== null && (
                        <span className={`text-xs font-bold ${resolutionColor(call.summary_score)}`}>
                          {Math.round((call.summary_score || 0) * 100)}%
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-zinc-400">{formatDuration(call.duration_seconds)} · {call.message_count} turns</p>
                    <p className="text-xs text-zinc-400">{formatRelative(call.started_at)}</p>
                  </div>
                  {expandedCall === call.call_sid ? <ChevronUp size={16} className="text-zinc-400 flex-shrink-0" /> : <ChevronDown size={16} className="text-zinc-400 flex-shrink-0" />}
                </button>

                {expandedCall === call.call_sid && callDetail && (
                  <div className="border-t border-zinc-100 px-6 py-4 bg-zinc-50 space-y-4">
                    {callDetail.summary && (
                      <div className="bg-white rounded-lg border border-zinc-100 p-4">
                        <p className="text-xs font-semibold text-zinc-500 uppercase mb-2">AI Summary</p>
                        <p className="text-sm text-zinc-700">{callDetail.summary.summary}</p>
                        <div className="flex gap-4 mt-2 text-xs text-zinc-500">
                          <span>Intent: <strong>{callDetail.summary.intent}</strong></span>
                          <span>Outcome: <strong>{callDetail.summary.outcome}</strong></span>
                          <span>Resolution: <strong className={resolutionColor(callDetail.summary.resolution_score)}>{Math.round((callDetail.summary.resolution_score || 0) * 100)}%</strong></span>
                        </div>
                        {callDetail.summary.next_action && (
                          <p className="text-xs text-amber-600 mt-1">Next: {callDetail.summary.next_action}</p>
                        )}
                      </div>
                    )}

                    {/* Live Tool Invocations */}
                    {callDetail.events && callDetail.events.filter((e: any) => e.event_type === "TOOL_EXECUTED").length > 0 && (
                      <div className="bg-white rounded-lg border border-indigo-100 p-4">
                        <p className="text-xs font-semibold text-zinc-500 uppercase mb-2 flex items-center gap-1">
                          <Wrench size={12} /> Tools Invoked During Call
                        </p>
                        <div className="space-y-2">
                          {callDetail.events
                            .filter((e: any) => e.event_type === "TOOL_EXECUTED")
                            .map((e: any, i: number) => {
                              let payload: any = {};
                              try { payload = JSON.parse(e.payload || "{}"); } catch {}
                              return (
                                <div key={i} className="flex items-center gap-3 text-xs">
                                  <span className={`px-2 py-0.5 rounded-full font-medium ${
                                    payload.success !== false ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-600"
                                  }`}>
                                    {payload.tool || "tool"}
                                  </span>
                                  <span className="text-zinc-500">{e.created_at}</span>
                                  {payload.durationMs && <span className="text-zinc-400">{payload.durationMs}ms</span>}
                                </div>
                              );
                            })}
                        </div>
                      </div>
                    )}

                    <div className="space-y-2">
                      <p className="text-xs font-semibold text-zinc-500 uppercase">Transcript</p>
                      {callDetail.messages.map((msg) => (
                        <div key={msg.id} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                          <div className={`max-w-lg px-4 py-2 rounded-2xl text-sm ${
                            msg.role === "user"
                              ? "bg-indigo-600 text-white rounded-br-sm"
                              : "bg-white border border-zinc-200 text-zinc-800 rounded-bl-sm"
                          }`}>
                            {msg.text}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ))}
            {calls.length === 0 && (
              <div className="bg-white rounded-xl border border-zinc-100 p-16 text-center">
                <Phone size={32} className="text-zinc-300 mx-auto mb-3" />
                <p className="text-zinc-400">No calls yet. Make your first call from the Dashboard.</p>
              </div>
            )}
          </div>
        )}

        {/* ── Contacts Tab ── */}
        {tab === "contacts" && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-bold text-zinc-900">Contacts</h2>
              <span className="text-sm text-zinc-400">{contacts.length} contacts</span>
            </div>
            <div className="bg-white rounded-xl border border-zinc-100 shadow-sm overflow-hidden">
              <div className="divide-y divide-zinc-50">
                {contacts.map((contact) => (
                  <div key={contact.id} className="px-6 py-4 flex items-center gap-4">
                    <div className="p-2 bg-violet-50 text-violet-600 rounded-lg flex-shrink-0">
                      <User size={16} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-semibold text-zinc-900">{contact.name || contact.phone_number}</p>
                        {contact.name && <p className="text-xs text-zinc-400">{contact.phone_number}</p>}
                        {contact.do_not_call ? <Badge2 label="DNC" color="bg-red-100 text-red-600" /> : null}
                      </div>
                      {contact.last_summary && <p className="text-xs text-zinc-500 truncate mt-0.5">{contact.last_summary}</p>}
                    </div>
                    <div className="text-right flex-shrink-0 space-y-1">
                      <p className="text-xs text-zinc-500">{contact.total_calls} call{contact.total_calls !== 1 ? "s" : ""}</p>
                      {contact.last_outcome && <Badge2 label={contact.last_outcome.replace(/_/g, " ")} color="bg-zinc-100 text-zinc-600" />}
                      {contact.open_tasks_count > 0 && (
                        <Badge2 label={`${contact.open_tasks_count} open task${contact.open_tasks_count !== 1 ? "s" : ""}`} color="bg-amber-100 text-amber-700" />
                      )}
                      <p className="text-xs text-zinc-400">Last: {formatRelative(contact.last_seen)}</p>
                    </div>
                  </div>
                ))}
                {contacts.length === 0 && (
                  <p className="px-6 py-12 text-sm text-zinc-400 text-center">No contacts yet. They're created automatically when calls come in.</p>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ── Tasks Tab ── */}
        {tab === "tasks" && (
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-bold text-zinc-900">Tasks & Follow-ups</h2>
              <span className="text-sm text-zinc-400">{tasks.length} open</span>
            </div>

            {/* Pending Handoffs */}
            {handoffs.length > 0 && (
              <div>
                <h3 className="text-sm font-semibold text-zinc-500 uppercase mb-3 flex items-center gap-2">
                  <ShieldAlert size={14} className="text-red-500" /> Pending Handoffs
                </h3>
                <div className="space-y-3">
                  {handoffs.map((h) => (
                    <div key={h.id} className="bg-white rounded-xl border border-red-100 shadow-sm p-5">
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="font-semibold text-zinc-900 text-sm">{h.contact_name || h.phone_number || "Unknown caller"}</span>
                            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${urgencyColor(h.urgency)}`}>{h.urgency}</span>
                          </div>
                          <p className="text-sm text-zinc-700 mb-1">{h.reason}</p>
                          {h.recommended_action && <p className="text-xs text-amber-600">→ {h.recommended_action}</p>}
                          {h.transcript_snippet && <p className="text-xs text-zinc-400 mt-1 italic">"{h.transcript_snippet}"</p>}
                        </div>
                        <div className="flex flex-col items-end gap-2">
                          <p className="text-xs text-zinc-400">{formatRelative(h.created_at)}</p>
                          <button
                            onClick={() => acknowledgeHandoff(h.id)}
                            className="text-xs bg-zinc-900 text-white px-3 py-1.5 rounded-lg hover:bg-zinc-700 transition-colors"
                          >
                            Acknowledge
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Open Tasks */}
            <div>
              <h3 className="text-sm font-semibold text-zinc-500 uppercase mb-3 flex items-center gap-2">
                <ListTodo size={14} /> Open Tasks
              </h3>
              <div className="space-y-3">
                {tasks.map((task) => (
                  <div key={task.id} className="bg-white rounded-xl border border-zinc-100 shadow-sm p-5 flex items-start gap-4">
                    <div className="p-2 bg-amber-50 text-amber-600 rounded-lg flex-shrink-0">
                      <ListTodo size={15} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-semibold text-zinc-900 text-sm">{task.contact_name || task.phone_number || "Unknown"}</span>
                        <Badge2 label={task.task_type.replace(/_/g, " ")} color="bg-zinc-100 text-zinc-600" />
                      </div>
                      {task.notes && <p className="text-sm text-zinc-600">{task.notes}</p>}
                      <p className="text-xs text-zinc-400 mt-1">
                        Created {formatRelative(task.created_at)}
                        {task.due_at ? ` · Due ${formatDate(task.due_at)}` : ""}
                      </p>
                    </div>
                    <button
                      onClick={() => completeTask(task.id)}
                      className="text-xs bg-emerald-600 text-white px-3 py-1.5 rounded-lg hover:bg-emerald-700 transition-colors flex-shrink-0"
                    >
                      Complete
                    </button>
                  </div>
                ))}
                {tasks.length === 0 && handoffs.length === 0 && (
                  <div className="bg-white rounded-xl border border-zinc-100 p-12 text-center">
                    <CheckCircle size={32} className="text-emerald-300 mx-auto mb-3" />
                    <p className="text-zinc-400">All caught up. No open tasks.</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ── Agent Config Tab ── */}
        {tab === "agents" && (
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-bold text-zinc-900">Agent Configuration</h2>
              <button
                onClick={() => setEditingAgent({ name: "", system_prompt: "", greeting: "", voice: "Polly.Joanna", language: "en-US", vertical: "general", max_turns: 20 })}
                className="bg-indigo-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-indigo-700 transition-colors"
              >
                + New Agent
              </button>
            </div>

            {editingAgent && (
              <div className="bg-white rounded-xl border border-indigo-100 shadow-sm p-6">
                <h3 className="font-semibold text-zinc-900 mb-4">{editingAgent.id ? "Edit Agent" : "New Agent"}</h3>
                <div className="grid grid-cols-2 gap-4 mb-4">
                  <div>
                    <label className="text-xs font-medium text-zinc-500 block mb-1">Name</label>
                    <input value={editingAgent.name || ""} onChange={(e) => setEditingAgent({ ...editingAgent, name: e.target.value })}
                      className="w-full border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-zinc-500 block mb-1">Voice</label>
                    <select value={editingAgent.voice || "Polly.Joanna"} onChange={(e) => setEditingAgent({ ...editingAgent, voice: e.target.value })}
                      className="w-full border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500">
                      {["Polly.Joanna", "Polly.Matthew", "Polly.Salli", "Polly.Joey", "Polly.Kendra", "Polly.Kimberly", "Polly.Amy", "Polly.Brian"].map((v) => (
                        <option key={v} value={v}>{v}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="text-xs font-medium text-zinc-500 block mb-1">Vertical</label>
                    <select value={editingAgent.vertical || "general"} onChange={(e) => setEditingAgent({ ...editingAgent, vertical: e.target.value })}
                      className="w-full border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500">
                      {["general", "home_services", "legal_intake", "med_spa", "real_estate", "auto_shop", "insurance"].map((v) => (
                        <option key={v} value={v}>{v.replace(/_/g, " ")}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="text-xs font-medium text-zinc-500 block mb-1">Max Turns</label>
                    <input type="number" min={3} max={50} value={editingAgent.max_turns || 20}
                      onChange={(e) => setEditingAgent({ ...editingAgent, max_turns: parseInt(e.target.value) })}
                      className="w-full border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                  </div>
                </div>
                <div className="mb-4">
                  <label className="text-xs font-medium text-zinc-500 block mb-1">Greeting</label>
                  <input value={editingAgent.greeting || ""} onChange={(e) => setEditingAgent({ ...editingAgent, greeting: e.target.value })}
                    className="w-full border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                </div>
                <div className="mb-4">
                  <label className="text-xs font-medium text-zinc-500 block mb-1">System Prompt</label>
                  <textarea rows={6} value={editingAgent.system_prompt || ""} onChange={(e) => setEditingAgent({ ...editingAgent, system_prompt: e.target.value })}
                    className="w-full border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none font-mono" />
                </div>
                <div className="flex gap-3">
                  <button onClick={saveAgent} className="bg-indigo-600 text-white px-5 py-2 rounded-lg text-sm font-medium hover:bg-indigo-700 transition-colors">Save</button>
                  <button onClick={() => setEditingAgent(null)} className="border border-zinc-200 text-zinc-600 px-5 py-2 rounded-lg text-sm font-medium hover:bg-zinc-50 transition-colors">Cancel</button>
                </div>
              </div>
            )}

            <div className="space-y-3">
              {agents.map((agent) => (
                <div key={agent.id} className={`bg-white rounded-xl border shadow-sm p-5 ${agent.is_active ? "border-indigo-200" : "border-zinc-100"}`}>
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <h3 className="font-semibold text-zinc-900">{agent.name}</h3>
                        {agent.is_active ? <Badge2 label="Active" color="bg-emerald-100 text-emerald-700" /> : null}
                        <Badge2 label={agent.vertical.replace(/_/g, " ")} color="bg-zinc-100 text-zinc-600" />
                        <Badge2 label={agent.voice} color="bg-indigo-50 text-indigo-600" />
                        <Badge2 label={`${agent.max_turns} turns`} color="bg-zinc-100 text-zinc-500" />
                      </div>
                      <p className="text-xs text-zinc-500 italic">"{agent.greeting}"</p>
                      <p className="text-xs text-zinc-400 mt-1 line-clamp-2">{agent.system_prompt}</p>
                    </div>
                    <div className="flex gap-2 flex-shrink-0">
                      {!agent.is_active && (
                        <button onClick={() => activateAgent(agent.id)} className="text-xs bg-indigo-600 text-white px-3 py-1.5 rounded-lg hover:bg-indigo-700 transition-colors">Activate</button>
                      )}
                      <button onClick={() => setEditingAgent(agent)} className="text-xs border border-zinc-200 text-zinc-600 px-3 py-1.5 rounded-lg hover:bg-zinc-50 transition-colors">Edit</button>
                      <button onClick={() => deleteAgent(agent.id)} className="text-xs border border-red-100 text-red-500 px-3 py-1.5 rounded-lg hover:bg-red-50 transition-colors">Delete</button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Setup Tab ── */}
        {tab === "setup" && (
          <div className="space-y-6 max-w-2xl">
            <h2 className="text-xl font-bold text-zinc-900">Setup & Configuration</h2>

            <div className="bg-white rounded-xl border border-zinc-100 shadow-sm p-6 space-y-4">
              <h3 className="font-semibold text-zinc-900">Twilio Webhook URLs</h3>
              <p className="text-sm text-zinc-500">Configure these in your Twilio phone number settings.</p>
              {webhookUrls ? (
                <div className="space-y-3">
                  {[
                    { label: "Incoming Call Webhook (Voice URL)", value: webhookUrls.incomingUrl },
                    { label: "Status Callback URL", value: webhookUrls.statusUrl },
                  ].map(({ label, value }) => (
                    <div key={label}>
                      <p className="text-xs font-medium text-zinc-500 mb-1">{label}</p>
                      <div className="flex gap-2">
                        <code className="flex-1 bg-zinc-50 border border-zinc-200 rounded-lg px-3 py-2 text-xs text-zinc-700 font-mono break-all">{value}</code>
                        <button onClick={() => navigator.clipboard.writeText(value)} className="text-xs border border-zinc-200 text-zinc-600 px-3 py-2 rounded-lg hover:bg-zinc-50 transition-colors flex-shrink-0">Copy</button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-zinc-400">Loading…</p>
              )}
            </div>

            <div className="bg-white rounded-xl border border-zinc-100 shadow-sm p-6">
              <h3 className="font-semibold text-zinc-900 mb-3">Environment Variables</h3>
              <div className="space-y-2 text-sm font-mono">
                {[
                  ["GEMINI_API_KEY", "Required — Gemini 2.0 Flash API key"],
                  ["TWILIO_ACCOUNT_SID", "Required — Twilio account SID"],
                  ["TWILIO_AUTH_TOKEN", "Required — Twilio auth token"],
                  ["TWILIO_PHONE_NUMBER", "Required — E.164 format (+15551234567)"],
                  ["APP_URL", "Required — Your public URL (ngrok for local dev)"],
                  ["DASHBOARD_API_KEY", "Optional — Protect API with X-Api-Key header"],
                  ["PORT", "Optional — Default: 3000"],
                ].map(([key, desc]) => (
                  <div key={key} className="flex gap-3">
                    <code className="text-indigo-600 w-52 flex-shrink-0">{key}</code>
                    <span className="text-zinc-500 text-xs self-center">{desc}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="bg-white rounded-xl border border-zinc-100 shadow-sm p-6">
              <h3 className="font-semibold text-zinc-900 mb-3">Quick Start</h3>
              <pre className="bg-zinc-50 rounded-lg p-4 text-xs text-zinc-700 font-mono overflow-x-auto whitespace-pre-wrap">{`cp .env.example .env.local
# Fill in your values
npm install
npm run dev

# For production:
docker-compose up -d`}</pre>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
