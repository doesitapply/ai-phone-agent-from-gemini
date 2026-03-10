import React, { useState, useEffect } from "react";
import { Phone, PhoneCall, Settings, Activity, AlertCircle } from "lucide-react";

type LogMessage = { role: string; text: string };
type LogsRecord = Record<string, LogMessage[]>;

export default function App() {
  const [phoneNumber, setPhoneNumber] = useState("");
  const [status, setStatus] = useState("");
  const [logs, setLogs] = useState<LogsRecord>({});
  const [isCalling, setIsCalling] = useState(false);

  // Poll for logs
  useEffect(() => {
    const fetchLogs = async () => {
      try {
        const res = await fetch(`/api/logs?t=${Date.now()}`, {
          credentials: "include",
        });
        if (res.ok) {
          const data = await res.json();
          setLogs(data);
        }
      } catch (err) {
        console.error("Failed to fetch logs", err);
      }
    };

    fetchLogs();
    const interval = setInterval(fetchLogs, 2000);
    return () => clearInterval(interval);
  }, []);

  const handleCall = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!phoneNumber) return;

    setIsCalling(true);
    setStatus("Initiating call...");

    try {
      const res = await fetch("/api/calls", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: phoneNumber }),
        credentials: "include",
      });

      const data = await res.json();

      if (res.ok) {
        setStatus(`Call initiated! Call SID: ${data.callSid}`);
      } else {
        setStatus(`Error: ${data.error}`);
      }
    } catch (err: any) {
      setStatus(`Error: ${err.message}`);
    } finally {
      setIsCalling(false);
    }
  };

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900 font-sans p-6 md:p-12">
      <div className="max-w-5xl mx-auto space-y-8">
        <header className="flex items-center space-x-4 border-b border-zinc-200 pb-6">
          <div className="p-3 bg-indigo-600 rounded-xl text-white shadow-sm">
            <PhoneCall size={28} />
          </div>
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">AI Phone Agent</h1>
            <p className="text-zinc-500 mt-1">Powered by Twilio and Google Gemini</p>
          </div>
        </header>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Left Column: Controls & Setup */}
          <div className="space-y-8 lg:col-span-1">
            {/* Make a Call Card */}
            <section className="bg-white rounded-2xl shadow-sm border border-zinc-200 p-6">
              <h2 className="text-lg font-medium flex items-center mb-4">
                <Phone className="mr-2 text-zinc-400" size={20} />
                Make Outbound Call
              </h2>
              <form onSubmit={handleCall} className="space-y-4">
                <div>
                  <label htmlFor="phone" className="block text-sm font-medium text-zinc-700 mb-1">
                    Phone Number
                  </label>
                  <input
                    id="phone"
                    type="tel"
                    placeholder="+1234567890"
                    value={phoneNumber}
                    onChange={(e) => setPhoneNumber(e.target.value)}
                    className="w-full px-4 py-2 border border-zinc-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none transition-all"
                    required
                  />
                  <p className="text-xs text-zinc-500 mt-1">Include country code (e.g., +1 for US)</p>
                </div>
                <button
                  type="submit"
                  disabled={isCalling || !phoneNumber}
                  className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-medium py-2.5 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex justify-center items-center"
                >
                  {isCalling ? "Calling..." : "Call Now"}
                </button>
              </form>
              {status && (
                <div className={`mt-4 p-3 rounded-lg text-sm ${status.startsWith("Error") ? "bg-red-50 text-red-700 border border-red-100" : "bg-emerald-50 text-emerald-700 border border-emerald-100"}`}>
                  {status}
                </div>
              )}
            </section>

            {/* Setup Instructions */}
            <section className="bg-white rounded-2xl shadow-sm border border-zinc-200 p-6">
              <h2 className="text-lg font-medium flex items-center mb-4">
                <Settings className="mr-2 text-zinc-400" size={20} />
                Setup Instructions
              </h2>
              
              <div className="space-y-4 text-sm text-zinc-600">
                <div className="p-3 bg-amber-50 border border-amber-100 rounded-lg flex items-start">
                  <AlertCircle className="text-amber-600 mr-2 shrink-0 mt-0.5" size={16} />
                  <p>You must configure Twilio credentials in the AI Studio Settings menu (Secrets panel) for this to work.</p>
                </div>

                <ol className="list-decimal list-inside space-y-3 ml-1">
                  <li>Add <code className="bg-zinc-100 px-1 py-0.5 rounded text-xs text-zinc-800">TWILIO_ACCOUNT_SID</code> to Secrets.</li>
                  <li>Add <code className="bg-zinc-100 px-1 py-0.5 rounded text-xs text-zinc-800">TWILIO_AUTH_TOKEN</code> to Secrets.</li>
                  <li>Add <code className="bg-zinc-100 px-1 py-0.5 rounded text-xs text-zinc-800">TWILIO_PHONE_NUMBER</code> to Secrets.</li>
                  <li className="pt-2 border-t border-zinc-100">
                    To receive incoming calls, configure your Twilio phone number's webhook URL to:
                    <div className="mt-2 p-2 bg-zinc-900 text-zinc-300 rounded text-xs break-all font-mono">
                      {window.location.origin.replace("ais-dev-", "ais-pre-")}/api/twilio/incoming
                    </div>
                    <p className="mt-2 text-xs text-zinc-500">
                      Note: You must use the Shared App URL (ais-pre-) so Twilio can access the webhook without authentication.
                    </p>
                  </li>
                </ol>
              </div>
            </section>
          </div>

          {/* Right Column: Call Logs */}
          <div className="lg:col-span-2">
            <section className="bg-white rounded-2xl shadow-sm border border-zinc-200 p-6 h-full min-h-[500px] flex flex-col">
              <h2 className="text-lg font-medium flex items-center mb-6">
                <Activity className="mr-2 text-zinc-400" size={20} />
                Live Conversation Logs
              </h2>
              
              <div className="flex-1 overflow-y-auto space-y-6 pr-2">
                {Object.keys(logs).length === 0 ? (
                  <div className="h-full flex flex-col items-center justify-center text-zinc-400 space-y-3">
                    <Activity size={48} className="opacity-20" />
                    <p>No active or recent calls.</p>
                  </div>
                ) : (
                  (Object.entries(logs) as [string, LogMessage[]][]).reverse().map(([callSid, messages]) => (
                    <div key={callSid} className="border border-zinc-100 rounded-xl overflow-hidden">
                      <div className="bg-zinc-50 px-4 py-2 border-b border-zinc-100 flex justify-between items-center">
                        <span className="text-xs font-mono text-zinc-500">Call: {callSid}</span>
                        <span className="text-xs font-medium text-emerald-600 bg-emerald-50 px-2 py-1 rounded-full">Active</span>
                      </div>
                      <div className="p-4 space-y-4">
                        {messages.length === 0 ? (
                          <p className="text-sm text-zinc-500 italic">Call initiated, waiting for speech...</p>
                        ) : (
                          messages.map((msg, idx) => (
                            <div key={idx} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                              <div className={`max-w-[80%] rounded-2xl px-4 py-2.5 text-sm ${
                                msg.role === "user" 
                                  ? "bg-indigo-600 text-white rounded-tr-sm" 
                                  : "bg-zinc-100 text-zinc-800 rounded-tl-sm"
                              }`}>
                                <span className="block text-[10px] opacity-70 mb-1 uppercase tracking-wider font-semibold">
                                  {msg.role === "user" ? "Caller" : "AI Agent"}
                                </span>
                                {msg.text}
                              </div>
                            </div>
                          ))
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
