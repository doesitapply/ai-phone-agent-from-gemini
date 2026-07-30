import { z } from "zod";

export const MINIMUM_VARIANT_SAMPLE = 10;

export const learningOutcomeSchema = z.enum([
  "delivered",
  "bounced",
  "replied",
  "qualified",
  "demo_booked",
  "converted",
  "not_interested",
  "dnc",
  "call_connected",
  "voicemail",
  "no_answer",
  "failed",
]);

export type LearningObservation = {
  outreachJobId: string;
  channel: "email" | "call";
  variantKey: string;
  outcome: z.infer<typeof learningOutcomeSchema>;
  occurredAt: string;
};

export type VariantScore = {
  channel: "email" | "call";
  variantKey: string;
  sampleSize: number;
  eventCount: number;
  positive: number;
  positiveRate: number;
  outcomes: Record<string, number>;
};

function stableRate(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function isPositive(observation: LearningObservation): boolean {
  if (observation.channel === "email") {
    return ["replied", "qualified", "demo_booked", "converted"].includes(
      observation.outcome
    );
  }
  return [
    "call_connected",
    "qualified",
    "demo_booked",
    "converted",
  ].includes(observation.outcome);
}

const OUTCOME_STAGE: Record<LearningObservation["outcome"], number> = {
  delivered: 1,
  bounced: 1,
  voicemail: 1,
  no_answer: 1,
  failed: 1,
  replied: 2,
  call_connected: 2,
  qualified: 3,
  demo_booked: 3,
  converted: 3,
  not_interested: 3,
  dnc: 3,
};

const OUTCOME_TIE_BREAKER: LearningObservation["outcome"][] = [
  "failed",
  "delivered",
  "voicemail",
  "no_answer",
  "bounced",
  "replied",
  "call_connected",
  "qualified",
  "demo_booked",
  "converted",
  "not_interested",
  "dnc",
];

function occurredAtMs(observation: LearningObservation): number {
  const value = new Date(observation.occurredAt).getTime();
  if (!Number.isFinite(value)) {
    throw new Error(
      `Learning observation ${observation.outreachJobId} has an invalid occurrence time.`
    );
  }
  return value;
}

function selectCanonicalOutcome(
  current: LearningObservation,
  candidate: LearningObservation
): LearningObservation {
  const currentStage = OUTCOME_STAGE[current.outcome];
  const candidateStage = OUTCOME_STAGE[candidate.outcome];
  if (candidateStage !== currentStage) {
    return candidateStage > currentStage ? candidate : current;
  }

  const currentTime = occurredAtMs(current);
  const candidateTime = occurredAtMs(candidate);
  if (candidateTime !== currentTime) {
    return candidateTime > currentTime ? candidate : current;
  }

  return OUTCOME_TIE_BREAKER.indexOf(candidate.outcome) >
    OUTCOME_TIE_BREAKER.indexOf(current.outcome)
    ? candidate
    : current;
}

function canonicalizeLearningObservations(
  observations: LearningObservation[]
): Array<LearningObservation & { eventCount: number }> {
  const jobs = new Map<
    string,
    { canonical: LearningObservation; eventCount: number }
  >();

  for (const observation of observations) {
    const outreachJobId = String(observation.outreachJobId || "").trim();
    if (!outreachJobId) {
      throw new Error("Learning observations require an outreach job ID.");
    }
    occurredAtMs(observation);
    const existing = jobs.get(outreachJobId);
    if (!existing) {
      jobs.set(outreachJobId, {
        canonical: { ...observation, outreachJobId },
        eventCount: 1,
      });
      continue;
    }
    if (
      existing.canonical.channel !== observation.channel ||
      existing.canonical.variantKey !== observation.variantKey
    ) {
      throw new Error(
        `Learning observation ${outreachJobId} changed channel or strategy attribution.`
      );
    }
    existing.canonical = selectCanonicalOutcome(
      existing.canonical,
      observation
    );
    existing.eventCount += 1;
  }

  return Array.from(jobs.values()).map(({ canonical, eventCount }) => ({
    ...canonical,
    eventCount,
  }));
}

export function buildProspectLearningScorecard(
  observations: LearningObservation[]
): VariantScore[] {
  const buckets = new Map<string, VariantScore>();
  for (const observation of canonicalizeLearningObservations(observations)) {
    const key = `${observation.channel}:${observation.variantKey}`;
    const bucket =
      buckets.get(key) ||
      ({
        channel: observation.channel,
        variantKey: observation.variantKey,
        sampleSize: 0,
        eventCount: 0,
        positive: 0,
        positiveRate: 0,
        outcomes: {},
      } satisfies VariantScore);
    bucket.sampleSize += 1;
    bucket.eventCount += observation.eventCount;
    if (isPositive(observation)) bucket.positive += 1;
    bucket.outcomes[observation.outcome] =
      (bucket.outcomes[observation.outcome] || 0) + 1;
    bucket.positiveRate = stableRate(bucket.positive / bucket.sampleSize);
    buckets.set(key, bucket);
  }
  return Array.from(buckets.values()).sort(
    (a, b) =>
      a.channel.localeCompare(b.channel) ||
      b.positiveRate - a.positiveRate ||
      a.variantKey.localeCompare(b.variantKey)
  );
}

export function evaluateProspectLearningCandidate(input: {
  channel: "email" | "call";
  currentVariant: string;
  challengerVariant: string;
  observations: LearningObservation[];
}):
  | {
      ready: true;
      sampleSize: number;
      proposal: {
        channel: "email" | "call";
        promoteVariant: string;
        replaceVariant: string;
      };
      evidence: {
        current: VariantScore;
        challenger: VariantScore;
        absoluteLift: number;
      };
    }
  | {
      ready: false;
      code: "INSUFFICIENT_SAMPLE" | "NO_MEASURED_LIFT";
      sampleSize: number;
    } {
  const scorecard = buildProspectLearningScorecard(
    input.observations.filter(
      (event) =>
        event.channel === input.channel &&
        [input.currentVariant, input.challengerVariant].includes(
          event.variantKey
        )
    )
  );
  const current = scorecard.find(
    (score) => score.variantKey === input.currentVariant
  );
  const challenger = scorecard.find(
    (score) => score.variantKey === input.challengerVariant
  );
  const sampleSize =
    (current?.sampleSize || 0) + (challenger?.sampleSize || 0);
  if (
    !current ||
    !challenger ||
    current.sampleSize < MINIMUM_VARIANT_SAMPLE ||
    challenger.sampleSize < MINIMUM_VARIANT_SAMPLE
  ) {
    return { ready: false, code: "INSUFFICIENT_SAMPLE", sampleSize };
  }
  const absoluteLift = stableRate(
    challenger.positiveRate - current.positiveRate
  );
  if (absoluteLift <= 0) {
    return { ready: false, code: "NO_MEASURED_LIFT", sampleSize };
  }
  return {
    ready: true,
    sampleSize,
    proposal: {
      channel: input.channel,
      promoteVariant: input.challengerVariant,
      replaceVariant: input.currentVariant,
    },
    evidence: {
      current,
      challenger,
      absoluteLift,
    },
  };
}
