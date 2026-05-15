# Railway DB Wiring Fix

Use this when the app deploys but `/health` reports DB degraded or logs show `CONNECT_TIMEOUT postgres.railway.internal:5432`.

## Symptom
- deploy succeeds
- `/livez` passes
- `/health` returns `db.ok: false`
- logs show `postgres.railway.internal:5432` timeout

## Fix in Railway
1. Open project `ai-phone-agent`
2. Open environment `production`
3. Open service `ai-phone-agent`
4. Go to **Variables**
5. Find `DATABASE_URL`
6. Delete the current value if it was pasted manually
7. Re-add `DATABASE_URL` using **Add Reference** from the Postgres service in the same project/environment
8. Confirm the Postgres service is healthy and attached in the same Railway project/environment
9. Redeploy the app service

## Verify
```bash
npm run check:railway-db-wiring
npm run check:post-deploy-live
```

## Expected result
- `check:railway-db-wiring` no longer warns about broken/risky DB wiring
- `/health` shows `db.ok: true`
- buyer smoke no longer fails on provisioning routes due to DB outage
