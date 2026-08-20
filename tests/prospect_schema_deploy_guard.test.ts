import assert from "node:assert/strict";
import test from "node:test";
import {
  PROSPECT_SCHEMA_BACKUP_CONFIRMATION,
  PROSPECT_SCHEMA_CHANGE_CONFIRMATION,
  buildExactDeployCommand,
  hasProspectSchemaDeployApproval,
  selectDeployCommandFromBundle,
} from "../scripts/lib/deploy-command.mjs";

const branch = "codex/pilot-revenue-loop-2026-07-29";
const commit = "a".repeat(40);

test("every exact deploy command includes schema review and backup attestations", () => {
  const command = buildExactDeployCommand({ branch, commit });
  assert.match(
    command,
    new RegExp(
      `CONFIRM_SMIRK_PROSPECT_SCHEMA_CHANGE=${PROSPECT_SCHEMA_CHANGE_CONFIRMATION}`
    )
  );
  assert.match(
    command,
    new RegExp(
      `CONFIRM_SMIRK_PROSPECT_SCHEMA_BACKUP=${PROSPECT_SCHEMA_BACKUP_CONFIRMATION}`
    )
  );
  assert.match(command, new RegExp(`CONFIRM_SMIRK_DEPLOY_COMMIT=${commit}`));
});

test("schema deployment approval fails closed unless both attestations match", () => {
  assert.equal(hasProspectSchemaDeployApproval({}), false);
  assert.equal(
    hasProspectSchemaDeployApproval({
      CONFIRM_SMIRK_PROSPECT_SCHEMA_CHANGE:
        PROSPECT_SCHEMA_CHANGE_CONFIRMATION,
    }),
    false
  );
  assert.equal(
    hasProspectSchemaDeployApproval({
      CONFIRM_SMIRK_PROSPECT_SCHEMA_CHANGE:
        PROSPECT_SCHEMA_CHANGE_CONFIRMATION,
      CONFIRM_SMIRK_PROSPECT_SCHEMA_BACKUP:
        PROSPECT_SCHEMA_BACKUP_CONFIRMATION,
    }),
    true
  );
});

test("approval packets retain the exact guarded deploy command while backup is blocked", () => {
  const guardedCommand = buildExactDeployCommand({
    branch,
    commit,
    bootstrapMode: "deploy-fail-closed-checkout",
  });
  const selected = selectDeployCommandFromBundle({
    deployCommand: guardedCommand,
    approvalSteps: [
      "Create and retain a manual backup for the exact bound production database in Railway.",
      "npm run -s check:production-backup",
    ],
    nextAction: "Create a production backup first.",
  });

  assert.equal(selected, guardedCommand);
  assert.match(
    selected,
    /SMIRK_FIRST_DOLLAR_ENV_BOOTSTRAP_DEPLOY=deploy-fail-closed-checkout/
  );
});
