import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const appSource = fs.readFileSync("src/App.tsx", "utf8");

test("dashboard exposes the deterministic experiment and review loop", () => {
  assert.match(
    appSource,
    /"\/api\/prospecting\/learning\/experiments"/
  );
  assert.match(
    appSource,
    /`\/api\/prospecting\/learning\/experiments\/\$\{experiment\.experiment_id\}\/\$\{action\}`/
  );
  assert.match(
    appSource,
    /"\/api\/prospecting\/learning\/candidates"/
  );
  assert.match(
    appSource,
    /`\/api\/prospecting\/learning\/candidates\/\$\{candidate\.id\}\/decision`/
  );
  assert.match(appSource, /Deterministic message experiment/);
  assert.match(appSource, /Activate assignment/);
  assert.match(appSource, /Close experiment/);
  assert.match(appSource, /Evaluate closed cohort/);
  assert.match(appSource, /Human decision queue/);
  assert.match(
    appSource,
    /I reviewed the assigned cohort and understand this decision records a recommendation only\./
  );
  assert.match(appSource, /candidate\.recommendation_eligible === true/);
  assert.match(appSource, /ASSIGNED COHORT/);
  assert.match(appSource, /LEGACY \/ INELIGIBLE/);
  assert.match(
    appSource,
    /This historical candidate cannot be approved as a recommendation\./
  );
  assert.match(
    appSource,
    /This legacy candidate is excluded from draft recommendations\./
  );
});

test("an approved strategy renders content into one draft without execution", () => {
  assert.match(
    appSource,
    /candidate\.state === "APPROVED" &&\s+candidate\.recommendation_eligible === true/
  );
  assert.match(
    appSource,
    /candidate\.proposal\.studyDesign ===\s+"deterministic-assignment-v1"/
  );
  assert.match(
    appSource,
    /candidate\.evidence\.studyDesign ===\s+"deterministic-assignment-v1"/
  );
  assert.match(
    appSource,
    /applyProspectMessageVariant\(\s*approvedVariant\.proposal\.promoteVariant,\s*channel\s*\)/
  );
  assert.match(appSource, /setSubject\(rendered\.subject \|\| ""\)/);
  assert.match(appSource, /setContent\(rendered\.content\)/);
  assert.match(appSource, /Use for this draft/);
  assert.match(appSource, /Use assigned strategy/);
  assert.match(appSource, /recorded as off protocol/);
  assert.match(appSource, /executed outreach jobs across/);
  assert.match(appSource, /Observational message signals/);
  assert.match(
    appSource,
    /descriptive and cannot create a\s+recommendation by itself/
  );
  assert.match(
    appSource,
    /This renders the registered subject and copy into this draft\s+only\. It does not send, dial, or change runtime outreach\s+policy\./
  );
  assert.match(
    appSource,
    /Recommendation approved\. It remains opt-in for each reviewed draft\./
  );
});

test("channel switching replaces email prose with a registered call brief", () => {
  assert.match(
    appSource,
    /const nextKey = getDefaultProspectMessageVariantKey\(nextChannel\)/
  );
  assert.match(
    appSource,
    /applyProspectMessageVariant\(nextKey, nextChannel\)/
  );
  assert.match(appSource, /onClick=\{\(\) => switchOutreachChannel\(value\)\}/);
});

test("operator edits are visibly separated from registered strategies", () => {
  assert.match(appSource, /setVariantKey\("operator-custom"\)/);
  assert.match(appSource, /Custom reviewed copy/);
  assert.match(appSource, /prepared as \$\{/);
});

test("operator approval displays QC without granting it execution authority", () => {
  assert.match(appSource, /qc_receipt/);
  assert.match(appSource, /"eligible for human review"/);
  assert.match(
    appSource,
    /QC authorizes neither contact nor execution\./
  );
  assert.match(
    appSource,
    /Legacy draft without a QC receipt\. Prepare a new draft;/
  );
  assert.match(appSource, /qcAdvisoryFlagsReviewed/);
  assert.match(
    appSource,
    /Advisory model flags reviewed; deterministic\s+rules and human judgment remain authoritative/
  );
  assert.match(appSource, /Send this one approved email/);
  assert.match(appSource, /Manual operator dial only/);
});

test("operator UI exposes a five-inbox gate without a bulk-send action", () => {
  assert.match(
    appSource,
    /"\/api\/prospecting\/inbox-placement"/
  );
  assert.match(
    appSource,
    /`\/api\/prospecting\/inbox-placement\/\$\{test\.testId\}\/items\/\$\{item\.approvalId\}\/inspect`/
  );
  assert.match(
    appSource,
    /`\/api\/prospecting\/inbox-placement\/\$\{test\.testId\}\/finalize`/
  );
  assert.match(appSource, /Controlled inbox placement gate/);
  assert.match(appSource, /Prepare five controlled drafts/);
  assert.match(appSource, /Approve this controlled draft/);
  assert.match(appSource, /Send this one controlled seed/);
  assert.match(appSource, /Record immutable inspection/);
  assert.match(appSource, /Finalize five-inbox receipt/);
  assert.match(
    appSource,
    /Preparation creates five hidden controlled-mailbox jobs and performs\s+no external action\./
  );
  assert.match(
    appSource,
    /Each draft requires its own approval and its own\s+send confirmation\./
  );
  assert.match(
    appSource,
    /Deployment or seed-test\s+preparation is not send approval\./
  );
  assert.match(
    appSource,
    /Fresh matching five-inbox receipt required/
  );
  assert.doesNotMatch(appSource, /Send all controlled seeds/);
  assert.doesNotMatch(appSource, /Approve all controlled drafts/);
});

test("operator chat stays docked in the command rail instead of covering work", () => {
  assert.match(appSource, /dockToCommandRail=\{!isCustomerView\}/);
  assert.match(appSource, /commandRailCollapsed=\{commandRailCollapsed\}/);
  assert.match(appSource, /dockToCommandRail && commandRailCollapsed/);
  assert.doesNotMatch(appSource, /xl:right-\[344px\]/);
});

test("prospect review is portaled above command and chat rails", () => {
  assert.match(appSource, /import \{ createPortal \} from "react-dom"/);
  assert.match(
    appSource,
    /return createPortal\(\s*<div\s+className="fixed inset-0 z-\[70\] bg-black\/70"/
  );
  assert.match(appSource, /document\.body\s*\);/);
  assert.match(
    appSource,
    /className=\{`fixed bottom-4 right-4 z-\[60\]/
  );
});
