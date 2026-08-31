import React, { useEffect, useState } from "react";
import { CheckCircle2, Layers, Loader2, RotateCcw, Target } from "lucide-react";

type KnowledgeQuotePolicy = "do_not_quote" | "starting_at" | "range" | "fixed" | "custom_quote_required";

type WorkspaceKnowledgeSource = {
  id: number;
  title: string;
  source_type: string;
};

type WorkspaceProfile = {
  business_name?: string | null;
  business_tagline?: string | null;
  business_phone?: string | null;
  business_website?: string | null;
  business_address?: string | null;
  business_hours?: string | null;
  agent_name?: string | null;
};

type WorkspaceKnowledgePack = {
  id: number;
  title: string;
  status: "draft" | "active" | "archived";
  source_ids: number[];
  quote_policy: KnowledgeQuotePolicy;
  updated_at: string;
};

type KnowledgeResponse = {
  packs?: WorkspaceKnowledgePack[];
  agent_context?: string;
};

type Props = {
  api: <T>(path: string, options?: RequestInit) => Promise<T>;
  sources: WorkspaceKnowledgeSource[];
  profile: WorkspaceProfile | null;
  onContextChanged: (context: string) => void;
  onToast: (toast: { type: "success" | "error" | "info" | "warning"; message: string }) => void;
};

const quotePolicyLabels: Record<KnowledgeQuotePolicy, string> = {
  do_not_quote: "Pricing: never quote — create callback",
  starting_at: "Pricing: approved “starting at” only",
  range: "Pricing: approved range only",
  fixed: "Pricing: approved fixed price only",
  custom_quote_required: "Pricing: custom quote required",
};

export function BusinessKnowledgePackPanel({ api, sources, profile, onContextChanged, onToast }: Props) {
  const [packs, setPacks] = useState<WorkspaceKnowledgePack[]>([]);
  const [title, setTitle] = useState("");
  const [quotePolicy, setQuotePolicy] = useState<KnowledgeQuotePolicy>("do_not_quote");
  const [reviewNotes, setReviewNotes] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busyPackId, setBusyPackId] = useState<number | null>(null);
  const [resetting, setResetting] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const data = await api<KnowledgeResponse>("/api/workspace/knowledge");
      setPacks(data.packs || []);
      if (data.agent_context) onContextChanged(data.agent_context);
    } catch {
      onToast({ type: "error", message: "Could not load demo context." });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const draft = async () => {
    if (sources.length === 0) {
      onToast({ type: "warning", message: "Import or approve website facts before building demo context." });
      return;
    }
    const identity = Object.fromEntries(Object.entries({
      business_name: profile?.business_name || "",
      business_tagline: profile?.business_tagline || "",
      business_phone: profile?.business_phone || "",
      business_website: profile?.business_website || "",
      business_address: profile?.business_address || "",
      business_hours: profile?.business_hours || "",
      agent_name: profile?.agent_name || "",
    }).filter(([, value]) => Boolean(value)));
    setSaving(true);
    try {
      const response = await api<{ pack: WorkspaceKnowledgePack }>("/api/workspace/knowledge/packs", {
        method: "POST",
        body: JSON.stringify({
          title: title.trim() || `${profile?.business_name || "Business"} demo context`,
          source_ids: sources.map((source) => source.id),
          identity,
          quote_policy: quotePolicy,
          review_notes: reviewNotes.trim() || undefined,
        }),
      });
      setTitle("");
      setReviewNotes("");
      onToast({ type: "success", message: `Draft context created from ${response.pack.source_ids.length} source${response.pack.source_ids.length === 1 ? "" : "s"}.` });
      await load();
    } catch (error: unknown) {
      onToast({ type: "error", message: error instanceof Error ? error.message : "Could not create demo context." });
    } finally {
      setSaving(false);
    }
  };

  const activate = async (pack: WorkspaceKnowledgePack) => {
    setBusyPackId(pack.id);
    try {
      const response = await api<{ pack: WorkspaceKnowledgePack; agent_context: string }>(`/api/workspace/knowledge/packs/${pack.id}/activate`, { method: "POST" });
      onContextChanged(response.agent_context || "");
      onToast({ type: "success", message: `Demo context active: ${response.pack.title}. The next call uses this workspace.` });
      await load();
    } catch (error: unknown) {
      onToast({ type: "error", message: error instanceof Error ? error.message : "Could not activate demo context." });
    } finally {
      setBusyPackId(null);
    }
  };

  const reset = async () => {
    setResetting(true);
    try {
      const response = await api<{ deactivated: number; agent_context: string }>("/api/workspace/knowledge/packs/reset", { method: "POST" });
      onContextChanged(response.agent_context || "");
      onToast({ type: "info", message: response.deactivated ? "Demo context deactivated. The next call will not use that pack." : "No active demo context to reset." });
      await load();
    } catch (error: unknown) {
      onToast({ type: "error", message: error instanceof Error ? error.message : "Could not reset demo context." });
    } finally {
      setResetting(false);
    }
  };

  const activePack = packs.find((pack) => pack.status === "active");
  const visiblePacks = packs.filter((pack) => pack.status !== "archived");

  return (
    <section className="border border-gray-800 bg-[#0a0a0a]">
      <header className="flex flex-col gap-3 border-b border-gray-800 px-5 py-4 md:flex-row md:items-center md:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Target size={14} className="text-[#00ff88]" />
            <h3 className="text-sm font-semibold text-white">Demo Answering Context</h3>
            {activePack ? (
              <span className="border border-[#00ff88]/50 bg-[#00ff88]/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em] text-[#00ff88]">Active</span>
            ) : (
              <span className="border border-amber-700/50 bg-amber-950/30 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em] text-amber-300">No active context</span>
            )}
          </div>
          <p className="mt-1 text-xs text-gray-500">The agent stays on the current context until you explicitly activate a reviewed draft for this workspace.</p>
        </div>
        <button
          onClick={reset}
          disabled={resetting || !activePack}
          className="inline-flex items-center justify-center gap-2 border border-gray-700 px-3 py-2 text-xs font-semibold text-gray-300 hover:border-gray-500 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
        >
          {resetting ? <Loader2 size={13} className="animate-spin" /> : <RotateCcw size={13} />}
          Reset demo
        </button>
      </header>

      <div className="grid grid-cols-1 gap-5 p-5 xl:grid-cols-[1.05fr_0.95fr]">
        <div className="space-y-3">
          <div className="font-mono text-[11px] uppercase tracking-[0.16em] text-gray-500">1. Build a reviewed draft</div>
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={`${profile?.business_name || "Business"} demo context`}
            className="w-full border border-gray-800 bg-gray-950 px-3 py-2.5 text-sm text-white placeholder-gray-700 outline-none focus:border-[#00ff88]"
          />
          <select value={quotePolicy} onChange={(event) => setQuotePolicy(event.target.value as KnowledgeQuotePolicy)} className="w-full border border-gray-800 bg-gray-950 px-3 py-2.5 text-sm text-white outline-none focus:border-[#00ff88]">
            {Object.entries(quotePolicyLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <textarea
            value={reviewNotes}
            onChange={(event) => setReviewNotes(event.target.value)}
            rows={3}
            placeholder="Optional review notes: service limits, escalation instructions, or exclusions."
            className="w-full resize-none border border-gray-800 bg-gray-950 px-3 py-2.5 text-xs leading-relaxed text-gray-300 placeholder-gray-700 outline-none focus:border-[#00ff88]"
          />
          <div className="flex items-center justify-between gap-3 border border-gray-900 bg-gray-950/60 px-3 py-2 text-xs text-gray-500">
            <span>{sources.length} source{sources.length === 1 ? "" : "s"} included. Remove irrelevant sources before drafting.</span>
            <button onClick={draft} disabled={saving || sources.length === 0} className="inline-flex shrink-0 items-center gap-2 bg-[#00ff88] px-3 py-2 text-xs font-bold text-black disabled:cursor-not-allowed disabled:opacity-40">
              {saving ? <Loader2 size={13} className="animate-spin" /> : <Layers size={13} />}
              Create draft
            </button>
          </div>
        </div>

        <div className="border border-gray-800 bg-gray-950/60">
          <div className="flex items-center justify-between border-b border-gray-800 px-4 py-3">
            <div className="font-mono text-[11px] uppercase tracking-[0.16em] text-gray-500">2. Activate for this workspace</div>
            {loading && <Loader2 size={13} className="animate-spin text-gray-500" />}
          </div>
          <div className="max-h-64 divide-y divide-gray-900 overflow-y-auto">
            {visiblePacks.length === 0 ? (
              <div className="px-4 py-8 text-xs leading-5 text-gray-600">No draft context yet. Import facts, review the source preview, then create a draft.</div>
            ) : visiblePacks.map((pack) => (
              <div key={pack.id} className="flex items-start justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className={`border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] ${pack.status === "active" ? "border-[#00ff88]/50 bg-[#00ff88]/10 text-[#00ff88]" : "border-gray-700 text-gray-500"}`}>{pack.status}</span>
                    <span className="truncate text-sm font-medium text-white">{pack.title}</span>
                  </div>
                  <div className="mt-1 text-xs text-gray-600">{pack.source_ids.length} source{pack.source_ids.length === 1 ? "" : "s"} · {pack.quote_policy.replace(/_/g, " ")}</div>
                </div>
                {pack.status === "active" ? (
                  <span className="pt-1 text-xs font-semibold text-[#00ff88]">Live on next call</span>
                ) : (
                  <button onClick={() => activate(pack)} disabled={busyPackId === pack.id} className="inline-flex shrink-0 items-center gap-1.5 border border-[#00ff88]/50 bg-[#00ff88]/10 px-2.5 py-1.5 text-xs font-bold text-[#00ff88] disabled:opacity-40">
                    {busyPackId === pack.id ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle2 size={12} />}
                    Activate
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
