import assert from "node:assert/strict";
import test from "node:test";
import { deleteWorkspaceCalls } from "../src/routes/call-routes.ts";

type RowState = {
  calls: Map<string, number>;
  messages: Set<string>;
  events: Set<string>;
  summaries: Set<string>;
};

function createSqlFixture(initial: Record<string, number>) {
  const state: RowState = {
    calls: new Map(Object.entries(initial)),
    messages: new Set(Object.keys(initial)),
    events: new Set(Object.keys(initial)),
    summaries: new Set(Object.keys(initial)),
  };
  const childDeletes: string[][] = [];

  const tx = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join(" ? ").replace(/\s+/g, " ").trim();

    if (query.startsWith("SELECT call_sid FROM calls")) {
      const workspaceId = Number(values[0]);
      const requested = values[1] as string[];
      return requested
        .filter((sid) => state.calls.get(sid) === workspaceId)
        .map((call_sid) => ({ call_sid }));
    }

    if (
      query.startsWith("DELETE FROM messages")
      || query.startsWith("DELETE FROM call_events")
      || query.startsWith("DELETE FROM call_summaries")
    ) {
      const requested = values[0] as string[];
      childDeletes.push([...requested]);
      const target = query.startsWith("DELETE FROM messages")
        ? state.messages
        : query.startsWith("DELETE FROM call_events")
          ? state.events
          : state.summaries;
      requested.forEach((sid) => target.delete(sid));
      return [];
    }

    if (query.startsWith("DELETE FROM calls")) {
      const workspaceId = Number(values[0]);
      const requested = values[1] as string[];
      const deleted: Array<{ call_sid: string }> = [];
      for (const sid of requested) {
        if (state.calls.get(sid) !== workspaceId) continue;
        state.calls.delete(sid);
        deleted.push({ call_sid: sid });
      }
      return deleted;
    }

    throw new Error(`Unexpected SQL in fixture: ${query}`);
  };

  const sql = Object.assign(tx, {
    begin: async (callback: (transaction: typeof tx) => Promise<string[]>) => callback(tx),
  });

  return { sql, state, childDeletes };
}

test("an unowned call cannot delete any child artifacts", async () => {
  const fixture = createSqlFixture({ "CA-OTHER": 2 });

  const deleted = await deleteWorkspaceCalls(fixture.sql, 1, ["CA-OTHER"]);

  assert.deepEqual(deleted, []);
  assert.deepEqual(fixture.childDeletes, []);
  assert.equal(fixture.state.calls.get("CA-OTHER"), 2);
  assert.equal(fixture.state.messages.has("CA-OTHER"), true);
  assert.equal(fixture.state.events.has("CA-OTHER"), true);
  assert.equal(fixture.state.summaries.has("CA-OTHER"), true);
});

test("a mixed-tenant request deletes only workspace-owned calls and artifacts", async () => {
  const fixture = createSqlFixture({ "CA-OWNED": 1, "CA-OTHER": 2 });

  const deleted = await deleteWorkspaceCalls(
    fixture.sql,
    1,
    ["CA-OWNED", "CA-OTHER", "CA-OWNED"],
  );

  assert.deepEqual(deleted, ["CA-OWNED"]);
  assert.deepEqual(fixture.childDeletes, [
    ["CA-OWNED"],
    ["CA-OWNED"],
    ["CA-OWNED"],
  ]);
  assert.equal(fixture.state.calls.has("CA-OWNED"), false);
  assert.equal(fixture.state.messages.has("CA-OWNED"), false);
  assert.equal(fixture.state.events.has("CA-OWNED"), false);
  assert.equal(fixture.state.summaries.has("CA-OWNED"), false);
  assert.equal(fixture.state.calls.get("CA-OTHER"), 2);
  assert.equal(fixture.state.messages.has("CA-OTHER"), true);
  assert.equal(fixture.state.events.has("CA-OTHER"), true);
  assert.equal(fixture.state.summaries.has("CA-OTHER"), true);
});
