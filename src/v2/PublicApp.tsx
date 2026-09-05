import { useEffect, useMemo, useState, type FormEvent } from "react";
import { ArrowRight, Check, Phone, ShieldCheck, Wrench } from "lucide-react";
import { writeWorkspaceSession } from "./api";

const FIELD_WORK_IMAGE = "https://files.manuscdn.com/user_upload_by_module/session_file/91847194/fIPRxIdlFOkcVraW.jpg";

type Plan = {
  id: string;
  name: string;
  price: number;
  interval: string;
  description?: string;
  features?: string[];
  usage_summary?: string;
  checkout_available?: boolean;
  checkout_blocker?: string | null;
};

type PolicyLink = { label?: string; url?: string; href?: string };

function Wordmark() {
  return <a className="v2-wordmark" href="/" aria-label="SMIRK home">SMIRK<span>.</span></a>;
}

function PublicHeader() {
  return (
    <header className="v2-public-header">
      <Wordmark />
      <nav aria-label="Public navigation">
        <a href="/#how-it-works">How it works</a>
        <a href="/launch">Launch</a>
        <a className="v2-button v2-button--ink" href="/dashboard?admin=1">Sign in</a>
      </nav>
    </header>
  );
}

function RecoveryInstrument() {
  return (
    <div className="v2-instrument" aria-label="Illustrated SMIRK recovery workflow">
      <div className="v2-instrument__plate">
        <div className="v2-instrument__rail">
          {[["SIGNAL", "Call captured"], ["CONTEXT", "Need summarized"], ["DECISION", "Owner decides"]].map(([label, value], index) => (
            <div className="v2-instrument__node" key={label}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <div><strong>{label}</strong><small>{value}</small></div>
            </div>
          ))}
        </div>
        <div className="v2-receipt">
          <div className="v2-receipt__head"><Phone size={17} /> RECOVERY RECEIPT</div>
          <dl>
            <div><dt>CALLER</dt><dd>Name and number captured</dd></div>
            <div><dt>NEED</dt><dd>Service request summarized</dd></div>
            <div><dt>WINDOW</dt><dd>Callback preference noted</dd></div>
            <div><dt>NEXT</dt><dd>Owner decision required</dd></div>
          </dl>
          <p>WORKFLOW FORMAT — NOT LIVE DATA</p>
        </div>
      </div>
    </div>
  );
}

function Hero() {
  return (
    <>
      <main className="v2-hero">
        <section className="v2-hero__copy">
          <div className="v2-kicker"><span /> MISSED-CALL RECOVERY</div>
          <h1>Protect the jobs that call while you’re working.</h1>
          <p>SMIRK answers the missed call, captures the context, and leaves you one clear next move. You keep control.</p>
          <div className="v2-hero__actions">
            <a className="v2-button v2-button--signal" href="/launch">Protect your line <ArrowRight size={18} /></a>
            <a className="v2-text-link" href="#how-it-works">See the recovery flow <ArrowRight size={16} /></a>
          </div>
          <div className="v2-trust-line"><ShieldCheck size={16} /> No invented availability, pricing, or promises.</div>
        </section>
        <RecoveryInstrument />
      </main>
      <div className="v2-process-strip" aria-label="SMIRK recovery stages">
        <span><b>01</b> Call captured</span><span><b>02</b> Context summarized</span><span><b>03</b> You decide next</span>
      </div>
    </>
  );
}

function HowItWorks() {
  return (
    <section className="v2-section" id="how-it-works">
      <div className="v2-section__eyebrow">THE WORKFLOW</div>
      <div className="v2-section__intro">
        <h2>Built for the call you cannot stop to answer.</h2>
        <p>Not a chatbot performance. A controlled intake chain with a durable receipt and a human decision at the end.</p>
      </div>
      <div className="v2-step-grid">
        {[
          ["01", "Your line rolls to SMIRK", "Forward missed calls or route the full line after your preferred ring window."],
          ["02", "SMIRK qualifies the need", "It asks one question at a time, records the work type, location, urgency, and timing."],
          ["03", "You get an obligation", "A callback, handoff, or owner decision appears with the source call and context attached."],
        ].map(([num, title, text]) => <article key={num}><span>{num}</span><h3>{title}</h3><p>{text}</p></article>)}
      </div>
    </section>
  );
}

function HumanWork() {
  return (
    <section className="v2-human-section">
      <figure><img src={FIELD_WORK_IMAGE} alt="An electrician working at an electrical panel while a phone remains available for missed-call recovery" /></figure>
      <div>
        <div className="v2-kicker"><span /> HUMAN WORK IN PROGRESS</div>
        <h2>Stay on the job in front of you.</h2>
        <p>SMIRK is for the moment when answering means putting down the tool, climbing off the roof, or leaving the customer you are already serving.</p>
        <div className="v2-field-list"><span><Check size={16} /> Caller intent captured</span><span><Check size={16} /> Safety boundaries preserved</span><span><Check size={16} /> Follow-up made explicit</span></div>
      </div>
    </section>
  );
}

function LaunchPanel({ compact = false }: { compact?: boolean }) {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [policies, setPolicies] = useState<PolicyLink[]>([]);
  const [form, setForm] = useState({ business_name: "", owner_email: "", phone: "", terms_accepted: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/pricing", { cache: "no-store" }).then(async (res) => {
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "Pricing is unavailable.");
      setPlan(Array.isArray(body.plans) ? body.plans[0] || null : null);
      setPolicies(Array.isArray(body.policy_links) ? body.policy_links : []);
    }).catch((cause) => setError(cause instanceof Error ? cause.message : "Pricing is unavailable."));
  }, []);

  const ready = useMemo(() => Boolean(plan?.checkout_available && form.business_name.trim().length > 1 && /@/.test(form.owner_email) && form.phone.replace(/\D/g, "").length >= 7 && form.terms_accepted), [form, plan]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready || !plan) return;
    setBusy(true); setError("");
    try {
      const res = await fetch("/api/checkout/create", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...form, plan: plan.id }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.checkout_url) throw new Error(body.error || "Secure checkout is unavailable.");
      window.location.assign(body.checkout_url);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Secure checkout is unavailable.");
      setBusy(false);
    }
  };

  return (
    <section className={`v2-launch-panel ${compact ? "v2-launch-panel--compact" : ""}`}>
      <div className="v2-launch-panel__offer">
        <div className="v2-section__eyebrow">CURRENT RELEASE</div>
        <h2>{plan?.name || "SMIRK Starter"}</h2>
        <div className="v2-price">{plan ? `$${plan.price}` : "—"}<small>/month</small></div>
        <p>{plan?.description || "Missed-call recovery with controlled intake and one clear owner action."}</p>
        <div className="v2-field-list">
          {(plan?.features?.slice(0, 5) || ["AI call intake", "Callback tasks", "Owner alerts", "Business knowledge", "500 calls / 1,000 minutes"]).map((feature) => <span key={feature}><Check size={16} /> {feature}</span>)}
        </div>
      </div>
      <form className="v2-launch-form" onSubmit={submit}>
        <div><span className="v2-section__eyebrow">SETUP DETAILS</span><h3>Protect this business line.</h3><p>These details bind checkout to the right owner and business.</p></div>
        <label>Business name<input value={form.business_name} onChange={(e) => setForm({ ...form, business_name: e.target.value })} autoComplete="organization" required /></label>
        <label>Owner email<input type="email" value={form.owner_email} onChange={(e) => setForm({ ...form, owner_email: e.target.value })} autoComplete="email" required /></label>
        <label>Owner phone<input type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} autoComplete="tel" required /></label>
        <label className="v2-check"><input type="checkbox" checked={form.terms_accepted} onChange={(e) => setForm({ ...form, terms_accepted: e.target.checked })} /><span>I reviewed and accept the SMIRK customer policies.</span></label>
        {policies.length > 0 && <div className="v2-policy-links">{policies.map((item, index) => <a key={`${item.label}-${index}`} href={item.url || item.href} target="_blank" rel="noreferrer">{item.label || "Policy"}</a>)}</div>}
        {error && <div className="v2-error" role="alert">{error}</div>}
        <button className="v2-button v2-button--signal" type="submit" disabled={!ready || busy}>{busy ? "Opening secure checkout…" : plan?.checkout_available ? "Continue to secure checkout" : "Checkout unavailable"}<ArrowRight size={18} /></button>
      </form>
    </section>
  );
}

export function PublicHome() {
  return <div className="v2-public"><PublicHeader /><Hero /><HowItWorks /><HumanWork /><section className="v2-section v2-section--launch"><LaunchPanel compact /></section><PublicFooter /></div>;
}

export function LaunchPage() {
  return <div className="v2-public"><PublicHeader /><main className="v2-launch-page"><div className="v2-section__eyebrow">SMIRK LAUNCH</div><h1>One line. One recovery loop. One owner decision.</h1><p>Start with the narrow system that is deployed and bounded today.</p><LaunchPanel /></main><PublicFooter /></div>;
}

function PublicFooter() {
  return <footer className="v2-footer"><Wordmark /><p>Field-operations intelligence for the calls that arrive while the work is happening.</p><a href="/dashboard?admin=1">Admin sign in</a></footer>;
}

export function InvitePage({ token }: { token: string }) {
  const [preview, setPreview] = useState<any>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { fetch(`/api/invite/${encodeURIComponent(token)}`).then(async (res) => { const body = await res.json(); if (!res.ok) throw new Error(body.error || "Invite unavailable"); setPreview(body); }).catch((cause) => setError(cause.message)); }, [token]);
  const accept = async () => {
    setBusy(true); setError("");
    try {
      const res = await fetch(`/api/invite/${encodeURIComponent(token)}/accept`, { method: "POST", headers: { "Content-Type": "application/json" } });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Invite unavailable");
      writeWorkspaceSession({ workspaceId: Number(body.workspace.id), workspaceName: body.workspace.name, apiKey: String(body.workspace.api_key), role: body.member?.role, plan: body.workspace?.plan });
      window.location.assign("/dashboard/settings");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Invite unavailable"); setBusy(false); }
  };
  return <div className="v2-access-page"><div className="v2-access-card"><Wordmark /><div className="v2-kicker"><span /> SECURE OWNER ACCESS</div><h1>{preview?.workspace?.name || "Open your SMIRK workspace"}</h1><p>{error || "Accept the owner invite to configure the line and review recovered calls."}</p><button className="v2-button v2-button--signal" onClick={accept} disabled={!preview || busy}>{busy ? "Opening workspace…" : "Accept and open workspace"}</button></div></div>;
}

export function CheckoutStatusPage({ cancelled = false }: { cancelled?: boolean }) {
  const sessionId = new URLSearchParams(window.location.search).get("session_id") || "";
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<any>(null);
  const [error, setError] = useState("");

  const lookup = async () => {
    if (!email.trim()) return;
    setBusy(true); setError("");
    try {
      const res = await fetch("/api/provisioning/checkout-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), checkout_session_id: sessionId }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "Activation status is unavailable.");
      setStatus(body);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Activation status is unavailable.");
    } finally {
      setBusy(false);
    }
  };

  const resend = async () => {
    setBusy(true); setError("");
    try {
      const res = await fetch("/api/provisioning/resend-invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), checkout_session_id: sessionId }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "A new invite could not be sent.");
      await lookup();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "A new invite could not be sent.");
      setBusy(false);
    }
  };

  const summary = status?.request_summary;
  const paymentReceived = status?.checkout_verified === true && status?.payment_received === true;
  const accessActive = status?.checkout_verified === true && status?.access_active === true;
  const needsInvite = summary?.invite_expired === true || status?.next_step === "refresh_owner_invite";

  return (
    <div className="v2-access-page"><div className="v2-access-card"><Wordmark />
      <div className="v2-kicker"><span /> {cancelled ? "CHECKOUT CANCELLED" : "ACTIVATION RECEIPT"}</div>
      <h1>{cancelled ? "Nothing was charged." : paymentReceived && accessActive ? "Access is active." : "Verify the activation."}</h1>
      <p>{cancelled
        ? "Your setup details remain unsubmitted. Return when you are ready to protect the line."
        : !sessionId
          ? "The checkout reference is missing. Open the secure success link from checkout or your owner email."
          : status
            ? `${summary?.status_label || summary?.status || status?.status || "Processing"}. ${status?.next_step_label || status?.next_step || "Check the owner email for the next step."}`
            : "Use the owner email entered at checkout to verify payment, workspace access, and invitation delivery."}</p>
      {!cancelled && sessionId && <div className="v2-activation-check">
        <label>Owner email<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="owner@business.com" /></label>
        <button className="v2-button v2-button--signal" onClick={lookup} disabled={busy || !email.trim()}>{busy ? "Checking verified status…" : "Check activation status"}</button>
        {needsInvite && <button className="v2-button v2-button--ink" onClick={resend} disabled={busy}>Send a fresh owner invite</button>}
      </div>}
      {error && <div className="v2-error">{error}</div>}
      <a className="v2-text-link" href={cancelled ? "/launch" : "/dashboard"}>{cancelled ? "Return to launch" : "Open owner access"}</a>
    </div></div>
  );
}

export function PublicRouter() {
  const path = window.location.pathname;
  if (path.startsWith("/invite/")) return <InvitePage token={path.split("/invite/")[1]?.split("/")[0] || ""} />;
  if (path === "/success") return <CheckoutStatusPage />;
  if (path === "/cancel") return <CheckoutStatusPage cancelled />;
  if (path === "/launch" || path === "/pricing" || path === "/book") return <LaunchPage />;
  return <PublicHome />;
}
