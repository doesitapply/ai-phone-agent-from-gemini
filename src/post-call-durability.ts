export type MandatoryPostCallArtifactOperations = {
  persistSummaryRow: () => Promise<void>;
  persistAppointment: () => Promise<void>;
  persistTasks: () => Promise<void>;
  persistLeadFanout: () => Promise<void>;
  markArtifactsComplete: () => Promise<void>;
};

/**
 * The production summary stage uses this exact sequence. Each operation must be
 * idempotent because a worker can restart after any awaited boundary.
 */
export async function runMandatoryPostCallArtifactPipeline(
  operations: MandatoryPostCallArtifactOperations,
): Promise<void> {
  await operations.persistSummaryRow();
  await operations.persistAppointment();
  await operations.persistTasks();
  await operations.persistLeadFanout();
  await operations.markArtifactsComplete();
}

export type CrmCheckpointAction = "contact_upsert" | "call_log";

export type CheckpointedCrmSyncOperations = {
  providers: readonly string[];
  actionsForProvider: (provider: string) => readonly CrmCheckpointAction[];
  isActionComplete: (provider: string, action: CrmCheckpointAction) => Promise<boolean>;
  executeAction: (provider: string, action: CrmCheckpointAction) => Promise<void>;
};

/**
 * Runs every configured CRM independently while preserving action-level
 * checkpoints. A failed provider cannot make a later retry replay an action
 * that was already durably completed for this CallSid.
 */
export async function runCheckpointedCrmSync(
  operations: CheckpointedCrmSyncOperations,
): Promise<void> {
  const failures: string[] = [];

  for (const provider of operations.providers) {
    for (const action of operations.actionsForProvider(provider)) {
      if (await operations.isActionComplete(provider, action)) continue;
      try {
        await operations.executeAction(provider, action);
      } catch (error) {
        failures.push(`${provider}/${action}: ${String((error as any)?.message || error || "failed")}`);
        break;
      }
    }
  }

  if (failures.length > 0) {
    throw new Error(`CRM sync incomplete: ${failures.join(", ")}`);
  }
}
