import type { Express, RequestHandler } from "express";

type ApiMiddlewareDeps = {
  apiRateLimit: RequestHandler;
  publicDemoRateLimit: RequestHandler;
  publicHealthRateLimit: RequestHandler;
  twilioValidate: RequestHandler;
};

export function registerApiMiddleware(app: Express, deps: ApiMiddlewareDeps): void {
  const {
    apiRateLimit,
    publicDemoRateLimit,
    publicHealthRateLimit,
    twilioValidate,
  } = deps;

  app.use("/api/calls", apiRateLimit);
  app.use("/api/agents", apiRateLimit);
  app.use("/api/stats", apiRateLimit);
  app.use("/api/contacts", apiRateLimit);
  app.use("/api/tasks", apiRateLimit);
  app.use("/api/handoffs", apiRateLimit);
  app.use("/api/summaries", apiRateLimit);
  app.use("/api/demo", publicDemoRateLimit);
  app.use("/api/system-health/public", publicHealthRateLimit);
  app.use("/api/public-proof-snapshot", publicHealthRateLimit);
  app.use("/api/twilio", twilioValidate);
}
