import type { Express, Request, RequestHandler, Response } from "express";
import type { Workspace } from "../saas.js";

type WorkspaceNotificationRouteDeps = {
  dashboardAuth: RequestHandler;
  workspaceTestEmailRateLimit: RequestHandler;
  env: {
    RESEND_API_KEY?: string;
    FROM_EMAIL?: string;
  };
  getWorkspaceById: (id: number) => Promise<Workspace | null>;
  log: (level: string, message: string, meta?: Record<string, unknown>) => void;
};

const isDeliverableEmailShape = (value: unknown): value is string => {
  const email = String(value || "").trim();
  return email.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && !/owner@example\.com$/i.test(email);
};

export function registerWorkspaceNotificationRoutes(app: Express, deps: WorkspaceNotificationRouteDeps): void {
  const {
    dashboardAuth,
    workspaceTestEmailRateLimit,
    env,
    getWorkspaceById,
    log,
  } = deps;

  app.post("/api/workspace/test-email", dashboardAuth,
    workspaceTestEmailRateLimit,
    async (req: Request, res: Response) => {
      res.setHeader("Cache-Control", "no-store");
      const workspaceAuth = (req as Request & { workspaceAuth?: { id?: number } }).workspaceAuth;
      if ((req as any).authMode !== "workspace" || !workspaceAuth?.id) {
        return res.status(403).json({
          ok: false,
          code: "WORKSPACE_AUTH_REQUIRED",
          error: "Sign in to this workspace to test its owner-alert email.",
        });
      }

      try {
        const workspace = await getWorkspaceById(Number(workspaceAuth.id));
        if (!workspace || Number(workspace.id) !== Number(workspaceAuth.id)) {
          return res.status(404).json({ ok: false, code: "WORKSPACE_NOT_FOUND", error: "Workspace not found." });
        }

        const recipient = String(workspace.notification_email || "").trim();
        if (!isDeliverableEmailShape(recipient)) {
          return res.status(409).json({
            ok: false,
            code: "WORKSPACE_NOTIFICATION_EMAIL_REQUIRED",
            error: "Save a real owner-alert email before sending a test.",
          });
        }

        const resendKey = String(env.RESEND_API_KEY || "").trim();
        const fromEmail = String(env.FROM_EMAIL || "").trim();
        if (!resendKey || !fromEmail) {
          return res.status(503).json({
            ok: false,
            code: "OWNER_ALERT_EMAIL_NOT_READY",
            error: "Owner-alert email is not available yet. Please contact SMIRK support.",
          });
        }

        const providerResponse = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${resendKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from: fromEmail,
            to: [recipient],
            subject: "Your SMIRK owner-alert test",
            html: "<p>This is a test of the owner-alert email saved for your SMIRK workspace.</p><p>No customer was contacted and no call was placed.</p>",
          }),
        });
        if (!providerResponse.ok) {
          log("warn", "Workspace owner-alert test email provider rejected request", {
            workspaceId: workspace.id,
            providerStatus: providerResponse.status,
          });
          return res.status(502).json({
            ok: false,
            code: "OWNER_ALERT_TEST_FAILED",
            error: "The test email could not be delivered. Please try again or contact SMIRK support.",
          });
        }

        log("info", "Workspace owner-alert test email sent", { workspaceId: workspace.id });
        return res.json({
          ok: true,
          message: "Test email sent to the owner-alert address saved for this workspace.",
        });
      } catch (error: unknown) {
        log("error", "POST /api/workspace/test-email failed", {
          workspaceId: workspaceAuth.id,
          error: error instanceof Error ? error.message : String(error),
        });
        return res.status(500).json({
          ok: false,
          code: "OWNER_ALERT_TEST_UNAVAILABLE",
          error: "The test email is temporarily unavailable. Please try again.",
        });
      }
    },
  );
}
