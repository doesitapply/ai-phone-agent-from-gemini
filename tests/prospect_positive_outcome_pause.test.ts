import assert from "node:assert/strict";
import test from "node:test";
import type { Request, Response } from "express";
import {
  PROSPECT_ACQUISITION_PAUSED_CODE,
  PROSPECT_ACQUISITION_LOCK_NAMESPACE,
  ProspectAcquisitionPausedError,
  assertProspectAcquisitionMutationUnpaused,
  assertProspectAcquisitionUnpaused,
  countPendingProspectPositiveOutcomeReviews,
  createProspectAcquisitionUnpausedGuard,
} from "../src/prospect-positive-outcome-pause.ts";

function sqlWithCount(value: number | string) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const sql: any = async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    calls.push({
      text: strings.join(" ").replace(/\s+/g, " ").trim(),
      values,
    });
    return [{ pending_count: value }];
  };
  return { sql, calls };
}

function makeResponse() {
  const state = {
    status: 200,
    body: undefined as any,
  };
  const response = {
    status(status: number) {
      state.status = status;
      return response;
    },
    json(body: unknown) {
      state.body = body;
      return response;
    },
  };
  return {
    response: response as unknown as Response,
    state,
  };
}

test("zero pending interactions permits the next guarded route", async () => {
  const setup = sqlWithCount(0);
  const guard = createProspectAcquisitionUnpausedGuard({
    sql: setup.sql,
    dbEnabled: true,
    getWorkspaceId: () => 7,
  });
  const { response, state } = makeResponse();
  let nextCalls = 0;
  await guard(
    {} as Request,
    response,
    () => {
      nextCalls += 1;
    }
  );
  assert.equal(nextCalls, 1);
  assert.equal(state.body, undefined);
  assert.equal(setup.calls.length, 1);
  assert.deepEqual(setup.calls[0].values, [7]);
});

test("a pending interaction blocks contact, acquisition, and learning", async () => {
  const setup = sqlWithCount("2");
  const guard = createProspectAcquisitionUnpausedGuard({
    sql: setup.sql,
    dbEnabled: true,
    getWorkspaceId: () => 11,
  });
  const { response, state } = makeResponse();
  let nextCalls = 0;
  await guard(
    {} as Request,
    response,
    () => {
      nextCalls += 1;
    }
  );
  assert.equal(nextCalls, 0);
  assert.equal(state.status, 409);
  assert.equal(state.body.code, PROSPECT_ACQUISITION_PAUSED_CODE);
  assert.equal(state.body.pendingPositiveOutcomeReviews, 2);
  assert.deepEqual(state.body.controls, {
    contactAuthorized: false,
    executionAuthorized: false,
    spendAuthorized: false,
    policyMutationAuthorized: false,
    providerRequestAuthorized: false,
  });
  assert.equal(state.body.externalAction, "none");
});

test("storage failure fails closed instead of silently resuming", async () => {
  const sql: any = async () => {
    throw new Error("synthetic storage failure");
  };
  const guard = createProspectAcquisitionUnpausedGuard({
    sql,
    dbEnabled: true,
    getWorkspaceId: () => 1,
  });
  const { response, state } = makeResponse();
  let nextCalls = 0;
  await guard(
    {} as Request,
    response,
    () => {
      nextCalls += 1;
    }
  );
  assert.equal(nextCalls, 0);
  assert.equal(state.status, 503);
  assert.equal(
    state.body.code,
    "PROSPECT_ACQUISITION_PAUSE_UNAVAILABLE"
  );
  assert.equal(state.body.externalAction, "none");
});

test("the count and assertion reject corrupt or positive pause state", async () => {
  const corrupt = sqlWithCount("not-a-count");
  await assert.rejects(
    countPendingProspectPositiveOutcomeReviews(
      corrupt.sql,
      1
    ),
    /pause count is unavailable/
  );

  const pending = sqlWithCount(1);
  await assert.rejects(
    assertProspectAcquisitionUnpaused(pending.sql, 1),
    (error: unknown) =>
      error instanceof ProspectAcquisitionPausedError &&
      error.pendingCount === 1 &&
      error.code === PROSPECT_ACQUISITION_PAUSED_CODE
  );
});

test("mutation checks take the workspace lock before reading pause state", async () => {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const sql: any = async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const text = strings.join(" ").replace(/\s+/g, " ").trim();
    calls.push({ text, values });
    if (text.includes("pg_advisory_xact_lock")) {
      return [{ pg_advisory_xact_lock: null }];
    }
    if (
      text.includes("FROM prospect_positive_outcome_reviews")
    ) {
      return [{ pending_count: 0 }];
    }
    throw new Error(`Unexpected SQL: ${text}`);
  };

  await assertProspectAcquisitionMutationUnpaused(sql, 7);
  assert.equal(calls.length, 2);
  assert.match(calls[0].text, /pg_advisory_xact_lock/);
  assert.deepEqual(calls[0].values, [
    PROSPECT_ACQUISITION_LOCK_NAMESPACE,
    7,
  ]);
  assert.match(
    calls[1].text,
    /FROM prospect_positive_outcome_reviews/
  );

  await assert.rejects(
    assertProspectAcquisitionMutationUnpaused(sql, 0),
    /valid workspace/
  );
  assert.equal(calls.length, 2);
});
