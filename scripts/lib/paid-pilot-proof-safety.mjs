const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const DISPOSABLE_DATABASE_PATTERN = /^smirk_revenue_proof_test_[a-z0-9_]+$/;

export function requirePaidPilotDisposableDatabaseUrl(rawValue) {
  const value = String(rawValue || "").trim();
  if (!value) {
    throw new Error("SMIRK_PAID_PILOT_TEST_DATABASE_URL is required for the local paid-pilot proof.");
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("SMIRK_PAID_PILOT_TEST_DATABASE_URL must be a valid PostgreSQL URL.");
  }

  if (!new Set(["postgres:", "postgresql:"]).has(parsed.protocol)) {
    throw new Error("Paid-pilot proof database URL must use PostgreSQL.");
  }
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new Error("Refusing paid-pilot proof against a non-loopback database host.");
  }
  if (parsed.port !== "5432") {
    throw new Error("Paid-pilot proof database URL must use the explicit local PostgreSQL port 5432.");
  }
  if (parsed.search || parsed.hash) {
    throw new Error("Paid-pilot proof database URL must not contain query parameters or a fragment.");
  }

  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!DISPOSABLE_DATABASE_PATTERN.test(databaseName)) {
    throw new Error("Refusing paid-pilot proof against a database without the disposable test prefix.");
  }

  return value;
}
