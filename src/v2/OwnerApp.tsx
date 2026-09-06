import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { AlertTriangle, ArrowRight, BookOpenCheck, Check, ChevronRight, CircleUserRound, ClipboardCheck, Database, FileText, Globe2, LogOut, Menu, Moon, Phone, RefreshCw, Settings, ShieldCheck, Sun, Wrench, X } from "lucide-react";
import { api, readActiveWorkspaceId, readOwnerSession, readWorkspaceSession, signOut, writeActiveWorkspaceId, type OwnerSession } from "./api";
import type { CallRecord, HandoffRecord, NavPage, Stats, TaskRecord, Workspace } from "./types";

type LoadState<T> = { data: T; loading: boolean; error: string };
const empty = <T,>(data: T): LoadState<T> => ({ data, loading: true, error: "" });
const dateLabel = (value?: string) => value ? new Date(value).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "Time unavailable";
const phoneLabel = (value?: string) => value?.trim() || "Caller withheld";

function Wordmark() { return <a href="/dashboard" className="v2-wordmark">SMIRK<span>.</span></a>; }

function GoogleAdminLogin() {
  const buttonRef = useRef<HTMLDivElement>(null);
  const [config, setConfig] = useState<any>(null);
  const [error, setError] = useState(() => {
    const code = new URLSearchParams(window.location.search).get("auth_error");
    if (!code) return "";
    if (code === "csrf") return "Google sign-in could not verify the browser request. Please try again.";
    if (code === "not_allowed") return "That Google account is not approved for SMIRK operator access.";
    if (code === "not_configured") return "Google operator sign-in is not configured.";
    if (code === "unverified_email") return "Google did not return a verified account email.";
    return "Google admin sign-in failed. Please try again.";
  });

  useEffect(() => {
    fetch("/api/auth/google/config", { cache: "no-store" }).then((res) => res.json()).then(setConfig).catch(() => setError("Google sign-in is unavailable."));
  }, []);

  useEffect(() => {
    if (!config?.enabled || !config?.clientId || !buttonRef.current) return;
    let cancelled = false;
    const render = () => {
      if (cancelled || !window.google?.accounts?.id || !buttonRef.current) return;
      window.google.accounts.id.initialize({
        client_id: config.clientId,
        ux_mode: "redirect",
        login_uri: `${window.location.origin}/api/auth/google/redirect`,
        login_hint: typeof config.adminHint === "string" && !config.adminHint.includes(",") ? config.adminHint : undefined,
      });
      buttonRef.current.innerHTML = "";
      window.google.accounts.id.renderButton(buttonRef.current, { theme: "outline", size: "large", text: "continue_with", shape: "rectangular", width: 320 });
    };
    if (window.google?.accounts?.id) render();
    else {
      const existing = document.querySelector('script[data-smirk-google-v2="true"]') as HTMLScriptElement | null;
      const script = existing || document.createElement("script");
      if (!existing) { script.src = "https://accounts.google.com/gsi/client"; script.async = true; script.defer = true; script.dataset.smirkGoogleV2 = "true"; document.head.appendChild(script); }
      script.addEventListener("load", render);
      return () => { cancelled = true; script.removeEventListener("load", render); };
    }
    return () => { cancelled = true; };
  }, [config]);

  return (
    <div className="v2-access-page">
      <div className="v2-access-card v2-access-card--login">
        <Wordmark />
        <div className="v2-kicker"><span /> VERIFIED OWNER ACCESS</div>
        <h1>Open the operations desk.</h1>
        <p>Use the approved Google administrator account. SMIRK creates a secure server session; it does not store your Google credential in the browser.</p>
        {config?.adminHint && <div className="v2-login-hint">Approved account: <strong>{config.adminHint}</strong></div>}
        <div ref={buttonRef} className="v2-google-button" />
        {error && <div className="v2-error" role="alert">{error}</div>}
        <a href="/" className="v2-text-link">Return to public site</a>
      </div>
    </div>
  );
}

function StatusBadge({ state, children }: { state: "live" | "attention" | "quiet" | "unavailable"; children: ReactNode }) {
  return <span className={`v2-status v2-status--${state}`}><i />{children}</span>;
}

function TodayPage({ stats, calls, tasks, handoffs, degraded, onNavigate }: { stats: Stats; calls: CallRecord[]; tasks: TaskRecord[]; handoffs: HandoffRecord[]; degraded: boolean; onNavigate: (page: NavPage) => void }) {
  const openTasks = tasks.filter((item) => !["completed", "resolved", "cancelled"].includes(String(item.status || "").toLowerCase()));
  const openHandoffs = handoffs.filter((item) => !["resolved", "completed", "closed"].includes(String(item.status || "").toLowerCase()));
  const attention = openTasks.length + openHandoffs.length;
  const latest = calls[0];
  return (
    <div className="v2-page">
      <div className="v2-page-heading"><div><div className="v2-kicker"><span /> TODAY</div><h1>SMIRK Intelligence Brief</h1><p>{degraded ? "The operating brief is incomplete because one or more live datasets did not load. SMIRK is not interpreting unavailable data as a clear queue." : attention > 0 ? `${attention} owner decision${attention === 1 ? "" : "s"} waiting. SMIRK captured the evidence; work the highest-value obligation first.` : "The line is covered. No open callback or handoff is currently asking for your attention."}</p></div><StatusBadge state={degraded ? "unavailable" : attention > 0 ? "attention" : "live"}>{degraded ? "Data unavailable" : attention > 0 ? "Action required" : "Standing by"}</StatusBadge></div>
      <section className="v2-intelligence-brief">
        <div className="v2-intelligence-brief__signal"><span>LINE SIGNAL</span><strong>{stats.todayCalls ?? calls.filter((call) => new Date(call.started_at || 0).toDateString() === new Date().toDateString()).length}</strong><small>calls today</small></div>
        <div className="v2-intelligence-brief__focus"><span>NEXT BEST ACTION</span><h2>{openHandoffs.length ? "Resolve the human handoff." : openTasks.length ? "Work the callback queue." : latest ? "Review the latest call receipt." : "No call evidence yet."}</h2><p>{openHandoffs[0]?.reason || openTasks[0]?.notes || latest?.summary || "SMIRK will place the next verified obligation here."}</p><button className="v2-button v2-button--signal" onClick={() => onNavigate(openHandoffs.length || openTasks.length ? "tasks" : "calls")}>{attention > 0 ? "Open response work" : "Open call ledger"}<ArrowRight size={17} /></button></div>
        <div className="v2-intelligence-brief__evidence"><span>CALL EVIDENCE</span><strong>{stats.totalCalls ?? calls.length}</strong><small>durable records</small><div className="v2-evidence-rule"><i /><span>Signal</span><i /><span>Context</span><i /><span>Decision</span></div></div>
      </section>
      <div className="v2-two-column">
        <section className="v2-surface"><div className="v2-surface__head"><div><span>RESPONSE QUEUE</span><h2>What needs a person</h2></div><button onClick={() => onNavigate("tasks")}>Open all <ChevronRight size={16} /></button></div>{attention === 0 ? <EmptyState icon={<ClipboardCheck />} title="Queue clear" text="Nothing is being hidden as zero. SMIRK found no open owner obligation in the loaded workspace data." /> : <div className="v2-list">{[...openHandoffs.map((item) => ({ id: `h-${item.id}`, title: item.reason || "Human handoff", meta: `${item.urgency || "normal"} priority · ${dateLabel(item.created_at)}` })), ...openTasks.map((item) => ({ id: `t-${item.id}`, title: item.notes || item.task_type || "Callback task", meta: `${item.status || "open"} · ${dateLabel(item.created_at)}` }))].slice(0, 4).map((item) => <div className="v2-list-row" key={item.id}><div><strong>{item.title}</strong><span>{item.meta}</span></div><ArrowRight size={16} /></div>)}</div>}</section>
        <section className="v2-surface"><div className="v2-surface__head"><div><span>LATEST RECEIPT</span><h2>Most recent call</h2></div><button onClick={() => onNavigate("calls")}>Call ledger <ChevronRight size={16} /></button></div>{latest ? <div className="v2-latest-call"><div className="v2-call-number">{phoneLabel(latest.from_number)}</div><p>{latest.summary || latest.intent || "No summary is available for this call."}</p><dl><div><dt>Started</dt><dd>{dateLabel(latest.started_at)}</dd></div><div><dt>Status</dt><dd>{latest.status || "unknown"}</dd></div><div><dt>Outcome</dt><dd>{latest.outcome || "not recorded"}</dd></div></dl></div> : <EmptyState icon={<Phone />} title="Awaiting call evidence" text="No fabricated example is shown. The first real call receipt will appear here." />}</section>
      </div>
    </div>
  );
}

function EmptyState({ icon, title, text }: { icon: ReactNode; title: string; text: string }) { return <div className="v2-empty"><span>{icon}</span><h3>{title}</h3><p>{text}</p></div>; }

function CallsPage({ calls }: { calls: CallRecord[] }) {
  const [selected, setSelected] = useState<CallRecord | null>(calls[0] || null);
  useEffect(() => { if (!selected && calls[0]) setSelected(calls[0]); }, [calls, selected]);
  return <div className="v2-page"><div className="v2-page-heading"><div><div className="v2-kicker"><span /> CALL EVIDENCE</div><h1>Calls</h1><p>Every row is a source record. Select one to inspect the captured identity, need, timing, boundaries, and recorded outcome.</p></div></div>{calls.length === 0 ? <section className="v2-surface"><EmptyState icon={<Phone />} title="No call records" text="Nothing is rendered as a fake example. Completed and active calls will appear here." /></section> : <div className="v2-ledger"><div className="v2-ledger__rows">{calls.map((call, index) => <button className={selected === call ? "is-selected" : ""} key={call.call_sid || call.id || index} onClick={() => setSelected(call)}><span className="v2-call-direction">{call.direction || "call"}</span><strong>{phoneLabel(call.from_number)}</strong><small>{dateLabel(call.started_at)}</small><i>{call.status || "unknown"}</i></button>)}</div><aside className="v2-inspector">{selected && <><div className="v2-inspector__head"><span>CALL EVIDENCE</span><StatusBadge state={selected.status === "completed" ? "live" : "quiet"}>{selected.status || "unknown"}</StatusBadge></div><h2>{phoneLabel(selected.from_number)}</h2><p>{selected.summary || "No post-call summary is available."}</p><dl><div><dt>Identity</dt><dd>{phoneLabel(selected.from_number)}</dd></div><div><dt>Intent</dt><dd>{selected.intent || "not classified"}</dd></div><div><dt>Boundary</dt><dd>{selected.outcome || "not recorded"}</dd></div><div><dt>Window</dt><dd>{dateLabel(selected.started_at)}</dd></div><div><dt>Duration</dt><dd>{Number.isFinite(selected.duration_seconds) ? `${selected.duration_seconds}s` : "unavailable"}</dd></div><div><dt>Evidence</dt><dd>{selected.transcript ? "transcript preserved" : "transcript unavailable"}</dd></div></dl>{selected.transcript && <details><summary>Open transcript</summary><pre>{selected.transcript}</pre></details>}</>}</aside></div>}</div>;
}

function TasksPage({ tasks, handoffs, reload }: { tasks: TaskRecord[]; handoffs: HandoffRecord[]; reload: () => Promise<void> }) {
  const [busy, setBusy] = useState<string>("");
  const openTasks = tasks.filter((item) => !["completed", "resolved", "cancelled"].includes(String(item.status || "").toLowerCase()));
  const openHandoffs = handoffs.filter((item) => !["resolved", "completed", "closed"].includes(String(item.status || "").toLowerCase()));
  const complete = async (task: TaskRecord) => { setBusy(`t-${task.id}`); try { await api(`/api/tasks/${task.id}/complete`, { method: "POST" }); await reload(); } finally { setBusy(""); } };
  const acknowledge = async (handoff: HandoffRecord) => { setBusy(`h-${handoff.id}`); try { await api(`/api/handoffs/${handoff.id}/acknowledge`, { method: "POST" }); await reload(); } finally { setBusy(""); } };
  const act = async (handoff: HandoffRecord, action: "queue_callback" | "complete") => { setBusy(`h-${handoff.id}`); try { await api(`/api/handoffs/${handoff.id}/action`, { method: "POST", body: JSON.stringify({ action, resolution_notes: action === "complete" ? "Completed by verified owner from SMIRK operations desk." : "Callback queued by verified owner from SMIRK operations desk." }) }); await reload(); } finally { setBusy(""); } };
  const primary = openHandoffs[0];
  return <div className="v2-page"><div className="v2-page-heading"><div><div className="v2-kicker"><span /> HUMAN ACTION</div><h1>Recovery Queue</h1><p>{openTasks.length + openHandoffs.length > 0 ? `${openTasks.length + openHandoffs.length} owner obligation${openTasks.length + openHandoffs.length === 1 ? " is" : "s are"} waiting. Each remains open until a person records the outcome.` : "No owner decision is waiting in the loaded workspace data."}</p></div><StatusBadge state={openTasks.length + openHandoffs.length > 0 ? "attention" : "live"}>{openTasks.length + openHandoffs.length} open</StatusBadge></div>{primary ? <section className="v2-recovery-queue"><div className="v2-recovery-flow"><div><span>CALLER</span><Phone size={28} /><strong>Captured</strong></div><i /><div><span>NEED</span><FileText size={28} /><strong>{primary.reason || "Summarized"}</strong></div><i /><div><span>WINDOW</span><ClipboardCheck size={28} /><strong>{dateLabel(primary.created_at)}</strong></div><i /><div className="is-decision"><span>OWNER DECISION</span><ArrowRight size={30} /><strong>{primary.recommended_action || "Review required"}</strong></div></div><p>{primary.transcript_snippet || "Review the source call before choosing the next action."}</p><div className="v2-recovery-actions"><button className="v2-button v2-button--signal" onClick={() => act(primary, "queue_callback")} disabled={!!busy}>Queue callback <ArrowRight size={17} /></button><button onClick={() => acknowledge(primary)} disabled={!!busy}>Take ownership</button><button onClick={() => act(primary, "complete")} disabled={!!busy}>Mark resolved</button></div></section> : <section className="v2-surface"><EmptyState icon={<Check />} title="Recovery queue clear" text="SMIRK found no unresolved human handoff in the loaded workspace data." /></section>}<section className="v2-surface"><div className="v2-surface__head"><div><span>CALLBACK TASKS</span><h2>Work promised to callers</h2></div></div>{openTasks.length === 0 ? <EmptyState icon={<ClipboardCheck />} title="Task queue clear" text="No open callback or follow-up task is present in the loaded data." /> : <div className="v2-work-list">{openTasks.map((item) => <article key={item.id}><div><span className="v2-call-direction">{item.task_type || "task"}</span><h3>{item.notes || "Follow up with caller"}</h3><p>{item.assigned_to ? `Owner: ${item.assigned_to}` : "Unassigned owner obligation"}</p><small>{dateLabel(item.due_at || item.created_at)}</small></div><div className="v2-work-actions"><button className="v2-work-actions__primary" onClick={() => complete(item)} disabled={!!busy}>{busy === `t-${item.id}` ? "Saving…" : "Mark complete"}</button></div></article>)}</div>}</section>{openHandoffs.length > 1 && <section className="v2-surface"><div className="v2-surface__head"><div><span>ADDITIONAL HANDOFFS</span><h2>Next owner decisions</h2></div></div><div className="v2-work-list">{openHandoffs.slice(1).map((item) => <article key={item.id}><div><StatusBadge state={item.urgency === "urgent" ? "attention" : "quiet"}>{item.urgency || "normal"}</StatusBadge><h3>{item.reason || "Human review requested"}</h3><p>{item.transcript_snippet || item.recommended_action || "Review the source call before deciding."}</p><small>{dateLabel(item.created_at)}</small></div><div className="v2-work-actions"><button onClick={() => acknowledge(item)} disabled={!!busy}>Acknowledge</button><button onClick={() => act(item, "queue_callback")} disabled={!!busy}>Queue callback</button><button onClick={() => act(item, "complete")} disabled={!!busy}>Complete</button></div></article>)}</div></section>}</div>;
}

type KnowledgeSource = { id: number; title: string; source_type: string; summary: string; updated_at?: string };
type KnowledgePack = { id: number; title: string; status: "draft" | "active" | "archived"; source_ids: number[]; identity: Record<string, string>; quote_policy: string; review_notes?: string | null; activated_at?: string | null };

function KnowledgePage({ workspaceId, workspace }: { workspaceId: number; workspace: Workspace | null }) {
  const [sources, setSources] = useState<KnowledgeSource[]>([]);
  const [packs, setPacks] = useState<KnowledgePack[]>([]);
  const [agentContext, setAgentContext] = useState("");
  const [selectedPackId, setSelectedPackId] = useState<number | null>(null);
  const [confirmPackId, setConfirmPackId] = useState<number | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [importForm, setImportForm] = useState({ title: "", sourceType: "manual", content: "" });
  const loadKnowledge = useCallback(async () => {
    setError("");
    try {
      const body = await api<any>("/api/workspace/knowledge", {}, workspaceId);
      const nextSources = Array.isArray(body.sources) ? body.sources : [];
      const nextPacks = Array.isArray(body.packs) ? body.packs : [];
      setSources(nextSources);
      setPacks(nextPacks);
      setAgentContext(String(body.agent_context || ""));
      setSelectedPackId((current) => current && nextPacks.some((item: KnowledgePack) => item.id === current) ? current : Number(nextPacks.find((item: KnowledgePack) => item.status === "active")?.id || nextPacks[0]?.id || 0) || null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Business knowledge is unavailable."); }
  }, [workspaceId]);
  useEffect(() => { void loadKnowledge(); }, [loadKnowledge]);
  const selected = packs.find((pack) => pack.id === selectedPackId) || null;
  const active = packs.find((pack) => pack.status === "active") || null;
  const importSource = async (event: FormEvent) => {
    event.preventDefault(); if (!importForm.content.trim()) return;
    setBusy("import"); setError("");
    try { await api("/api/workspace/knowledge/import", { method: "POST", body: JSON.stringify(importForm) }, workspaceId); setImportForm({ title: "", sourceType: "manual", content: "" }); await loadKnowledge(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Source import failed."); }
    finally { setBusy(""); }
  };
  const buildDraft = async () => {
    if (!sources.length) return; setBusy("draft"); setError("");
    try {
      const body = await api<any>("/api/workspace/knowledge/packs", { method: "POST", body: JSON.stringify({ title: `${workspace?.business_name || workspace?.name || "Business"} Knowledge Pack`, source_ids: sources.map((source) => source.id), identity: { business_name: workspace?.business_name || workspace?.name || "", service_area: workspace?.service_area || "", business_hours: workspace?.business_hours || "" }, quote_policy: "do_not_quote", review_notes: "Draft assembled from the selected workspace sources. Owner review required before activation." }) }, workspaceId);
      await loadKnowledge(); setSelectedPackId(Number(body.pack?.id || 0) || null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Draft creation failed."); }
    finally { setBusy(""); }
  };
  const activate = async (pack: KnowledgePack) => {
    if (confirmPackId !== pack.id) { setConfirmPackId(pack.id); return; }
    setBusy(`activate-${pack.id}`); setError("");
    try { await api(`/api/workspace/knowledge/packs/${pack.id}/activate`, { method: "POST" }, workspaceId); setConfirmPackId(null); await loadKnowledge(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Activation failed."); }
    finally { setBusy(""); }
  };
  const quoteLabel = selected?.quote_policy === "fixed" ? "Approved exact price only" : selected?.quote_policy === "starting_at" ? "Approved starting price only" : selected?.quote_policy === "range" ? "Approved range only" : selected?.quote_policy === "custom_quote_required" ? "Owner quote required" : "Do not quote";
  return <div className="v2-page v2-knowledge-page"><div className="v2-page-heading"><div><div className="v2-kicker"><span /> EVIDENCE CONTROL PLANE</div><h1>Business Knowledge Pack</h1><p>Imported material remains non-caller-facing until an owner reviews and activates a pack. Missing, ambiguous, or conflicting facts escalate to a person.</p></div><StatusBadge state={error ? "unavailable" : active ? "live" : "attention"}>{error ? "Unavailable" : active ? "Active pack" : "Draft only"}</StatusBadge></div>{error && <div className="v2-error">{error}</div>}<div className="v2-knowledge-grid"><section className="v2-knowledge-zone"><div className="v2-knowledge-zone__head"><Database size={18} /><span>Sources</span></div><div className="v2-source-list">{sources.length ? sources.map((source) => <button className={selected?.source_ids?.includes(source.id) ? "is-linked" : ""} key={source.id} title={source.summary}><span>{source.source_type === "website" ? <Globe2 /> : <FileText />}</span><div><strong>{source.title}</strong><small>{source.source_type} · {dateLabel(source.updated_at)}</small></div><i /></button>) : <EmptyState icon={<Database />} title="No sources" text="Add an official website export, CRM data, or a manual fact before building a draft." />}</div><form className="v2-knowledge-import" onSubmit={importSource}><input aria-label="Source title" placeholder="Source title" value={importForm.title} onChange={(event) => setImportForm({ ...importForm, title: event.target.value })} /><select aria-label="Source type" value={importForm.sourceType} onChange={(event) => setImportForm({ ...importForm, sourceType: event.target.value })}><option value="manual">Manual fact</option><option value="website">Website text</option><option value="csv">CRM CSV</option><option value="json">CRM JSON</option><option value="text">Plain text</option></select><textarea aria-label="Source content" placeholder="Paste verified source content. Imported instructions are treated as data, not commands." value={importForm.content} onChange={(event) => setImportForm({ ...importForm, content: event.target.value })} /><button type="submit" disabled={busy === "import" || !importForm.content.trim()}>{busy === "import" ? "Importing…" : "Add source"}</button></form></section><section className="v2-knowledge-zone v2-knowledge-zone--context"><div className="v2-knowledge-zone__head"><BookOpenCheck size={18} /><span>Draft business context</span></div><div className="v2-pack-selector">{packs.length ? packs.map((pack) => <button className={selectedPackId === pack.id ? "is-selected" : ""} key={pack.id} onClick={() => { setSelectedPackId(pack.id); setConfirmPackId(null); }}><span>{pack.title}</span><StatusBadge state={pack.status === "active" ? "live" : pack.status === "draft" ? "attention" : "quiet"}>{pack.status}</StatusBadge></button>) : <EmptyState icon={<BookOpenCheck />} title="No knowledge pack" text="Imported sources are not caller-facing. Build a draft, review it, then activate it deliberately." />}</div>{selected && <div className="v2-context-rows"><div><span>Identity</span><strong>{Object.keys(selected.identity || {}).length ? `${Object.keys(selected.identity).length} reviewed fields` : "Workspace profile fallback"}</strong><i className={selected.status === "active" ? "is-live" : "is-draft"} /></div><div><span>Source set</span><strong>{selected.source_ids.length} linked source{selected.source_ids.length === 1 ? "" : "s"}</strong><i className={selected.status === "active" ? "is-live" : "is-draft"} /></div><div><span>Pricing</span><strong>{quoteLabel}</strong><i className={selected.quote_policy === "do_not_quote" || selected.quote_policy === "custom_quote_required" ? "is-draft" : "is-live"} /></div><div><span>Caller-facing</span><strong>{selected.status === "active" ? `Active since ${dateLabel(selected.activated_at || undefined)}` : "No — review required"}</strong><i className={selected.status === "active" ? "is-live" : "is-draft"} /></div></div>}<div className="v2-knowledge-controls">{!packs.length && <button className="v2-button v2-button--ink" onClick={buildDraft} disabled={!sources.length || busy === "draft"}>{busy === "draft" ? "Building draft…" : "Build review draft"}</button>}{selected?.status === "draft" && <button className="v2-button v2-button--signal" onClick={() => activate(selected)} disabled={busy === `activate-${selected.id}`}>{busy === `activate-${selected.id}` ? "Activating…" : confirmPackId === selected.id ? "Confirm caller-facing activation" : "Activate for this workspace"}<ArrowRight size={17} /></button>}{selected?.status === "active" && <StatusBadge state="live">Caller-facing context active</StatusBadge>}</div></section><section className="v2-knowledge-zone v2-knowledge-zone--rules"><div className="v2-knowledge-zone__head"><ShieldCheck size={18} /><span>Answer rules</span></div><article className="is-safe"><ShieldCheck /><div><strong>Safe to say</strong><p>{active ? "Facts explicitly grounded in the active pack and its selected sources." : "Nothing imported is caller-facing until a pack is activated."}</p></div></article><article className="is-approval"><CircleUserRound /><div><strong>Needs owner approval</strong><p>Draft facts, pricing outside the active quote policy, availability, warranties, and unresolved conflicts.</p></div></article><article className="is-escalate"><AlertTriangle /><div><strong>Always escalate</strong><p>Anything absent, ambiguous, expired, unsafe, or outside the approved source set.</p></div></article></section></div><details className="v2-agent-context"><summary>View exact active agent context</summary><pre>{agentContext || "No active caller-facing context returned."}</pre></details></div>;
}

function SettingsPage({ workspace, reload, admin }: { workspace: Workspace | null; reload: () => Promise<void>; admin: boolean }) {
  const [form, setForm] = useState<Workspace>(workspace || { id: 0 });
  const [status, setStatus] = useState("");
  useEffect(() => setForm(workspace || { id: 0 }), [workspace]);
  const save = async (event: FormEvent) => { event.preventDefault(); setStatus("Saving…"); try { await api("/api/workspace/profile", { method: "PATCH", body: JSON.stringify({ business_name: form.business_name, business_phone: form.business_phone, business_website: form.business_website, service_area: form.service_area, business_hours: form.business_hours, owner_phone: form.owner_phone, notification_email: form.notification_email, inbound_greeting: form.inbound_greeting, agent_name: form.agent_name }) }, workspace?.id); await reload(); setStatus("Saved"); } catch (cause) { setStatus(cause instanceof Error ? cause.message : "Unable to save"); } };
  return <div className="v2-page"><div className="v2-page-heading"><div><div className="v2-kicker"><span /> OWNER CONTROLS</div><h1>Settings</h1><p>Tell SMIRK who it represents, how to answer, and where owner obligations go.</p></div></div><form className="v2-settings-grid" onSubmit={save}><section className="v2-surface"><div className="v2-surface__head"><div><span>BUSINESS SETUP</span><h2>Who callers reached</h2></div></div><label>Business name<input value={form.business_name || ""} onChange={(e) => setForm({ ...form, business_name: e.target.value })} /></label><label>Public phone<input value={form.business_phone || ""} onChange={(e) => setForm({ ...form, business_phone: e.target.value })} /></label><label>Website<input value={form.business_website || ""} onChange={(e) => setForm({ ...form, business_website: e.target.value })} /></label><label>Service area<input value={form.service_area || ""} onChange={(e) => setForm({ ...form, service_area: e.target.value })} /></label><label>Business hours<textarea value={form.business_hours || ""} onChange={(e) => setForm({ ...form, business_hours: e.target.value })} /></label></section><section className="v2-surface"><div className="v2-surface__head"><div><span>CALL BEHAVIOR</span><h2>How SMIRK answers</h2></div></div><label>Agent name<input value={form.agent_name || ""} onChange={(e) => setForm({ ...form, agent_name: e.target.value })} /></label><label>Inbound greeting<textarea value={form.inbound_greeting || ""} onChange={(e) => setForm({ ...form, inbound_greeting: e.target.value })} /></label><label>Owner callback phone<input value={form.owner_phone || ""} onChange={(e) => setForm({ ...form, owner_phone: e.target.value })} /></label><label>Owner alert email<input type="email" value={form.notification_email || ""} onChange={(e) => setForm({ ...form, notification_email: e.target.value })} /></label><button className="v2-button v2-button--signal" type="submit">Save owner settings</button>{status && <div className="v2-save-state" role="status">{status}</div>}</section><section className="v2-surface v2-settings-wide"><div className="v2-surface__head"><div><span>BUSINESS KNOWLEDGE</span><h2>What SMIRK can safely say</h2></div><a href="/dashboard/knowledge">Open control plane <ArrowRight size={16} /></a></div><p>Review website and CRM facts before activation. Pricing, availability, warranty, and policy claims remain constrained by owner-approved sources.</p></section>{admin && <section className="v2-surface v2-settings-wide"><div className="v2-surface__head"><div><span>ADMIN TOOLS</span><h2>Advanced system controls</h2></div><a href="/dashboard/admin">Open admin tools <ArrowRight size={16} /></a></div><p>System health, integrations, workspaces, agent behavior, compliance, and launch diagnostics are separated from daily owner work.</p></section>}</form></div>;
}

function AdminPage({ workspaceId }: { workspaceId: number | null }) {
  const [health, setHealth] = useState<any>(null);
  const [session, setSession] = useState<any>(null);
  const [error, setError] = useState("");
  useEffect(() => { Promise.all([api<any>("/api/system-health", {}, workspaceId), api<any>("/api/operator/session", {}, workspaceId)]).then(([nextHealth, nextSession]) => { setHealth(nextHealth); setSession(nextSession); }).catch((cause) => setError(cause.message)); }, [workspaceId]);
  return <div className="v2-page"><div className="v2-page-heading"><div><div className="v2-kicker"><span /> VERIFIED ADMIN</div><h1>Admin tools</h1><p>Full capability access is separated from the owner’s daily operating surface.</p></div><StatusBadge state={error ? "unavailable" : "live"}>{error ? "Unavailable" : "Owner verified"}</StatusBadge></div>{error && <div className="v2-error">{error}</div>}<div className="v2-admin-grid"><section className="v2-surface"><div className="v2-surface__head"><div><span>SYSTEM</span><h2>Dependency health</h2></div></div><pre>{health ? JSON.stringify(health, null, 2) : "Loading verified health…"}</pre></section><section className="v2-surface"><div className="v2-surface__head"><div><span>CAPABILITY</span><h2>Operator session</h2></div></div><div className="v2-capability-list">{(session?.capabilities || []).map((item: string) => <span key={item}><Check size={14} /> {item.replace(/_/g, " ")}</span>)}</div></section></div></div>;
}

function ChatDock({ workspaceId }: { workspaceId: number | null }) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Array<{ role: string; content: string }>>([{ role: "assistant", content: "Owner identity is verified by the server session. I can inspect operations and prepare consequential actions, but I will require exact confirmation before execution." }]);
  const [busy, setBusy] = useState(false);
  const send = async () => { const text = input.trim(); if (!text || busy) return; const next = [...messages, { role: "user", content: text }]; setMessages(next); setInput(""); setBusy(true); try { const body = await api<any>("/api/chat", { method: "POST", body: JSON.stringify({ message: text, history: messages.slice(-8) }) }, workspaceId); setMessages([...next, { role: "assistant", content: String(body.response || body.message || "No response returned.") }]); } catch (cause) { setMessages([...next, { role: "assistant", content: cause instanceof Error ? cause.message : "Chat unavailable." }]); } finally { setBusy(false); } };
  return <div className={`v2-chat ${open ? "is-open" : ""}`}><button className="v2-chat__trigger" onClick={() => setOpen(!open)} aria-label="Open SMIRK owner agent">S<span>.</span></button>{open && <section><header><div><strong>SMIRK owner agent</strong><small>Verified session · confirmation gated</small></div><button onClick={() => setOpen(false)}><X size={18} /></button></header><div className="v2-chat__messages">{messages.map((item, index) => <div className={`v2-chat__message is-${item.role}`} key={index}>{item.content}</div>)}</div><footer><textarea value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }} placeholder="Ask about calls, tasks, or prepare an action…" /><button onClick={() => void send()} disabled={busy}>{busy ? "…" : <ArrowRight size={18} />}</button></footer></section>}</div>;
}

export function OwnerApp() {
  const route = window.location.pathname.split("/dashboard/")[1]?.split("/")[0] || "today";
  const initialPage: NavPage = route === "calls" || route === "tasks" || route === "knowledge" || route === "settings" || route === "admin" ? route : "today";
  const [page, setPage] = useState<NavPage>(initialPage);
  const [dark, setDark] = useState(() => localStorage.getItem("smirk_v2_theme") !== "light");
  const [menu, setMenu] = useState(false);
  const [owner, setOwner] = useState<OwnerSession | null | undefined>(undefined);
  const [workspaceSession] = useState(() => readWorkspaceSession());
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState<number | null>(() => workspaceSession?.workspaceId || readActiveWorkspaceId());
  const [stats, setStats] = useState<LoadState<Stats>>(empty({}));
  const [calls, setCalls] = useState<LoadState<CallRecord[]>>(empty([]));
  const [tasks, setTasks] = useState<LoadState<TaskRecord[]>>(empty([]));
  const [handoffs, setHandoffs] = useState<LoadState<HandoffRecord[]>>(empty([]));
  const [workspace, setWorkspace] = useState<LoadState<Workspace | null>>(empty(null));

  useEffect(() => { readOwnerSession().then(setOwner); }, []);
  useEffect(() => {
    if (!owner) return;
    api<any>("/api/workspaces").then((body) => {
      const list = Array.isArray(body.workspaces) ? body.workspaces : [];
      setWorkspaces(list);
      const next = workspaceId && list.some((item: Workspace) => Number(item.id) === workspaceId) ? workspaceId : Number(list[0]?.id || 0) || null;
      setWorkspaceId(next); writeActiveWorkspaceId(next);
    }).catch(() => setWorkspaces([]));
  }, [owner]);

  const load = useCallback(async () => {
    if (!workspaceId) return;
    const results = await Promise.allSettled([
      api<Stats>("/api/stats", {}, workspaceId),
      api<any>("/api/calls?limit=80", {}, workspaceId),
      api<any>("/api/tasks", {}, workspaceId),
      api<any>("/api/handoffs", {}, workspaceId),
      api<Workspace>("/api/workspace/profile", {}, workspaceId),
    ]);
    const assign = <T,>(result: PromiseSettledResult<any>, setter: (value: LoadState<T>) => void, pick: (body: any) => T, fallback: T) => result.status === "fulfilled" ? setter({ data: pick(result.value), loading: false, error: "" }) : setter({ data: fallback, loading: false, error: result.reason?.message || "Data unavailable" });
    assign(results[0], setStats, (body) => body || {}, {});
    assign(results[1], setCalls, (body) => Array.isArray(body.calls) ? body.calls.map((row: any) => ({ ...row, summary: row.summary ?? row.call_summary })) : [], []);
    assign(results[2], setTasks, (body) => Array.isArray(body.tasks) ? body.tasks : [], []);
    assign(results[3], setHandoffs, (body) => Array.isArray(body.handoffs) ? body.handoffs : [], []);
    assign(results[4], setWorkspace, (body) => body || null, null);
  }, [workspaceId]);
  useEffect(() => { void load(); const timer = window.setInterval(() => void load(), 15_000); return () => window.clearInterval(timer); }, [load]);

  const navigate = (next: NavPage) => { setPage(next); setMenu(false); const suffix = next === "today" ? "" : `/${next}`; window.history.pushState({}, "", `/dashboard${suffix}`); };
  const toggleTheme = () => { setDark(!dark); localStorage.setItem("smirk_v2_theme", dark ? "light" : "dark"); };
  const authenticated = owner !== null || workspaceSession !== null;
  if (owner === undefined) return <div className="v2-access-page"><div className="v2-access-card"><Wordmark /><p>Checking secure owner session…</p></div></div>;
  if (!authenticated) return <GoogleAdminLogin />;
  const admin = Boolean(owner);
  const errors = [stats.error, calls.error, tasks.error, handoffs.error, workspace.error].filter(Boolean);
  const nav: Array<{ id: NavPage; label: string; icon: ReactNode }> = [{ id: "today", label: "Today", icon: <Wrench size={18} /> }, { id: "calls", label: "Calls", icon: <Phone size={18} /> }, { id: "tasks", label: "Tasks", icon: <ClipboardCheck size={18} /> }, { id: "knowledge", label: "Business knowledge", icon: <BookOpenCheck size={18} /> }, { id: "settings", label: "Settings", icon: <Settings size={18} /> }, ...(admin ? [{ id: "admin" as NavPage, label: "Admin tools", icon: <CircleUserRound size={18} /> }] : [])];
  return <div className={`v2-owner ${dark ? "v2-theme-dark" : "v2-theme-light"}`}><header className="v2-owner-header"><Wordmark /><button className="v2-mobile-menu" onClick={() => setMenu(!menu)}>{menu ? <X /> : <Menu />}</button><div className="v2-owner-header__workspace"><small>ACTIVE WORKSPACE</small>{admin && workspaces.length > 0 ? <select value={workspaceId || ""} onChange={(e) => { const id = Number(e.target.value); setWorkspaceId(id); writeActiveWorkspaceId(id); }}><option value="" disabled>Select workspace</option>{workspaces.map((item) => <option key={item.id} value={item.id}>{item.name || item.business_name || `Workspace ${item.id}`}</option>)}</select> : <strong>{workspace.data?.name || workspace.data?.business_name || workspaceSession?.workspaceName || "Owner workspace"}</strong>}</div><div className="v2-owner-header__actions"><button onClick={() => void load()} title="Refresh"><RefreshCw size={17} /></button><button onClick={toggleTheme} title="Switch theme">{dark ? <Sun size={17} /> : <Moon size={17} />}</button><button onClick={() => void signOut().then(() => window.location.assign("/dashboard?admin=1"))} title="Sign out"><LogOut size={17} /></button></div></header><aside className={menu ? "is-open" : ""}><div className="v2-nav-status"><StatusBadge state={errors.length ? "unavailable" : "live"}>{errors.length ? "Data degraded" : "System connected"}</StatusBadge>{owner && <small>{owner.email}</small>}</div><nav>{nav.map((item) => <button className={page === item.id ? "is-active" : ""} key={item.id} onClick={() => navigate(item.id)}>{item.icon}<span>{item.label}</span></button>)}</nav><div className="v2-sidebar-note"><AlertTriangle size={15} /><p>SMIRK records evidence. You approve consequential actions.</p></div></aside><main>{errors.length > 0 && <div className="v2-degraded"><AlertTriangle size={16} /> Some workspace data is unavailable. SMIRK is not substituting fake zeroes.</div>}{workspaceId ? <>{page === "today" && <TodayPage stats={stats.data} calls={calls.data} tasks={tasks.data} handoffs={handoffs.data} degraded={Boolean(stats.error || calls.error || tasks.error || handoffs.error)} onNavigate={navigate} />}{page === "calls" && (calls.error ? <div className="v2-page"><section className="v2-surface"><EmptyState icon={<AlertTriangle />} title="Call data unavailable" text={calls.error} /></section></div> : <CallsPage calls={calls.data} />)}{page === "tasks" && (tasks.error || handoffs.error ? <div className="v2-page"><section className="v2-surface"><EmptyState icon={<AlertTriangle />} title="Response queue unavailable" text={tasks.error || handoffs.error} /></section></div> : <TasksPage tasks={tasks.data} handoffs={handoffs.data} reload={load} />)}{page === "knowledge" && <KnowledgePage workspaceId={workspaceId} workspace={workspace.data} />}{page === "settings" && (workspace.error ? <div className="v2-page"><section className="v2-surface"><EmptyState icon={<AlertTriangle />} title="Settings unavailable" text={workspace.error} /></section></div> : <SettingsPage workspace={workspace.data} reload={load} admin={admin} />)}{page === "admin" && admin && <AdminPage workspaceId={workspaceId} />}</> : <div className="v2-page"><section className="v2-surface"><EmptyState icon={<AlertTriangle />} title="No workspace selected" text="The verified admin account has no accessible workspace in the loaded production data." /></section></div>}</main>{admin && <ChatDock workspaceId={workspaceId} />}</div>;
}
