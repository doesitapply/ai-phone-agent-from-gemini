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
    /I reviewed the measured sample and understand this\s+decision records a recommendation only\./
  );
});

test("an approved strategy renders content into one draft without execution", () => {
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
