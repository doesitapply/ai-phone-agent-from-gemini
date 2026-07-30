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
  channel: "email" | "call";
  variantKey: string;
  outcome: z.infer<typeof learningOutcomeSchema>;
};

export type VariantScore = {
  channel: "email" | "call";
  variantKey: string;
  sampleSize: number;
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

export function buildProspectLearningScorecard(
  observations: LearningObservation[]
): VariantScore[] {
  const buckets = new Map<string, VariantScore>();
  for (const observation of observations) {
    const key = `${observation.channel}:${observation.variantKey}`;
    const bucket =
      buckets.get(key) ||
      ({
        channel: observation.channel,
        variantKey: observation.variantKey,
        sampleSize: 0,
        positive: 0,
        positiveRate: 0,
        outcomes: {},
      } satisfies VariantScore);
    bucket.sampleSize += 1;
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
