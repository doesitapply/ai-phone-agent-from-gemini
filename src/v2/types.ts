export type NavPage = "today" | "calls" | "tasks" | "knowledge" | "settings" | "admin";

export type Stats = {
  totalCalls?: number;
  todayCalls?: number;
  weekCalls?: number;
  openTasks?: number;
  callbackTasks?: number;
  pendingHandoffs?: number;
};

export type CallRecord = {
  id?: number;
  call_sid?: string;
  from_number?: string;
  to_number?: string;
  direction?: string;
  status?: string;
  started_at?: string;
  ended_at?: string;
  duration_seconds?: number;
  summary?: string;
  intent?: string;
  outcome?: string;
  transcript?: string;
};

export type TaskRecord = {
  id: number;
  task_type?: string;
  status?: string;
  notes?: string;
  assigned_to?: string;
  due_at?: string;
  created_at?: string;
  call_sid?: string;
};

export type HandoffRecord = {
  id: number;
  call_sid?: string;
  reason?: string;
  urgency?: string;
  recommended_action?: string;
  status?: string;
  created_at?: string;
  transcript_snippet?: string;
};

export type Workspace = {
  id: number;
  name?: string;
  plan?: string;
  business_name?: string;
  business_tagline?: string;
  business_phone?: string;
  business_website?: string;
  service_area?: string;
  business_hours?: string;
  owner_phone?: string;
  notification_email?: string;
  inbound_greeting?: string;
  agent_name?: string;
  mode?: string;
};
