import assert from "node:assert/strict";
import test from "node:test";
import {
  buildVelvetHandoffLiveSafetyReport,
  inspectSmirkSyntheticHandoffSource,
  inspectVelvetProductionBundle,
  type VelvetHandoffLiveSafetyInput,
} from "../src/velvet-handoff-live-safety.ts";

const safeSmirkSource = `
  VELVET_SYNTHETIC_HANDOFF_MODE
  VELVET_SYNTHETIC_HANDOFF_PHONE
  validateSyntheticVelvetHandoffPayload
  VELVET_ALCHEMY_HANDOFF_SYNTHETIC_FIXTURE_REQUIRED
  if (!validateSyntheticVelvetHandoffPayload(input).ok)
`;

const safeVelvetBundle = `
  Add to SMIRK Research
  No contact action was created
  SMIRK Research Queue
`;

const baseInput: VelvetHandoffLiveSafetyInput = {
  localTargetCommit: "a".repeat(40),
  localTargetSource: safeSmirkSource,
  liveSmirkCommit: "a".repeat(40),
  liveSmirkSource: safeSmirkSource,
  railwayVariablesRead: true,
  handoffApiKeyConfigured: true,
  handoffApiKeyStrong: true,
  handoffMode: "synthetic-fixture-only-v1",
  handoffWorkspaceConfigured: true,
  handoffCredentialSeparated: true,
  velvetBundleRead: true,
  velvetBundleSource: safeVelvetBundle,
  requestsPerformed: 3,
};

test("detects the deployed legacy receiver and obsolete Velvet action", () => {
  const report = buildVelvetHandoffLiveSafetyReport({
    ...baseInput,
    liveSmirkSource: "legacy receiver without a synthetic boundary",
    handoffMode: null,
    velvetBundleSource: "Queue SMIRK Call SMIRK call queued",
  });

  assert.equal(report.ok, false);
  assert.equal(report.containmentRequired, true);
  assert.equal(
    report.containmentApprovalPhrase,
    "APPROVE_DISABLE_LEGACY_VELVET_HANDOFF_IN_RAILWAY"
  );
  assert.equal(
    report.liveSmirk.receiverState,
    "LEGACY_RECEIVER_EXPOSED"
  );
  assert.deepEqual(report.blockers, [
    "LIVE_LEGACY_HANDOFF_RECEIVER_EXPOSED",
    "LIVE_SMIRK_SYNTHETIC_BOUNDARY_NOT_DEPLOYED",
    "LIVE_VELVET_LEGACY_HANDOFF_UI_PRESENT",
    "LIVE_VELVET_RESEARCH_UI_UNPROVEN",
  ]);
});

test("a hardened receiver with no fixture mode is safely disabled", () => {
  const report = buildVelvetHandoffLiveSafetyReport({
    ...baseInput,
    handoffMode: null,
  });

  assert.equal(report.ok, true);
  assert.equal(report.containmentRequired, false);
  assert.equal(
    report.liveSmirk.receiverState,
    "DISABLED_SYNTHETIC_MODE_NOT_CONFIGURED"
  );
  assert.equal(report.guardrails.contactAuthorized, false);
  assert.equal(report.externalAction, "read-only-production-inspection");
});

test("a hardened receiver can expose only the explicit synthetic fixture lane", () => {
  const report = buildVelvetHandoffLiveSafetyReport(baseInput);

  assert.equal(report.ok, true);
  assert.equal(
    report.liveSmirk.receiverState,
    "SYNTHETIC_FIXTURE_ONLY"
  );
  assert.equal(report.blockers.length, 0);
});

test("credential reuse and missing inspection evidence fail closed", () => {
  const report = buildVelvetHandoffLiveSafetyReport({
    ...baseInput,
    liveSmirkSource: null,
    railwayVariablesRead: false,
    handoffCredentialSeparated: false,
    velvetBundleRead: false,
    velvetBundleSource: null,
  });

  assert.equal(report.ok, false);
  assert.equal(report.liveSmirk.receiverState, "UNKNOWN");
  assert.deepEqual(report.blockers, [
    "HANDOFF_CREDENTIAL_NOT_SEPARATED",
    "LIVE_SMIRK_SOURCE_UNAVAILABLE",
    "LIVE_VELVET_BUNDLE_UNAVAILABLE",
    "RAILWAY_PRODUCTION_VARIABLES_UNAVAILABLE",
  ]);
});

test("a safe-looking source cannot substitute for exact deploy parity", () => {
  const report = buildVelvetHandoffLiveSafetyReport({
    ...baseInput,
    liveSmirkCommit: "b".repeat(40),
  });

  assert.equal(report.ok, false);
  assert.equal(report.liveSmirk.matchesLocalTarget, false);
  assert.deepEqual(report.blockers, [
    "LIVE_SMIRK_COMMIT_NOT_LOCAL_TARGET",
  ]);
});

test("source and bundle inspectors require every hardened marker", () => {
  assert.equal(
    inspectSmirkSyntheticHandoffSource(safeSmirkSource)
      .syntheticBoundaryPresent,
    true
  );
  assert.equal(
    inspectSmirkSyntheticHandoffSource(
      safeSmirkSource.replace(
        "if (!validateSyntheticVelvetHandoffPayload(input).ok)",
        ""
      )
    ).syntheticBoundaryPresent,
    false
  );
  assert.deepEqual(inspectVelvetProductionBundle(safeVelvetBundle), {
    available: true,
    legacyHandoffControlPresent: false,
    hardenedResearchControlPresent: true,
    safe: true,
  });
  assert.equal(
    inspectVelvetProductionBundle(
      `${safeVelvetBundle} Queue SMIRK Call`
    ).safe,
    false
  );
  assert.equal(
    inspectVelvetProductionBundle(
      `${safeVelvetBundle} triggerHandoff`
    ).safe,
    false
  );
});
