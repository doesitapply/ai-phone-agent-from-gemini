# SMIRK Real Audit Report - 2026-07-01

## Scope

This audit used the current checkout, source code, command output, live production checks, dependency audit output, and rendered local UI behavior. Existing SMIRK documentation was not used as product truth.

No mock product data was used for production readiness conclusions. The only local browser check using an intentionally invalid workspace session was used to verify UI access/error behavior, not to prove customer data or business metrics.

## Executive Verdict

SMIRK is a working production system with a live, current deployment, healthy database connectivity, protected operational endpoints, live buyer routes, and fresh proof-loop evidence. The core first-dollar engine is real.

It is not pristine SaaS-ready today. The biggest blocker is that the newly implemented customer-facing dashboard cleanup is still local only. Production is current to committed HEAD, but the working tree contains deploy-relevant changes that have not been committed, pushed, or deployed. The deploy approval handoff also currently fails because its artifact bundle describes an older deploy scope.

The second hard blocker is dependency hygiene: `npm audit --audit-level=moderate` fails with one high vulnerability in `form-data` and two low vulnerabilities. `npm ls form-data @babel/core esbuild` also reports extraneous and invalid installed packages, so this is not just a clean one-package advisory.

Current readiness rating from actual evidence:

- Production runtime health: 8/10
- First-dollar payment/proof loop: 8/10
- Customer-facing SaaS polish in local checkout: 7/10
- Customer-facing SaaS polish in deployed production: not verified as shipped; local patch is undeployed
- Hands-off SaaS readiness: 6/10 after deploy, 4/10 if judged only by deployed customer UX
- Local sales demo readiness: 5/10 without a real local/staging database

## Source Of Truth

- Repository: `/Users/cameronchurch/OpenClaw/workspace/ai-phone-agent-from-gemini`
- Branch: `cleanup/stop-tracking-generated-deploy-output`
- Local HEAD: `cbfb8f73af67d5b38ec8b59ade269ca6c985c335`
- Remote: `git@github.com:doesitapply/ai-phone-agent-from-gemini.git`
- Live health URL used by checks: `https://ai-phone-agent-production-6811.up.railway.app/health`
- Live reported version: `cbfb8f73af67d5b38ec8b59ade269ca6c985c335`
- Live reported branch: `cleanup/stop-tracking-generated-deploy-output`

## Verified Green

### Production deployment is current to committed HEAD

`npm run -s check:live-is-current` returned `ok: true`.

Evidence:

- Live `/health` returned HTTP 200.
- Live readiness header was `1`.
- Live version header matched local HEAD: `cbfb8f73af67d5b38ec8b59ade269ca6c985c335`.
- Live branch header matched local branch: `cleanup/stop-tracking-generated-deploy-output`.

`npm run -s check:latest-failed-deploy` returned:

```text
OK no failed deployments found for ai-phone-agent
```

### Live app health and database health are good

`npm run -s check:live-db-health && npm run -s check:live:health` passed.

Evidence:

- Live `/health` returned HTTP 200.
- App status was `ok`.
- Live DB was enabled and healthy.
- DB latency reported by the check was `3ms`.
- Live environment showed Twilio configured, AI configured, payment links configured, and owner email delivery configured.

### Buyer/public routes are live

`npm run -s check:buyer-routes-live` passed.

Verified routes included:

- `GET /`
- `GET /api/version`
- `GET /api/pricing`
- `GET /api/first-dollar-readiness`
- `GET /api/public-proof-snapshot`
- `GET /success`
- `GET /cancel`
- validation behavior on checkout/provisioning request endpoints

The public checkout route returned a validation response for incomplete input and the live buyer smoke confirmed public create behavior in the operational auth check.

### Operational auth is protected

`npm run -s check:operator-session-live && npm run -s check:operational-auth-live` passed.

Evidence:

- Operator session resolved from Railway variables.
- Role returned as `operator`.
- Operator capabilities included workspaces, logs, migrations, OpenClaw injection, provisioning, settings, and admin API.
- Unauthenticated operational endpoints rejected with 401.

Code evidence:

- `server.ts:450-488` accepts the dashboard API key as operator auth, accepts workspace Bearer tokens as workspace auth, and gates operator-only routes through `requireOperator`.
- `src/routes/operator-routes.ts` registers OpenClaw/operator routes with `dashboardAuth` plus `requireOperator`.

### Live proof loop is fresh

`npm run -s check:proof-artifacts-live && npm run -s check:post-call-intelligence-live && npm run -s check:dashboard-proof-live` passed.

Proof evidence:

- Proof artifacts check: `ok`.
- Total calls: `100`.
- Fresh calls: `100`.
- Summarized calls: `93`.
- Total tasks: `187`.
- Fresh tasks: `187`.
- Owner-action tasks: `127`.
- Correlated proof calls: `5`.
- Latest proof call: `CA9235569c21c4eaf0c4bf83084055423b`.
- Post-call latest outcome: `callback_needed`.
- Related callback tasks: `2`.
- Open related tasks: `4`.

Dashboard/public proof evidence:

- Workspace total calls: `104`.
- Summaries generated: `97`.
- Callback tasks created: `109`.
- Owner email alerts sent: `30`.
- Complete proof calls: `27`.
- Public proof calls this month: `37`.
- Transferred handoffs: `11`.
- Summary coverage: `93`.
- Latest complete proof time: `2026-07-01T23:11:00.974Z`.
- Proof age: `0.3` hours.
- `fresh: true`.
- `needsProofCall: false`.
- Public proof check confirmed no leaked fields and cache protection.

### Local compile/build/contracts pass

Verified local gates passed:

- `npm run lint`
- `npm run build`
- `npm run -s check:customer-dashboard`
- `npm run -s check:contact-management`
- `npm run -s check:auth-regression`
- `npm run -s check:openapi`
- `npm run -s check:local-runtime-smoke`

Build warning:

- Vite warned that some chunks exceed 500 kB after minification.
- Main frontend bundle reported around `1,394.81 kB`, gzip around `259.96 kB`.

## Local Only Work Not Shipped

The current working tree is dirty:

```text
M package.json
M src/App.tsx
M src/components/SetupWizard.tsx
?? scripts/check-customer-dashboard-contract.mjs
```

These changes are deploy-relevant and currently local only.

What the local patch does:

- Adds `check:customer-dashboard` to `package.json`.
- Adds `scripts/check-customer-dashboard-contract.mjs`.
- Adds customer-safe API error mapping in `src/App.tsx`.
- Adds customer-safe setup wizard error handling in `src/components/SetupWizard.tsx`.
- Hides operator cockpit tabs from customer workspace sessions.
- Keeps customer navigation to Calls, Contacts, and Tasks.
- Hides destructive/operator-only controls from customer view.
- Adds owner-visible retry states instead of silent empty states for Calls, Contacts, and Tasks failures.

Code evidence:

- `src/App.tsx:1639-1667` maps auth/network/server failures into customer-safe messages before throwing UI errors.
- `src/App.tsx:11215-11239` detects customer view and defines allowed tabs as Calls, Contacts, and Tasks.
- `src/App.tsx:11649-11691` redirects hidden customer tabs back to Calls and filters primary/overflow navigation.
- `src/App.tsx:2764`, `src/App.tsx:2902`, and `src/App.tsx:2994` hide call clearing and call deletion behind operator mode.

Local browser evidence:

- Desktop customer session at `http://localhost:3000/dashboard` showed only Calls, Contacts, and Tasks.
- The hidden labels CRM, Appointments, Handoffs, Recovery, Settings, Analytics, Mission Control, Prospecting, Agent, Voice Config, Lead Hunter, Integrations, Compliance, System Health, Logs, Call Now, Command Rail, Telemetry, and SMIRK OS were not visible.
- Customer-visible auth failure rendered: `This workspace session is not authorized. Sign out and open your latest SMIRK invite, or contact support if this keeps happening.`
- No raw `Failed to fetch`, `Network error`, `X-Api-Key`, or `Bearer token` text was visible in that rendered customer check.
- Mobile viewport also showed only Calls, Contacts, and Tasks.

Important caveat:

- This local UI check used an intentionally invalid workspace session to force a failure state. It proves the access/error surface behavior, not live customer data rendering.

## Hard Blockers

### 1. The customer-facing cleanup is not deployed

`npm run -s check:deploy-post-call-fix-ready` failed.

Failure summary:

- `ok: false`
- blocker: `deploy-approval-handoff-drift`
- `handoffSafety: fail`
- `localDeployClean: false`
- deploy-relevant dirty files:
  - `M package.json`
  - `M src/App.tsx`
  - `M src/components/SetupWizard.tsx`
  - `?? scripts/check-customer-dashboard-contract.mjs`

The live fingerprint matches local committed HEAD, but local deploy-relevant changes still need explicit approval and shipping. The approval handoff artifacts are stale and still describe an older deploy scope.

Business impact:

- The important SaaS polish work exists locally, but production cannot be claimed to have it.
- Do not tell a real customer this simplified dashboard is live until this patch is committed, approval artifacts are refreshed, deployed, and rechecked.

### 2. Dependency audit fails with a high vulnerability

`npm audit --audit-level=moderate` failed.

Findings:

- `form-data 4.0.0 - 4.0.5`: high severity, CRLF injection risk through multipart field names/filenames.
- `@babel/core <=7.29.0`: low severity arbitrary file read via malicious source map URL.
- `esbuild 0.27.3 - 0.28.0`: low severity arbitrary file read when running the dev server on Windows.

`npm audit fix` is available for `form-data` and `@babel/core`. The esbuild fix reported by npm requires `npm audit fix --force` and would install an esbuild breaking change.

Additional dependency health issue:

`npm ls form-data @babel/core esbuild` exited with `ELSPROBLEMS` and reported extraneous/invalid packages including `@babel/core`, `form-data`, and `esbuild`. It also surfaced invalid peer/range relationships around Spline, Vite, Tailwind, TypeScript, and express-rate-limit.

Business impact:

- This should block a “pristine for first customer” claim.
- The high `form-data` issue should be fixed before packaging this as ready.

### 3. Local demo mode is not real product parity

`npm run -s check:local-runtime-smoke` passed, but local no-DB startup is still a shell/demo mode.

Evidence:

- Local `/health` returned HTTP 200.
- Local no-DB health showed:
  - `twilioConfigured: false`
  - `aiConfigured: true`
  - `paymentLinksConfigured: false`
  - `ownerEmailDeliveryConfigured: false`
- Local `/api/tasks` returned an empty task list.

Business impact:

- You can boot the app locally, but it is not a convincing sales demo unless you attach a real DB/staging workspace.
- The local UI polish reduces embarrassment, but it does not replace a real demo tenant.

## High Risks

### 1. The frontend is too large and centralized

Line count evidence:

- `src/App.tsx`: `14,430` lines.
- `server.ts`: `3,873` lines.
- Source/routes sampled total: `41,352` lines.

Build evidence:

- Vite chunk warning on build.
- Main frontend bundle around `1.4 MB` before gzip.

Risk:

- This increases regression risk for every UI change.
- The customer/operator split is now logically implemented, but it lives inside a giant file where future changes can accidentally re-expose operator UI.

Practical next step:

- Keep the current local patch scoped, ship it, then split dashboard surfaces by role or route after production is stable.

### 2. DNC removal is controlled, but not customer-self-service

Code evidence:

- `src/routes/contact-routes.ts:204-229` allows authenticated workspace users to update contact status.
- `src/routes/contact-routes.ts:232-256` requires `requireOperator` for adding/removing DNC.
- `src/routes/contact-routes.ts:248-250` requires a consent/correction note of at least 8 characters to remove DNC.

Verdict:

- Contact status editing is real.
- DNC add/remove has an audit-conscious operator gate.
- A regular customer workspace user cannot directly remove DNC through the API today.

Risk:

- That is safer legally, but it means the requested “if a DNC contact calls and should get off DNC” workflow is not self-serve for the customer yet.

### 3. Workspace auth returns long-lived workspace API keys to the browser

Code evidence:

- `src/routes/auth-routes.ts` returns `workspace.api_key` after Google workspace auth.
- `server.ts:458-472` accepts that key as a Bearer token and writes the workspace ID into the request headers.

Verdict:

- This is functional and currently guarded by Google verified email plus workspace membership.
- It is still a sensitive browser credential pattern.

Risk:

- If a browser/local storage profile is compromised, the workspace Bearer token is the workspace session.
- A future SaaS hardening pass should move this toward short-lived sessions or refreshable session tokens.

## Medium Risks

### 1. Some customer-visible API failures are still swallowed

The new local patch improves Calls, Contacts, Tasks, and setup wizard errors. Some polling/fetch effects still catch and ignore failures, for example workspace list, recent calls, and task count badge fetches in `src/App.tsx`.

Risk:

- The major customer views are improved, but there can still be stale/missing badges or context without an explanation.

### 2. Some backend errors still return raw messages

Several route catch blocks return `err.message`, including workspace profile generation, website scan, and contact creation. The local frontend sanitizes major customer-facing fetch failures, but API responses themselves still expose raw operational text in places.

Risk:

- If another frontend, integration, or browser view displays these directly, customer-grade copy can regress.

### 3. Route surface remains broad

Actual route/source inspection confirms many advanced systems still exist:

- Agents
- Compliance
- Integrations
- Logs
- Mission Control
- Prospecting
- Lead Hunter
- System Health
- Workspace admin
- OpenClaw operator controls
- Twilio ops

The local customer UI now hides these, but the platform surface is still broad. Backend operator gates cover many of the high-risk routes, but the product remains bigger than a narrow missed-call MVP.

## Not Audited

These were intentionally not claimed as verified:

- No real customer workspace login was used.
- No production database rows were manually queried outside the app checks.
- No live Stripe signed webhook smoke was executed.
- No live proof call was placed.
- No Twilio cleanup apply was run.
- No legal compliance opinion was made about TCPA/DNC rules.
- No secrets were printed or inspected directly.
- No existing markdown documentation was treated as product truth.

## Immediate Action Plan

1. Refresh the deploy approval bundle so it describes the current four-file deploy scope.

   Command:

   ```bash
   npm run write:deploy-approval-bundle
   ```

2. Review and ship the local customer dashboard patch.

   Current guarded deploy command printed by the checker:

   ```bash
   CONFIRM_SMIRK_POST_CALL_FIX_DEPLOY=deploy-post-call-fix CONFIRM_SMIRK_DEPLOY_BRANCH=cleanup/stop-tracking-generated-deploy-output npm run deploy:post-call-fix
   ```

3. After deploy, rerun:

   ```bash
   npm run -s check:live-is-current
   npm run -s check:deploy-post-call-fix-ready
   npm run -s check:buyer-routes-live
   npm run -s check:live-db-health
   npm run -s check:live:health
   npm run -s check:operator-session-live
   npm run -s check:operational-auth-live
   npm run -s check:proof-artifacts-live
   npm run -s check:post-call-intelligence-live
   npm run -s check:dashboard-proof-live
   ```

4. Fix dependency audit without using force first.

   Start with:

   ```bash
   npm audit fix
   npm audit --audit-level=moderate
   npm ls form-data @babel/core esbuild
   ```

   Do not run the forced esbuild upgrade blind. It can change build/runtime behavior.

5. Create a real staging/demo workspace backed by a real database.

   Goal:

   - No fake local session.
   - No empty no-DB data shell.
   - One demo tenant with calls, contacts, tasks, proof freshness, and owner-safe UI.

6. Decide the DNC self-service policy before changing the route gate.

   Current implementation is conservative: customer can update contact status, operator can add/remove DNC with a note. If customers need DNC correction, add a request/review flow rather than simply removing `requireOperator`.

## Final Bottom Line

The backend business engine is real and live. The proof loop is fresh. The buyer/public routes are reachable. Operator auth checks pass. Production health is good.

The customer-facing SaaS cleanup is real but not shipped. The dependency tree is not clean. The local demo mode is still not production parity. Fix those three and SMIRK moves from “strong operator-assisted MVP” to a much more credible first customer SaaS.
