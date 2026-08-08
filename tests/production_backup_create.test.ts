import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  PRODUCTION_BACKUP_CREATE_APPROVAL_PREFIX,
  bindProductionBackupCreatePlanRuntime,
  buildProductionBackupCreatePlan,
  evaluateProductionBackupCreateApproval,
  productionBackupIds,
  productionBackupTimeoutMs,
  verifyProductionBackupCreate,
} from "../scripts/lib/production-backup-create.mjs";
import {
  claimProductionBackupReceipt,
  readProductionBackupReceipt,
  updateProductionBackupReceipt,
} from "../scripts/lib/production-backup-receipt.mjs";

const checkedAt = "2026-08-07T12:00:00.000Z";
const snapshot = {
  projectId: "90599f03-6d6f-4044-8933-e0301be67a82",
  appServiceId: "96bcd6e7-9487-4197-bcd1-a6bd0546e6b2",
  environmentId: "22e0a5a3-43bf-4b6c-8fa6-635e7c94b84a",
  environmentName: "production",
  databaseBindingVerified: true,
  database: {
    serviceId: "9d4a2f61-2ed3-4e66-8ea4-dcd07d1fbf79",
    serviceName: "Postgres-sTit",
    volumeId: "093ff8f8-a4be-48ed-91b6-6def18d6835c",
    volumeName: "postgres-volume-82PP",
    volumeInstanceId: "744e315f-e4f0-4105-8bf1-36811434201a",
    mountPath: "/var/lib/postgresql/data",
    state: "READY",
    currentSizeMB: 1162,
    capacityMB: 5000,
  },
  headCommit: "a".repeat(40),
  liveCommit: "b".repeat(40),
  liveReadinessConfirmed: true,
  worktreeClean: true,
  headPublished: true,
  activeDeploymentPresent: false,
  deploymentIds: ["deployment-before"],
  backups: [],
  schedules: [],
  providerBackupCapability: {
    ok: true,
    error: null,
    subscriptionType: "pro",
    maxBackupsCount: 10,
  },
  checkedAt,
};

test("one exact production backup request is digest-bound and approval-gated", () => {
  const plan = buildProductionBackupCreatePlan({ snapshot });
  assert.equal(plan.ok, true);
  assert.equal(plan.mutationRequired, true);
  assert.equal(plan.idempotentReplay, false);
  assert.equal(
    plan.backupName,
    "smirk-predeploy-aaaaaaaaaaaa-bbbbbbbbbbbb"
  );
  assert.match(plan.requestDigest, /^[a-f0-9]{64}$/);
  assert.ok(plan.approvalPhrase.startsWith(
    `${PRODUCTION_BACKUP_CREATE_APPROVAL_PREFIX}: digest=`
  ));
  assert.match(plan.approvalPhrase, /action=create-one-backup-only$/);
  assert.equal(plan.guardrails.backupCreateAuthorized, false);
  assert.equal(plan.guardrails.backupDeleteAuthorized, false);
  assert.equal(plan.guardrails.backupRestoreAuthorized, false);
  assert.equal(plan.guardrails.backupScheduleChangeAuthorized, false);
  assert.equal(plan.guardrails.deploymentAuthorized, false);

  const refused = evaluateProductionBackupCreateApproval({
    plan,
    providedApproval: `${plan.approvalPhrase} `,
  });
  assert.equal(refused.authorized, false);
  assert.ok(refused.blockers.includes(
    "EXACT_PRODUCTION_BACKUP_APPROVAL_MISSING"
  ));

  const approved = evaluateProductionBackupCreateApproval({
    plan,
    providedApproval: plan.approvalPhrase,
  });
  assert.equal(approved.authorized, true);
  assert.equal(approved.backupCreateAuthorized, true);
  assert.equal(approved.backupDeleteAuthorized, false);
  assert.equal(approved.backupRestoreAuthorized, false);
  assert.equal(approved.deploymentAuthorized, false);
});

test("the approval digest binds deployment state and timeout parsing is bounded", () => {
  const baseline = buildProductionBackupCreatePlan({ snapshot });
  const deploymentDrift = buildProductionBackupCreatePlan({
    snapshot: {
      ...snapshot,
      deploymentIds: ["deployment-before", "failed-deployment-after-dry-run"],
    },
  });
  assert.notEqual(deploymentDrift.requestDigest, baseline.requestDigest);
  assert.notEqual(deploymentDrift.approvalPhrase, baseline.approvalPhrase);
  assert.equal(productionBackupTimeoutMs("not-a-number"), 180_000);
  assert.equal(productionBackupTimeoutMs(""), 180_000);
  assert.equal(productionBackupTimeoutMs("1"), 30_000);
  assert.equal(productionBackupTimeoutMs("900"), 600_000);
  assert.deepEqual(
    productionBackupIds([{ id: "b" }, { id: "a" }, { id: "a" }, {}]),
    ["a", "a", "b"]
  );
});

test("target, binding, source, and deployment drift fail closed", () => {
  const cases = [
    {
      expected: "RAILWAY_PROJECT_NOT_SMIRK_PRODUCTION",
      value: { ...snapshot, projectId: "other-project" },
    },
    {
      expected: "PRODUCTION_DATABASE_BINDING_UNVERIFIED",
      value: { ...snapshot, databaseBindingVerified: false },
    },
    {
      expected: "PRODUCTION_DATABASE_VOLUME_NAME_MISMATCH",
      value: {
        ...snapshot,
        database: { ...snapshot.database, volumeName: "another-volume" },
      },
    },
    {
      expected: "PRODUCTION_DATABASE_VOLUME_NOT_READY",
      value: {
        ...snapshot,
        database: { ...snapshot.database, state: "MIGRATING" },
      },
    },
    {
      expected: "LOCAL_WORKTREE_DIRTY",
      value: { ...snapshot, worktreeClean: false },
    },
    {
      expected: "LOCAL_HEAD_NOT_PUBLISHED",
      value: { ...snapshot, headPublished: false },
    },
    {
      expected: "ACTIVE_RAILWAY_DEPLOYMENT_PRESENT",
      value: { ...snapshot, activeDeploymentPresent: true },
    },
    {
      expected: "LIVE_SMIRK_READINESS_UNCONFIRMED",
      value: { ...snapshot, liveReadinessConfirmed: false },
    },
  ];

  for (const entry of cases) {
    const plan = buildProductionBackupCreatePlan({ snapshot: entry.value });
    assert.equal(plan.ok, false, entry.expected);
    assert.ok(plan.blockers.includes(entry.expected), entry.expected);
    assert.equal(plan.mutationRequired, false, entry.expected);
    assert.equal(plan.approvalPhrase, null, entry.expected);
  }
});

test("a plan with zero provider backup capacity fails before approval", () => {
  const plan = buildProductionBackupCreatePlan({
    snapshot: {
      ...snapshot,
      providerBackupCapability: {
        ok: false,
        error: "railway-backups-unavailable-on-current-plan",
        subscriptionType: "hobby",
        maxBackupsCount: 0,
      },
    },
  });
  assert.equal(plan.ok, false);
  assert.equal(plan.mutationRequired, false);
  assert.equal(plan.approvalPhrase, null);
  assert.ok(plan.blockers.includes(
    "RAILWAY_BACKUPS_UNAVAILABLE_ON_CURRENT_PLAN"
  ));
  assert.equal(plan.observed.subscriptionType, "hobby");
  assert.equal(plan.observed.maxBackupsCount, 0);
});

test("a fresh exact-volume backup turns apply into an idempotent no-op", () => {
  const plan = buildProductionBackupCreatePlan({
    snapshot: {
      ...snapshot,
      backups: [{
        id: "backup-ready",
        name: "manual-backup",
        createdAt: "2026-08-07T11:30:00.000Z",
        expiresAt: "2026-08-09T12:00:00.000Z",
      }],
    },
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.backupAlreadyReady, true);
  assert.equal(plan.mutationRequired, false);
  assert.equal(plan.idempotentReplay, true);
  assert.equal(plan.selectedExistingBackup?.id, "backup-ready");

  const approval = evaluateProductionBackupCreateApproval({
    plan,
    providedApproval: plan.approvalPhrase,
  });
  assert.equal(approval.authorized, false);
  assert.ok(approval.blockers.includes(
    "PRODUCTION_BACKUP_CREATE_NOT_REQUIRED"
  ));
});

test("verification requires the exact new backup and proves no deployment", () => {
  const plan = bindProductionBackupCreatePlanRuntime(
    buildProductionBackupCreatePlan({ snapshot }),
    snapshot
  );
  const createdBackup = {
    id: "backup-created",
    name: plan.backupName,
    createdAt: "2026-08-07T12:02:00.000Z",
    expiresAt: "2026-08-09T12:00:00.000Z",
    usedMB: 2,
    referencedMB: 1162,
  };
  const result = verifyProductionBackupCreate({
    plan,
    workflowStatus: "Complete",
    afterBackups: [createdBackup],
    afterDeploymentIds: ["deployment-before"],
    verifiedAt: "2026-08-07T12:03:00.000Z",
  });
  assert.equal(result.ok, true);
  assert.equal(result.backupCreated, true);
  assert.equal(result.selectedBackup?.id, "backup-created");
  assert.equal(result.deploymentPerformed, false);
  assert.equal(result.restoreTested, false);
  assert.equal(result.guardrails.backupDeletePerformed, false);
  assert.equal(result.guardrails.backupRestorePerformed, false);
  assert.equal(result.guardrails.backupScheduleChanged, false);
});

test("workflow failure, missing exact backup, and a surprise deploy are terminal", () => {
  const plan = bindProductionBackupCreatePlanRuntime(
    buildProductionBackupCreatePlan({ snapshot }),
    snapshot
  );
  const result = verifyProductionBackupCreate({
    plan,
    workflowStatus: "Error",
    workflowError: "provider refused",
    afterBackups: [{
      id: "wrong-backup",
      name: "not-the-approved-name",
      createdAt: "2026-08-07T12:02:00.000Z",
      expiresAt: null,
    }],
    afterDeploymentIds: ["deployment-before", "unexpected-deployment"],
    verifiedAt: "2026-08-07T12:03:00.000Z",
  });
  assert.equal(result.ok, false);
  assert.ok(result.blockers.includes("PRODUCTION_BACKUP_WORKFLOW_FAILED"));
  assert.ok(result.blockers.includes("PRODUCTION_BACKUP_WORKFLOW_ERROR_PRESENT"));
  assert.ok(result.blockers.includes("EXACT_CREATED_BACKUP_NOT_LISTED"));
  assert.ok(result.blockers.includes("UNEXPECTED_DEPLOYMENT_OBSERVED"));
  assert.equal(result.backupCreated, false);
  assert.equal(result.deploymentPerformed, false);
  assert.equal(result.unexpectedDeploymentObserved, true);
});

test("the private workflow receipt is single-use, replayable, and binding-checked", () => {
  const root = mkdtempSync(path.join(tmpdir(), "smirk-backup-receipt-"));
  const receiptDirectory = path.join(root, "state");
  const plan = bindProductionBackupCreatePlanRuntime(
    buildProductionBackupCreatePlan({ snapshot }),
    snapshot
  );
  try {
    const first = claimProductionBackupReceipt({ plan, receiptDirectory });
    assert.equal(first.created, true);
    assert.equal(first.receipt.status, "CLAIMED");
    assert.equal(statSync(first.path).mode & 0o777, 0o600);

    const concurrent = claimProductionBackupReceipt({
      plan,
      receiptDirectory,
    });
    assert.equal(concurrent.created, false);
    assert.equal(concurrent.receipt.workflowId, null);

    updateProductionBackupReceipt({
      plan,
      receiptDirectory,
      changes: {
        status: "WORKFLOW_ACCEPTED",
        workflowId: "workflow-one",
      },
    });
    const replay = claimProductionBackupReceipt({ plan, receiptDirectory });
    assert.equal(replay.created, false);
    assert.equal(replay.receipt.workflowId, "workflow-one");

    chmodSync(first.path, 0o644);
    assert.throws(
      () => readProductionBackupReceipt({ plan, receiptDirectory }),
      /PRODUCTION_BACKUP_RECEIPT_FILE_UNSAFE/
    );
    chmodSync(first.path, 0o600);

    const tampered = JSON.parse(readFileSync(first.path, "utf8"));
    tampered.backupName = "different-backup";
    writeFileSync(first.path, `${JSON.stringify(tampered)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    assert.throws(
      () => readProductionBackupReceipt({ plan, receiptDirectory }),
      /PRODUCTION_BACKUP_RECEIPT_BINDING_INVALID/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the executable contains no backup delete, restore, or schedule mutation", () => {
  const source = readFileSync(
    new URL("../scripts/create-production-backup.mjs", import.meta.url),
    "utf8"
  );
  const receiptSource = readFileSync(
    new URL(
      "../scripts/lib/production-backup-receipt.mjs",
      import.meta.url
    ),
    "utf8"
  );
  assert.match(source, /volumeInstanceBackupCreate/);
  assert.match(receiptSource, /openSync\(target, "wx", 0o600\)/);
  assert.match(source, /PRODUCTION_BACKUP_REQUEST_CLAIMED_WITHOUT_WORKFLOW/);
  assert.match(source, /RAILWAY_BACKUP_SET_CHANGED_BEFORE_BACKUP/);
  assert.match(source, /none-reconciled-existing-workflow/);
  assert.doesNotMatch(source, /volumeInstanceBackupDelete/);
  assert.doesNotMatch(source, /volumeInstanceBackupRestore/);
  assert.doesNotMatch(source, /volumeInstanceBackupScheduleUpdate/);
  assert.doesNotMatch(source, /railway up|railway redeploy|serviceInstanceRedeploy/);
});
