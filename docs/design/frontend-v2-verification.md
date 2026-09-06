# Frontend V2 Verification Record

## Local production-build preview

The new frontend root rendered successfully from the production Vite bundle on 2026-09-05. The observed public home is the new warm industrial interface, not the legacy `App.tsx` interface. The desktop hero, recovery instrument, workflow receipt, primary launch action, public navigation, and no-fabrication disclosure were visible and legible at the first viewport.

At 1440×900, the hero uses a balanced two-column structure with the operational headline and CTA on the left and the recovery receipt instrument on the right. Text contrast, primary-action contrast, spacing, and the no-fabrication label are clear. The stage strip remains visible at the bottom of the first viewport and reinforces the intended signal → context → decision grammar without pretending to be live data.

At 390×844, the layout becomes a single-column mobile hierarchy. The wordmark and sign-in action remain visible, the headline wraps without clipping, the primary and secondary actions retain clear separation, and the recovery instrument begins below the narrative without horizontal overflow. The top navigation intentionally collapses to sign-in; workflow and launch remain available through the body actions. Below-the-fold mobile sections still require a full-page review after integrated API data is available.

The replacement bundle is materially smaller than the legacy frontend bundle: the switched V2 build produced approximately 492 kB of JavaScript and 25 kB of CSS before compression, compared with approximately 1.4 MB of JavaScript and 154 kB of CSS when the legacy root was active.

## Remaining verification gates

The local static preview does not provide backend API responses, so live pricing, authenticated workspace data, owner actions, and Google exchange require integrated or production verification.

The last production Google Identity attempt reached Google but returned an `origin_mismatch` error for `https://www.smirkcalls.com`. The application-side server-session correction is implemented and tested, but Google Cloud must authorize the production JavaScript origin before browser sign-in can be declared fixed. This is a provider-console configuration gate, not a remaining browser-token design issue.

The connected Google Cloud browser account can access the visible `SMIRK` project (`smirk-491205`), but that project currently contains no OAuth 2.0 clients. Directly opening the numeric project that owns the rejected client (`699281577830`) returns `resourcemanager.projects.get` missing. Therefore the active browser account does not have permission to edit the OAuth client currently configured in Railway. The safe options are: grant the operator account access to the existing Google project and add `https://www.smirkcalls.com` as an authorized JavaScript origin, or create a replacement web OAuth client inside the accessible SMIRK project and deliberately rotate Railway to that new client ID after its origin is configured. No provider setting was changed during this inspection.

Desktop and mobile route screenshots, authenticated owner-session behavior, ordinary-user denial, logout, and production deploy verification remain open.

## Workfloor fidelity correction

After the user rejected the softened V2 direction, the presentation layer was replaced rather than incrementally restyled. The active V2 root now loads `src/v2/workfloor.css`; the former `v2.css` is no longer imported.

The corrected 1440×900 public hero now materially follows the supplied ivory workfloor reference family: a 40/60 split canvas, condensed oversized job-protection headline, machined black instrument housing, vertical signal/context/decision modules, physical fastener details, a paper recovery receipt, restrained lime signal path, and a full-width three-stage workflow rail. The illustration remains explicitly labeled `WORKFLOW FORMAT — NOT LIVE DATA`.

At 390×844, the mobile hierarchy remains legible and does not overflow horizontally. The CTA and evidence disclosure are retained above the instrument. The machined instrument converts to a stacked layout below the hero copy. A full-page mobile capture remains required to validate the entire receipt and downstream sections.

The 1440×5000 full-page review confirmed that the corrected visual language continues beyond the hero: the workflow explanation uses clipped evidence plates, the human-at-work section is embedded in a dark workfloor bay, and the live checkout form is paired with a machined current-release panel. The footer returns to the black instrument surface instead of a generic marketing footer. The production-build preview correctly shows live pricing as unavailable because the static preview has no API backend; it does not insert a fabricated price.

The 1440×1800 launch-page review confirmed the checkout route shares the same ivory workfloor base, condensed uppercase hierarchy, black release plate, clipped setup panel, monospace labels, and restrained lime action state. The remaining public visual check is the full mobile page, which requires tiled inspection because its capture is more than twelve times taller than it is wide.

## Reconciled current-main captures

After rebasing the V2/auth work onto the 33 newer commits that were present on GitHub `main`, the production bundle was rebuilt and recaptured. The 1440×1600 public desktop view retains the intended asymmetric ivory workfloor, condensed headline, machined black signal instrument, physical recovery receipt, three-stage rail, clipped workflow plates, and explicit `WORKFLOW FORMAT — NOT LIVE DATA` disclosure. No post-rebase visual regression was observed in the visible hero or first workflow section.

The 390×1200 public mobile view preserves one dominant CTA, a separate workflow link, the no-fabrication disclosure, and the complete signal/context/decision strip above the receipt. The receipt remains inside the machined frame without horizontal overflow; narrow rows wrap rather than truncating evidence labels. This viewport validates the hero and upper instrument only. A later full-height or tiled mobile review is still required for the lower workflow, human-work, checkout, and footer sections.

The reconciled 1440×1600 launch view preserves the same ivory, black-machined, condensed-type system as the public hero. Pricing remains a dash and the action reads `Checkout unavailable` in the static preview because no backend is attached; the page does not substitute the approved $197 price without API evidence. The business, email, phone, and policy-acknowledgement controls remain visible and aligned next to the current-release panel.

At 390×1200, the launch headline and Starter plate fit without horizontal clipping, the features remain readable, and the setup panel begins as a clear second stage. The captured viewport ends before the form fields and submit action, so a taller mobile capture is still required to verify the entire checkout form and footer at phone width.

The reconciled Google owner-access screen remains visually coherent at 1440×1200 and 390×1100: one centered machined access panel, one purpose statement, one trust explanation, one provider state, and a clear return path. At mobile width the clipped housing remains inside the viewport and the headline, explanatory copy, failure state, and return link remain readable. The static preview correctly reports `Google sign-in is unavailable` because it has no backend configuration. A real Google button, approved-account exchange, authenticated owner shell, ordinary-account denial, cookie restoration, and logout still require the replacement OAuth client and an integrated production-origin test.

### Full-height public mobile tile review

Tiles 1–2 confirm the header, hero headline, explanatory copy, primary and secondary actions, and no-fabrication disclosure remain readable without horizontal clipping. The overlap shows a clean transition into the machined instrument; all three evidence stages remain aligned above the receipt, and the receipt rows begin within the black housing without overflow.

Tiles 3–4 confirm the receipt closes cleanly with the no-live-data label and physical torn edge, followed by a vertically stacked call/context/decision rail with consistent numbering. The workflow section starts without an accidental gap or overlap; its condensed headline and supporting explanation remain fully readable at 390 pixels.

Tiles 5–6 confirm all three workflow plates remain distinct, correctly ordered, and readable at phone width, with no collapsed borders or overlapping copy. The third plate transitions into the approved human-at-work image without clipping; the worker remains legible as a real-world context image rather than being mislabeled as live customer evidence.

Tiles 7–8 confirm the human-work image and dark narrative panel share one continuous section. The large `STAY ON THE JOB IN FRONT OF YOU` statement, supporting copy, and three bounded outcomes remain readable, and the transition into the Starter release plate does not introduce a broken divider. The static preview continues to show pricing as unavailable rather than inventing a value.

Tiles 9–10 confirm the entire Starter feature list, business name, owner email, owner phone, policy acknowledgement, and checkout action remain visible and usable at 390 pixels. Labels and policy text wrap without colliding with controls. The disabled `Checkout unavailable` state is obvious but not visually mistaken for an enabled action. The dark footer follows without overlap and retains the wordmark, positioning line, and admin return path. The ten-tile review therefore closes the full-height public mobile visual gate with no horizontal overflow or missing section.

### Full-height launch mobile tile review

Launch tiles 1–2 confirm the mobile header, full owner-decision headline, bounded release explanation, Starter plate, unavailable pricing state, and complete feature list remain readable without horizontal clipping. The clipped black release plate retains its physical geometry and transitions directly into the ivory setup panel.

Launch tiles 3–4 confirm the complete setup panel fits the mobile column: all three labeled fields, policy acknowledgement, and disabled checkout action remain aligned and readable. The clipped lower panel boundary closes cleanly, followed by the dark footer with no overlap. The large empty area after the footer in the oversized viewport is outside the document content, not a layout gap inside the page.

Launch tile 5 contains only the ivory body background after the document footer. This confirms the prior tile captured the complete route and no lower form, policy, action, or footer content was clipped. The five-tile launch mobile review is complete.

## Reconciled release and authenticated-shell evidence

The full current-main release command completed successfully after regenerating `openapi.yaml`: TypeScript, unit suites, deployment-identity guards, Velvet control/handoff/acquisition/outcome contracts, checkout/fulfillment fixtures, auth checks, all 233 concrete OpenAPI route declarations, and the production frontend/server build returned zero failures. The first two attempts were rejected by the deploy-archive guard because the sandbox injected ambient Git override variables; rerunning with only that sandbox override tuple removed preserved the guard and allowed it to evaluate the actual repository.

For authenticated UI verification, an isolated local server used a disposable non-production signing value and a temporary local-only cookie bridge. No Google token or production secret was used. The first browser attempt failed because production `APP_URL` in the inherited environment caused the local Origin to be rejected by the intentional CORS allowlist; Chrome DevTools showed HTTP 500 for `/@vite/client`, `/@react-refresh`, and `/src/main.tsx`. Restarting the isolated server with `http://127.0.0.1:3001` explicitly allowlisted resolved the module failures without changing product CORS code.

The authenticated root then mounted with the dark workfloor owner shell, `SYSTEM CONNECTED`, the verified admin identity, and the narrow navigation set: Today, Calls, Tasks, Business knowledge, Settings, and Admin tools. The UI truthfully rendered `NO WORKSPACE SELECTED` because the sandbox could not establish its external database connection; it did not fabricate workspace data. Page-level Today/Calls/Tasks/Business Knowledge/Settings/Admin visual validation against real workspace records therefore remains a production-origin gate after the replacement OAuth client is active.

## Replacement Google Auth client

On 2026-09-05, the accessible Google Cloud project `smirk-491205` was configured for an External OAuth audience in Testing status. A replacement Web application client named `SMIRK Calls Production Web` was created with exactly two authorized JavaScript origins: `https://www.smirkcalls.com` and `https://smirkcalls.com`. No redirect URI was added because SMIRK uses the Google Identity Services credential response and posts the resulting ID token to the same-origin server exchange route.

The approved administrator account was added as the sole test user. The public client identifier was copied directly to the browser clipboard for placement in Railway; the displayed client secret was not downloaded, copied, stored, or added to application configuration because this sign-in design does not use it. Google reports that origin changes may take from five minutes to several hours to propagate. Branding remains marked incomplete for public publication, but the app is intentionally restricted to the approved test user for this operator-login repair.

Google's current Sign in with Google documentation distinguishes popup and redirect handling. The JavaScript popup UX can return the JWT only to a browser callback, while redirect UX sends the JWT directly to an HTTPS `login_uri` by POST; that URI must exactly match an authorized redirect URI. This provides a deterministic full-page fallback for browsers or automation environments where the popup account chooser is suppressed or inaccessible. Sources: https://developers.google.com/identity/gsi/web/reference/js-reference and https://developers.google.com/identity/gsi/web/guides/display-button.
