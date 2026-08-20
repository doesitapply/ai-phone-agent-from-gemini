import type {
  NextFunction,
  Request,
  RequestHandler,
  Response,
} from "express";

export const PROSPECT_ACQUISITION_PAUSED_CODE =
  "PROSPECT_ACQUISITION_PAUSED_FOR_INTERACTION_REVIEW" as const;
export const PROSPECT_ACQUISITION_LOCK_NAMESPACE =
  1_397_573_954 as const;

type SqlClient = any;

export class ProspectAcquisitionPausedError extends Error {
  readonly status = 409;
  readonly code = PROSPECT_ACQUISITION_PAUSED_CODE;

  constructor(readonly pendingCount: number) {
    super(
      "A market interaction is waiting for full-operator review. Classify or acknowledge every pending interaction before preparing, approving, executing, dispatching, or learning from additional acquisition work."
    );
  }
}

export async function countPendingProspectPositiveOutcomeReviews(
  sql: SqlClient,
  workspaceId: number
): Promise<number> {
  const rows = await sql<
    Array<{ pending_count: number | string }>
  >`
    WITH scope AS (
      SELECT ${workspaceId}::int AS workspace_id
    )
    SELECT (
      (
        SELECT COUNT(*)::int
        FROM prospect_positive_outcome_reviews r, scope s
        WHERE r.workspace_id = s.workspace_id
          AND r.state = 'PENDING'
      ) + (
        SELECT COUNT(*)::int
        FROM prospect_email_provider_events e, scope s
        WHERE e.workspace_id = s.workspace_id
          AND e.provider = 'resend'
          AND e.event_type = 'email.received'
          AND e.process_status = 'REVIEW_REQUIRED'
          AND e.details ? 'replyReview'
      )
    )::int AS pending_count
  `;
  const pendingCount = Number(rows[0]?.pending_count);
  if (
    !Number.isSafeInteger(pendingCount) ||
    pendingCount < 0
  ) {
    throw new Error(
      "The positive-outcome pause count is unavailable."
    );
  }
  return pendingCount;
}

export async function assertProspectAcquisitionUnpaused(
  sql: SqlClient,
  workspaceId: number
): Promise<void> {
  const pendingCount =
    await countPendingProspectPositiveOutcomeReviews(
      sql,
      workspaceId
    );
  if (pendingCount > 0) {
    throw new ProspectAcquisitionPausedError(pendingCount);
  }
}

export async function acquireProspectAcquisitionWorkspaceLock(
  sql: SqlClient,
  workspaceId: number
): Promise<void> {
  if (
    !Number.isSafeInteger(workspaceId) ||
    workspaceId <= 0 ||
    workspaceId > 2_147_483_647
  ) {
    throw new Error(
      "A valid workspace is required for the acquisition lock."
    );
  }
  await sql`
    SELECT pg_advisory_xact_lock(
      ${PROSPECT_ACQUISITION_LOCK_NAMESPACE},
      ${workspaceId}
    )
  `;
}

export async function assertProspectAcquisitionMutationUnpaused(
  sql: SqlClient,
  workspaceId: number
): Promise<void> {
  await acquireProspectAcquisitionWorkspaceLock(
    sql,
    workspaceId
  );
  await assertProspectAcquisitionUnpaused(sql, workspaceId);
}

export function createProspectAcquisitionUnpausedGuard(input: {
  sql: SqlClient;
  dbEnabled: boolean;
  getWorkspaceId: (req: Request) => number;
}): RequestHandler {
  return async function prospectAcquisitionUnpausedGuard(
    req: Request,
    res: Response,
    next: NextFunction
  ) {
    if (!input.dbEnabled) {
      return res.status(503).json({
        error:
          "Durable prospect storage is required before acquisition can continue.",
        code: "PROSPECT_STORAGE_REQUIRED",
        externalAction: "none",
      });
    }
    try {
      const workspaceId = input.getWorkspaceId(req);
      try {
        await assertProspectAcquisitionUnpaused(
          input.sql,
          workspaceId
        );
      } catch (error) {
        if (!(error instanceof ProspectAcquisitionPausedError)) {
          throw error;
        }
        return res.status(409).json({
          error: error.message,
          code: error.code,
          pendingPositiveOutcomeReviews: error.pendingCount,
          pendingInteractionReviews: error.pendingCount,
          reviewPath:
            "/api/prospecting/email-replies?state=pending",
          reviewPaths: [
            "/api/prospecting/email-replies?state=pending",
            "/api/prospecting/positive-outcomes?state=pending",
          ],
          controls: {
            contactAuthorized: false,
            executionAuthorized: false,
            spendAuthorized: false,
            policyMutationAuthorized: false,
            providerRequestAuthorized: false,
          },
          externalAction: "none",
        });
      }
      return next();
    } catch {
      return res.status(503).json({
        error:
          "The positive-outcome review state could not be verified. Acquisition remains paused.",
        code: "PROSPECT_ACQUISITION_PAUSE_UNAVAILABLE",
        controls: {
          contactAuthorized: false,
          executionAuthorized: false,
          spendAuthorized: false,
          policyMutationAuthorized: false,
          providerRequestAuthorized: false,
        },
        externalAction: "none",
      });
    }
  };
}
