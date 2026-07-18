import express, { type Express, type Request, type Response } from "express";

type GoogleIdentity = {
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
  aud?: string;
  sub?: string;
};

type AuthRouteDeps = {
  env: {
    DASHBOARD_API_KEY?: string;
    DEMO_OPERATOR_API_KEY?: string;
  };
  googleClientIds: () => string[];
  googleAdminEmails: () => string[];
  googleDemoOperatorEmails: () => string[];
  verifyGoogleIdToken: (credential: string) => Promise<GoogleIdentity>;
  getWorkspacesForEmail: (email: string) => Promise<Array<{
    id: number;
    name: string;
    slug: string;
    plan: string;
    mode: string;
    api_key: string;
    role: string;
  }>>;
};

export function registerAuthRoutes(app: Express, deps: AuthRouteDeps): void {
  const {
    env,
    googleClientIds,
    googleAdminEmails,
    googleDemoOperatorEmails,
    verifyGoogleIdToken,
    getWorkspacesForEmail,
  } = deps;

  app.get("/api/auth/google/config", (_req: Request, res: Response) => {
    const clientId = googleClientIds()[0] || "";
    const adminEmails = googleAdminEmails();
    const demoOperatorEmails = googleDemoOperatorEmails();
    res.json({
      enabled: !!clientId,
      clientId: clientId || null,
      adminEnabled: (!!env.DASHBOARD_API_KEY && adminEmails.length > 0) || (!!env.DEMO_OPERATOR_API_KEY && demoOperatorEmails.length > 0),
      adminHint: adminEmails.length > 0 ? adminEmails.join(", ") : null,
      demoOperatorEnabled: !!env.DEMO_OPERATOR_API_KEY && demoOperatorEmails.length > 0,
      demoOperatorHint: demoOperatorEmails.length > 0 ? demoOperatorEmails.join(", ") : null,
    });
  });

  app.post("/api/auth/google/exchange", express.json(), async (req: Request, res: Response) => {
    if (googleClientIds().length === 0) {
      return res.status(503).json({
        error: "Google workspace sign-in is not configured.",
        code: "GOOGLE_OAUTH_NOT_CONFIGURED",
      });
    }
    try {
      const mode = String(req.body?.mode || "workspace").trim().toLowerCase();
      const workspaceId = Number(req.body?.workspaceId || 0);
      const identity = await verifyGoogleIdToken(String(req.body?.credential || ""));

      if (!identity.email || !identity.email_verified) {
        return res.status(401).json({ error: "Google account email is missing or not verified." });
      }

      if (mode === "operator") {
        const allowedAdminEmails = googleAdminEmails();
        const allowedDemoOperatorEmails = googleDemoOperatorEmails();
        const fullAdminEnabled = !!env.DASHBOARD_API_KEY && allowedAdminEmails.length > 0;
        const demoOperatorEnabled = !!env.DEMO_OPERATOR_API_KEY && allowedDemoOperatorEmails.length > 0;
        if (!fullAdminEnabled && !demoOperatorEnabled) {
          return res.status(503).json({ error: "Operator Google sign-in is not configured." });
        }
        if (fullAdminEnabled && allowedAdminEmails.includes(identity.email)) {
          return res.json({
            ok: true,
            mode: "operator",
            user: identity,
            session: {
              apiKey: env.DASHBOARD_API_KEY,
              label: `SMIRK Admin · ${identity.email}`,
              role: "operator",
            },
          });
        }
        if (demoOperatorEnabled && allowedDemoOperatorEmails.includes(identity.email)) {
          return res.json({
            ok: true,
            mode: "operator",
            user: identity,
            session: {
              apiKey: env.DEMO_OPERATOR_API_KEY,
              label: `SMIRK Demo Operator · ${identity.email}`,
              role: "demo_operator",
              spendRestricted: true,
            },
          });
        }
        return res.status(403).json({ error: `Google account ${identity.email} is not allowed for operator access.` });
      }

      const matches = await getWorkspacesForEmail(identity.email);
      const eligible = workspaceId > 0 ? matches.filter((row) => Number(row.id) === workspaceId) : matches;
      if (eligible.length === 0) {
        return res.status(404).json({
          error: workspaceId > 0
            ? `Google account ${identity.email} does not have access to workspace ${workspaceId}.`
            : `Google account ${identity.email} is not attached to any active SMIRK workspace yet.`,
        });
      }

      if (workspaceId === 0 && eligible.length > 1) {
        return res.status(409).json({
          error: `Google account ${identity.email} matches multiple workspaces. Pick one workspace ID first.`,
          choices: eligible.map((row) => ({ id: row.id, name: row.name, slug: row.slug, role: row.role })),
        });
      }

      const workspace = eligible[0];
      return res.json({
        ok: true,
        mode: "workspace",
        user: identity,
        workspace: {
          id: workspace.id,
          name: workspace.name,
          slug: workspace.slug,
          plan: workspace.plan,
          mode: workspace.mode,
          role: workspace.role,
          apiKey: workspace.api_key,
        },
      });
    } catch (err: any) {
      return res.status(400).json({ error: err?.message || "Google sign-in failed." });
    }
  });
}
