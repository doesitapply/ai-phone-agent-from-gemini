import { z } from "zod";

export const MINIMUM_VARIANT_SAMPLE = 10;
export const PROSPECT_LEARNING_STATISTICAL_TEST =
  "fisher-exact-one-sided-v1" as const;
export const MAXIMUM_ONE_SIDED_FISHER_P_VALUE = 0.05;

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

function stableProbability(value: number): number {
  return Math.ceil(value * 1_000_000) / 1_000_000;
}

function combination(n: number, k: number): number {
  if (
    !Number.isSafeInteger(n) ||
    !Number.isSafeInteger(k) ||
    n < 0 ||
    k < 0 ||
    k > n
  ) {
    return 0;
  }
  const selected = Math.min(k, n - k);
  let result = 1;
  for (let index = 1; index <= selected; index += 1) {
    result = (result * (n - selected + index)) / index;
  }
  return result;
}

export function calculateOneSidedFisherExactPValue(input: {
  currentPositive: number;
  currentSampleSize: number;
  challengerPositive: number;
  challengerSampleSize: number;
}): number {
  const values = [
    input.currentPositive,
    input.currentSampleSize,
    input.challengerPositive,
    input.challengerSampleSize,
  ];
  if (
    values.some(value => !Number.isSafeInteger(value) || value < 0) ||
    input.currentPositive > input.currentSampleSize ||
    input.challengerPositive > input.challengerSampleSize ||
    input.currentSampleSize + input.challengerSampleSize === 0
  ) {
    throw new Error("Fisher exact inputs must be valid binary counts.");
  }
  const totalSampleSize =
    input.currentSampleSize + input.challengerSampleSize;
  const totalPositive =
    input.currentPositive + input.challengerPositive;
  const denominator = combination(totalSampleSize, totalPositive);
  if (!Number.isFinite(denominator) || denominator <= 0) {
    throw new Error("Fisher exact probability could not be calculated.");
  }
  const maximumChallengerPositive = Math.min(
    input.challengerSampleSize,
    totalPositive
  );
  let probability = 0;
  for (
    let challengerPositive = input.challengerPositive;
    challengerPositive <= maximumChallengerPositive;
    challengerPositive += 1
  ) {
    const currentPositive = totalPositive - challengerPositive;
    if (
      currentPositive < 0 ||
      currentPositive > input.currentSampleSize
    ) {
      continue;
    }
    probability +=
      (combination(
        input.challengerSampleSize,
        challengerPositive
      ) *
        combination(input.currentSampleSize, currentPositive)) /
      denominator;
  }
  return stableProbability(Math.min(1, Math.max(0, probability)));
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
        statisticalTest: typeof PROSPECT_LEARNING_STATISTICAL_TEST;
        oneSidedFisherPValue: number;
        maximumOneSidedFisherPValue:
          typeof MAXIMUM_ONE_SIDED_FISHER_P_VALUE;
      };
    }
  | {
      ready: false;
      code:
        | "INSUFFICIENT_SAMPLE"
        | "NO_MEASURED_LIFT"
        | "INSUFFICIENT_CONFIDENCE";
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
  const oneSidedFisherPValue =
    calculateOneSidedFisherExactPValue({
      currentPositive: current.positive,
      currentSampleSize: current.sampleSize,
      challengerPositive: challenger.positive,
      challengerSampleSize: challenger.sampleSize,
    });
  if (
    oneSidedFisherPValue > MAXIMUM_ONE_SIDED_FISHER_P_VALUE
  ) {
    return {
      ready: false,
      code: "INSUFFICIENT_CONFIDENCE",
      sampleSize,
    };
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
      statisticalTest: PROSPECT_LEARNING_STATISTICAL_TEST,
      oneSidedFisherPValue,
      maximumOneSidedFisherPValue:
        MAXIMUM_ONE_SIDED_FISHER_P_VALUE,
    },
  };
}
