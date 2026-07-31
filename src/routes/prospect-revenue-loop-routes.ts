import type {
  Express,
  Request,
  RequestHandler,
  Response,
} from "express";
import { readProspectEmailProviderConfig } from "../prospect-email-provider.js";
import {
  readProspectInboxPlacementConfig,
  SMIRK_INTERNAL_INBOX_SEED_SOURCE,
} from "../prospect-inbox-placement.js";
import {
  buildProspectRevenueLoopStatus,
  type ProspectRevenueLoopConnection,
  type ProspectRevenueLoopCounts,
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
  email_experiment_unenrolled: number | string;
  call_experiments_prepared: number | string;
  call_experiments_active: number | string;
  call_experiment_unenrolled: number | string;
  closed_experiments: number | string;
  learning_candidates_pending: number | string;
  learning_candidates_approved: number | string;
  learning_candidates_approved_unapplied: number | string;
};

function count(value: number | string): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
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
    emailExperimentUnenrolled: count(
      row.email_experiment_unenrolled
    ),
    callExperimentsPrepared: count(row.call_experiments_prepared),
    callExperimentsActive: count(row.call_experiments_active),
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
              WHERE c.workspace_id = ${workspaceId}
                AND c.state = 'APPROVED'
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
        const email = readProspectEmailProviderConfig(env);
        const inbox = readProspectInboxPlacementConfig(env);
        const outcome = readVelvetOutcomeDispatchConfig(env);
        return res.json(
          buildProspectRevenueLoopStatus({
            counts: mapCounts(rows[0]),
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
              emailProvider: connection({
                configured: email.configured,
                enabled: email.enabled,
                workspaceId: email.workspaceId,
                expectedWorkspaceId: workspaceId,
                missing: email.missing,
              }),
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
          })
        );
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
