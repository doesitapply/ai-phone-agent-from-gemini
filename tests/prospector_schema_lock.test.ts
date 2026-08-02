import assert from "node:assert/strict";
import test from "node:test";
import {
  PROSPECT_SCHEMA_ADVISORY_LOCK_CLASS_ID,
  PROSPECT_SCHEMA_ADVISORY_LOCK_OBJECT_ID,
  withProspectorSchemaLock,
} from "../src/prospector.js";

function schemaLockFixture(input: {
  acquired?: boolean;
  released?: boolean;
  unlockError?: Error;
} = {}) {
  const events: string[] = [];
  const values: unknown[][] = [];
  const connection = Object.assign(
    async (strings: TemplateStringsArray, ...parameters: unknown[]) => {
      const query = strings.join("?");
      values.push(parameters);
      if (query.includes("pg_try_advisory_lock")) {
        events.push("lock");
        return [{ acquired: input.acquired ?? true }];
      }
      if (query.includes("pg_advisory_unlock")) {
        events.push("unlock");
        if (input.unlockError) throw input.unlockError;
        return [{ released: input.released ?? true }];
      }
      throw new Error(`Unexpected query: ${query}`);
    },
    {
      release: () => events.push("release"),
    }
  );
  const rootSql = {
    reserve: async () => {
      events.push("reserve");
      return connection;
    },
  };
  return { events, values, rootSql };
}

test("prospector schema work holds one reserved advisory lock", async () => {
  const fixture = schemaLockFixture();
  const result = await withProspectorSchemaLock(
    fixture.rootSql,
    async () => {
      fixture.events.push("schema");
      return "complete";
    }
  );

  assert.equal(result, "complete");
  assert.deepEqual(fixture.events, [
    "reserve",
    "lock",
    "schema",
    "unlock",
    "release",
  ]);
  assert.deepEqual(fixture.values, [
    [
      PROSPECT_SCHEMA_ADVISORY_LOCK_CLASS_ID,
      PROSPECT_SCHEMA_ADVISORY_LOCK_OBJECT_ID,
    ],
    [
      PROSPECT_SCHEMA_ADVISORY_LOCK_CLASS_ID,
      PROSPECT_SCHEMA_ADVISORY_LOCK_OBJECT_ID,
    ],
  ]);
});

test("a competing schema initializer fails before schema work", async () => {
  const fixture = schemaLockFixture({ acquired: false });
  let operationCalls = 0;

  await assert.rejects(
    withProspectorSchemaLock(fixture.rootSql, async () => {
      operationCalls += 1;
    }),
    /already running on another instance/
  );

  assert.equal(operationCalls, 0);
  assert.deepEqual(fixture.events, ["reserve", "lock", "release"]);
});

test("schema failure still unlocks and releases the connection", async () => {
  const fixture = schemaLockFixture();
  const schemaError = new Error("schema failed");

  await assert.rejects(
    withProspectorSchemaLock(fixture.rootSql, async () => {
      fixture.events.push("schema");
      throw schemaError;
    }),
    (error: unknown) => error === schemaError
  );

  assert.deepEqual(fixture.events, [
    "reserve",
    "lock",
    "schema",
    "unlock",
    "release",
  ]);
});

test("unlock transport failure does not hide the schema failure", async () => {
  const fixture = schemaLockFixture({
    unlockError: new Error("unlock transport failed"),
  });
  const schemaError = new Error("schema failed first");

  await assert.rejects(
    withProspectorSchemaLock(fixture.rootSql, async () => {
      fixture.events.push("schema");
      throw schemaError;
    }),
    (error: unknown) => error === schemaError
  );

  assert.deepEqual(fixture.events, [
    "reserve",
    "lock",
    "schema",
    "unlock",
    "release",
  ]);
});

test("an unlock mismatch fails closed after successful schema work", async () => {
  const fixture = schemaLockFixture({ released: false });

  await assert.rejects(
    withProspectorSchemaLock(fixture.rootSql, async () => {
      fixture.events.push("schema");
    }),
    /advisory lock was not released/
  );

  assert.deepEqual(fixture.events, [
    "reserve",
    "lock",
    "schema",
    "unlock",
    "release",
  ]);
});

test("schema initialization refuses a non-reservable database adapter", async () => {
  await assert.rejects(
    withProspectorSchemaLock({}, async () => undefined),
    /requires a reserved Postgres connection/
  );
});
