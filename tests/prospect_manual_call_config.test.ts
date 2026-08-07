import assert from "node:assert/strict";
import test from "node:test";
import {
  PROSPECT_MANUAL_CALL_MODE,
  publicProspectManualCallConfig,
  readProspectManualCallConfig,
} from "../src/prospect-manual-call-config.ts";

const configuredEnv = {
  PROSPECT_MANUAL_CALL_ENABLED: "true",
  PROSPECT_MANUAL_CALL_MODE,
  PROSPECT_MANUAL_CALL_WORKSPACE_ID: "7",
  PROSPECT_MANUAL_CALL_DAILY_APPROVAL_CAP: "1",
};

test("manual-call configuration exposes only an operator tel-link lane", () => {
  const config = readProspectManualCallConfig(configuredEnv);
  assert.equal(config.enabled, true);
  assert.equal(config.configured, true);
  assert.equal(config.workspaceId, 7);
  assert.equal(config.dailyApprovalCap, 1);
  assert.equal(config.manualDialOnly, true);
  assert.equal(config.providerExecutionAllowed, false);
  assert.equal(config.automatedDialingAllowed, false);
  assert.deepEqual(config.missing, []);

  const publicConfig = publicProspectManualCallConfig(config, 7);
  assert.equal(publicConfig.availableForWorkspace, true);
  assert.equal(publicConfig.providerExecutionAllowed, false);
  assert.equal(publicConfig.automatedDialingAllowed, false);
});

test("manual-call configuration fails closed on missing, drifted, or excessive values", () => {
  const config = readProspectManualCallConfig({
    PROSPECT_MANUAL_CALL_ENABLED: "true",
    PROSPECT_MANUAL_CALL_MODE: "provider-autodial-v1",
    PROSPECT_MANUAL_CALL_WORKSPACE_ID: "0",
    PROSPECT_MANUAL_CALL_DAILY_APPROVAL_CAP: "6",
  });
  assert.equal(config.enabled, true);
  assert.equal(config.configured, false);
  assert.deepEqual(config.missing, [
    "PROSPECT_MANUAL_CALL_MODE",
    "PROSPECT_MANUAL_CALL_WORKSPACE_ID",
    "PROSPECT_MANUAL_CALL_DAILY_APPROVAL_CAP",
  ]);
  assert.equal(
    publicProspectManualCallConfig(config, 7)
      .availableForWorkspace,
    false
  );
});

test("manual-call availability binds the configured workspace and activation switch", () => {
  const configured = readProspectManualCallConfig(configuredEnv);
  assert.equal(
    publicProspectManualCallConfig(configured, 8)
      .availableForWorkspace,
    false
  );

  const disabled = readProspectManualCallConfig({
    ...configuredEnv,
    PROSPECT_MANUAL_CALL_ENABLED: "false",
  });
  assert.equal(disabled.configured, true);
  assert.equal(disabled.enabled, false);
  assert.equal(
    publicProspectManualCallConfig(disabled, 7)
      .availableForWorkspace,
    false
  );
});
