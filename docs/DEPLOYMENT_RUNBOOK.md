# SMIRK deployment and rollback runbook

SMIRK production is connected to the repository's `main` branch in Railway. A merge or push to `main` starts a production deployment. GitHub CI records the release checks, but it is not a deployment gate unless repository branch protection and the Railway trigger are explicitly configured to wait for it.

## Before merging to `main`

1. Fetch the remote and confirm the release branch is based on the current `origin/main`.
2. Confirm the worktree contains only the reviewed release changes.
3. Record the current successful Railway deployment ID as the known-good rollback target.
4. Run the exact local evidence set:

   ```bash
   npm ci
   npm audit --audit-level=moderate
   npm run check:release
   git diff --check
   git status --short
   ```

5. Review any failing live-readiness command separately. A code release can be healthy while checkout, billing, proof-call, or commercial gates remain blocked.

Do not use an old approval command or an approval tied to a different commit. Do not run `railway up` directly when a guarded deploy packet is required.

## Deploy and verify

1. Merge the reviewed release commit to `main`.
2. Wait for Railway to report a successful deployment sourced from that exact `main` commit.
3. Verify the application independently:

   ```bash
   npm run -s check:live-is-current
   npm run -s check:latest-failed-deploy
   npm run -s check:live:health
   ```

4. Confirm `/health` and `/api/version` report the exact deployed Railway Git commit and branch. Railway Git metadata is authoritative for GitHub-source deployments; manual `SMIRK_DEPLOY_*` stamps are fallback metadata for reviewed archive or CLI deployments.
5. Exercise the public landing, pricing, setup, and authenticated owner entry points at desktop and mobile widths.

Do not equate a successful deployment with a completed proof call, qualifying revenue, customer activation, provider change, or outreach authorization.

## Roll back an incident

Railway's dashboard can restore a prior deployment image. The CLI `railway redeploy` rebuilds the latest deployment and is not an arbitrary rollback.

1. In Railway, open `ai-phone-agent` -> **Deployments**.
2. Select the recorded known-good deployment, choose **Rollback**, and confirm.
3. Wait for health to recover, then rerun the three verification commands above and confirm the live fingerprint matches the restored deployment.
4. Create a forward `git revert` of the bad release on `main` and take it through the full release checks. Do not leave production dependent on an unrepresented dashboard-only rollback.
5. Record the failed deployment ID, rollback deployment ID, symptoms, and verification evidence in the release issue or incident record.
