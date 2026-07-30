import assert from "node:assert/strict";
import test from "node:test";
import {
  PROSPECT_SCHEMA_BACKUP_CONFIRMATION,
  PROSPECT_SCHEMA_CHANGE_CONFIRMATION,
  buildExactDeployCommand,
  hasProspectSchemaDeployApproval,
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
