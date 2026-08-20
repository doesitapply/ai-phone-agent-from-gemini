import {
  hashProspectInboxPlacementValue,
  prospectInboxPlacementDefinitionSchema,
  prospectInboxPlacementReceiptSchema,
  type ProspectInboxPlacementDefinition,
  type ProspectInboxPlacementReceipt,
} from "./prospect-inbox-placement.js";

type SqlClient = any;

export type PassingProspectInboxPlacementProof = {
  testId: string;
  definitionHash: string;
  receiptHash: string;
  validUntil: string;
  definition: ProspectInboxPlacementDefinition;
  receipt: ProspectInboxPlacementReceipt;
};

function storedJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export async function loadPassingProspectInboxPlacementProof(
  tx: SqlClient,
  input: {
    workspaceId: number;
    campaignId: number;
    controlVariantKey: string;
    challengerVariantKey: string;
    now: Date;
  }
): Promise<PassingProspectInboxPlacementProof | null> {
  const rows = await tx<{
    test_id: string;
    definition: unknown;
    definition_hash: string;
    receipt: unknown;
    receipt_hash: string;
    valid_until: string | Date;
  }[]>`
    SELECT test_id, definition, definition_hash, receipt, receipt_hash,
           valid_until
    FROM prospect_inbox_placement_tests
    WHERE workspace_id = ${input.workspaceId}
      AND target_campaign_id = ${input.campaignId}
      AND state = 'PASSED'
      AND control_variant_key = ${input.controlVariantKey}
      AND challenger_variant_key = ${input.challengerVariantKey}
      AND valid_until > ${input.now.toISOString()}
    ORDER BY finalized_at DESC
    LIMIT 1
    FOR SHARE
  `;
  const row = rows[0];
  if (!row) return null;

  const definition = prospectInboxPlacementDefinitionSchema.safeParse(
    storedJson(row.definition)
  );
  const receipt = prospectInboxPlacementReceiptSchema.safeParse(
    storedJson(row.receipt)
  );
  const validUntil = new Date(row.valid_until);
  if (
    !definition.success ||
    !receipt.success ||
    !Number.isFinite(validUntil.getTime()) ||
    hashProspectInboxPlacementValue(definition.data) !==
      row.definition_hash ||
    hashProspectInboxPlacementValue(receipt.data) !== row.receipt_hash ||
    definition.data.testId !== row.test_id ||
    definition.data.workspaceId !== input.workspaceId ||
    definition.data.campaignId !== input.campaignId ||
    definition.data.controlVariantKey !== input.controlVariantKey ||
    definition.data.challengerVariantKey !==
      input.challengerVariantKey ||
    receipt.data.testId !== row.test_id ||
    receipt.data.definitionHash !== row.definition_hash ||
    receipt.data.verdict !== "PASS" ||
    receipt.data.authorizesExperimentActivation !== true ||
    receipt.data.authorizesContact !== false ||
    receipt.data.authorizesSpend !== false ||
    receipt.data.validUntil !== validUntil.toISOString() ||
    validUntil.getTime() <= input.now.getTime()
  ) {
    throw new Error(
      "The stored inbox-placement proof failed its immutable activation check."
    );
  }

  return {
    testId: row.test_id,
    definitionHash: row.definition_hash,
    receiptHash: row.receipt_hash,
    validUntil: validUntil.toISOString(),
    definition: definition.data,
    receipt: receipt.data,
  };
}
