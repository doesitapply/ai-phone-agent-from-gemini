import assert from "node:assert/strict";
import test from "node:test";
import {
  VelvetAcquisitionStoreError,
  createPostgresVelvetAcquisitionStore,
} from "../src/routes/velvet-acquisition-routes.ts";
import { velvetAcquisitionPayloadSchema } from "../src/velvet-acquisition.ts";

const basePayload = velvetAcquisitionPayloadSchema.parse({
  workspaceId: 42,
  recordKind: "synthetic",
  sourceRecordId: "velvet-manus-fake-lead-00000001",
  sourceEventId: "velvet-manus-fake-event-00000001",
  caller: { phone: "+12025550124", name: "Test Caller" },
  companyName: "Velvet Test Co",
  reason: "Synthetic callback handoff integration test.",
  urgency: "low",
});

function makeFakeSql() {
  const workspaces = new Set([42, 43]);
  const records = new Map<string, any>();
  const events = new Map<string, any>();
  const reviews = new Map<string, any>();
  const queries: string[] = [];

  const tx: any = async (strings: TemplateStringsArray, ...values: any[]) => {
    const query = strings.join("?").replace(/\s+/g, " ").trim();
    queries.push(query);

    if (query.includes("SELECT receipt_id, acquisition_id, payload_hash FROM acquisition_events")) {
      const row = events.get(`${values[0]}|${values[1]}|${values[2]}`);
      return row ? [row] : [];
    }
    if (query.includes("SELECT id FROM workspaces")) {
      return workspaces.has(Number(values[0])) ? [{ id: Number(values[0]) }] : [];
    }
    if (query.includes("INSERT INTO acquisition_records")) {
      const key = `${values[1]}|${values[2]}|${values[3]}`;
      if (!records.has(key)) {
        records.set(key, {
          acquisition_id: values[0],
          record_kind: values[5],
          contact_permission: values[6],
          contact_basis: values[7],
          first_payload_hash: values[4],
        });
      }
      return [];
    }
    if (query.includes("FROM acquisition_records")) {
      const row = records.get(`${values[0]}|${values[1]}|${values[2]}`);
      return row ? [row] : [];
    }
    if (query.includes("INSERT INTO acquisition_events")) {
      const key = `${values[2]}|${values[3]}|${values[4]}`;
      if (events.has(key)) return [];
      const row = {
        receipt_id: values[0],
        acquisition_id: values[1],
        payload_hash: values[5],
      };
      events.set(key, row);
      return [{ receipt_id: values[0] }];
    }
    if (query.includes("INSERT INTO acquisition_reviews")) {
      if (!reviews.has(values[0])) {
        reviews.set(values[0], {
          acquisition_id: values[1],
          workspace_id: values[2],
          decision: values[3],
          contact_basis: values[4],
          evidence_hash: values[5],
          evidence_ref: values[6],
        });
      }
      return [];
    }
    throw new Error(`Unhandled acquisition SQL fixture query: ${query}`);
  };
  tx.begin = async (callback: (transaction: any) => Promise<unknown>) => callback(tx);
  tx.json = (value: unknown) => value;

  return { sql: tx, records, events, reviews, queries };
}

test("persists one immutable root, distinct receipts, and one synthetic safety review", async () => {
  const fixture = makeFakeSql();
  const store = createPostgresVelvetAcquisitionStore(fixture.sql);
  const first = await store.receive(basePayload);
  const duplicate = await store.receive(basePayload);
  const nextEventPayload = { ...basePayload, sourceEventId: "velvet-manus-fake-event-00000002" };
  const nextEvent = await store.receive(nextEventPayload);

  assert.equal(first.outcome, "created");
  assert.equal(duplicate.outcome, "duplicate");
  assert.equal(nextEvent.outcome, "created");
  assert.equal(first.acquisitionId, duplicate.acquisitionId);
  assert.equal(first.acquisitionId, nextEvent.acquisitionId);
  assert.equal(first.receiptId, duplicate.receiptId);
  assert.notEqual(first.receiptId, nextEvent.receiptId);
  assert.equal(fixture.records.size, 1);
  assert.equal(fixture.events.size, 2);
  assert.equal(fixture.reviews.size, 1);
  assert.equal(fixture.queries.some((query) => /\b(?:contacts|calls|handoffs|tasks|messages|launch_outreach_approvals)\b/.test(query)), false);
});

test("rejects a changed replay without changing its original evidence", async () => {
  const fixture = makeFakeSql();
  const store = createPostgresVelvetAcquisitionStore(fixture.sql);
  await store.receive(basePayload);

  await assert.rejects(
    store.receive({ ...basePayload, reason: "Synthetic changed replay integration test." }),
    (error: unknown) => error instanceof VelvetAcquisitionStoreError
      && error.code === "VELVET_ALCHEMY_IDEMPOTENCY_CONFLICT"
      && error.status === 409,
  );
  assert.equal(fixture.records.size, 1);
  assert.equal(fixture.events.size, 1);
  assert.equal(fixture.reviews.size, 1);
});

test("keeps identical Velvet source identities tenant-scoped", async () => {
  const fixture = makeFakeSql();
  const store = createPostgresVelvetAcquisitionStore(fixture.sql);
  const workspace42 = { ...basePayload, workspaceId: 42 };
  const workspace43 = { ...basePayload, workspaceId: 43 };

  const first = await store.receive(workspace42);
  const second = await store.receive(workspace43);

  assert.notEqual(first.acquisitionId, second.acquisitionId);
  assert.notEqual(first.receiptId, second.receiptId);
  assert.equal(fixture.records.size, 2);
  assert.equal(fixture.events.size, 2);
});

test("persists real evidence as unverified and held without creating contact work", async () => {
  const fixture = makeFakeSql();
  const store = createPostgresVelvetAcquisitionStore(fixture.sql);
  const payload = velvetAcquisitionPayloadSchema.parse({
    workspaceId: 42,
    recordKind: "real",
    sourceRecordId: "velvet-lead-store-00000001",
    sourceEventId: "velvet-event-store-00000001",
    caller: { phone: "+17755550142", name: "Prospect Owner" },
    companyName: "Prospect Plumbing Company",
    reason: "Qualified prospect evidence received for operator review.",
    urgency: "normal",
  });
  const result = await store.receive(payload);

  assert.equal(result.recordKind, "real");
  assert.equal(result.contactPermission, "unverified");
  assert.equal(result.contactBasis, "not_evaluated");
  assert.equal(fixture.records.size, 1);
  assert.equal(fixture.events.size, 1);
  assert.equal(fixture.reviews.size, 1);
  assert.equal([...fixture.reviews.values()][0].decision, "observe_only");
  assert.equal(fixture.queries.some((query) => /\b(?:contacts|calls|handoffs|tasks|messages|launch_outreach_approvals)\b/.test(query)), false);
});

test("the Postgres adapter independently rejects misclassified data before opening a transaction", async () => {
  let transactions = 0;
  const sql: any = () => {
    throw new Error("must not query");
  };
  sql.begin = async () => {
    transactions += 1;
    throw new Error("must not transact");
  };
  const store = createPostgresVelvetAcquisitionStore(sql);
  const realShapedPayload = velvetAcquisitionPayloadSchema.parse({
    ...basePayload,
    caller: { ...basePayload.caller, phone: "+17755550142" },
  });

  await assert.rejects(
    store.receive(realShapedPayload),
    (error: unknown) => error instanceof VelvetAcquisitionStoreError
      && error.code === "VELVET_ALCHEMY_ACQUISITION_CLASSIFICATION_CONFLICT",
  );
  assert.equal(transactions, 0);
});

test("the Postgres adapter revalidates strict payload shape at its own boundary", async () => {
  let transactions = 0;
  const sql: any = () => { throw new Error("must not query"); };
  sql.begin = async () => { transactions += 1; throw new Error("must not transact"); };
  const store = createPostgresVelvetAcquisitionStore(sql);

  await assert.rejects(
    store.receive({ ...basePayload, injected: "not-canonical-evidence" } as any),
    (error: unknown) => error instanceof VelvetAcquisitionStoreError
      && error.code === "VELVET_ALCHEMY_ACQUISITION_INVALID_PAYLOAD",
  );
  assert.equal(transactions, 0);
});
