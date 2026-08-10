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
  workspacesTotal: number;
  workspacesActive: number;
  calls7d: number;
  callsPrevious7d: number;
  completedCalls7d: number;
  summarizedCalls7d: number;
  contacts7d: number;
  tasks7d: number;
  completedTasks7d: number;
  openTasks: number;
  overdueTasks: number;
  handoffs7d: number;
  clearedHandoffs7d: number;
  pendingHandoffs: number;
  appointments7d: number;
  upcomingAppointments: number;
  provisioningAttention: number;
};

export type OperatorScoreComponent = {
  id: "call_completion" | "intelligence_coverage" | "follow_up_clearance" | "handoff_clearance";
  label: string;
  score: number | null;
  weight: number;
  detail: string;
  applicable: boolean;
};

const boundedPercent = (numerator: number, denominator: number): number | null => {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((numerator / denominator) * 100)));
};

export function calculateOperatorScoreboard(input: OperatorScoreInputs) {
  const components: OperatorScoreComponent[] = [
    {
      id: "call_completion",
      label: "Call completion",
      score: boundedPercent(input.completedCalls, input.calls),
      weight: 30,
      detail: input.calls > 0 ? `${input.completedCalls} of ${input.calls} calls completed` : "No calls in this window",
      applicable: input.calls > 0,
    },
    {
      id: "intelligence_coverage",
      label: "Intelligence coverage",
      score: boundedPercent(input.summarizedCalls, input.completedCalls),
      weight: 25,
      detail: input.completedCalls > 0
        ? `${input.summarizedCalls} of ${input.completedCalls} completed calls summarized`
        : "No completed calls in this window",
      applicable: input.completedCalls > 0,
    },
    {
      id: "follow_up_clearance",
      label: "New-task disposition",
      score: boundedPercent(input.completedTasks, input.tasks),
      weight: 25,
      detail: input.tasks > 0
        ? `${input.completedTasks} of ${input.tasks} tasks created this window are now cleared`
        : "No tasks created in this window",
      applicable: input.tasks > 0,
    },
    {
      id: "handoff_clearance",
      label: "New-handoff disposition",
      score: boundedPercent(input.clearedHandoffs, input.handoffs),
      weight: 20,
      detail: input.handoffs > 0
        ? `${input.clearedHandoffs} of ${input.handoffs} handoffs created this window are now cleared or transferred`
        : "No handoffs created in this window",
      applicable: input.handoffs > 0,
    },
  ];

  const activity = input.calls + input.tasks + input.handoffs;
  const applicable = components.filter((component) => component.applicable && component.score !== null);
  const applicableWeight = applicable.reduce((sum, component) => sum + component.weight, 0);
  const overall = applicableWeight === 0
    ? null
    : Math.round(applicable.reduce((sum, component) => sum + Number(component.score) * component.weight, 0) / applicableWeight);
  const grade = overall === null
    ? "N/A"
    : overall >= 90 ? "A" : overall >= 80 ? "B" : overall >= 70 ? "C" : overall >= 60 ? "D" : "F";

  return { overall, grade, activity, components, applicableWeight };
}
