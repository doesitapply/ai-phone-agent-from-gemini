export type OperatorScoreInputs = {
  calls: number;
  completedCalls: number;
  summarizedCalls: number;
  tasks: number;
  completedTasks: number;
  handoffs: number;
  clearedHandoffs: number;
};

export type OperatorMissionControlMetrics = {
  workspaces: { total: number; active: number };
  calls: { last7d: number; previous7d: number; completed7d: number; summarized7d: number };
  contacts: { new7d: number };
  tasks: { created7d: number; completed7d: number; open: number; overdue: number };
  handoffs: { created7d: number; cleared7d: number; pending: number };
  appointments: { created7d: number; upcoming: number };
  provisioning: { needsAttention: number };
};

export type OperatorScoreComponent = {
  id: "call_completion" | "intelligence_coverage" | "follow_up_clearance" | "handoff_clearance";
  label: string;
  score: number;
  weight: number;
  detail: string;
};

const boundedPercent = (numerator: number, denominator: number) => {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((numerator / denominator) * 100)));
};

export function calculateOperatorScoreboard(input: OperatorScoreInputs) {
  const components: OperatorScoreComponent[] = [
    {
      id: "call_completion",
      label: "Call completion",
      score: boundedPercent(input.completedCalls, input.calls),
      weight: 30,
      detail: `${input.completedCalls} of ${input.calls} calls completed`,
    },
    {
      id: "intelligence_coverage",
      label: "Intelligence coverage",
      score: boundedPercent(input.summarizedCalls, input.completedCalls),
      weight: 25,
      detail: `${input.summarizedCalls} of ${input.completedCalls} completed calls summarized`,
    },
    {
      id: "follow_up_clearance",
      label: "Follow-up clearance",
      score: boundedPercent(input.completedTasks, input.tasks),
      weight: 25,
      detail: `${input.completedTasks} of ${input.tasks} follow-up tasks cleared`,
    },
    {
      id: "handoff_clearance",
      label: "Handoff clearance",
      score: boundedPercent(input.clearedHandoffs, input.handoffs),
      weight: 20,
      detail: `${input.clearedHandoffs} of ${input.handoffs} human handoffs cleared`,
    },
  ];

  const activity = input.calls + input.tasks + input.handoffs;
  const overall = activity === 0
    ? 0
    : Math.round(components.reduce((sum, component) => sum + (component.score * component.weight) / 100, 0));
  const grade = overall >= 90 ? "A" : overall >= 80 ? "B" : overall >= 70 ? "C" : overall >= 60 ? "D" : "F";

  return { overall, grade, activity, components };
}
