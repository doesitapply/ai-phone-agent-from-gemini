import React, { useState, useEffect, useCallback } from "react";
import {
  Phone,
  PhoneCall,
  PhoneIncoming,
  PhoneOutgoing,
  Settings,
  Activity,
  AlertCircle,
  Bot,
  BarChart3,
  MessageSquare,
  Clock,
  CheckCircle,
  XCircle,
  ChevronDown,
  ChevronUp,
  Plus,
  Trash2,
  Edit3,
  Zap,
  Copy,
  Check,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────
type CallRecord = {
  call_sid: string;
  direction: "inbound" | "outbound";
  to_number: string | null;
  from_number: string | null;
  status: string;
  started_at: string;
  ended_at: string | null;
  duration_seconds: number | null;
  agent_name: string | null;
  message_count: number;
};

type Message = {
  id: number;
  call_sid: string;
  role: "user" | "assistant";
  text: string;
  created_at: string;
};

type AgentConfig = {
  id: number;
  name: string;
  system_prompt: string;
  greeting: string;
  voice: string;
  language: string;
  is_active: number;
  created_at: string;
};

type Stats = {
  totalCalls: number;
  activeCalls: number;
  completedCalls: number;
  totalMessages: number;
  avgDurationSeconds: number;
  inboundCalls: number;
  outboundCalls: number;
  avgAiLatencyMs: number;
};

type WebhookUrls = {
  incomingUrl: string;
  statusUrl: string;
};

// ─── Utility ──────────────────────────────────────────────────────────────────
const formatDuration = (seconds: number | null) => {
  if (!seconds) return "—";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
};

const formatTime = (iso: string) => {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
};

const statusColor = (status: string) => {
  switch (status) {
    case "completed": return "text-emerald-600 bg-emerald-50 border-emerald-100";
    case "in-progress": return "text-blue-600 bg-blue-50 border-blue-100 animate-pulse";
    case "failed":
    case "busy":
    case "no-answer": return "text-red-600 bg-red-50 border-red-100";
    default: return "text-zinc-500 bg-zinc-50 border-zinc-100";
  }
};

const VOICES = [
  { value: "Polly.Joanna", label: "Joanna (US English, Female)" },
  { value: "Polly.Matthew", label: "Matthew (US English, Male)" },
  { value: "Polly.Amy", label: "Amy (British English, Female)" },
  { value: "Polly.Brian", label: "Brian (British English, Male)" },
  { value: "Polly.Salli", label: "Salli (US English, Female)" },
  { value: "Polly.Joey", label: "Joey (US English, Male)" },
  { value: "Polly.Nicole", label: "Nicole (Australian, Female)" },
  { value: "Polly.Russell", label: "Russell (Australian, Male)" },
];

const LANGUAGES = [
  { value: "en-US", label: "English (US)" },
  { value: "en-GB", label: "English (UK)" },
  { value: "en-AU", label: "English (Australia)" },
  { value: "es-US", label: "Spanish (US)" },
  { value: "es-ES", label: "Spanish (Spain)" },
  { value: "fr-FR", label: "French" },
  { value: "de-DE", label: "German" },
  { value: "pt-BR", label: "Portuguese (Brazil)" },
];

// ─── Components ───────────────────────────────────────────────────────────────
const StatCard = ({ icon: Icon, label, value, sub, color }: {
  icon: React.ElementType; label: string; value: string | number; sub?: string; color: string;
}) => (
  <div className="bg-white rounded-2xl border border-zinc-200 p-5 shadow-sm">
    <div className="flex items-start justify-between">
      <div>
        <p className="text-sm text-zinc-500 font-medium">{label}</p>
        <p className="text-3xl font-bold text-zinc-900 mt-1">{value}</p>
        {sub && <p className="text-xs text-zinc-400 mt-1">{sub}</p>}
      </div>
      <div className={`p-2.5 rounded-xl ${color}`}>
        <Icon size={20} />
      </div>
    </div>
  </div>
);

const CopyButton = ({ text }: { text: string }) => {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <button onClick={copy} className="ml-2 p-1 text-zinc-400 hover:text-zinc-600 transition-colors" title="Copy">
      {copied ? <Check size={14} className="text-emerald-500" /> : <Copy size={14} />}
    </button>
  );
};

// ─── Main App ─────────────────────────────────────────────────────────────────
type Tab = "dashboard" | "calls" | "agents" | "setup";

export default function App() {
  const [tab, setTab] = useState<Tab>("dashboard");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [callStatus, setCallStatus] = useState("");
  const [isCalling, setIsCalling] = useState(false);
  const [calls, setCalls] = useState<CallRecord[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const [webhookUrls, setWebhookUrls] = useState<WebhookUrls | null>(null);
  const [expandedCall, setExpandedCall] = useState<string | null>(null);
  const [callMessages, setCallMessages] = useState<Record<string, Message[]>>({});
  const [showAgentForm, setShowAgentForm] = useState(false);
  const [editingAgent, setEditingAgent] = useState<AgentConfig | null>(null);

  // Agent form state
  const [agentForm, setAgentForm] = useState({
    name: "",
    system_prompt: "You are a helpful, friendly AI assistant on a phone call. Keep your answers concise, conversational, and easy to understand when spoken aloud. Do not use markdown or special formatting.",
    greeting: "Hello! I'm your AI assistant. How can I help you today?",
    voice: "Polly.Joanna",
    language: "en-US",
  });

  const fetchData = useCallback(async () => {
    try {
      const [callsRes, statsRes, agentsRes, webhookRes] = await Promise.all([
        fetch("/api/calls"),
        fetch("/api/stats"),
        fetch("/api/agents"),
        fetch("/api/webhook-url"),
      ]);
      if (callsRes.ok) setCalls(await callsRes.json());
      if (statsRes.ok) setStats(await statsRes.json());
      if (agentsRes.ok) setAgents(await agentsRes.json());
      if (webhookRes.ok) setWebhookUrls(await webhookRes.json());
    } catch (err) {
      console.error("Fetch error:", err);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 3000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const handleCall = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!phoneNumber) return;
    setIsCalling(true);
    setCallStatus("Initiating call...");
    try {
      const res = await fetch("/api/calls", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: phoneNumber }),
      });
      const data = await res.json();
      if (res.ok) {
        setCallStatus(`✓ Call initiated — SID: ${data.callSid}`);
        setPhoneNumber("");
        fetchData();
      } else {
        setCallStatus(`Error: ${data.error}`);
      }
    } catch (err: any) {
      setCallStatus(`Error: ${err.message}`);
    } finally {
      setIsCalling(false);
    }
  };

  const toggleCallExpand = async (callSid: string) => {
    if (expandedCall === callSid) {
      setExpandedCall(null);
      return;
    }
    setExpandedCall(callSid);
    if (!callMessages[callSid]) {
      try {
        const res = await fetch(`/api/calls/${callSid}/messages`);
        if (res.ok) {
          const data = await res.json();
          setCallMessages((prev) => ({ ...prev, [callSid]: data.messages }));
        }
      } catch (err) {
        console.error("Failed to fetch messages:", err);
      }
    }
  };

  const handleSaveAgent = async () => {
    const url = editingAgent ? `/api/agents/${editingAgent.id}` : "/api/agents";
    const method = editingAgent ? "PUT" : "POST";
    try {
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(agentForm),
      });
      if (res.ok) {
        setShowAgentForm(false);
        setEditingAgent(null);
        setAgentForm({ name: "", system_prompt: "", greeting: "", voice: "Polly.Joanna", language: "en-US" });
        fetchData();
      }
    } catch (err) {
      console.error("Failed to save agent:", err);
    }
  };

  const handleActivateAgent = async (id: number) => {
    await fetch(`/api/agents/${id}/activate`, { method: "PUT" });
    fetchData();
  };

  const handleDeleteAgent = async (id: number) => {
    if (!confirm("Delete this agent configuration?")) return;
    await fetch(`/api/agents/${id}`, { method: "DELETE" });
    fetchData();
  };

  const startEditAgent = (agent: AgentConfig) => {
    setEditingAgent(agent);
    setAgentForm({
      name: agent.name,
      system_prompt: agent.system_prompt,
      greeting: agent.greeting,
      voice: agent.voice,
      language: agent.language,
    });
    setShowAgentForm(true);
  };

  const navItems: { id: Tab; label: string; icon: React.ElementType }[] = [
    { id: "dashboard", label: "Dashboard", icon: BarChart3 },
    { id: "calls", label: "Call History", icon: Activity },
    { id: "agents", label: "Agent Config", icon: Bot },
    { id: "setup", label: "Setup", icon: Settings },
  ];

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900 font-sans">
      {/* Header */}
      <header className="bg-white border-b border-zinc-200 px-6 py-4 flex items-center justify-between sticky top-0 z-10 shadow-sm">
        <div className="flex items-center space-x-3">
          <div className="p-2 bg-indigo-600 rounded-xl text-white">
            <PhoneCall size={22} />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight">AI Phone Agent</h1>
            <p className="text-xs text-zinc-400">Powered by Gemini + Twilio</p>
          </div>
        </div>
        {stats && stats.activeCalls > 0 && (
          <div className="flex items-center space-x-2 bg-blue-50 border border-blue-100 text-blue-700 px-3 py-1.5 rounded-full text-sm font-medium">
            <span className="w-2 h-2 bg-blue-500 rounded-full animate-pulse" />
            <span>{stats.activeCalls} active call{stats.activeCalls > 1 ? "s" : ""}</span>
          </div>
        )}
      </header>

      {/* Nav */}
      <nav className="bg-white border-b border-zinc-200 px-6 flex space-x-1">
        {navItems.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`flex items-center space-x-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
              tab === id
                ? "border-indigo-600 text-indigo-600"
                : "border-transparent text-zinc-500 hover:text-zinc-800"
            }`}
          >
            <Icon size={16} />
            <span>{label}</span>
          </button>
        ))}
      </nav>

      <main className="max-w-6xl mx-auto px-6 py-8 space-y-8">

        {/* ── Dashboard Tab ── */}
        {tab === "dashboard" && (
          <div className="space-y-8">
            {/* Stats Grid */}
            {stats && (
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                <StatCard icon={Phone} label="Total Calls" value={stats.totalCalls} color="bg-indigo-50 text-indigo-600" />
                <StatCard icon={Zap} label="Active Now" value={stats.activeCalls} color="bg-blue-50 text-blue-600" />
                <StatCard icon={CheckCircle} label="Completed" value={stats.completedCalls} color="bg-emerald-50 text-emerald-600" />
                <StatCard icon={MessageSquare} label="Total Messages" value={stats.totalMessages} color="bg-violet-50 text-violet-600" />
                <StatCard icon={PhoneIncoming} label="Inbound" value={stats.inboundCalls} color="bg-amber-50 text-amber-600" />
                <StatCard icon={PhoneOutgoing} label="Outbound" value={stats.outboundCalls} color="bg-cyan-50 text-cyan-600" />
                <StatCard icon={Clock} label="Avg Duration" value={formatDuration(stats.avgDurationSeconds)} color="bg-rose-50 text-rose-600" />
                <StatCard icon={Zap} label="Avg AI Latency" value={stats.avgAiLatencyMs > 0 ? `${stats.avgAiLatencyMs}ms` : "—"} sub="Gemini response time" color="bg-orange-50 text-orange-600" />
                <StatCard
                  icon={Bot}
                  label="Active Agent"
                  value={agents.find((a) => a.is_active)?.name || "None"}
                  color="bg-zinc-100 text-zinc-600"
                />
              </div>
            )}

            {/* Make a Call */}
            <div className="bg-white rounded-2xl border border-zinc-200 shadow-sm p-6">
              <h2 className="text-lg font-semibold flex items-center mb-4">
                <PhoneOutgoing className="mr-2 text-indigo-500" size={20} />
                Make Outbound Call
              </h2>
              <form onSubmit={handleCall} className="flex gap-3">
                <div className="flex-1">
                  <input
                    type="tel"
                    placeholder="+1 (555) 000-0000"
                    value={phoneNumber}
                    onChange={(e) => setPhoneNumber(e.target.value)}
                    className="w-full px-4 py-2.5 border border-zinc-300 rounded-xl focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none transition-all text-sm"
                    required
                  />
                </div>
                <button
                  type="submit"
                  disabled={isCalling || !phoneNumber}
                  className="bg-indigo-600 hover:bg-indigo-700 text-white font-medium px-6 py-2.5 rounded-xl transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center space-x-2 text-sm"
                >
                  <Phone size={16} />
                  <span>{isCalling ? "Calling..." : "Call Now"}</span>
                </button>
              </form>
              {callStatus && (
                <p className={`mt-3 text-sm px-3 py-2 rounded-lg ${callStatus.startsWith("Error") ? "bg-red-50 text-red-700" : "bg-emerald-50 text-emerald-700"}`}>
                  {callStatus}
                </p>
              )}
            </div>

            {/* Recent Calls */}
            <div className="bg-white rounded-2xl border border-zinc-200 shadow-sm p-6">
              <h2 className="text-lg font-semibold flex items-center mb-4">
                <Activity className="mr-2 text-zinc-400" size={20} />
                Recent Calls
              </h2>
              {calls.length === 0 ? (
                <div className="text-center py-12 text-zinc-400">
                  <Phone size={40} className="mx-auto mb-3 opacity-20" />
                  <p>No calls yet. Make your first call above.</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {calls.slice(0, 5).map((call) => (
                    <div key={call.call_sid} className="border border-zinc-100 rounded-xl overflow-hidden">
                      <button
                        onClick={() => toggleCallExpand(call.call_sid)}
                        className="w-full flex items-center justify-between px-4 py-3 hover:bg-zinc-50 transition-colors text-left"
                      >
                        <div className="flex items-center space-x-3">
                          {call.direction === "inbound"
                            ? <PhoneIncoming size={16} className="text-emerald-500" />
                            : <PhoneOutgoing size={16} className="text-blue-500" />}
                          <div>
                            <p className="text-sm font-medium">
                              {call.direction === "inbound" ? call.from_number : call.to_number}
                            </p>
                            <p className="text-xs text-zinc-400">{formatTime(call.started_at)}</p>
                          </div>
                        </div>
                        <div className="flex items-center space-x-3">
                          <span className={`text-xs px-2 py-1 rounded-full border font-medium ${statusColor(call.status)}`}>
                            {call.status}
                          </span>
                          <span className="text-xs text-zinc-400">{formatDuration(call.duration_seconds)}</span>
                          <span className="text-xs text-zinc-400">{call.message_count} msgs</span>
                          {expandedCall === call.call_sid ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                        </div>
                      </button>
                      {expandedCall === call.call_sid && (
                        <div className="border-t border-zinc-100 p-4 bg-zinc-50 space-y-3">
                          {(callMessages[call.call_sid] || []).length === 0 ? (
                            <p className="text-sm text-zinc-400 italic">No messages recorded.</p>
                          ) : (
                            (callMessages[call.call_sid] || []).map((msg) => (
                              <div key={msg.id} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                                <div className={`max-w-[75%] rounded-2xl px-4 py-2.5 text-sm ${
                                  msg.role === "user"
                                    ? "bg-indigo-600 text-white rounded-tr-sm"
                                    : "bg-white border border-zinc-200 text-zinc-800 rounded-tl-sm"
                                }`}>
                                  <span className="block text-[10px] opacity-60 mb-1 uppercase tracking-wider font-semibold">
                                    {msg.role === "user" ? "Caller" : "AI Agent"}
                                  </span>
                                  {msg.text}
                                </div>
                              </div>
                            ))
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                  {calls.length > 5 && (
                    <button onClick={() => setTab("calls")} className="text-sm text-indigo-600 hover:underline pt-1">
                      View all {calls.length} calls →
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── Call History Tab ── */}
        {tab === "calls" && (
          <div className="bg-white rounded-2xl border border-zinc-200 shadow-sm p-6">
            <h2 className="text-lg font-semibold flex items-center mb-6">
              <Activity className="mr-2 text-zinc-400" size={20} />
              Call History
              <span className="ml-2 text-sm font-normal text-zinc-400">({calls.length} total)</span>
            </h2>
            {calls.length === 0 ? (
              <div className="text-center py-16 text-zinc-400">
                <Phone size={48} className="mx-auto mb-3 opacity-20" />
                <p>No calls recorded yet.</p>
              </div>
            ) : (
              <div className="space-y-2">
                {calls.map((call) => (
                  <div key={call.call_sid} className="border border-zinc-100 rounded-xl overflow-hidden">
                    <button
                      onClick={() => toggleCallExpand(call.call_sid)}
                      className="w-full flex items-center justify-between px-4 py-3 hover:bg-zinc-50 transition-colors text-left"
                    >
                      <div className="flex items-center space-x-3">
                        {call.direction === "inbound"
                          ? <PhoneIncoming size={16} className="text-emerald-500" />
                          : <PhoneOutgoing size={16} className="text-blue-500" />}
                        <div>
                          <p className="text-sm font-medium">
                            {call.direction === "inbound" ? `From: ${call.from_number}` : `To: ${call.to_number}`}
                          </p>
                          <p className="text-xs text-zinc-400 font-mono">{call.call_sid}</p>
                        </div>
                      </div>
                      <div className="flex items-center space-x-3">
                        <span className="text-xs text-zinc-400 hidden md:block">{formatTime(call.started_at)}</span>
                        <span className={`text-xs px-2 py-1 rounded-full border font-medium ${statusColor(call.status)}`}>
                          {call.status}
                        </span>
                        <span className="text-xs text-zinc-400">{formatDuration(call.duration_seconds)}</span>
                        <span className="text-xs text-zinc-400">{call.message_count} msgs</span>
                        {expandedCall === call.call_sid ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                      </div>
                    </button>
                    {expandedCall === call.call_sid && (
                      <div className="border-t border-zinc-100 p-4 bg-zinc-50 space-y-3">
                        <div className="flex flex-wrap gap-4 text-xs text-zinc-500 mb-3">
                          <span>Agent: <strong>{call.agent_name || "—"}</strong></span>
                          <span>Direction: <strong>{call.direction}</strong></span>
                          {call.ended_at && <span>Ended: <strong>{formatTime(call.ended_at)}</strong></span>}
                        </div>
                        {(callMessages[call.call_sid] || []).length === 0 ? (
                          <p className="text-sm text-zinc-400 italic">No messages recorded.</p>
                        ) : (
                          (callMessages[call.call_sid] || []).map((msg) => (
                            <div key={msg.id} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                              <div className={`max-w-[75%] rounded-2xl px-4 py-2.5 text-sm ${
                                msg.role === "user"
                                  ? "bg-indigo-600 text-white rounded-tr-sm"
                                  : "bg-white border border-zinc-200 text-zinc-800 rounded-tl-sm"
                              }`}>
                                <span className="block text-[10px] opacity-60 mb-1 uppercase tracking-wider font-semibold">
                                  {msg.role === "user" ? "Caller" : "AI Agent"}
                                </span>
                                {msg.text}
                              </div>
                            </div>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── Agent Config Tab ── */}
        {tab === "agents" && (
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold flex items-center">
                <Bot className="mr-2 text-zinc-400" size={20} />
                Agent Configurations
              </h2>
              <button
                onClick={() => { setEditingAgent(null); setAgentForm({ name: "", system_prompt: "", greeting: "", voice: "Polly.Joanna", language: "en-US" }); setShowAgentForm(true); }}
                className="flex items-center space-x-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium px-4 py-2 rounded-xl transition-colors"
              >
                <Plus size={16} />
                <span>New Agent</span>
              </button>
            </div>

            {showAgentForm && (
              <div className="bg-white rounded-2xl border border-zinc-200 shadow-sm p-6 space-y-4">
                <h3 className="font-semibold text-zinc-800">{editingAgent ? "Edit Agent" : "Create New Agent"}</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-zinc-700 mb-1">Agent Name</label>
                    <input
                      value={agentForm.name}
                      onChange={(e) => setAgentForm((p) => ({ ...p, name: e.target.value }))}
                      placeholder="e.g., Customer Support Agent"
                      className="w-full px-3 py-2 border border-zinc-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-zinc-700 mb-1">Voice</label>
                    <select
                      value={agentForm.voice}
                      onChange={(e) => setAgentForm((p) => ({ ...p, voice: e.target.value }))}
                      className="w-full px-3 py-2 border border-zinc-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 outline-none"
                    >
                      {VOICES.map((v) => <option key={v.value} value={v.value}>{v.label}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-zinc-700 mb-1">Language</label>
                    <select
                      value={agentForm.language}
                      onChange={(e) => setAgentForm((p) => ({ ...p, language: e.target.value }))}
                      className="w-full px-3 py-2 border border-zinc-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 outline-none"
                    >
                      {LANGUAGES.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-zinc-700 mb-1">Greeting Message</label>
                    <input
                      value={agentForm.greeting}
                      onChange={(e) => setAgentForm((p) => ({ ...p, greeting: e.target.value }))}
                      placeholder="Hello! How can I help you today?"
                      className="w-full px-3 py-2 border border-zinc-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 outline-none"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-zinc-700 mb-1">System Prompt</label>
                  <textarea
                    value={agentForm.system_prompt}
                    onChange={(e) => setAgentForm((p) => ({ ...p, system_prompt: e.target.value }))}
                    rows={5}
                    placeholder="Describe the agent's personality, role, and behavior..."
                    className="w-full px-3 py-2 border border-zinc-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 outline-none resize-none"
                  />
                </div>
                <div className="flex space-x-3">
                  <button onClick={handleSaveAgent} className="bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium px-5 py-2 rounded-xl transition-colors">
                    {editingAgent ? "Save Changes" : "Create Agent"}
                  </button>
                  <button onClick={() => { setShowAgentForm(false); setEditingAgent(null); }} className="text-zinc-600 hover:text-zinc-800 text-sm font-medium px-5 py-2 rounded-xl border border-zinc-200 transition-colors">
                    Cancel
                  </button>
                </div>
              </div>
            )}

            <div className="space-y-3">
              {agents.map((agent) => (
                <div key={agent.id} className={`bg-white rounded-2xl border shadow-sm p-5 ${agent.is_active ? "border-indigo-200 ring-2 ring-indigo-100" : "border-zinc-200"}`}>
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="flex items-center space-x-2 mb-1">
                        <h3 className="font-semibold text-zinc-800">{agent.name}</h3>
                        {agent.is_active ? (
                          <span className="text-xs bg-indigo-100 text-indigo-700 px-2 py-0.5 rounded-full font-medium">Active</span>
                        ) : null}
                      </div>
                      <p className="text-xs text-zinc-500 mb-2">
                        Voice: {VOICES.find((v) => v.value === agent.voice)?.label || agent.voice} · Language: {agent.language}
                      </p>
                      <p className="text-sm text-zinc-600 italic">"{agent.greeting}"</p>
                      <p className="text-xs text-zinc-400 mt-2 line-clamp-2">{agent.system_prompt}</p>
                    </div>
                    <div className="flex items-center space-x-2 ml-4">
                      {!agent.is_active && (
                        <button onClick={() => handleActivateAgent(agent.id)} className="text-xs bg-indigo-50 hover:bg-indigo-100 text-indigo-700 px-3 py-1.5 rounded-lg font-medium transition-colors">
                          Activate
                        </button>
                      )}
                      <button onClick={() => startEditAgent(agent)} className="p-1.5 text-zinc-400 hover:text-zinc-600 transition-colors">
                        <Edit3 size={15} />
                      </button>
                      <button onClick={() => handleDeleteAgent(agent.id)} className="p-1.5 text-zinc-400 hover:text-red-500 transition-colors">
                        <Trash2 size={15} />
                      </button>
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
            <div className="bg-amber-50 border border-amber-200 rounded-2xl p-5 flex items-start space-x-3">
              <AlertCircle className="text-amber-600 shrink-0 mt-0.5" size={20} />
              <div>
                <p className="font-semibold text-amber-800">Configuration Required</p>
                <p className="text-sm text-amber-700 mt-1">Set the following environment variables in your <code className="bg-amber-100 px-1 rounded">.env.local</code> file before starting the server.</p>
              </div>
            </div>

            <div className="bg-white rounded-2xl border border-zinc-200 shadow-sm p-6 space-y-4">
              <h2 className="font-semibold flex items-center">
                <Settings className="mr-2 text-zinc-400" size={18} />
                Required Environment Variables
              </h2>
              {[
                { key: "GEMINI_API_KEY", desc: "Your Google Gemini API key", link: "https://aistudio.google.com/apikey" },
                { key: "TWILIO_ACCOUNT_SID", desc: "From your Twilio Console dashboard", link: "https://console.twilio.com" },
                { key: "TWILIO_AUTH_TOKEN", desc: "From your Twilio Console dashboard", link: "https://console.twilio.com" },
                { key: "TWILIO_PHONE_NUMBER", desc: "Your Twilio phone number (e.g. +15551234567)", link: "https://console.twilio.com/us1/develop/phone-numbers/manage/incoming" },
              ].map(({ key, desc, link }) => (
                <div key={key} className="p-3 bg-zinc-50 rounded-xl border border-zinc-100">
                  <div className="flex items-center justify-between">
                    <code className="text-sm font-mono font-semibold text-zinc-800">{key}</code>
                    <a href={link} target="_blank" rel="noopener noreferrer" className="text-xs text-indigo-600 hover:underline">Get it →</a>
                  </div>
                  <p className="text-xs text-zinc-500 mt-1">{desc}</p>
                </div>
              ))}
            </div>

            {webhookUrls && (
              <div className="bg-white rounded-2xl border border-zinc-200 shadow-sm p-6 space-y-4">
                <h2 className="font-semibold flex items-center">
                  <PhoneIncoming className="mr-2 text-zinc-400" size={18} />
                  Twilio Webhook Configuration
                </h2>
                <p className="text-sm text-zinc-600">
                  To receive inbound calls, configure your Twilio phone number's webhook URL in the{" "}
                  <a href="https://console.twilio.com" target="_blank" rel="noopener noreferrer" className="text-indigo-600 hover:underline">Twilio Console</a>.
                </p>
                <div>
                  <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-1">Voice Webhook (A Call Comes In)</p>
                  <div className="flex items-center bg-zinc-900 text-zinc-200 rounded-xl px-4 py-3 font-mono text-xs break-all">
                    <span className="flex-1">{webhookUrls.incomingUrl}</span>
                    <CopyButton text={webhookUrls.incomingUrl} />
                  </div>
                </div>
                <div>
                  <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-1">Status Callback URL</p>
                  <div className="flex items-center bg-zinc-900 text-zinc-200 rounded-xl px-4 py-3 font-mono text-xs break-all">
                    <span className="flex-1">{webhookUrls.statusUrl}</span>
                    <CopyButton text={webhookUrls.statusUrl} />
                  </div>
                </div>
                <p className="text-xs text-zinc-400">Set HTTP Method to <strong>POST</strong> for both.</p>
              </div>
            )}

            <div className="bg-white rounded-2xl border border-zinc-200 shadow-sm p-6 space-y-3">
              <h2 className="font-semibold flex items-center">
                <XCircle className="mr-2 text-zinc-400" size={18} />
                Quick Start
              </h2>
              <ol className="space-y-2 text-sm text-zinc-600 list-decimal list-inside">
                <li>Copy <code className="bg-zinc-100 px-1 rounded text-xs">.env.example</code> to <code className="bg-zinc-100 px-1 rounded text-xs">.env.local</code> and fill in your keys.</li>
                <li>Run <code className="bg-zinc-100 px-1 rounded text-xs">npm install</code> to install dependencies.</li>
                <li>Run <code className="bg-zinc-100 px-1 rounded text-xs">npm run dev</code> to start the server.</li>
                <li>Expose your local server with <code className="bg-zinc-100 px-1 rounded text-xs">ngrok http 3000</code> for Twilio webhooks.</li>
                <li>Set the webhook URL in your Twilio phone number settings.</li>
                <li>Configure your AI agent persona in the <strong>Agent Config</strong> tab.</li>
                <li>Make or receive calls!</li>
              </ol>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
