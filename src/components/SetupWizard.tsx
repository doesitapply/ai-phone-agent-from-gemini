import React, { useEffect, useMemo, useState } from "react";

// Minimal wizard: guided setup + test buttons. Designed to be boring and reliable.

type ConfigStatus = {
  isConfigured: boolean;
  missingRequired: string[];
};

type Health = {
  ok: boolean;
  summary?: { failed: number; warned: number; passed: number };
  checks?: { id: string; status: "pass" | "warn" | "fail"; message: string }[];
};

async function api<T>(path: string, opts?: RequestInit): Promise<T> {
  const r = await fetch(path, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      ...(opts?.headers || {}),
    },
  });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
}

const steps = [
  { id: "basics", label: "Business" },
  { id: "twilio", label: "Twilio" },
  { id: "brain", label: "AI Brain" },
  { id: "test_sms", label: "Test SMS" },
  { id: "test_call", label: "Test Call" },
  { id: "health", label: "Health" },
] as const;

type StepId = (typeof steps)[number]["id"];

export function SetupWizard({
  open,
  onClose,
  configStatus,
}: {
  open: boolean;
  onClose: () => void;
  configStatus: ConfigStatus | null;
}) {
  const [step, setStep] = useState<StepId>("basics");

  const [webhookUrls, setWebhookUrls] = useState<{ incomingUrl: string; statusUrl: string } | null>(null);
  const [health, setHealth] = useState<Health | null>(null);

  const [testSmsTo, setTestSmsTo] = useState("");
  const [testCallTo, setTestCallTo] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setErr(null);
    setOkMsg(null);
    api<{ incomingUrl: string; statusUrl: string }>("/api/webhook-url")
      .then(setWebhookUrls)
      .catch(() => {});
  }, [open]);

  const missing = useMemo(() => configStatus?.missingRequired || [], [configStatus]);

  if (!open) return null;

  const copy = async (value: string, label: string) => {
    await navigator.clipboard.writeText(value);
    setOkMsg(`${label} copied`);
    setTimeout(() => setOkMsg(null), 2000);
  };

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setErr(null);
    setOkMsg(null);
    try {
      await fn();
      setOkMsg(`${label} OK`);
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setBusy(null);
    }
  };

  const panelCls = "rounded-2xl border border-gray-800 bg-gray-950/40 p-4";
  const btn = "rounded-xl px-4 py-2 text-sm border transition-colors";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-3xl rounded-3xl border border-gray-800 bg-gray-900 shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800">
          <div>
            <div className="text-sm font-semibold text-white">Finish setup</div>
            <div className="text-xs text-gray-400">Make this usable in 10 minutes. No terminal.</div>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white">✕</button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-[220px,1fr]">
          <div className="border-b md:border-b-0 md:border-r border-gray-800 p-3">
            {steps.map((s) => (
              <button
                key={s.id}
                onClick={() => setStep(s.id)}
                className={`w-full text-left px-3 py-2 rounded-xl text-sm transition-colors ${step === s.id ? "bg-violet-600 text-white" : "text-gray-300 hover:bg-gray-800"}`}
              >
                {s.label}
              </button>
            ))}
            {missing.length > 0 && (
              <div className="mt-3 text-[11px] text-gray-500">
                Missing required: <span className="text-gray-300">{missing.join(", ")}</span>
              </div>
            )}
          </div>

          <div className="p-6 space-y-4">
            {okMsg && <div className="text-xs text-emerald-300">{okMsg}</div>}
            {err && <div className="text-xs text-red-300">{err}</div>}

            {step === "basics" && (
              <div className={panelCls}>
                <div className="text-sm font-semibold text-white mb-1">Business basics</div>
                <div className="text-xs text-gray-400 mb-3">
                  Fill these in under <b>Settings → Business</b>. This controls what the agent says.
                </div>
                <ul className="text-xs text-gray-300 list-disc pl-5 space-y-1">
                  <li>Business name + tagline</li>
                  <li>Timezone + hours</li>
                  <li>Owner phone for escalations</li>
                </ul>
              </div>
            )}

            {step === "twilio" && (
              <div className={panelCls}>
                <div className="text-sm font-semibold text-white mb-1">Twilio</div>
                <div className="text-xs text-gray-400 mb-3">Configure Twilio in Settings, then set these URLs in Twilio Console.</div>

                <div className="space-y-3">
                  <div>
                    <div className="text-[11px] text-gray-500 mb-1">Voice webhook</div>
                    <div className="flex gap-2">
                      <code className="flex-1 text-xs p-3 rounded-xl bg-black/40 border border-gray-800 text-emerald-300 overflow-x-auto">{webhookUrls?.incomingUrl || "Loading…"}</code>
                      <button disabled={!webhookUrls?.incomingUrl} onClick={() => webhookUrls?.incomingUrl && copy(webhookUrls.incomingUrl, "Voice webhook URL")} className={`${btn} ${!webhookUrls?.incomingUrl ? "opacity-50" : "hover:border-gray-600"} border-gray-700 text-gray-200`}>Copy</button>
                    </div>
                  </div>
                  <div>
                    <div className="text-[11px] text-gray-500 mb-1">Status callback</div>
                    <div className="flex gap-2">
                      <code className="flex-1 text-xs p-3 rounded-xl bg-black/40 border border-gray-800 text-emerald-300 overflow-x-auto">{webhookUrls?.statusUrl || "Loading…"}</code>
                      <button disabled={!webhookUrls?.statusUrl} onClick={() => webhookUrls?.statusUrl && copy(webhookUrls.statusUrl, "Status callback URL")} className={`${btn} ${!webhookUrls?.statusUrl ? "opacity-50" : "hover:border-gray-600"} border-gray-700 text-gray-200`}>Copy</button>
                    </div>
                  </div>
                </div>

                <div className="mt-4 flex gap-2">
                  <button
                    onClick={() => run("Test Twilio", () => api("/api/settings/test/twilio", { method: "POST" }).then(() => {}))}
                    className={`${btn} border-violet-600 text-white hover:bg-violet-600/20`}
                    disabled={!!busy}
                  >
                    {busy === "Test Twilio" ? "Testing…" : "Test Twilio"}
                  </button>
                  <button
                    onClick={() => run("Webhook self-test", () => api("/api/twilio/test-webhook", { method: "POST" }).then(() => {}))}
                    className={`${btn} border-gray-700 text-gray-200 hover:border-gray-600`}
                    disabled={!!busy}
                  >
                    {busy === "Webhook self-test" ? "Running…" : "Run webhook self-test"}
                  </button>
                </div>
              </div>
            )}

            {step === "brain" && (
              <div className={panelCls}>
                <div className="text-sm font-semibold text-white mb-1">AI Brain</div>
                <div className="text-xs text-gray-400 mb-3">For v1, we recommend OpenRouter (fast and cheap). Configure in Settings → AI.</div>
                <div className="flex gap-2">
                  <button
                    onClick={() => run("Test OpenRouter", () => api("/api/settings/test/openrouter", { method: "POST" }).then(() => {}))}
                    className={`${btn} border-violet-600 text-white hover:bg-violet-600/20`}
                    disabled={!!busy}
                  >
                    {busy === "Test OpenRouter" ? "Testing…" : "Test OpenRouter"}
                  </button>
                  <button
                    onClick={() => run("Test OpenClaw", () => api("/api/settings/test/openclaw", { method: "POST" }).then(() => {}))}
                    className={`${btn} border-gray-700 text-gray-200 hover:border-gray-600`}
                    disabled={!!busy}
                  >
                    {busy === "Test OpenClaw" ? "Testing…" : "Test OpenClaw (optional)"}
                  </button>
                </div>
              </div>
            )}

            {step === "test_sms" && (
              <div className={panelCls}>
                <div className="text-sm font-semibold text-white mb-1">Test SMS</div>
                <div className="text-xs text-gray-400 mb-3">Send a test text to your own phone.</div>
                <div className="flex gap-2">
                  <input
                    value={testSmsTo}
                    onChange={(e) => setTestSmsTo(e.target.value)}
                    placeholder="+15551234567"
                    className="flex-1 rounded-xl bg-black/40 border border-gray-800 px-3 py-2 text-sm text-white"
                  />
                  <button
                    onClick={() => run("Send test SMS", () => api("/api/twilio/test-sms", { method: "POST", body: JSON.stringify({ to: testSmsTo }) }).then(() => {}))}
                    className={`${btn} border-violet-600 text-white hover:bg-violet-600/20`}
                    disabled={!!busy || !testSmsTo.trim()}
                  >
                    {busy === "Send test SMS" ? "Sending…" : "Send"}
                  </button>
                </div>
                <div className="text-[11px] text-gray-500 mt-2">Requires Dashboard auth. If you get a 403, add your number to COMPLIANCE_ALWAYS_ALLOW_NUMBERS.</div>
              </div>
            )}

            {step === "test_call" && (
              <div className={panelCls}>
                <div className="text-sm font-semibold text-white mb-1">Test Call</div>
                <div className="text-xs text-gray-400 mb-3">Place a test outbound call to your phone.</div>
                <div className="flex gap-2">
                  <input
                    value={testCallTo}
                    onChange={(e) => setTestCallTo(e.target.value)}
                    placeholder="+15551234567"
                    className="flex-1 rounded-xl bg-black/40 border border-gray-800 px-3 py-2 text-sm text-white"
                  />
                  <button
                    onClick={() => run("Place test call", () => api("/api/twilio/test-call", { method: "POST", body: JSON.stringify({ to: testCallTo }) }).then(() => {}))}
                    className={`${btn} border-violet-600 text-white hover:bg-violet-600/20`}
                    disabled={!!busy || !testCallTo.trim()}
                  >
                    {busy === "Place test call" ? "Calling…" : "Call"}
                  </button>
                </div>
                <div className="text-[11px] text-gray-500 mt-2">For safety, outbound test calls can require allowlist (COMPLIANCE_ALWAYS_ALLOW_NUMBERS).</div>
              </div>
            )}

            {step === "health" && (
              <div className={panelCls}>
                <div className="text-sm font-semibold text-white mb-1">System health</div>
                <div className="text-xs text-gray-400 mb-3">Run the full health check and see what is failing.</div>

                <div className="flex gap-2 mb-3">
                  <button
                    onClick={() => run("Run health", async () => {
                      const h = await api<Health>("/api/system-health");
                      setHealth(h);
                    })}
                    className={`${btn} border-violet-600 text-white hover:bg-violet-600/20`}
                    disabled={!!busy}
                  >
                    {busy === "Run health" ? "Running…" : "Run health"}
                  </button>
                </div>

                {health && (
                  <div className="text-xs text-gray-300 space-y-2">
                    <div>OK: <b>{String(health.ok)}</b> (passed {health.summary?.passed ?? 0}, warned {health.summary?.warned ?? 0}, failed {health.summary?.failed ?? 0})</div>
                    <div className="space-y-1">
                      {(health.checks || []).map((c) => (
                        <div key={c.id} className="flex gap-2">
                          <div className={`w-12 text-[11px] ${c.status === "pass" ? "text-emerald-300" : c.status === "warn" ? "text-yellow-300" : "text-red-300"}`}>{c.status.toUpperCase()}</div>
                          <div className="text-[11px] text-gray-300"><b>{c.id}</b>: {c.message}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            <div className="flex items-center justify-between pt-2">
              <div className="text-[11px] text-gray-500">
                Goal: setup in under 10 minutes. Click “Test Call”, hear the agent, see it logged.
              </div>
              <div className="flex gap-2">
                <button onClick={onClose} className={`${btn} border-gray-700 text-gray-200 hover:border-gray-600`}>Close</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
