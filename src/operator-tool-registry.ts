export type OperatorToolSafety = "read" | "write" | "destructive" | "bulk_destructive";

type GeminiTypeEnum = {
  OBJECT: unknown;
  STRING: unknown;
  NUMBER: unknown;
};

export type OperatorToolDefinition = {
  name: string;
  safety: OperatorToolSafety;
  description: string;
  required?: string[];
  properties: Record<string, { type: "string" | "number"; description: string }>;
};

export const OPERATOR_TOOL_DEFINITIONS: OperatorToolDefinition[] = [
  {
    name: "list_workspace_tasks",
    safety: "read",
    description: "List tasks across the entire workspace, not just the current caller.",
    properties: {
      status: { type: "string", description: "Task status: open, in_progress, completed, or cancelled. Defaults to open." },
      limit: { type: "number", description: "Maximum number of tasks to return. Defaults to 20, max 50." },
    },
  },
  {
    name: "create_workspace_task",
    safety: "write",
    description: "Create a task for the workspace from an owner/operator instruction.",
    required: ["title"],
    properties: {
      title: { type: "string", description: "Short task title" },
      notes: { type: "string", description: "Task details or context" },
      assigned_to: { type: "string", description: "Person or team to assign" },
      due_at: { type: "string", description: "Due date/time in ISO 8601 format when provided" },
      priority: { type: "string", description: "Priority: low, medium, high, or urgent" },
      task_type: { type: "string", description: "Task category. Defaults to operator_task." },
    },
  },
  {
    name: "update_workspace_task",
    safety: "write",
    description: "Update, transfer, cancel, or complete a workspace task by ID. Use assigned_to to transfer/reassign a task.",
    required: ["task_id"],
    properties: {
      task_id: { type: "number", description: "Numeric task ID" },
      title: { type: "string", description: "New title" },
      status: { type: "string", description: "New status: open, in_progress, completed, or cancelled" },
      notes: { type: "string", description: "Updated notes" },
      assigned_to: { type: "string", description: "New assignee" },
      due_at: { type: "string", description: "New due date/time in ISO 8601 format" },
    },
  },
  {
    name: "delete_workspace_task",
    safety: "destructive",
    description: "Permanently delete one workspace task by ID. Use only when the owner/operator explicitly says delete or remove that specific task.",
    required: ["task_id"],
    properties: {
      task_id: { type: "number", description: "Numeric task ID to delete" },
      reason: { type: "string", description: "Optional reason for audit logging" },
    },
  },
  {
    name: "complete_all_open_workspace_tasks",
    safety: "bulk_destructive",
    description: "Bulk complete every open or in-progress task in the workspace, optionally limited to one assignee.",
    properties: {
      resolution_notes: { type: "string", description: "Why the tasks were completed" },
      assigned_to: { type: "string", description: "Optional assignee filter" },
    },
  },
  {
    name: "list_handoff_targets",
    safety: "read",
    description: "List active/on-call team members who can receive a handoff or transfer.",
    properties: {
      topic: { type: "string", description: "Optional handoff topic, such as billing, sales, support, legal, or emergency" },
    },
  },
];

export const OPERATOR_TOOL_NAMES = new Set(OPERATOR_TOOL_DEFINITIONS.map((tool) => tool.name));

export function getOperatorToolSafety(name: string): OperatorToolSafety | null {
  return OPERATOR_TOOL_DEFINITIONS.find((tool) => tool.name === name)?.safety ?? null;
}

export function buildOperatorGeminiDeclarations(Type: GeminiTypeEnum): Array<Record<string, unknown>> {
  return OPERATOR_TOOL_DEFINITIONS.map((tool) => ({
    name: tool.name,
    description: `Operator-only. ${tool.description}`,
    parameters: {
      type: Type.OBJECT,
      properties: Object.fromEntries(
        Object.entries(tool.properties).map(([key, value]) => [
          key,
          {
            type: value.type === "number" ? Type.NUMBER : Type.STRING,
            description: value.description,
          },
        ])
      ),
      required: tool.required || [],
    },
  }));
}

export function buildOperatorOpenAiTools(): Array<Record<string, unknown>> {
  return OPERATOR_TOOL_DEFINITIONS.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: `Operator-only. ${tool.description} Safety: ${tool.safety}.`,
      parameters: {
        type: "object",
        properties: Object.fromEntries(
          Object.entries(tool.properties).map(([key, value]) => [
            key,
            {
              type: value.type,
              description: value.description,
            },
          ])
        ),
        required: tool.required || [],
      },
    },
  }));
}
