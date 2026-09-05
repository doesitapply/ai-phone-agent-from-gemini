import { Headphones, Info, PhoneCall } from "lucide-react";

const SAMPLE_CALL_TURNS = [
  ["SMIRK", "Thanks for calling Valley Air. This is SMIRK covering a missed call. How can we help?"],
  ["Caller", "The AC just died and my mom is 78. It is 98 degrees in the house."],
  ["SMIRK", "I am sorry she is in that heat. What address should the technician go to?"],
  ["Caller", "418 Maple in Sparks. The unit is a Carrier, maybe 12 years old."],
  ["SMIRK", "No cooling, elderly resident at home. Is anyone there now for a callback?"],
  ["Caller", "I will be here. After two if you can."],
  ["SMIRK", "Valley Air will call this number as soon as a technician is free. I will flag it urgent."],
  ["Caller", "The breaker has not tripped. It just blows warm air."],
  ["SMIRK", "Logged. You will get a callback from Valley Air."],
] as const;

const OWNER_FIELDS = [
  ["Who", "Maria Alvarez"],
  ["Need", "No AC · elderly resident home"],
  ["Urgency", "Urgent"],
  ["Address", "418 Maple St · Sparks"],
  ["Window", "After 2:00 p.m."],
] as const;

export function PublicRecoveredCallDemo() {
  return (
    <section id="hear" className="smirk-recovered-call-section px-5 py-16 sm:py-24" aria-labelledby="recovered-call-title">
      <div className="mx-auto max-w-7xl">
        <div className="mb-9 grid gap-5 lg:grid-cols-[0.72fr_1.28fr] lg:items-end">
          <div className="smirk-public-eyebrow">Hear the handoff</div>
          <div>
            <h2 id="recovered-call-title" className="max-w-4xl text-4xl sm:text-5xl">Five facts. One callback. No transcript hunt.</h2>
            <p className="mt-4 max-w-2xl text-base leading-7 text-gray-400">Listen to a fictional HVAC recovery, then see the exact owner-ready record it leaves behind.</p>
          </div>
        </div>

        <div className="smirk-recovered-call grid overflow-hidden lg:grid-cols-[0.88fr_1.12fr]">
          <div className="smirk-recovered-call__photo relative min-h-[330px] overflow-hidden lg:min-h-[610px]">
            <img src="/smirk-images/dash-phone.webp" alt="A callback notification shown on a phone inside a service vehicle" className="absolute inset-0 h-full w-full object-cover" />
            <div className="smirk-recovered-call__photo-shade absolute inset-0" aria-hidden="true" />
            <div className="smirk-recovered-call__ticket absolute bottom-5 left-5 right-5 p-5">
              <div className="smirk-recovered-call__eyebrow">Callback ready</div>
              <div className="mt-1 text-lg font-semibold">No AC · elderly resident home</div>
            </div>
          </div>

          <div className="flex flex-col justify-between p-6 sm:p-9 lg:p-12">
            <div>
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2 text-sm font-semibold"><Headphones size={17} /> Sample HVAC recovery</div>
                  <div className="mt-2 text-sm text-white/55">No cooling · urgent callback · 49 seconds</div>
                </div>
                <span className="smirk-recovered-call__badge">Fictional demo</span>
              </div>

              <audio controls preload="metadata" className="mt-7 h-11 w-full" aria-label="Play the synthetic SMIRK recovered-call demonstration">
                <source src="/smirk-recovered-call-demo.mp3" type="audio/mpeg" />
                Your browser does not support audio playback.
              </audio>

              <dl className="mt-7 grid gap-px overflow-hidden sm:grid-cols-2">
                {OWNER_FIELDS.map(([label, value]) => (
                  <div key={label} className="smirk-recovered-call__fact p-4">
                    <dt>{label}</dt>
                    <dd className="mt-1 text-sm font-semibold">{value}</dd>
                  </div>
                ))}
                <div className="smirk-recovered-call__task p-4 sm:col-span-2">
                  <dt>Open task</dt>
                  <dd className="mt-1 flex flex-wrap items-center justify-between gap-3 text-sm font-semibold">
                    <span>Call Maria about urgent no-cooling request</span>
                    <a href="/dashboard" className="inline-flex items-center gap-2">Open owner desk <PhoneCall size={15} /></a>
                  </dd>
                </div>
              </dl>

              <details className="mt-4 border border-white/10 px-5 py-4">
                <summary className="cursor-pointer text-sm font-semibold">Read the transcript excerpt</summary>
                <div className="mt-5 grid gap-3">
                  {SAMPLE_CALL_TURNS.map(([speaker, spokenText], index) => (
                    <div key={`${speaker}-${index}`} className="grid grid-cols-[58px_1fr] gap-3 text-xs leading-5">
                      <span className={speaker === "SMIRK" ? "text-[#c8e86a]" : "text-white/45"}>{speaker}</span>
                      <span className="text-white/70">{spokenText}</span>
                    </div>
                  ))}
                </div>
              </details>
            </div>

            <div className="mt-7 flex items-start gap-2 border-t border-white/10 pt-5 text-[11px] leading-5 text-white/50">
              <Info size={14} className="mt-0.5 shrink-0" />
              <span>Synthetic demonstration with fictional business, caller, address, and scenario. It is not a customer recording, testimonial, booked-job claim, or revenue result.</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
