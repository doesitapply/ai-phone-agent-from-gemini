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
