import type {
  Express,
  Request,
  RequestHandler,
  Response,
} from "express";
import { readProspectEmailProviderConfig } from "../prospect-email-provider.js";
import { readProspectEmailWebhookConfig } from "../prospect-email-webhook.js";
import {
  readProspectInboxPlacementConfig,
  SMIRK_INTERNAL_INBOX_SEED_SOURCE,
} from "../prospect-inbox-placement.js";
import {
  PROSPECT_MESSAGE_EXPERIMENT_CONTRACT_VERSION,
  PROSPECT_MESSAGE_EXPERIMENT_LEGACY_CONTRACT_VERSION,
  PROSPECT_MESSAGE_EXPERIMENT_LEGACY_STUDY_DESIGN,
  PROSPECT_MESSAGE_EXPERIMENT_STUDY_DESIGN,
} from "../prospect-message-experiments.js";
import {
  PROSPECT_MESSAGE_VARIANT_REGISTRY_VERSION,
} from "../prospect-message-variants.js";
import { readProspectQcModelProviderConfig } from "../prospect-qc-model-provider.js";
import {
  buildProspectRevenueLoopStatus,
  type ProspectRevenueLoopConnection,
  type ProspectRevenueLoopCounts,
  type ProspectRevenueLoopNextAction,
  type ProspectRevenueLoopNextActionCode,
} from "../prospect-revenue-loop.js";
import { readVelvetDiscoveryConfig } from "../velvet-discovery.js";
import { readVelvetLeadSourceConfig } from "../velvet-lead-source.js";
import { readVelvetOutcomeDispatchConfig } from "../velvet-outcome.js";

type SqlClient = any;

type ProspectRevenueLoopRouteDeps = {
  dashboardAuth: RequestHandler;
  requireOperator: RequestHandler;
  sql: SqlClient;
  dbEnabled: boolean;
  getWorkspaceId: (req: Request) => number;
  env?: Record<string, string | undefined>;
};

type RevenueLoopCountRow = {
  campaigns: number | string;
  discovery_prepared: number | string;
  discovery_approved: number | string;
  discovery_in_flight: number | string;
  discovery_ready_for_import: number | string;
  discovery_failed: number | string;
  source_prepared: number | string;
  source_approved: number | string;
  source_in_flight: number | string;
  pending_review_leads: number | string;
  qualified_leads: number | string;
  qualified_email_leads_without_outreach: number | string;
  qualified_call_leads_without_outreach: number | string;
  outreach_prepared: number | string;
  outreach_approved_email: number | string;
  outreach_approved_call: number | string;
  outreach_sending: number | string;
  outreach_sent_without_outcome: number | string;
  outreach_sent_email_without_outcome: number | string;
  outreach_sent_call_without_outcome: number | string;
  outcome_events: number | string;
  positive_outcome_jobs: number | string;
  unreviewed_positive_outcome_jobs: number | string;
  velvet_callbacks_prepared: number | string;
  velvet_callbacks_sending: number | string;
  passing_inbox_tests: number | string;
  email_experiments_prepared: number | string;
  email_experiments_prepared_with_matching_inbox_test:
    | number
    | string;
  email_experiments_active: number | string;
  email_experiments_ready_to_close: number | string;
  email_experiment_unenrolled: number | string;
  call_experiments_prepared: number | string;
  call_experiments_active: number | string;
  call_experiments_ready_to_close: number | string;
  call_experiment_unenrolled: number | string;
  closed_experiments: number | string;
  learning_candidates_pending: number | string;
  learning_candidates_approved: number | string;
  learning_candidates_approved_unapplied: number | string;
};

type RevenueLoopProspectFocusRow = {
  campaign_id: number | string;
  lead_id: number | string;
  approval_id?: string | null;
};

function count(value: number | string): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? parsed
    : undefined;
}

function opaqueUuid(value: unknown): string | undefined {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value
    )
    ? value
    : undefined;
}

function connection(input: {
  configured: boolean;
  enabled: boolean;
  workspaceId: number | null;
  expectedWorkspaceId: number;
  missing: string[];
}): ProspectRevenueLoopConnection {
  return {
    configured: input.configured,
    enabled: input.enabled,
    availableForWorkspace:
      input.configured &&
      input.enabled &&
      input.workspaceId === input.expectedWorkspaceId,
    missing: input.missing,
  };
}

function mapCounts(row: RevenueLoopCountRow): ProspectRevenueLoopCounts {
  return {
    campaigns: count(row.campaigns),
    discoveryPrepared: count(row.discovery_prepared),
    discoveryApproved: count(row.discovery_approved),
    discoveryInFlight: count(row.discovery_in_flight),
    discoveryReadyForImport: count(row.discovery_ready_for_import),
    discoveryFailed: count(row.discovery_failed),
    sourcePrepared: count(row.source_prepared),
    sourceApproved: count(row.source_approved),
    sourceInFlight: count(row.source_in_flight),
    pendingReviewLeads: count(row.pending_review_leads),
    qualifiedLeads: count(row.qualified_leads),
    qualifiedEmailLeadsWithoutOutreach: count(
      row.qualified_email_leads_without_outreach
    ),
    qualifiedCallLeadsWithoutOutreach: count(
      row.qualified_call_leads_without_outreach
    ),
    outreachPrepared: count(row.outreach_prepared),
    outreachApprovedEmail: count(row.outreach_approved_email),
    outreachApprovedCall: count(row.outreach_approved_call),
    outreachSending: count(row.outreach_sending),
    outreachSentWithoutOutcome: count(
      row.outreach_sent_without_outcome
    ),
    outreachSentEmailWithoutOutcome: count(
      row.outreach_sent_email_without_outcome
    ),
    outreachSentCallWithoutOutcome: count(
      row.outreach_sent_call_without_outcome
    ),
    outcomeEvents: count(row.outcome_events),
    positiveOutcomeJobs: count(row.positive_outcome_jobs),
    unreviewedPositiveOutcomeJobs: count(
      row.unreviewed_positive_outcome_jobs
    ),
    velvetCallbacksPrepared: count(row.velvet_callbacks_prepared),
    velvetCallbacksSending: count(row.velvet_callbacks_sending),
    passingInboxTests: count(row.passing_inbox_tests),
    emailExperimentsPrepared: count(
      row.email_experiments_prepared
    ),
    emailExperimentsPreparedWithMatchingInboxTest: count(
      row.email_experiments_prepared_with_matching_inbox_test
    ),
    emailExperimentsActive: count(row.email_experiments_active),
    emailExperimentsReadyToClose: count(
      row.email_experiments_ready_to_close
    ),
    emailExperimentUnenrolled: count(
      row.email_experiment_unenrolled
    ),
    callExperimentsPrepared: count(row.call_experiments_prepared),
    callExperimentsActive: count(row.call_experiments_active),
    callExperimentsReadyToClose: count(
      row.call_experiments_ready_to_close
    ),
    callExperimentUnenrolled: count(
      row.call_experiment_unenrolled
    ),
    closedExperiments: count(row.closed_experiments),
    learningCandidatesPending: count(
      row.learning_candidates_pending
    ),
    learningCandidatesApproved: count(
      row.learning_candidates_approved
    ),
    learningCandidatesApprovedUnapplied: count(
      row.learning_candidates_approved_unapplied
    ),
  };
}

async function readRevenueLoopActionFocus(input: {
  sql: SqlClient;
  workspaceId: number;
  actionCode: ProspectRevenueLoopNextActionCode;
  counts: ProspectRevenueLoopCounts;
}): Promise<ProspectRevenueLoopNextAction["focus"] | undefined> {
  const { sql, workspaceId, actionCode, counts } = input;

  if (actionCode === "REVIEW_POSITIVE_OUTCOME") {
    const rows = await sql<Array<{ review_id: string }>>`
      SELECT review_id
      FROM prospect_positive_outcome_reviews
      WHERE workspace_id = ${workspaceId}
        AND state = 'PENDING'
      ORDER BY created_at ASC, id ASC
      LIMIT 1
    `;
    const reviewId = opaqueUuid(rows[0]?.review_id);
    return reviewId
      ? { kind: "positive_outcome_review", reviewId }
      : undefined;
  }

  if (actionCode === "REVIEW_LEARNING_CANDIDATE") {
    const rows = await sql<Array<{ candidate_id: number | string }>>`
      SELECT id AS candidate_id
      FROM prospect_learning_candidates
      WHERE workspace_id = ${workspaceId}
        AND state = 'CANDIDATE'
      ORDER BY generated_at ASC, id ASC
      LIMIT 1
    `;
    const candidateId = positiveInteger(rows[0]?.candidate_id);
    return candidateId
      ? { kind: "learning_candidate", candidateId }
      : undefined;
  }

  if (actionCode === "APPLY_MESSAGE_POLICY") {
    const rows = await sql<Array<{ candidate_id: number | string }>>`
      SELECT c.id AS candidate_id
      FROM prospect_learning_candidates c
      JOIN prospect_message_experiments e
        ON e.workspace_id = c.workspace_id
       AND e.experiment_id = c.proposal->>'experimentId'
      WHERE c.workspace_id = ${workspaceId}
        AND c.state = 'APPROVED'
        AND e.state = 'CLOSED'
        AND c.candidate_key = 'experiment:' || e.experiment_id
        AND c.proposal->>'studyDesign' =
          c.evidence->>'studyDesign'
        AND (
          (
            e.definition->>'contractVersion' =
              ${PROSPECT_MESSAGE_EXPERIMENT_CONTRACT_VERSION}
            AND c.proposal->>'studyDesign' =
              ${PROSPECT_MESSAGE_EXPERIMENT_STUDY_DESIGN}
          )
          OR
          (
            e.definition->>'contractVersion' =
              ${PROSPECT_MESSAGE_EXPERIMENT_LEGACY_CONTRACT_VERSION}
            AND c.proposal->>'studyDesign' =
              ${PROSPECT_MESSAGE_EXPERIMENT_LEGACY_STUDY_DESIGN}
          )
        )
        AND c.evidence->>'experimentId' = e.experiment_id
        AND c.proposal->>'experimentDefinitionHash' =
          e.definition_hash
        AND c.evidence->>'experimentDefinitionHash' =
          e.definition_hash
        AND c.proposal->>'registryVersion' =
          ${PROSPECT_MESSAGE_VARIANT_REGISTRY_VERSION}
        AND c.evidence->>'registryVersion' =
          ${PROSPECT_MESSAGE_VARIANT_REGISTRY_VERSION}
        AND c.proposal->>'runtimePolicyChange' = 'false'
        AND c.proposal->>'channel' = e.channel
        AND c.evidence->'current'->>'channel' = e.channel
        AND c.evidence->'challenger'->>'channel' = e.channel
        AND c.proposal->>'replaceVariant' =
          e.control_variant_key
        AND c.proposal->>'promoteVariant' =
          e.challenger_variant_key
        AND c.evidence->'current'->>'variantKey' =
          e.control_variant_key
        AND c.evidence->'challenger'->>'variantKey' =
          e.challenger_variant_key
        AND c.evidence->>'executedProtocolDeviationCount' = '0'
        AND CASE
          WHEN
            c.evidence->'current'->>'sampleSize' ~ '^[0-9]+$'
            AND c.evidence->'challenger'->>'sampleSize' ~ '^[0-9]+$'
          THEN
            (c.evidence->'current'->>'sampleSize')::int >= 10
            AND (c.evidence->'challenger'->>'sampleSize')::int >= 10
            AND c.sample_size =
              (c.evidence->'current'->>'sampleSize')::int +
              (c.evidence->'challenger'->>'sampleSize')::int
          ELSE FALSE
        END
        AND NOT EXISTS (
          SELECT 1
          FROM prospect_message_policy_releases p
          WHERE p.workspace_id = c.workspace_id
            AND p.source_candidate_id = c.id
            AND p.action = 'PROMOTE'
        )
      ORDER BY c.generated_at ASC, c.id ASC
      LIMIT 1
    `;
    const candidateId = positiveInteger(rows[0]?.candidate_id);
    return candidateId
      ? { kind: "learning_candidate", candidateId }
      : undefined;
  }

  if (
    actionCode === "CONFIGURE_VELVET_OUTCOME" ||
    actionCode === "DISPATCH_ONE_VELVET_OUTCOME" ||
    actionCode === "RECONCILE_VELVET_OUTCOME"
  ) {
    const state =
      actionCode === "RECONCILE_VELVET_OUTCOME"
        ? "SENDING"
        : "PREPARED";
    const rows = await sql<Array<{ outbox_id: number | string }>>`
      SELECT id AS outbox_id
      FROM velvet_outcome_outbox
      WHERE workspace_id = ${workspaceId}
        AND state = ${state}
      ORDER BY created_at ASC, id ASC
      LIMIT 1
    `;
    const outboxId = positiveInteger(rows[0]?.outbox_id);
    return outboxId
      ? { kind: "velvet_outcome", outboxId }
      : undefined;
  }

  if (
    actionCode === "CONFIGURE_VELVET_SOURCE" ||
    actionCode === "APPROVE_VELVET_SOURCE" ||
    actionCode === "DISPATCH_VELVET_SOURCE" ||
    actionCode === "RECONCILE_VELVET_SOURCE"
  ) {
    const states =
      actionCode === "APPROVE_VELVET_SOURCE"
        ? ["PREPARED"]
        : actionCode === "RECONCILE_VELVET_SOURCE"
          ? ["SENDING", "PARTIAL"]
          : ["APPROVED"];
    const rows = await sql<Array<{ request_id: number | string }>>`
      SELECT id AS request_id
      FROM velvet_lead_source_requests
      WHERE workspace_id = ${workspaceId}
        AND state = ANY(${states}::text[])
      ORDER BY created_at ASC, id ASC
      LIMIT 1
    `;
    const requestId = positiveInteger(rows[0]?.request_id);
    return requestId
      ? { kind: "velvet_source_request", requestId }
      : undefined;
  }

  if (
    actionCode === "CONFIGURE_VELVET_DISCOVERY" ||
    actionCode === "APPROVE_VELVET_DISCOVERY" ||
    actionCode === "DISPATCH_VELVET_DISCOVERY" ||
    actionCode === "REFRESH_VELVET_DISCOVERY" ||
    actionCode === "PREPARE_DISCOVERY_IMPORT" ||
    actionCode === "REVIEW_VELVET_DISCOVERY_FAILURE"
  ) {
    let rows: Array<{ request_id: number | string }> = [];
    if (actionCode === "APPROVE_VELVET_DISCOVERY") {
      rows = await sql`
        SELECT id AS request_id
        FROM velvet_discovery_requests
        WHERE workspace_id = ${workspaceId}
          AND state = 'PREPARED'
        ORDER BY created_at ASC, id ASC
        LIMIT 1
      `;
    } else if (
      actionCode === "CONFIGURE_VELVET_DISCOVERY" ||
      actionCode === "DISPATCH_VELVET_DISCOVERY"
    ) {
      rows = await sql`
        SELECT id AS request_id
        FROM velvet_discovery_requests
        WHERE workspace_id = ${workspaceId}
          AND state = 'APPROVED'
        ORDER BY created_at ASC, id ASC
        LIMIT 1
      `;
    } else if (actionCode === "REFRESH_VELVET_DISCOVERY") {
      rows = await sql`
        SELECT id AS request_id
        FROM velvet_discovery_requests
        WHERE workspace_id = ${workspaceId}
          AND (
            state = 'SENDING' OR (
              state = 'SUBMITTED'
              AND (
                remote_state IS NULL OR
                remote_state IN (
                  'PREPARED', 'APPROVED', 'QUEUED', 'RUNNING'
                )
              )
            )
          )
        ORDER BY created_at ASC, id ASC
        LIMIT 1
      `;
    } else if (actionCode === "PREPARE_DISCOVERY_IMPORT") {
      rows = await sql`
        SELECT d.id AS request_id
        FROM velvet_discovery_requests d
        WHERE d.workspace_id = ${workspaceId}
          AND d.state = 'SUBMITTED'
          AND d.remote_state IN ('COMPLETED', 'PARTIAL')
          AND d.ready_lead_count > 0
          AND NOT EXISTS (
            SELECT 1
            FROM velvet_lead_source_requests s
            WHERE s.workspace_id = d.workspace_id
              AND s.discovery_request_id = d.id
          )
        ORDER BY d.created_at ASC, d.id ASC
        LIMIT 1
      `;
    } else {
      rows = await sql`
        SELECT id AS request_id
        FROM velvet_discovery_requests
        WHERE workspace_id = ${workspaceId}
          AND (
            state = 'FAILED'
            OR remote_state IN (
              'FAILED', 'REJECTED', 'CANCELLED', 'EXPIRED'
            )
          )
        ORDER BY created_at ASC, id ASC
        LIMIT 1
      `;
    }
    const requestId = positiveInteger(rows[0]?.request_id);
    return requestId
      ? { kind: "velvet_discovery_request", requestId }
      : undefined;
  }

  if (
    actionCode === "ACTIVATE_EMAIL_EXPERIMENT" ||
    actionCode === "ACTIVATE_CALL_EXPERIMENT" ||
    actionCode === "PREPARE_EXPERIMENT_DRAFTS" ||
    actionCode === "CLOSE_ACTIVE_EXPERIMENT" ||
    actionCode === "RECONCILE_ACTIVE_EXPERIMENT"
  ) {
    const state =
      actionCode === "ACTIVATE_EMAIL_EXPERIMENT" ||
      actionCode === "ACTIVATE_CALL_EXPERIMENT"
        ? "PREPARED"
        : "ACTIVE";
    const channel =
      actionCode === "ACTIVATE_EMAIL_EXPERIMENT"
        ? "email"
        : actionCode === "ACTIVATE_CALL_EXPERIMENT"
          ? "call"
          : counts.emailExperimentsActive > 0
            ? "email"
            : counts.callExperimentsActive > 0
              ? "call"
              : null;
    const rows = await sql<
      Array<{
        experiment_id: string;
        campaign_id: number | string;
      }>
    >`
      SELECT experiment_id, campaign_id
      FROM prospect_message_experiments
      WHERE workspace_id = ${workspaceId}
        AND state = ${state}
        AND (${channel}::text IS NULL OR channel = ${channel})
      ORDER BY created_at ASC, id ASC
      LIMIT 1
    `;
    const experimentId = opaqueUuid(rows[0]?.experiment_id);
    const campaignId = positiveInteger(rows[0]?.campaign_id);
    return experimentId && campaignId
      ? { kind: "message_experiment", experimentId, campaignId }
      : undefined;
  }

  let rows: RevenueLoopProspectFocusRow[] = [];

  if (actionCode === "REVIEW_IMPORTED_PROSPECT") {
    rows = await sql<RevenueLoopProspectFocusRow[]>`
      SELECT l.campaign_id, l.id AS lead_id,
             NULL::text AS approval_id
      FROM prospect_leads l
      JOIN prospecting_campaigns c
        ON c.id = l.campaign_id
       AND c.workspace_id = l.workspace_id
      WHERE l.workspace_id = ${workspaceId}
        AND l.review_state = 'pending_review'
        AND c.external_source IS DISTINCT FROM
          ${SMIRK_INTERNAL_INBOX_SEED_SOURCE}
      ORDER BY l.created_at ASC, l.id ASC
      LIMIT 1
    `;
  } else if (
    actionCode === "WAIT_FOR_MEASURED_OUTCOME" &&
    counts.outreachSentCallWithoutOutcome > 0
  ) {
    rows = await sql<RevenueLoopProspectFocusRow[]>`
      SELECT j.campaign_id, j.lead_id,
             j.approval_id::text AS approval_id
      FROM prospect_outreach_jobs j
      WHERE j.workspace_id = ${workspaceId}
        AND j.is_seed = FALSE
        AND j.channel = 'call'
        AND j.state = 'SENT'
        AND NOT EXISTS (
          SELECT 1
          FROM prospect_outcome_events o
          WHERE o.workspace_id = j.workspace_id
            AND o.outreach_job_id = j.id
        )
      ORDER BY j.created_at ASC, j.id ASC
      LIMIT 1
    `;
  } else if (
    actionCode === "CONFIGURE_EMAIL_OUTCOME_WEBHOOK" &&
    counts.outreachApprovedEmail === 0 &&
    counts.outreachSentEmailWithoutOutcome > 0
  ) {
    rows = await sql<RevenueLoopProspectFocusRow[]>`
      SELECT j.campaign_id, j.lead_id,
             j.approval_id::text AS approval_id
      FROM prospect_outreach_jobs j
      WHERE j.workspace_id = ${workspaceId}
        AND j.is_seed = FALSE
        AND j.channel = 'email'
        AND j.state = 'SENT'
        AND NOT EXISTS (
          SELECT 1
          FROM prospect_outcome_events o
          WHERE o.workspace_id = j.workspace_id
            AND o.outreach_job_id = j.id
        )
      ORDER BY j.created_at ASC, j.id ASC
      LIMIT 1
    `;
  } else {
    const outreachCriteria:
      | { state: string; channel: "email" | "call" | null }
      | undefined =
      actionCode === "CONFIGURE_ADVISORY_QC"
        ? counts.outreachPrepared > 0
          ? { state: "PREPARED", channel: null }
          : counts.outreachApprovedEmail > 0
            ? { state: "APPROVED", channel: "email" }
            : { state: "APPROVED", channel: "call" }
        : actionCode === "REVIEW_RECIPIENT_OUTREACH"
        ? { state: "PREPARED", channel: null }
        : actionCode === "SEND_ONE_APPROVED_EMAIL" ||
            actionCode === "CONFIGURE_EMAIL_PROVIDER" ||
            (actionCode === "CONFIGURE_EMAIL_OUTCOME_WEBHOOK" &&
              counts.outreachApprovedEmail > 0)
          ? { state: "APPROVED", channel: "email" }
          : actionCode === "MANUALLY_DIAL_ONE_APPROVED_CALL"
            ? { state: "APPROVED", channel: "call" }
            : actionCode === "RECONCILE_EMAIL_PROVIDER"
              ? { state: "SENDING", channel: "email" }
              : undefined;

    if (outreachCriteria) {
      rows = await sql<RevenueLoopProspectFocusRow[]>`
        SELECT j.campaign_id, j.lead_id,
               j.approval_id::text AS approval_id
        FROM prospect_outreach_jobs j
        WHERE j.workspace_id = ${workspaceId}
          AND j.is_seed = FALSE
          AND j.state = ${outreachCriteria.state}
          AND (
            ${outreachCriteria.channel}::text IS NULL
            OR j.channel = ${outreachCriteria.channel}
          )
        ORDER BY j.created_at ASC, j.id ASC
        LIMIT 1
      `;
    }
  }

  const row = rows[0];
  const campaignId = Number(row?.campaign_id);
  const leadId = Number(row?.lead_id);
  if (
    !Number.isSafeInteger(campaignId) ||
    campaignId <= 0 ||
    !Number.isSafeInteger(leadId) ||
    leadId <= 0
  ) {
    return undefined;
  }
  const approvalId = opaqueUuid(row.approval_id);
  return {
    kind: "prospect",
    campaignId,
    leadId,
    ...(approvalId ? { approvalId } : {}),
  };
}

export function registerProspectRevenueLoopRoutes(
  app: Express,
  deps: ProspectRevenueLoopRouteDeps
): void {
  const {
    dashboardAuth,
    requireOperator,
    sql,
    dbEnabled,
    getWorkspaceId,
    env = process.env,
  } = deps;

  app.get(
    "/api/prospecting/revenue-loop",
    dashboardAuth,
    requireOperator,
    async (req: Request, res: Response) => {
      if (!dbEnabled) {
        return res.status(503).json({
          error: "Durable prospect storage is required.",
          code: "PROSPECT_REVENUE_LOOP_STORAGE_REQUIRED",
          externalAction: "none",
        });
      }
      const workspaceId = getWorkspaceId(req);
      try {
        const rows = await sql<RevenueLoopCountRow[]>`
          SELECT
            (
              SELECT COUNT(*)::int
              FROM prospecting_campaigns c
              WHERE c.workspace_id = ${workspaceId}
                AND c.external_source IS DISTINCT FROM
                  ${SMIRK_INTERNAL_INBOX_SEED_SOURCE}
            ) AS campaigns,
            (
              SELECT COUNT(*)::int
              FROM velvet_discovery_requests d
              WHERE d.workspace_id = ${workspaceId}
                AND d.state = 'PREPARED'
            ) AS discovery_prepared,
            (
              SELECT COUNT(*)::int
              FROM velvet_discovery_requests d
              WHERE d.workspace_id = ${workspaceId}
                AND d.state = 'APPROVED'
            ) AS discovery_approved,
            (
              SELECT COUNT(*)::int
              FROM velvet_discovery_requests d
              WHERE d.workspace_id = ${workspaceId}
                AND (
                  d.state = 'SENDING' OR (
                    d.state = 'SUBMITTED'
                    AND (
                      d.remote_state IS NULL OR
                      d.remote_state IN (
                        'PREPARED', 'APPROVED', 'QUEUED', 'RUNNING'
                      )
                    )
                  )
                )
            ) AS discovery_in_flight,
            (
              SELECT COUNT(*)::int
              FROM velvet_discovery_requests d
              WHERE d.workspace_id = ${workspaceId}
                AND d.state = 'SUBMITTED'
                AND d.remote_state IN ('COMPLETED', 'PARTIAL')
                AND d.ready_lead_count > 0
                AND NOT EXISTS (
                  SELECT 1
                  FROM velvet_lead_source_requests s
                  WHERE s.workspace_id = d.workspace_id
                    AND s.discovery_request_id = d.id
                )
            ) AS discovery_ready_for_import,
            (
              SELECT COUNT(*)::int
              FROM velvet_discovery_requests d
              WHERE d.workspace_id = ${workspaceId}
                AND (
                  d.state = 'FAILED' OR
                  d.remote_state IN (
                    'FAILED', 'REJECTED', 'CANCELLED', 'EXPIRED'
                  )
                )
            ) AS discovery_failed,
            (
              SELECT COUNT(*)::int
              FROM velvet_lead_source_requests s
              WHERE s.workspace_id = ${workspaceId}
                AND s.state = 'PREPARED'
            ) AS source_prepared,
            (
              SELECT COUNT(*)::int
              FROM velvet_lead_source_requests s
              WHERE s.workspace_id = ${workspaceId}
                AND s.state = 'APPROVED'
            ) AS source_approved,
            (
              SELECT COUNT(*)::int
              FROM velvet_lead_source_requests s
              WHERE s.workspace_id = ${workspaceId}
                AND s.state IN ('SENDING', 'PARTIAL')
            ) AS source_in_flight,
            (
              SELECT COUNT(*)::int
              FROM prospect_leads l
              JOIN prospecting_campaigns c ON c.id = l.campaign_id
              WHERE c.workspace_id = ${workspaceId}
                AND c.external_source IS DISTINCT FROM
                  ${SMIRK_INTERNAL_INBOX_SEED_SOURCE}
                AND l.review_state = 'pending_review'
            ) AS pending_review_leads,
            (
              SELECT COUNT(*)::int
              FROM prospect_leads l
              JOIN prospecting_campaigns c ON c.id = l.campaign_id
              WHERE c.workspace_id = ${workspaceId}
                AND c.external_source IS DISTINCT FROM
                  ${SMIRK_INTERNAL_INBOX_SEED_SOURCE}
                AND l.review_state = 'qualified'
            ) AS qualified_leads,
            (
              SELECT COUNT(*)::int
              FROM prospect_leads l
              JOIN prospecting_campaigns c ON c.id = l.campaign_id
              WHERE c.workspace_id = ${workspaceId}
                AND c.external_source IS DISTINCT FROM
                  ${SMIRK_INTERNAL_INBOX_SEED_SOURCE}
                AND l.review_state = 'qualified'
                AND l.email IS NOT NULL
                AND l.email_verification = 'verified_owner_email'
                AND NOT EXISTS (
                  SELECT 1
                  FROM prospect_outreach_jobs j
                  WHERE j.workspace_id = ${workspaceId}
                    AND j.lead_id = l.id
                    AND j.channel = 'email'
                    AND j.is_seed = FALSE
                    AND j.state IN (
                      'PREPARED', 'APPROVED', 'SENDING', 'SENT'
                    )
                )
            ) AS qualified_email_leads_without_outreach,
            (
              SELECT COUNT(*)::int
              FROM prospect_leads l
              JOIN prospecting_campaigns c ON c.id = l.campaign_id
              WHERE c.workspace_id = ${workspaceId}
                AND c.external_source IS DISTINCT FROM
                  ${SMIRK_INTERNAL_INBOX_SEED_SOURCE}
                AND l.review_state = 'qualified'
                AND l.phone IS NOT NULL
                AND l.phone_contact_mode = 'operator_review_only'
                AND NOT EXISTS (
                  SELECT 1
                  FROM prospect_outreach_jobs j
                  WHERE j.workspace_id = ${workspaceId}
                    AND j.lead_id = l.id
                    AND j.channel = 'call'
                    AND j.is_seed = FALSE
                    AND j.state IN (
                      'PREPARED', 'APPROVED', 'SENDING', 'SENT'
                    )
                )
            ) AS qualified_call_leads_without_outreach,
            (
              SELECT COUNT(*)::int
              FROM prospect_outreach_jobs j
              WHERE j.workspace_id = ${workspaceId}
                AND j.is_seed = FALSE
                AND j.state = 'PREPARED'
            ) AS outreach_prepared,
            (
              SELECT COUNT(*)::int
              FROM prospect_outreach_jobs j
              WHERE j.workspace_id = ${workspaceId}
                AND j.is_seed = FALSE
                AND j.state = 'APPROVED'
                AND j.channel = 'email'
            ) AS outreach_approved_email,
            (
              SELECT COUNT(*)::int
              FROM prospect_outreach_jobs j
              WHERE j.workspace_id = ${workspaceId}
                AND j.is_seed = FALSE
                AND j.state = 'APPROVED'
                AND j.channel = 'call'
            ) AS outreach_approved_call,
            (
              SELECT COUNT(*)::int
              FROM prospect_outreach_jobs j
              WHERE j.workspace_id = ${workspaceId}
                AND j.is_seed = FALSE
                AND j.state = 'SENDING'
            ) AS outreach_sending,
            (
              SELECT COUNT(*)::int
              FROM prospect_outreach_jobs j
              WHERE j.workspace_id = ${workspaceId}
                AND j.is_seed = FALSE
                AND j.state = 'SENT'
                AND NOT EXISTS (
                  SELECT 1
                  FROM prospect_outcome_events o
                  WHERE o.workspace_id = j.workspace_id
                    AND o.outreach_job_id = j.id
                )
            ) AS outreach_sent_without_outcome,
            (
              SELECT COUNT(*)::int
              FROM prospect_outreach_jobs j
              WHERE j.workspace_id = ${workspaceId}
                AND j.is_seed = FALSE
                AND j.channel = 'email'
                AND j.state = 'SENT'
                AND NOT EXISTS (
                  SELECT 1
                  FROM prospect_outcome_events o
                  WHERE o.workspace_id = j.workspace_id
                    AND o.outreach_job_id = j.id
                )
            ) AS outreach_sent_email_without_outcome,
            (
              SELECT COUNT(*)::int
              FROM prospect_outreach_jobs j
              WHERE j.workspace_id = ${workspaceId}
                AND j.is_seed = FALSE
                AND j.channel = 'call'
                AND j.state = 'SENT'
                AND NOT EXISTS (
                  SELECT 1
                  FROM prospect_outcome_events o
                  WHERE o.workspace_id = j.workspace_id
                    AND o.outreach_job_id = j.id
                )
            ) AS outreach_sent_call_without_outcome,
            (
              SELECT COUNT(*)::int
              FROM prospect_outcome_events o
              JOIN prospect_outreach_jobs j
                ON j.id = o.outreach_job_id
               AND j.workspace_id = o.workspace_id
              WHERE o.workspace_id = ${workspaceId}
                AND j.is_seed = FALSE
            ) AS outcome_events,
            (
              SELECT COUNT(DISTINCT o.outreach_job_id)::int
              FROM prospect_outcome_events o
              JOIN prospect_outreach_jobs j
                ON j.id = o.outreach_job_id
               AND j.workspace_id = o.workspace_id
              WHERE o.workspace_id = ${workspaceId}
                AND j.is_seed = FALSE
                AND o.outcome IN (
                  'replied', 'qualified', 'demo_booked', 'converted'
                )
            ) AS positive_outcome_jobs,
            (
              SELECT COUNT(DISTINCT r.outreach_job_id)::int
              FROM prospect_positive_outcome_reviews r
              JOIN prospect_outreach_jobs j
                ON j.id = r.outreach_job_id
               AND j.workspace_id = r.workspace_id
              WHERE r.workspace_id = ${workspaceId}
                AND r.state = 'PENDING'
                AND j.is_seed = FALSE
            ) AS unreviewed_positive_outcome_jobs,
            (
              SELECT COUNT(*)::int
              FROM velvet_outcome_outbox o
              WHERE o.workspace_id = ${workspaceId}
                AND o.state = 'PREPARED'
            ) AS velvet_callbacks_prepared,
            (
              SELECT COUNT(*)::int
              FROM velvet_outcome_outbox o
              WHERE o.workspace_id = ${workspaceId}
                AND o.state = 'SENDING'
            ) AS velvet_callbacks_sending,
            (
              SELECT COUNT(*)::int
              FROM prospect_inbox_placement_tests t
              WHERE t.workspace_id = ${workspaceId}
                AND t.state = 'PASSED'
                AND t.valid_until > NOW()
            ) AS passing_inbox_tests,
            (
              SELECT COUNT(*)::int
              FROM prospect_message_experiments e
              WHERE e.workspace_id = ${workspaceId}
                AND e.channel = 'email'
                AND e.state = 'PREPARED'
            ) AS email_experiments_prepared,
            (
              SELECT COUNT(*)::int
              FROM prospect_message_experiments e
              WHERE e.workspace_id = ${workspaceId}
                AND e.channel = 'email'
                AND e.state = 'PREPARED'
                AND EXISTS (
                  SELECT 1
                  FROM prospect_inbox_placement_tests t
                  WHERE t.workspace_id = e.workspace_id
                    AND t.target_campaign_id = e.campaign_id
                    AND t.state = 'PASSED'
                    AND t.control_variant_key =
                      e.control_variant_key
                    AND t.challenger_variant_key =
                      e.challenger_variant_key
                    AND t.valid_until > NOW()
                    AND t.definition IS NOT NULL
                    AND t.definition_hash IS NOT NULL
                    AND t.receipt IS NOT NULL
                    AND t.receipt_hash IS NOT NULL
                )
            ) AS email_experiments_prepared_with_matching_inbox_test,
            (
              SELECT COUNT(*)::int
              FROM prospect_message_experiments e
              WHERE e.workspace_id = ${workspaceId}
                AND e.channel = 'email'
                AND e.state = 'ACTIVE'
            ) AS email_experiments_active,
            (
              SELECT COUNT(*)::int
              FROM prospect_message_experiments e
              WHERE e.workspace_id = ${workspaceId}
                AND e.channel = 'email'
                AND e.state = 'ACTIVE'
                AND JSONB_ARRAY_LENGTH(
                  CASE
                    WHEN JSONB_TYPEOF(e.definition->'cohort') = 'array'
                      THEN e.definition->'cohort'
                    ELSE '[]'::jsonb
                  END
                ) > 0
                AND (
                  SELECT COUNT(*)::int
                  FROM prospect_outreach_jobs j
                  WHERE j.workspace_id = e.workspace_id
                    AND j.payload->'experimentAssignment'->>'experimentId'
                      = e.experiment_id
                ) = JSONB_ARRAY_LENGTH(
                  CASE
                    WHEN JSONB_TYPEOF(e.definition->'cohort') = 'array'
                      THEN e.definition->'cohort'
                    ELSE '[]'::jsonb
                  END
                )
                AND NOT EXISTS (
                  SELECT 1
                  FROM JSONB_ARRAY_ELEMENTS(
                    CASE
                      WHEN JSONB_TYPEOF(e.definition->'cohort') = 'array'
                        THEN e.definition->'cohort'
                      ELSE '[]'::jsonb
                    END
                  ) selected
                  WHERE NOT EXISTS (
                    SELECT 1
                    FROM prospect_outreach_jobs j
                    WHERE j.workspace_id = e.workspace_id
                      AND j.lead_id::text =
                        selected->>'prospectId'
                      AND j.payload->'experimentAssignment'->>'experimentId'
                        = e.experiment_id
                  )
                )
                AND NOT EXISTS (
                  SELECT 1
                  FROM prospect_outreach_jobs j
                  WHERE j.workspace_id = e.workspace_id
                    AND j.payload->'experimentAssignment'->>'experimentId'
                      = e.experiment_id
                    AND (
                      j.campaign_id IS DISTINCT FROM e.campaign_id
                      OR j.channel IS DISTINCT FROM e.channel
                      OR j.state IN ('PREPARED', 'APPROVED', 'SENDING')
                    )
                )
            ) AS email_experiments_ready_to_close,
            (
              SELECT COUNT(*)::int
              FROM prospect_message_experiments e
              CROSS JOIN LATERAL JSONB_ARRAY_ELEMENTS(
                CASE
                  WHEN JSONB_TYPEOF(e.definition->'cohort') = 'array'
                    THEN e.definition->'cohort'
                  ELSE '[]'::jsonb
                END
              ) selected
              WHERE e.workspace_id = ${workspaceId}
                AND e.channel = 'email'
                AND e.state = 'ACTIVE'
                AND NOT EXISTS (
                  SELECT 1
                  FROM prospect_outreach_jobs j
                  WHERE j.workspace_id = e.workspace_id
                    AND j.lead_id::text =
                      selected->>'prospectId'
                    AND j.payload->'experimentAssignment'->>'experimentId'
                      = e.experiment_id
                )
            ) AS email_experiment_unenrolled,
            (
              SELECT COUNT(*)::int
              FROM prospect_message_experiments e
              WHERE e.workspace_id = ${workspaceId}
                AND e.channel = 'call'
                AND e.state = 'PREPARED'
            ) AS call_experiments_prepared,
            (
              SELECT COUNT(*)::int
              FROM prospect_message_experiments e
              WHERE e.workspace_id = ${workspaceId}
                AND e.channel = 'call'
                AND e.state = 'ACTIVE'
            ) AS call_experiments_active,
            (
              SELECT COUNT(*)::int
              FROM prospect_message_experiments e
              WHERE e.workspace_id = ${workspaceId}
                AND e.channel = 'call'
                AND e.state = 'ACTIVE'
                AND JSONB_ARRAY_LENGTH(
                  CASE
                    WHEN JSONB_TYPEOF(e.definition->'cohort') = 'array'
                      THEN e.definition->'cohort'
                    ELSE '[]'::jsonb
                  END
                ) > 0
                AND (
                  SELECT COUNT(*)::int
                  FROM prospect_outreach_jobs j
                  WHERE j.workspace_id = e.workspace_id
                    AND j.payload->'experimentAssignment'->>'experimentId'
                      = e.experiment_id
                ) = JSONB_ARRAY_LENGTH(
                  CASE
                    WHEN JSONB_TYPEOF(e.definition->'cohort') = 'array'
                      THEN e.definition->'cohort'
                    ELSE '[]'::jsonb
                  END
                )
                AND NOT EXISTS (
                  SELECT 1
                  FROM JSONB_ARRAY_ELEMENTS(
                    CASE
                      WHEN JSONB_TYPEOF(e.definition->'cohort') = 'array'
                        THEN e.definition->'cohort'
                      ELSE '[]'::jsonb
                    END
                  ) selected
                  WHERE NOT EXISTS (
                    SELECT 1
                    FROM prospect_outreach_jobs j
                    WHERE j.workspace_id = e.workspace_id
                      AND j.lead_id::text =
                        selected->>'prospectId'
                      AND j.payload->'experimentAssignment'->>'experimentId'
                        = e.experiment_id
                  )
                )
                AND NOT EXISTS (
                  SELECT 1
                  FROM prospect_outreach_jobs j
                  WHERE j.workspace_id = e.workspace_id
                    AND j.payload->'experimentAssignment'->>'experimentId'
                      = e.experiment_id
                    AND (
                      j.campaign_id IS DISTINCT FROM e.campaign_id
                      OR j.channel IS DISTINCT FROM e.channel
                      OR j.state IN ('PREPARED', 'APPROVED', 'SENDING')
                    )
                )
            ) AS call_experiments_ready_to_close,
            (
              SELECT COUNT(*)::int
              FROM prospect_message_experiments e
              CROSS JOIN LATERAL JSONB_ARRAY_ELEMENTS(
                CASE
                  WHEN JSONB_TYPEOF(e.definition->'cohort') = 'array'
                    THEN e.definition->'cohort'
                  ELSE '[]'::jsonb
                END
              ) selected
              WHERE e.workspace_id = ${workspaceId}
                AND e.channel = 'call'
                AND e.state = 'ACTIVE'
                AND NOT EXISTS (
                  SELECT 1
                  FROM prospect_outreach_jobs j
                  WHERE j.workspace_id = e.workspace_id
                    AND j.lead_id::text =
                      selected->>'prospectId'
                    AND j.payload->'experimentAssignment'->>'experimentId'
                      = e.experiment_id
                )
            ) AS call_experiment_unenrolled,
            (
              SELECT COUNT(*)::int
              FROM prospect_message_experiments e
              WHERE e.workspace_id = ${workspaceId}
                AND e.state = 'CLOSED'
            ) AS closed_experiments,
            (
              SELECT COUNT(*)::int
              FROM prospect_learning_candidates c
              WHERE c.workspace_id = ${workspaceId}
                AND c.state = 'CANDIDATE'
            ) AS learning_candidates_pending,
            (
              SELECT COUNT(*)::int
              FROM prospect_learning_candidates c
              WHERE c.workspace_id = ${workspaceId}
                AND c.state = 'APPROVED'
            ) AS learning_candidates_approved,
            (
              SELECT COUNT(*)::int
              FROM prospect_learning_candidates c
              JOIN prospect_message_experiments e
                ON e.workspace_id = c.workspace_id
               AND e.experiment_id =
                 c.proposal->>'experimentId'
              WHERE c.workspace_id = ${workspaceId}
                AND c.state = 'APPROVED'
                AND e.state = 'CLOSED'
                AND c.candidate_key =
                  'experiment:' || e.experiment_id
                AND c.proposal->>'studyDesign' =
                  c.evidence->>'studyDesign'
                AND (
                  (
                    e.definition->>'contractVersion' =
                      ${PROSPECT_MESSAGE_EXPERIMENT_CONTRACT_VERSION}
                    AND c.proposal->>'studyDesign' =
                      ${PROSPECT_MESSAGE_EXPERIMENT_STUDY_DESIGN}
                  )
                  OR
                  (
                    e.definition->>'contractVersion' =
                      ${PROSPECT_MESSAGE_EXPERIMENT_LEGACY_CONTRACT_VERSION}
                    AND c.proposal->>'studyDesign' =
                      ${PROSPECT_MESSAGE_EXPERIMENT_LEGACY_STUDY_DESIGN}
                  )
                )
                AND c.evidence->>'experimentId' =
                  e.experiment_id
                AND c.proposal->>'experimentDefinitionHash' =
                  e.definition_hash
                AND c.evidence->>'experimentDefinitionHash' =
                  e.definition_hash
                AND c.proposal->>'registryVersion' =
                  ${PROSPECT_MESSAGE_VARIANT_REGISTRY_VERSION}
                AND c.evidence->>'registryVersion' =
                  ${PROSPECT_MESSAGE_VARIANT_REGISTRY_VERSION}
                AND c.proposal->>'runtimePolicyChange' = 'false'
                AND c.proposal->>'channel' = e.channel
                AND c.evidence->'current'->>'channel' =
                  e.channel
                AND c.evidence->'challenger'->>'channel' =
                  e.channel
                AND c.proposal->>'replaceVariant' =
                  e.control_variant_key
                AND c.proposal->>'promoteVariant' =
                  e.challenger_variant_key
                AND c.evidence->'current'->>'variantKey' =
                  e.control_variant_key
                AND c.evidence->'challenger'->>'variantKey' =
                  e.challenger_variant_key
                AND c.evidence->>'executedProtocolDeviationCount' =
                  '0'
                AND CASE
                  WHEN
                    c.evidence->'current'->>'sampleSize' ~
                      '^[0-9]+$'
                    AND c.evidence->'challenger'->>'sampleSize' ~
                      '^[0-9]+$'
                  THEN
                    (c.evidence->'current'->>'sampleSize')::int >=
                      10
                    AND
                      (c.evidence->'challenger'->>'sampleSize')::int >=
                        10
                    AND c.sample_size =
                      (c.evidence->'current'->>'sampleSize')::int +
                      (c.evidence->'challenger'->>'sampleSize')::int
                  ELSE FALSE
                END
                AND NOT EXISTS (
                  SELECT 1
                  FROM prospect_message_policy_releases p
                  WHERE p.workspace_id = c.workspace_id
                    AND p.source_candidate_id = c.id
                    AND p.action = 'PROMOTE'
                )
            ) AS learning_candidates_approved_unapplied
        `;
        if (rows.length !== 1) {
          return res.status(503).json({
            error: "The revenue-loop status row was not available.",
            code: "PROSPECT_REVENUE_LOOP_STATUS_UNAVAILABLE",
            externalAction: "none",
          });
        }

        const discovery = readVelvetDiscoveryConfig(env);
        const source = readVelvetLeadSourceConfig(env);
        const qc = readProspectQcModelProviderConfig(env);
        const email = readProspectEmailProviderConfig(env);
        const emailWebhook = readProspectEmailWebhookConfig(env);
        const inbox = readProspectInboxPlacementConfig(env);
        const outcome = readVelvetOutcomeDispatchConfig(env);
        const counts = mapCounts(rows[0]);
        const status = buildProspectRevenueLoopStatus({
          counts,
          connections: {
            velvetDiscovery: connection({
              configured: discovery.configured,
              enabled: discovery.enabled,
              workspaceId: discovery.workspaceId,
              expectedWorkspaceId: workspaceId,
              missing: discovery.missing,
            }),
            velvetSource: connection({
              configured: source.configured,
              enabled: source.enabled,
              workspaceId: source.workspaceId,
              expectedWorkspaceId: workspaceId,
              missing: source.missing,
            }),
            advisoryQc: {
              configured: qc.configured,
              enabled: qc.enabled,
              availableForWorkspace:
                qc.configured &&
                qc.enabled &&
                qc.requiredForApproval &&
                qc.workspaceId === workspaceId,
              missing: [
                ...new Set([
                  ...qc.missing,
                  ...(qc.enabled
                    ? []
                    : ["PROSPECT_QC_MODEL_REVIEW_ENABLED"]),
                  ...(qc.requiredForApproval
                    ? []
                    : [
                        "PROSPECT_QC_MODEL_REVIEW_REQUIRED_FOR_APPROVAL",
                      ]),
                ]),
              ].sort(),
            },
            emailProvider: connection({
              configured: email.configured,
              enabled: email.enabled,
              workspaceId: email.workspaceId,
              expectedWorkspaceId: workspaceId,
              missing: email.missing,
            }),
            emailWebhook: {
              configured: emailWebhook.configured,
              enabled: emailWebhook.enabled,
              availableForWorkspace:
                emailWebhook.configured &&
                emailWebhook.enabled &&
                emailWebhook.workspaceId === workspaceId,
              missing: [
                ...new Set([
                  ...emailWebhook.missing,
                  ...(emailWebhook.enabled
                    ? []
                    : ["PROSPECT_EMAIL_WEBHOOK_ENABLED"]),
                ]),
              ].sort(),
            },
            inboxPlacement: {
              configured: inbox.configured,
              enabled: true,
              availableForWorkspace: inbox.configured,
              missing: inbox.missing,
            },
            velvetOutcome: connection({
              configured: outcome.configured,
              enabled: outcome.enabled,
              workspaceId: outcome.workspaceId,
              expectedWorkspaceId: workspaceId,
              missing: outcome.missing,
            }),
          },
        });
        let focus: ProspectRevenueLoopNextAction["focus"];
        try {
          focus = await readRevenueLoopActionFocus({
            sql,
            workspaceId,
            actionCode: status.nextAction.code,
            counts,
          });
        } catch {
          focus = undefined;
        }
        return res.json({
          ...status,
          nextAction: {
            ...status.nextAction,
            ...(focus ? { focus } : {}),
          },
        });
      } catch {
        return res.status(503).json({
          error: "Revenue-loop status could not be loaded.",
          code: "PROSPECT_REVENUE_LOOP_STATUS_FAILED",
          externalAction: "none",
        });
      }
    }
  );
}
