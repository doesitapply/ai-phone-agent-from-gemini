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
  assert.match(appSource, /Frozen cohort size/);
  assert.match(appSource, /eligible, exact 50\/50/);
  assert.match(appSource, /Activate assignment/);
  assert.match(
    appSource,
    /`\/api\/prospecting\/learning\/experiments\/\$\{experiment\.experiment_id\}\/prepare-drafts`/
  );
  assert.match(appSource, /prepare-frozen-cohort-drafts-v1/);
  assert.match(appSource, /Prepare assigned review queue/);
  assert.match(
    appSource,
    /Every\s+recipient still requires individual approval\s+and separate execution confirmation\./
  );
  assert.match(
    appSource,
    /This creates drafts only\. It does not approve,\s+send, dial, contact, or spend\./
  );
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

test("dashboard exposes one durable next step without authorizing it", () => {
  assert.match(
    appSource,
    /"\/api\/prospecting\/revenue-loop"/
  );
  assert.match(appSource, /Revenue loop controller/);
  assert.match(appSource, /Next safe step/);
  assert.match(appSource, /NO ACTION AUTHORIZED/);
  assert.match(appSource, /Human approval required/);
  assert.match(
    appSource,
    /requiresSeparateExecutionConfirmation/
  );
  assert.match(appSource, /focusRevenueLoopNextAction/);
  assert.match(appSource, /revenueLoop\?\.nextAction\.focus/);
  assert.match(
    appSource,
    /`\/api\/prospecting\/campaigns\/\$\{campaign\.id\}`/
  );
  assert.match(
    appSource,
    /setSelectedApprovalId\(focus\.approvalId \|\| null\)/
  );
  assert.match(appSource, /setSelectedLead\(lead\)/);
  assert.match(appSource, /focusApprovalId=\{selectedApprovalId\}/);
  assert.match(
    appSource,
    /id=\{`prospect-outreach-\$\{job\.approval_id\}`\}/
  );
  assert.match(
    appSource,
    /getElementById\(`prospect-outreach-\$\{focusApprovalId\}`\)/
  );
  assert.match(appSource, /id="prospect-approval-ledger"/);
  assert.match(
    appSource,
    /The referenced outreach job changed after the controller snapshot\./
  );
  assert.match(
    appSource,
    /\.scrollIntoView\(\{ behavior: "smooth", block: "center" \}\)/
  );
  assert.match(appSource, /Open prospect/);
  assert.match(appSource, /Open record/);
  assert.match(appSource, /prioritizeRevenueLoopRecords/);
  assert.match(appSource, /revenueLoopFocusElementId/);
  assert.match(
    appSource,
    /revenue-loop-positive-review-\$\{review\.reviewId\}/
  );
  assert.match(
    appSource,
    /revenue-loop-learning-candidate-\$\{candidate\.id\}/
  );
  assert.match(
    appSource,
    /revenue-loop-velvet-outcome-\$\{item\.id\}/
  );
  assert.match(
    appSource,
    /revenue-loop-velvet-source-\$\{item\.id\}/
  );
  assert.match(
    appSource,
    /revenue-loop-velvet-discovery-\$\{item\.id\}/
  );
  assert.match(
    appSource,
    /revenue-loop-experiment-\$\{experiment\.experiment_id\}/
  );
  assert.match(
    appSource,
    /The referenced operator record changed after the controller snapshot\./
  );
  assert.match(appSource, /id="revenue-loop-source"/);
  assert.match(appSource, /id="revenue-loop-inbox"/);
  assert.match(appSource, /id="revenue-loop-learning"/);
  assert.match(appSource, /id="revenue-loop-feedback"/);
  assert.match(
    appSource,
    /id="revenue-loop-positive-review"/
  );
  assert.match(
    appSource,
    /Treat the acquisition loop as\s+paused until this queue loads successfully/
  );
  assert.match(appSource, /id="revenue-loop-review"/);
  assert.match(appSource, /id="revenue-loop-outreach"/);
});

test("an approved strategy renders content into one draft without execution", () => {
  assert.match(
    appSource,
    /candidate\.state === "APPROVED" &&\s+candidate\.recommendation_eligible === true/
  );
  assert.match(
    appSource,
    /"deterministic-eligible-cohort-v1"/
  );
  assert.match(
    appSource,
    /candidate\.evidence\.studyDesign ===\s+candidate\.proposal\.studyDesign/
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

test("approved learning has a separate reversible next-control release", () => {
  assert.match(
    appSource,
    /"\/api\/prospecting\/learning\/policies"/
  );
  assert.match(
    appSource,
    /`\/api\/prospecting\/learning\/candidates\/\$\{candidate\.id\}\/apply-policy`/
  );
  assert.match(
    appSource,
    /apply-one-approved-message-policy-v1/
  );
  assert.match(appSource, /Release as next control/);
  assert.match(
    appSource,
    /This changes experiment selection only\. It\s+does not send, dial, approve contact, or\s+spend\./
  );
  assert.match(appSource, /policy locked/);
  assert.match(
    appSource,
    /`\/api\/prospecting\/learning\/policies\/\$\{releaseId\}\/rollback`/
  );
  assert.match(
    appSource,
    /rollback-one-message-policy-v1/
  );
  assert.match(appSource, /Roll back next control/);
  assert.match(
    appSource,
    /Existing drafts and outcomes stay\s+immutable\./
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

test("experiment defaults follow inbox-tested champion-versus-challenger order", () => {
  assert.match(
    appSource,
    /getPreferredProspectMessageChallengerKey\(\{/
  );
  assert.match(
    appSource,
    /previousVariantKey:\s+policy\?\.release\.previousChampionVariantKey/
  );
  assert.match(
    appSource,
    /current\.challengerVariantKey !==\s+policy\.release\.previousChampionVariantKey/
  );
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
  assert.match(
    appSource,
    /review-one-prospect-draft-with-advisory-model-v1/
  );
  assert.match(appSource, /Run advisory QC/);
  assert.match(
    appSource,
    /Run one capped advisory review against this\s+exact draft and evidence/
  );
  assert.match(
    appSource,
    /Human approval remains mandatory\./
  );
  assert.match(
    appSource,
    /No automatic retry is permitted for this provider request\./
  );
  assert.match(
    appSource,
    /cannot approve contact, and never sends or\s+dials/
  );
  assert.doesNotMatch(appSource, /Run advisory QC for all/);
});

test("manual-call approval collects and displays the bounded compliance receipt", () => {
  assert.match(appSource, /recipientTimezone/);
  assert.match(appSource, /Federal source/);
  assert.match(appSource, /State source/);
  assert.match(appSource, /Internal source/);
  assert.match(appSource, /Federal reference/);
  assert.match(appSource, /State reference/);
  assert.match(appSource, /Internal reference/);
  assert.match(
    appSource,
    /Federal, state, and internal do-not-call\s+checks completed/
  );
  assert.match(appSource, /09:00-17:00 local/);
  assert.match(appSource, /callComplianceReceiptHash/);
  assert.match(appSource, /Evidence valid/);
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
