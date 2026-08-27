import type { Express, Request, Response } from "express";
import { readFile } from "node:fs/promises";
import path from "node:path";

const POLICY_FILES = Object.freeze({
  "/policies/terms-v1.0.0": "terms-v1.0.0.html",
  "/policies/privacy-v1.0.0": "privacy-v1.0.0.html",
  "/policies/cancellation-refund-v1.0.0": "cancellation-refund-v1.0.0.html",
  "/policies/billing-management-v1.0.0": "billing-management-v1.0.0.html",
  "/policies/support-v1.0.0": "support-v1.0.0.html",
  "/policies/data-consent-v1.0.0": "data-consent-v1.0.0.html",
});

export function registerPublicPolicyRoutes(app: Express) {
  for (const [route, filename] of Object.entries(POLICY_FILES)) {
    app.get(route, async (_req: Request, res: Response) => {
      try {
        const policyPath = path.resolve(process.cwd(), "public", "policies", filename);
        const body = await readFile(policyPath);
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.setHeader("Cache-Control", "public, max-age=300");
        res.setHeader("Content-Length", String(body.byteLength));
        return res.status(200).send(body);
      } catch {
        return res.status(503).send("Approved policy document is temporarily unavailable.");
      }
    });
  }
}
