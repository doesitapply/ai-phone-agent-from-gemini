import { randomUUID } from "node:crypto";
import type {
  Express,
  Request,
  RequestHandler,
  Response,
} from "express";
import { z } from "zod";
import {
  PROSPECT_INBOX_PLACEMENT_CONTRACT_VERSION,
  SMIRK_INTERNAL_INBOX_SEED_SOURCE,
  buildProspectInboxPlacementDefinition,
  buildProspectInboxPlacementReceipt,
  assertProspectInboxPlacementAllowlist,
  cancelProspectInboxPlacementSchema,
  finalizeProspectInboxPlacementSchema,
  hashProspectInboxPlacementValue,
  normalizeProspectInboxPlacementEmail,
  prepareProspectInboxPlacementSchema,
  readProspectInboxPlacementConfig,
  prospectInboxPlacementDefinitionSchema,
  prospectInboxPlacementInspectionSchema,
  prospectInboxPlacementReceiptSchema,
  type ProspectInboxPlacementEvaluationItem,
} from "../prospect-inbox-placement.js";
import {
  PROSPECT_OUTREACH_CONTRACT_VERSION,
  buildProspectOutreachPayload,
  hashProspectEvidence,
  hashProspectOutreachPayload,
} from "../prospect-outreach.js";
import {
  buildProspectMessageContext,
  getProspectMessageVariantDefinition,
  renderProspectMessageVariant,
} from "../prospect-message-variants.js";
import { readProspectEmailProviderConfig } from "../prospect-email-provider.js";

type SqlClient = any;

type ProspectInboxPlacementRouteDeps = {
  dashboardAuth: RequestHandler;
  requireOperator: RequestHandler;
  requireFullOperator: RequestHandler;
  sql: SqlClient;
  dbEnabled: boolean;
  getWorkspaceId: (req: Request) => number;
  now?: () => Date;
  env?: Record<string, string | undefined>;
};

class ProspectInboxPlacementRouteError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string
  ) {
    super(message);
  }
}

function fail(res: Response, error: unknown): Response {
  if (error instanceof ProspectInboxPlacementRouteError) {
    return res.status(error.status).json({
      error: error.message,
      code: error.code,
      externalAction: "none",
    });
  }
  console.error("[prospect-inbox-placement]", error);
  return res.status(503).json({
    error: "The controlled inbox-placement ledger is unavailable.",
    code: "PROSPECT_INBOX_PLACEMENT_UNAVAILABLE",
    externalAction: "none",
  });
}

function parseUuid(value: unknown): string | null {
  const parsed = z.string().uuid().safeParse(value);
  return parsed.success ? parsed.data : null;
}

function actorForRequest(req: Request): string {
  return (req as any).authMode === "operator"
    ? "dashboard_operator"
    : "unknown_operator";
}

function parseStoredJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function safeTimestamp(value: unknown): Date | null {
  const parsed = new Date(String(value || ""));
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function maskEmail(value: string): string {
  const [local, domain] = value.split("@");
  if (!local || !domain) return "[invalid]";
  return `${local.slice(0, Math.min(2, local.length))}***@${domain}`;
}

async function appendInboxPlacementEvent(
  tx: SqlClient,
  input: {
    workspaceId: number;
    testRowId: number;
    fromState: string | null;
    toState: string;
    actor: string;
    definitionHash: string;
    details?: Record<string, unknown>;
  }
): Promise<void> {
  const rows = await tx<{ id: number }[]>`
    INSERT INTO prospect_inbox_placement_events (
      event_id, workspace_id, test_row_id, from_state, to_state,
      actor, definition_hash, details
    ) VALUES (
      ${randomUUID()}, ${input.workspaceId}, ${input.testRowId},
      ${input.fromState}, ${input.toState}, ${input.actor},
      ${input.definitionHash}, ${tx.json(input.details || {})}
    )
    RETURNING id
  `;
  if (rows.length !== 1) {
    throw new ProspectInboxPlacementRouteError(
      "The inbox-placement audit event was not persisted.",
      503,
      "PROSPECT_INBOX_PLACEMENT_AUDIT_WRITE_FAILED"
    );
  }
}

async function appendSeedOutreachEvent(
  tx: SqlClient,
  input: {
    workspaceId: number;
    jobId: number;
    fromState: string | null;
    toState: string;
    actor: string;
    payloadHash: string;
    details?: Record<string, unknown>;
  }
): Promise<void> {
  const rows = await tx<{ id: number }[]>`
    INSERT INTO prospect_outreach_events (
      event_id, workspace_id, outreach_job_id, from_state, to_state,
      actor, payload_hash, details
    ) VALUES (
      ${randomUUID()}, ${input.workspaceId}, ${input.jobId},
      ${input.fromState}, ${input.toState}, ${input.actor},
      ${input.payloadHash}, ${tx.json(input.details || {})}
    )
    RETURNING id
  `;
  if (rows.length !== 1) {
    throw new ProspectInboxPlacementRouteError(
      "The controlled seed outreach event was not persisted.",
      503,
      "PROSPECT_INBOX_PLACEMENT_OUTREACH_AUDIT_WRITE_FAILED"
    );
  }
}

function requireDefinition(input: {
  definition: unknown;
  definitionHash: string;
}) {
  const parsed = prospectInboxPlacementDefinitionSchema.safeParse(
    parseStoredJson(input.definition)
  );
  if (
    !parsed.success ||
    hashProspectInboxPlacementValue(parsed.data) !==
      input.definitionHash
  ) {
    throw new ProspectInboxPlacementRouteError(
      "The controlled inbox test failed its immutable definition check.",
      409,
      "PROSPECT_INBOX_PLACEMENT_DEFINITION_INVALID"
    );
  }
  return parsed.data;
}

function requireReceipt(input: {
  receipt: unknown;
  receiptHash: string | null;
}) {
  const parsed = prospectInboxPlacementReceiptSchema.safeParse(
    parseStoredJson(input.receipt)
  );
  if (
    !parsed.success ||
    !input.receiptHash ||
    hashProspectInboxPlacementValue(parsed.data) !== input.receiptHash
  ) {
    throw new ProspectInboxPlacementRouteError(
      "The controlled inbox test failed its immutable receipt check.",
      409,
      "PROSPECT_INBOX_PLACEMENT_RECEIPT_INVALID"
    );
  }
  return parsed.data;
}

export function registerProspectInboxPlacementRoutes(
  app: Express,
  deps: ProspectInboxPlacementRouteDeps
): void {
  const {
    dashboardAuth,
    requireOperator,
    requireFullOperator,
    sql,
    dbEnabled,
    getWorkspaceId,
    now = () => new Date(),
    env = process.env,
  } = deps;

  app.get(
    "/api/prospecting/inbox-placement",
    dashboardAuth,
    requireOperator,
    async (req: Request, res: Response) => {
      if (!dbEnabled) {
        return res.json({
          tests: [],
          policyChanged: false,
          externalAction: "none",
        });
      }
      const campaignIdRaw = req.query.campaign_id;
      const campaignId =
        campaignIdRaw === undefined ? null : Number(campaignIdRaw);
      if (
        campaignId !== null &&
        (!Number.isSafeInteger(campaignId) || campaignId <= 0)
      ) {
        return res.status(400).json({
          error: "A positive campaign_id is required.",
          code: "PROSPECT_INBOX_PLACEMENT_CAMPAIGN_INVALID",
          externalAction: "none",
        });
      }
      const workspaceId = getWorkspaceId(req);
      try {
        const rows = await sql<{
          id: number;
          test_id: string;
          target_campaign_id: number;
          state: string;
          control_variant_key: string;
          challenger_variant_key: string;
          definition: unknown;
          definition_hash: string;
          receipt: unknown;
          receipt_hash: string | null;
          prepared_by: string;
          finalized_by: string | null;
          finalized_at: string | null;
          valid_until: string | null;
          expires_at: string;
          cancel_reason: string | null;
          created_at: string;
          updated_at: string;
        }[]>`
          SELECT id, test_id, target_campaign_id, state,
                 control_variant_key, challenger_variant_key,
                 definition, definition_hash, receipt, receipt_hash,
                 prepared_by, finalized_by, finalized_at, valid_until,
                 expires_at, cancel_reason, created_at, updated_at
          FROM prospect_inbox_placement_tests
          WHERE workspace_id = ${workspaceId}
            AND (${campaignId}::integer IS NULL
              OR target_campaign_id = ${campaignId})
          ORDER BY created_at DESC
          LIMIT 50
        `;
        const tests = [];
        for (const row of rows) {
          const definition = requireDefinition({
            definition: row.definition,
            definitionHash: row.definition_hash,
          });
          const receipt =
            row.receipt === null
              ? null
              : requireReceipt({
                  receipt: row.receipt,
                  receiptHash: row.receipt_hash,
                });
          const items = await sql<{
            slot: number;
            mailbox_label: string;
            provider: string;
            assigned_variant_key: string;
            inspection: unknown;
            inspection_hash: string | null;
            inspected_by: string | null;
            inspected_at: string | null;
            approval_id: string;
            recipient: string;
            subject: string | null;
            content: string;
            qc_receipt: unknown;
            payload_hash: string;
            max_cost_cents: number;
            state: string;
            provider_message_id: string | null;
          }[]>`
            SELECT i.slot, i.mailbox_label, i.provider,
                   i.assigned_variant_key, i.inspection,
                   i.inspection_hash, i.inspected_by, i.inspected_at,
                   j.approval_id, j.recipient, j.subject, j.content,
                   j.payload->'qcReceipt' AS qc_receipt, j.payload_hash,
                   j.max_cost_cents, j.state, j.provider_message_id
            FROM prospect_inbox_placement_items i
            JOIN prospect_outreach_jobs j ON j.id = i.outreach_job_id
            WHERE i.workspace_id = ${workspaceId}
              AND i.test_row_id = ${row.id}
              AND j.workspace_id = ${workspaceId}
              AND j.is_seed = TRUE
            ORDER BY i.slot ASC
          `;
          const expiresAt = safeTimestamp(row.expires_at);
          tests.push({
            testId: row.test_id,
            campaignId: row.target_campaign_id,
            state: row.state,
            effectiveState:
              row.state === "PREPARED" &&
              expiresAt &&
              expiresAt.getTime() <= now().getTime()
                ? "EXPIRED"
                : row.state,
            controlVariantKey: row.control_variant_key,
            challengerVariantKey: row.challenger_variant_key,
            definitionHash: row.definition_hash,
            definition,
            receiptHash: row.receipt_hash,
            receipt,
            preparedBy: row.prepared_by,
            finalizedBy: row.finalized_by,
            finalizedAt: row.finalized_at,
            validUntil: row.valid_until,
            expiresAt: row.expires_at,
            cancelReason: row.cancel_reason,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            items: items.map((item) => ({
              slot: item.slot,
              mailboxLabel: item.mailbox_label,
              provider: item.provider,
              assignedVariantKey: item.assigned_variant_key,
              approvalId: item.approval_id,
              recipientMasked: maskEmail(item.recipient),
              subject: item.subject,
              content: item.content,
              qcReceipt: parseStoredJson(item.qc_receipt),
              payloadHash: item.payload_hash,
              maxCostCents: item.max_cost_cents,
              state: item.state,
              providerMessageId: item.provider_message_id,
              inspection:
                item.inspection === null
                  ? null
                  : parseStoredJson(item.inspection),
              inspectionHash: item.inspection_hash,
              inspectedBy: item.inspected_by,
              inspectedAt: item.inspected_at,
            })),
          });
        }
        const inboxConfig = readProspectInboxPlacementConfig(env);
        const providerConfig = readProspectEmailProviderConfig(env);
        return res.json({
          tests,
          configuration: {
            configured: inboxConfig.configured,
            missing: inboxConfig.missing,
          },
          emailProvider: {
            enabled: providerConfig.enabled,
            configured: providerConfig.configured,
            availableForWorkspace:
              providerConfig.configured &&
              providerConfig.workspaceId === workspaceId,
            mode: providerConfig.mode,
            missing: providerConfig.missing,
            dailyRecipientCap: providerConfig.dailyRecipientCap,
            dailySpendCapCents: providerConfig.dailySpendCapCents,
            reservedCostPerEmailCents: providerConfig.unitCostCents,
            provider: "resend",
            sendsSms: false,
            placesCalls: false,
          },
          policyChanged: false,
          externalAction: "none",
        });
      } catch (error) {
        return fail(res, error);
      }
    }
  );

  app.post(
    "/api/prospecting/inbox-placement",
    dashboardAuth,
    requireOperator,
    requireFullOperator,
    async (req: Request, res: Response) => {
      if (!dbEnabled) {
        return res.status(503).json({
          error: "Durable prospect storage is required.",
          code: "PROSPECT_STORAGE_REQUIRED",
          externalAction: "none",
        });
      }
      const parsed = prepareProspectInboxPlacementSchema.safeParse(
        req.body
      );
      if (!parsed.success) {
        return res.status(400).json({
          error: "Invalid controlled inbox-placement test.",
          code: "PROSPECT_INBOX_PLACEMENT_PREPARE_INVALID",
          issues: parsed.error.issues,
          externalAction: "none",
        });
      }
      const workspaceId = getWorkspaceId(req);
      const actor = actorForRequest(req);
      const preparedAt = now();
      if (!Number.isFinite(preparedAt.getTime())) {
        return res.status(503).json({
          error: "The inbox-placement clock is unavailable.",
          code: "PROSPECT_INBOX_PLACEMENT_CLOCK_INVALID",
          externalAction: "none",
        });
      }
      const control = getProspectMessageVariantDefinition(
        parsed.data.controlVariantKey
      );
      const challenger = getProspectMessageVariantDefinition(
        parsed.data.challengerVariantKey
      );
      if (
        !control ||
        !challenger ||
        control.channel !== "email" ||
        challenger.channel !== "email"
      ) {
        return res.status(409).json({
          error:
            "Controlled inbox tests require two registered email strategies.",
          code: "PROSPECT_INBOX_PLACEMENT_VARIANT_INVALID",
          externalAction: "none",
        });
      }
      try {
        assertProspectInboxPlacementAllowlist({
          config: readProspectInboxPlacementConfig(env),
          recipients: parsed.data.mailboxes.map(
            (mailbox) => mailbox.email
          ),
        });
      } catch (error) {
        return res.status(409).json({
          error:
            error instanceof Error
              ? error.message
              : "The controlled inbox allowlist is invalid.",
          code: "PROSPECT_INBOX_PLACEMENT_ALLOWLIST_REQUIRED",
          externalAction: "none",
        });
      }

      try {
        const result = await sql.begin(async (tx: SqlClient) => {
          const campaignRows = await tx<{
            id: number;
            target_industry: string | null;
            external_source: string | null;
          }[]>`
            SELECT id, target_industry, external_source
            FROM prospecting_campaigns
            WHERE id = ${parsed.data.campaignId}
              AND workspace_id = ${workspaceId}
            LIMIT 1
            FOR SHARE
          `;
          const campaign = campaignRows[0];
          if (
            !campaign ||
            campaign.external_source ===
              SMIRK_INTERNAL_INBOX_SEED_SOURCE
          ) {
            throw new ProspectInboxPlacementRouteError(
              "The target campaign was not found.",
              404,
              "PROSPECT_INBOX_PLACEMENT_CAMPAIGN_NOT_FOUND"
            );
          }

          const openRows = await tx<{ test_id: string }[]>`
            SELECT test_id
            FROM prospect_inbox_placement_tests
            WHERE workspace_id = ${workspaceId}
              AND target_campaign_id = ${campaign.id}
              AND state = 'PREPARED'
              AND expires_at > ${preparedAt.toISOString()}
            LIMIT 1
            FOR UPDATE
          `;
          if (openRows[0]) {
            throw new ProspectInboxPlacementRouteError(
              "Cancel or finalize the existing controlled inbox test before preparing another.",
              409,
              "PROSPECT_INBOX_PLACEMENT_ALREADY_OPEN"
            );
          }
          await tx`
            UPDATE prospect_inbox_placement_tests
            SET state = 'EXPIRED', updated_at = ${preparedAt.toISOString()}
            WHERE workspace_id = ${workspaceId}
              AND target_campaign_id = ${campaign.id}
              AND state = 'PREPARED'
              AND expires_at <= ${preparedAt.toISOString()}
          `;

          const testId = randomUUID();
          const definition = buildProspectInboxPlacementDefinition({
            testId,
            workspaceId,
            preparedAt: preparedAt.toISOString(),
            data: parsed.data,
          });
          const definitionHash =
            hashProspectInboxPlacementValue(definition);

          const internalCampaignRows = await tx<{ id: number }[]>`
            INSERT INTO prospecting_campaigns (
              name, description, status, agent_name, target_industry,
              target_location, max_calls_per_day, call_window_start,
              call_window_end, workspace_id, external_source, external_id
            ) VALUES (
              'SMIRK controlled inbox placement',
              'Internal controlled-mailbox proof. Never a prospect cohort.',
              'paused', 'SMIRK QC',
              ${campaign.target_industry || "home service"},
              'controlled mailboxes', 0, '09:00', '17:00',
              ${workspaceId}, ${SMIRK_INTERNAL_INBOX_SEED_SOURCE},
              ${`workspace:${workspaceId}`}
            )
            ON CONFLICT (workspace_id, external_source, external_id)
              WHERE external_source IS NOT NULL AND external_id IS NOT NULL
            DO UPDATE SET
              target_industry = EXCLUDED.target_industry
            RETURNING id
          `;
          const internalCampaignId = internalCampaignRows[0]?.id;
          if (!internalCampaignId) {
            throw new ProspectInboxPlacementRouteError(
              "The internal controlled-mailbox campaign was not persisted.",
              503,
              "PROSPECT_INBOX_PLACEMENT_INTERNAL_CAMPAIGN_FAILED"
            );
          }

          const testRows = await tx<{ id: number }[]>`
            INSERT INTO prospect_inbox_placement_tests (
              test_id, workspace_id, target_campaign_id, state,
              control_variant_key, challenger_variant_key,
              definition, definition_hash, prepared_by, expires_at
            ) VALUES (
              ${testId}, ${workspaceId}, ${campaign.id}, 'PREPARED',
              ${definition.controlVariantKey},
              ${definition.challengerVariantKey},
              ${tx.json(definition)}, ${definitionHash}, ${actor},
              ${definition.expiresAt}
            )
            RETURNING id
          `;
          const testRowId = testRows[0]?.id;
          if (!testRowId) {
            throw new ProspectInboxPlacementRouteError(
              "The controlled inbox test was not persisted.",
              503,
              "PROSPECT_INBOX_PLACEMENT_WRITE_FAILED"
            );
          }

          const context = buildProspectMessageContext({
            businessName: "SMIRK controlled inbox seed",
            industry: campaign.target_industry || "home service",
            researchEvidence: [],
          });
          const items = [];
          for (const mailboxDefinition of definition.mailboxes) {
            const mailbox =
              parsed.data.mailboxes[mailboxDefinition.slot - 1];
            const recipient = normalizeProspectInboxPlacementEmail(
              mailbox.email
            );
            const evidence = [
              {
                kind: "controlled_inbox_seed",
                basis: "operator_attested",
                observation:
                  "This address is a controlled deliverability-test mailbox, not a business prospect.",
                source: PROSPECT_INBOX_PLACEMENT_CONTRACT_VERSION,
              },
            ];
            const evidenceHash = hashProspectEvidence(evidence);
            const leadRows = await tx<{ id: number }[]>`
              INSERT INTO prospect_leads (
                campaign_id, business_name, email, email_verification,
                industry, source, external_id, payload_hash,
                research_evidence, status, review_state, reviewed_by,
                reviewed_at
              ) VALUES (
                ${internalCampaignId},
                ${`Controlled inbox: ${mailbox.label}`},
                ${recipient}, 'verified_owner_email',
                ${campaign.target_industry || "home service"},
                ${SMIRK_INTERNAL_INBOX_SEED_SOURCE},
                ${`${testId}:${mailboxDefinition.slot}`},
                ${mailboxDefinition.recipientHash},
                ${tx.json(evidence)}, 'pending', 'qualified', ${actor},
                ${preparedAt.toISOString()}
              )
              ON CONFLICT (campaign_id, source, external_id)
                WHERE external_id IS NOT NULL
              DO UPDATE SET
                email = EXCLUDED.email,
                email_verification = EXCLUDED.email_verification,
                research_evidence = EXCLUDED.research_evidence,
                status = 'pending',
                review_state = 'qualified',
                reviewed_by = EXCLUDED.reviewed_by,
                reviewed_at = EXCLUDED.reviewed_at
              RETURNING id
            `;
            const leadId = leadRows[0]?.id;
            if (!leadId) {
              throw new ProspectInboxPlacementRouteError(
                "A controlled inbox seed record was not persisted.",
                503,
                "PROSPECT_INBOX_PLACEMENT_SEED_LEAD_FAILED"
              );
            }
            const rendered = renderProspectMessageVariant(
              mailboxDefinition.assignedVariantKey,
              context
            );
            if (
              !rendered ||
              rendered.channel !== "email" ||
              !rendered.subject
            ) {
              throw new ProspectInboxPlacementRouteError(
                "A registered inbox-test strategy could not be rendered.",
                409,
                "PROSPECT_INBOX_PLACEMENT_VARIANT_RENDER_FAILED"
              );
            }
            const payload = buildProspectOutreachPayload({
              workspaceId,
              campaignId: internalCampaignId,
              prospectId: leadId,
              recipient,
              evidenceHash,
              preparedAt: preparedAt.toISOString(),
              qcContext: context,
              draft: {
                channel: "email",
                subject: rendered.subject,
                body: rendered.content,
                emailCompliance: parsed.data.emailCompliance,
                variantKey: rendered.key,
                maxCostCents: parsed.data.maxCostCents,
                expiresInHours: parsed.data.expiresInHours,
              },
            });
            const payloadHash = hashProspectOutreachPayload(payload);
            const approvalId = randomUUID();
            const fingerprint = hashProspectInboxPlacementValue({
              testId,
              slot: mailboxDefinition.slot,
              leadId,
              recipient,
              payloadHash,
            });
            const jobRows = await tx<{ id: number }[]>`
              INSERT INTO prospect_outreach_jobs (
                approval_id, workspace_id, campaign_id, lead_id,
                channel, state, recipient, subject, content, variant_key,
                contract_version, evidence_hash, draft_fingerprint,
                payload, payload_hash, max_cost_cents, prepared_by,
                expires_at, is_seed
              ) VALUES (
                ${approvalId}, ${workspaceId}, ${internalCampaignId},
                ${leadId}, 'email', 'PREPARED', ${recipient},
                ${payload.subject || null}, ${payload.content},
                ${payload.variantKey},
                ${PROSPECT_OUTREACH_CONTRACT_VERSION},
                ${payload.evidenceHash}, ${fingerprint},
                ${tx.json(payload)}, ${payloadHash},
                ${payload.maxCostCents}, ${actor}, ${payload.expiresAt},
                TRUE
              )
              RETURNING id
            `;
            const jobId = jobRows[0]?.id;
            if (!jobId) {
              throw new ProspectInboxPlacementRouteError(
                "A controlled inbox outreach job was not persisted.",
                503,
                "PROSPECT_INBOX_PLACEMENT_JOB_FAILED"
              );
            }
            const itemRows = await tx<{ id: number }[]>`
              INSERT INTO prospect_inbox_placement_items (
                workspace_id, test_row_id, slot, mailbox_label,
                provider, recipient_hash, assigned_variant_key,
                outreach_job_id
              ) VALUES (
                ${workspaceId}, ${testRowId},
                ${mailboxDefinition.slot}, ${mailboxDefinition.label},
                ${mailboxDefinition.provider},
                ${mailboxDefinition.recipientHash},
                ${mailboxDefinition.assignedVariantKey}, ${jobId}
              )
              RETURNING id
            `;
            if (itemRows.length !== 1) {
              throw new ProspectInboxPlacementRouteError(
                "A controlled inbox item was not persisted.",
                503,
                "PROSPECT_INBOX_PLACEMENT_ITEM_FAILED"
              );
            }
            await appendSeedOutreachEvent(tx, {
              workspaceId,
              jobId,
              fromState: null,
              toState: "PREPARED",
              actor,
              payloadHash,
              details: {
                controlledInboxPlacementTestId: testId,
                mailboxSlot: mailboxDefinition.slot,
                provider: mailboxDefinition.provider,
                externalAction: "none",
                contactAuthorized: false,
                spendAuthorized: false,
              },
            });
            items.push({
              slot: mailboxDefinition.slot,
              mailboxLabel: mailboxDefinition.label,
              provider: mailboxDefinition.provider,
              assignedVariantKey:
                mailboxDefinition.assignedVariantKey,
              approvalId,
              payloadHash,
              state: "PREPARED",
              recipientMasked: maskEmail(recipient),
              qcReceipt: payload.qcReceipt,
            });
          }
          await appendInboxPlacementEvent(tx, {
            workspaceId,
            testRowId,
            fromState: null,
            toState: "PREPARED",
            actor,
            definitionHash,
            details: {
              itemCount: items.length,
              providerCounts: {
                google_workspace: 2,
                microsoft_365: 2,
                yahoo_aol: 1,
              },
              contactAuthorized: false,
              spendAuthorized: false,
              externalAction: "none",
            },
          });
          return {
            testId,
            definition,
            definitionHash,
            items,
          };
        });
        return res.status(201).json({
          ok: true,
          state: "PREPARED",
          ...result,
          nextAction:
            "Approve and execute each seed job separately, then inspect each controlled mailbox and record its exact result.",
          externalAction: "none",
          spendAuthorized: false,
        });
      } catch (error) {
        return fail(res, error);
      }
    }
  );

  app.post(
    "/api/prospecting/inbox-placement/:testId/items/:approvalId/inspect",
    dashboardAuth,
    requireOperator,
    requireFullOperator,
    async (req: Request, res: Response) => {
      if (!dbEnabled) {
        return res.status(503).json({
          error: "Durable prospect storage is required.",
          code: "PROSPECT_STORAGE_REQUIRED",
          externalAction: "none",
        });
      }
      const testId = parseUuid(req.params.testId);
      const approvalId = parseUuid(req.params.approvalId);
      const parsed = prospectInboxPlacementInspectionSchema.safeParse(
        req.body
      );
      if (!testId || !approvalId || !parsed.success) {
        return res.status(400).json({
          error: "Invalid controlled inbox inspection.",
          code: "PROSPECT_INBOX_PLACEMENT_INSPECTION_INVALID",
          externalAction: "none",
        });
      }
      const workspaceId = getWorkspaceId(req);
      const actor = actorForRequest(req);
      const inspectedAt = new Date(parsed.data.inspectedAt);
      const observedNow = now();
      if (
        inspectedAt.getTime() > observedNow.getTime() + 5 * 60_000
      ) {
        return res.status(400).json({
          error: "The inspection timestamp cannot be in the future.",
          code: "PROSPECT_INBOX_PLACEMENT_INSPECTION_TIME_INVALID",
          externalAction: "none",
        });
      }
      try {
        const result = await sql.begin(async (tx: SqlClient) => {
          const rows = await tx<{
            test_row_id: number;
            state: string;
            definition: unknown;
            definition_hash: string;
            expires_at: string;
            item_id: number;
            inspection: unknown;
            inspection_hash: string | null;
            payload_hash: string;
            job_state: string;
            provider_message_id: string | null;
          }[]>`
            SELECT t.id AS test_row_id, t.state, t.definition,
                   t.definition_hash, t.expires_at, i.id AS item_id,
                   i.inspection, i.inspection_hash, j.payload_hash,
                   j.state AS job_state, j.provider_message_id
            FROM prospect_inbox_placement_tests t
            JOIN prospect_inbox_placement_items i
              ON i.test_row_id = t.id
             AND i.workspace_id = t.workspace_id
            JOIN prospect_outreach_jobs j
              ON j.id = i.outreach_job_id
             AND j.workspace_id = t.workspace_id
             AND j.is_seed = TRUE
            WHERE t.workspace_id = ${workspaceId}
              AND t.test_id = ${testId}
              AND j.approval_id = ${approvalId}
            LIMIT 1
            FOR UPDATE
          `;
          const row = rows[0];
          if (!row) {
            throw new ProspectInboxPlacementRouteError(
              "The controlled inbox item was not found.",
              404,
              "PROSPECT_INBOX_PLACEMENT_ITEM_NOT_FOUND"
            );
          }
          requireDefinition({
            definition: row.definition,
            definitionHash: row.definition_hash,
          });
          if (
            parsed.data.definitionHash !== row.definition_hash ||
            parsed.data.payloadHash !== row.payload_hash
          ) {
            throw new ProspectInboxPlacementRouteError(
              "The inspection does not match the immutable seed payload.",
              409,
              "PROSPECT_INBOX_PLACEMENT_INSPECTION_HASH_MISMATCH"
            );
          }
          if (row.state !== "PREPARED") {
            throw new ProspectInboxPlacementRouteError(
              `A ${row.state} controlled inbox test cannot accept an inspection.`,
              409,
              "PROSPECT_INBOX_PLACEMENT_STATE_CONFLICT"
            );
          }
          const expiresAt = safeTimestamp(row.expires_at);
          if (
            !expiresAt ||
            expiresAt.getTime() <= observedNow.getTime()
          ) {
            throw new ProspectInboxPlacementRouteError(
              "The controlled inbox test has expired. Prepare a new test.",
              409,
              "PROSPECT_INBOX_PLACEMENT_EXPIRED"
            );
          }
          if (
            row.job_state !== "SENT" ||
            !row.provider_message_id ||
            parsed.data.providerMessageId !== row.provider_message_id
          ) {
            throw new ProspectInboxPlacementRouteError(
              "Inspection requires the exact SENT seed job and matching provider message ID.",
              409,
              "PROSPECT_INBOX_PLACEMENT_SENT_PROOF_REQUIRED"
            );
          }
          const inspectionHash =
            hashProspectInboxPlacementValue(parsed.data);
          if (row.inspection !== null) {
            if (row.inspection_hash === inspectionHash) {
              return {
                outcome: "duplicate" as const,
                inspectionHash,
              };
            }
            throw new ProspectInboxPlacementRouteError(
              "This controlled inbox already has a different immutable inspection.",
              409,
              "PROSPECT_INBOX_PLACEMENT_INSPECTION_REPLAY_CONFLICT"
            );
          }
          const updated = await tx<{ id: number }[]>`
            UPDATE prospect_inbox_placement_items
            SET inspection = ${tx.json(parsed.data)},
                inspection_hash = ${inspectionHash},
                inspected_by = ${actor},
                inspected_at = ${parsed.data.inspectedAt},
                updated_at = ${observedNow.toISOString()}
            WHERE id = ${row.item_id}
              AND workspace_id = ${workspaceId}
              AND inspection IS NULL
            RETURNING id
          `;
          if (updated.length !== 1) {
            throw new ProspectInboxPlacementRouteError(
              "The expected inbox item did not change.",
              409,
              "PROSPECT_INBOX_PLACEMENT_INSPECTION_CONFLICT"
            );
          }
          await appendInboxPlacementEvent(tx, {
            workspaceId,
            testRowId: row.test_row_id,
            fromState: "PREPARED",
            toState: "PREPARED",
            actor,
            definitionHash: row.definition_hash,
            details: {
              approvalId,
              inspectionHash,
              folder: parsed.data.folder,
              providerMessageId: parsed.data.providerMessageId,
              externalAction: "none",
            },
          });
          return {
            outcome: "recorded" as const,
            inspectionHash,
          };
        });
        return res.json({
          ok: true,
          ...result,
          testId,
          approvalId,
          externalAction: "none",
        });
      } catch (error) {
        return fail(res, error);
      }
    }
  );

  app.post(
    "/api/prospecting/inbox-placement/:testId/finalize",
    dashboardAuth,
    requireOperator,
    requireFullOperator,
    async (req: Request, res: Response) => {
      if (!dbEnabled) {
        return res.status(503).json({
          error: "Durable prospect storage is required.",
          code: "PROSPECT_STORAGE_REQUIRED",
          externalAction: "none",
        });
      }
      const testId = parseUuid(req.params.testId);
      const parsed = finalizeProspectInboxPlacementSchema.safeParse(
        req.body
      );
      if (!testId || !parsed.success) {
        return res.status(400).json({
          error: "Invalid controlled inbox finalization.",
          code: "PROSPECT_INBOX_PLACEMENT_FINALIZE_INVALID",
          externalAction: "none",
        });
      }
      const workspaceId = getWorkspaceId(req);
      const actor = actorForRequest(req);
      const finalizedAt = now();
      try {
        const result = await sql.begin(async (tx: SqlClient) => {
          const testRows = await tx<{
            id: number;
            state: string;
            definition: unknown;
            definition_hash: string;
            receipt: unknown;
            receipt_hash: string | null;
            expires_at: string;
          }[]>`
            SELECT id, state, definition, definition_hash, receipt,
                   receipt_hash, expires_at
            FROM prospect_inbox_placement_tests
            WHERE workspace_id = ${workspaceId}
              AND test_id = ${testId}
            LIMIT 1
            FOR UPDATE
          `;
          const row = testRows[0];
          if (!row) {
            throw new ProspectInboxPlacementRouteError(
              "The controlled inbox test was not found.",
              404,
              "PROSPECT_INBOX_PLACEMENT_NOT_FOUND"
            );
          }
          const definition = requireDefinition({
            definition: row.definition,
            definitionHash: row.definition_hash,
          });
          if (parsed.data.definitionHash !== row.definition_hash) {
            throw new ProspectInboxPlacementRouteError(
              "The finalization does not match the reviewed test.",
              409,
              "PROSPECT_INBOX_PLACEMENT_FINALIZE_HASH_MISMATCH"
            );
          }
          if (["PASSED", "FAILED"].includes(row.state)) {
            const receipt = requireReceipt({
              receipt: row.receipt,
              receiptHash: row.receipt_hash,
            });
            return {
              outcome: "duplicate" as const,
              state: row.state,
              receipt,
              receiptHash: row.receipt_hash!,
            };
          }
          if (row.state !== "PREPARED") {
            throw new ProspectInboxPlacementRouteError(
              `A ${row.state} controlled inbox test cannot be finalized.`,
              409,
              "PROSPECT_INBOX_PLACEMENT_STATE_CONFLICT"
            );
          }
          const expiresAt = safeTimestamp(row.expires_at);
          if (
            !expiresAt ||
            expiresAt.getTime() <= finalizedAt.getTime()
          ) {
            throw new ProspectInboxPlacementRouteError(
              "The controlled inbox test expired before finalization.",
              409,
              "PROSPECT_INBOX_PLACEMENT_EXPIRED"
            );
          }
          const itemRows = await tx<{
            slot: number;
            mailbox_label: string;
            provider: "google_workspace" | "microsoft_365" | "yahoo_aol";
            inspection: unknown;
            inspection_hash: string | null;
            approval_id: string;
            payload_hash: string;
            job_state: string;
            provider_message_id: string | null;
          }[]>`
            SELECT i.slot, i.mailbox_label, i.provider, i.inspection,
                   i.inspection_hash, j.approval_id, j.payload_hash,
                   j.state AS job_state, j.provider_message_id
            FROM prospect_inbox_placement_items i
            JOIN prospect_outreach_jobs j
              ON j.id = i.outreach_job_id
             AND j.workspace_id = i.workspace_id
             AND j.is_seed = TRUE
            WHERE i.workspace_id = ${workspaceId}
              AND i.test_row_id = ${row.id}
            ORDER BY i.slot ASC
            FOR SHARE
          `;
          if (
            itemRows.length !== 5 ||
            itemRows.some(
              (item) =>
                item.inspection === null || !item.inspection_hash
            )
          ) {
            throw new ProspectInboxPlacementRouteError(
              "All five controlled inboxes require immutable inspections before finalization.",
              409,
              "PROSPECT_INBOX_PLACEMENT_INSPECTIONS_REQUIRED"
            );
          }
          const items: ProspectInboxPlacementEvaluationItem[] =
            itemRows.map((item) => {
              const inspection =
                prospectInboxPlacementInspectionSchema.safeParse(
                  parseStoredJson(item.inspection)
                );
              if (
                !inspection.success ||
                hashProspectInboxPlacementValue(inspection.data) !==
                  item.inspection_hash
              ) {
                throw new ProspectInboxPlacementRouteError(
                  "A controlled inbox inspection failed its immutable receipt check.",
                  409,
                  "PROSPECT_INBOX_PLACEMENT_INSPECTION_INVALID"
                );
              }
              return {
                slot: item.slot,
                label: item.mailbox_label,
                provider: item.provider,
                approvalId: item.approval_id,
                payloadHash: item.payload_hash,
                jobState: item.job_state,
                storedProviderMessageId: item.provider_message_id,
                inspection: inspection.data,
                inspectionHash: item.inspection_hash,
              };
            });
          const receipt = buildProspectInboxPlacementReceipt({
            definition,
            definitionHash: row.definition_hash,
            finalizedAt: finalizedAt.toISOString(),
            items,
          });
          const receiptHash =
            hashProspectInboxPlacementValue(receipt);
          const state = receipt.verdict === "PASS" ? "PASSED" : "FAILED";
          const updated = await tx<{ id: number }[]>`
            UPDATE prospect_inbox_placement_tests
            SET state = ${state}, receipt = ${tx.json(receipt)},
                receipt_hash = ${receiptHash}, finalized_by = ${actor},
                finalized_at = ${receipt.finalizedAt},
                valid_until = ${receipt.validUntil},
                updated_at = ${finalizedAt.toISOString()}
            WHERE id = ${row.id}
              AND workspace_id = ${workspaceId}
              AND state = 'PREPARED'
              AND definition_hash = ${row.definition_hash}
            RETURNING id
          `;
          if (updated.length !== 1) {
            throw new ProspectInboxPlacementRouteError(
              "The expected controlled inbox test did not change state.",
              409,
              "PROSPECT_INBOX_PLACEMENT_FINALIZE_CONFLICT"
            );
          }
          await appendInboxPlacementEvent(tx, {
            workspaceId,
            testRowId: row.id,
            fromState: "PREPARED",
            toState: state,
            actor,
            definitionHash: row.definition_hash,
            details: {
              receiptHash,
              failureReasons: receipt.failureReasons,
              authorizesExperimentActivation:
                receipt.authorizesExperimentActivation,
              authorizesContact: false,
              authorizesSpend: false,
              externalAction: "none",
            },
          });
          return {
            outcome: "finalized" as const,
            state,
            receipt,
            receiptHash,
          };
        });
        return res.json({
          ok: true,
          ...result,
          testId,
          policyChanged: false,
          externalAction: "none",
        });
      } catch (error) {
        return fail(res, error);
      }
    }
  );

  app.post(
    "/api/prospecting/inbox-placement/:testId/cancel",
    dashboardAuth,
    requireOperator,
    requireFullOperator,
    async (req: Request, res: Response) => {
      if (!dbEnabled) {
        return res.status(503).json({
          error: "Durable prospect storage is required.",
          code: "PROSPECT_STORAGE_REQUIRED",
          externalAction: "none",
        });
      }
      const testId = parseUuid(req.params.testId);
      const parsed = cancelProspectInboxPlacementSchema.safeParse(
        req.body
      );
      if (!testId || !parsed.success) {
        return res.status(400).json({
          error: "Invalid controlled inbox cancellation.",
          code: "PROSPECT_INBOX_PLACEMENT_CANCEL_INVALID",
          externalAction: "none",
        });
      }
      const workspaceId = getWorkspaceId(req);
      const actor = actorForRequest(req);
      try {
        const result = await sql.begin(async (tx: SqlClient) => {
          const rows = await tx<{
            id: number;
            state: string;
            definition: unknown;
            definition_hash: string;
          }[]>`
            SELECT id, state, definition, definition_hash
            FROM prospect_inbox_placement_tests
            WHERE workspace_id = ${workspaceId}
              AND test_id = ${testId}
            LIMIT 1
            FOR UPDATE
          `;
          const row = rows[0];
          if (!row) {
            throw new ProspectInboxPlacementRouteError(
              "The controlled inbox test was not found.",
              404,
              "PROSPECT_INBOX_PLACEMENT_NOT_FOUND"
            );
          }
          requireDefinition({
            definition: row.definition,
            definitionHash: row.definition_hash,
          });
          if (parsed.data.definitionHash !== row.definition_hash) {
            throw new ProspectInboxPlacementRouteError(
              "The cancellation does not match the reviewed test.",
              409,
              "PROSPECT_INBOX_PLACEMENT_CANCEL_HASH_MISMATCH"
            );
          }
          if (row.state === "CANCELLED") {
            return {
              outcome: "duplicate" as const,
              state: "CANCELLED",
            };
          }
          if (row.state !== "PREPARED") {
            throw new ProspectInboxPlacementRouteError(
              `A ${row.state} controlled inbox test cannot be cancelled.`,
              409,
              "PROSPECT_INBOX_PLACEMENT_STATE_CONFLICT"
            );
          }
          const inFlight = await tx<{ approval_id: string }[]>`
            SELECT j.approval_id
            FROM prospect_inbox_placement_items i
            JOIN prospect_outreach_jobs j ON j.id = i.outreach_job_id
            WHERE i.workspace_id = ${workspaceId}
              AND i.test_row_id = ${row.id}
              AND j.state = 'SENDING'
            LIMIT 1
            FOR UPDATE
          `;
          if (inFlight[0]) {
            throw new ProspectInboxPlacementRouteError(
              "A provider request is in flight. Reconcile it before cancelling the test.",
              409,
              "PROSPECT_INBOX_PLACEMENT_PROVIDER_IN_FLIGHT"
            );
          }
          const cancelledJobs = await tx<{
            id: number;
            previous_state: string;
            payload_hash: string;
          }[]>`
            UPDATE prospect_outreach_jobs j
            SET state = 'CANCELLED', updated_at = NOW()
            FROM prospect_inbox_placement_items i
            WHERE i.outreach_job_id = j.id
              AND i.workspace_id = ${workspaceId}
              AND i.test_row_id = ${row.id}
              AND j.workspace_id = ${workspaceId}
              AND j.is_seed = TRUE
              AND j.state IN ('PREPARED', 'APPROVED')
            RETURNING j.id, j.payload_hash,
              CASE
                WHEN j.approved_at IS NULL THEN 'PREPARED'
                ELSE 'APPROVED'
              END AS previous_state
          `;
          for (const job of cancelledJobs) {
            await appendSeedOutreachEvent(tx, {
              workspaceId,
              jobId: job.id,
              fromState: job.previous_state,
              toState: "CANCELLED",
              actor,
              payloadHash: job.payload_hash,
              details: {
                controlledInboxPlacementTestId: testId,
                reason: parsed.data.reason,
                externalAction: "none",
              },
            });
          }
          const updated = await tx<{ id: number }[]>`
            UPDATE prospect_inbox_placement_tests
            SET state = 'CANCELLED',
                cancel_reason = ${parsed.data.reason},
                updated_at = NOW()
            WHERE id = ${row.id}
              AND workspace_id = ${workspaceId}
              AND state = 'PREPARED'
            RETURNING id
          `;
          if (updated.length !== 1) {
            throw new ProspectInboxPlacementRouteError(
              "The expected controlled inbox test did not change state.",
              409,
              "PROSPECT_INBOX_PLACEMENT_CANCEL_CONFLICT"
            );
          }
          await appendInboxPlacementEvent(tx, {
            workspaceId,
            testRowId: row.id,
            fromState: "PREPARED",
            toState: "CANCELLED",
            actor,
            definitionHash: row.definition_hash,
            details: {
              reason: parsed.data.reason,
              cancelledJobCount: cancelledJobs.length,
              externalAction: "none",
            },
          });
          return {
            outcome: "cancelled" as const,
            state: "CANCELLED",
          };
        });
        return res.json({
          ok: true,
          ...result,
          testId,
          externalAction: "none",
        });
      } catch (error) {
        return fail(res, error);
      }
    }
  );
}
