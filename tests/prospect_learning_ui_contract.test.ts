import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const appSource = fs.readFileSync("src/App.tsx", "utf8");

test("dashboard exposes the measured candidate review loop", () => {
  assert.match(
    appSource,
    /"\/api\/prospecting\/learning\/candidates"/
  );
  assert.match(
    appSource,
    /`\/api\/prospecting\/learning\/candidates\/\$\{candidate\.id\}\/decision`/
  );
  assert.match(appSource, /Create review candidate/);
  assert.match(appSource, /Human decision queue/);
  assert.match(
    appSource,
    /I reviewed the measured sample and understand this\s+decision records a recommendation only\./
  );
});

test("an approved variant is opt-in for one draft and cannot imply execution", () => {
  assert.match(
    appSource,
    /setVariantKey\(\s*approvedVariant\.proposal\.promoteVariant\s*\)/
  );
  assert.match(appSource, /Use for this draft/);
  assert.match(
    appSource,
    /This copies one variant key into this draft only\. It does not\s+send, dial, or change runtime outreach policy\./
  );
  assert.match(
    appSource,
    /Recommendation approved\. It remains opt-in for each reviewed draft\./
  );
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
