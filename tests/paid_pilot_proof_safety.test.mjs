import assert from "node:assert/strict";
import test from "node:test";
import { requirePaidPilotDisposableDatabaseUrl } from "../scripts/lib/paid-pilot-proof-safety.mjs";

test("paid-pilot proof accepts only disposable loopback PostgreSQL databases", () => {
  const safe = "postgresql://developer@127.0.0.1:5432/smirk_revenue_proof_test_20260801_123_abcd";
  assert.equal(requirePaidPilotDisposableDatabaseUrl(safe), safe);

  for (const unsafe of [
    "",
    "postgresql://developer@db.railway.internal/smirk_revenue_proof_test_20260801",
    "postgresql://developer@127.0.0.1/smirk_production",
    "postgresql://developer@127.0.0.1/smirk_revenue_proof_test_missing_port",
    "postgresql://developer@127.0.0.1:6543/smirk_revenue_proof_test_tunnel",
    "postgresql://developer@127.0.0.1/smirk_revenue_proof_test_ok?sslmode=require",
    "mysql://developer@127.0.0.1/smirk_revenue_proof_test_20260801",
  ]) {
    assert.throws(() => requirePaidPilotDisposableDatabaseUrl(unsafe));
  }
});
