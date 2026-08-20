#!/usr/bin/env node
import { readFileSync } from "node:fs";

const files = {
  chat: readFileSync("src/smirk-chat.ts", "utf8"),
  policy: readFileSync("src/smirk-chat-policy.ts", "utf8"),
  provider: readFileSync("src/smirk-chat-provider.ts", "utf8"),
  routes: readFileSync("src/routes/lead-routes.ts", "utf8"),
  app: readFileSync("src/App.tsx", "utf8"),
  settings: readFileSync("src/settings.ts", "utf8"),
};

const failures = [];
const expect = (label, condition) => {
  if (!condition) failures.push(label);
};

expect(
  "OpenRouter is attempted before Gemini",
  files.chat.indexOf('name: "openrouter"') >= 0 &&
    files.chat.indexOf('name: "openrouter"') <
      files.chat.indexOf('name: "gemini"')
);
expect(
  "provider failover stops after a tool execution attempt",
  files.chat.includes(
    "canFailover: () => toolExecutionAttempts === 0"
  )
);
expect(
  "workspace provider auth failure is fail closed",
  files.chat.includes(
    "stopOnAuthenticationFailure:"
  )
);
expect(
  "raw provider response bodies are not propagated",
  files.chat.includes(
    "throw new Error(`OpenRouter HTTP ${response.status}`)"
  ) &&
    !files.chat.includes("await response.text()")
);
expect(
  "public provider error is stable",
  files.provider.includes(
    '"SMIRK chat is temporarily unavailable. Check AI provider status and billing, then try again."'
  )
);
expect(
  "provider-unavailable route returns 503",
  files.routes.includes(
    "isSmirkChatProviderUnavailableError(err)"
  ) &&
    files.routes.includes("return res.status(503).json({")
);
expect(
  "chat request input is bounded",
  files.routes.includes("validateChatRequestMessages") &&
    files.policy.includes("CHAT_REQUEST_MAX_TOTAL_CHARS")
);
expect(
  "operator tool execution uses a shared fail-closed allowlist",
  files.chat.includes(
    "isChatToolAllowed(input.accessMode, input.name)"
  ) &&
    files.policy.includes("CHAT_GUARDED_WORKFLOW_TOOLS")
);
expect(
  "settings inspection exposes configuration status through a value allowlist",
  files.chat.includes("const valueAllowlist = new Set([") &&
    files.chat.includes("configured: Boolean(String(v || \"\").trim())") &&
    !files.chat.includes('safe[k] = k.toUpperCase().includes("API_KEY")')
);
for (const guardedTool of [
  "make_call",
  "book_appointment",
  "update_setting",
  "update_agent_prompt",
  "inject_briefing",
]) {
  expect(
    `${guardedTool} remains in the guarded-workflow list`,
    files.policy.includes(`"${guardedTool}"`)
  );
}
for (const forbiddenExecutionPath of [
  'from "twilio"',
  "api.resend.com/emails",
  "insertCalendarEvent",
  "writeEnvFile",
  'if (name === "make_call")',
  'if (name === "book_appointment")',
  'if (name === "update_setting")',
  'if (name === "update_agent_prompt")',
  'if (name === "inject_briefing")',
]) {
  expect(
    `chat source excludes guarded execution path ${forbiddenExecutionPath}`,
    !files.chat.includes(forbiddenExecutionPath)
  );
}
expect(
  "contact lookup is workspace scoped",
  files.chat.includes(
    "WHERE workspace_id = ${workspaceId}\n        AND phone_number = ${args.phone_number}"
  )
);
expect(
  "contact creation writes workspace identity",
  files.chat.includes(
    "INSERT INTO contacts (workspace_id, phone_number, name, email, business_name, notes)"
  )
);
expect(
  "contact mutation requires workspace identity and reports changed rows",
  files.chat.includes(
    "AND workspace_id = ${workspaceId}\n      RETURNING id"
  ) &&
    files.chat.includes("CONTACT_NOT_FOUND_OR_FORBIDDEN")
);
expect(
  "task mutation reports a missing or forbidden row",
  files.chat.includes("TASK_NOT_FOUND_OR_FORBIDDEN")
);
expect(
  "chat UI does not claim an unverified online state",
  !files.app.includes(">● Online</div>") &&
    files.app.includes("Provider check needed")
);
expect(
  "configuration readiness accepts enabled OpenRouter or Gemini instead of requiring Gemini",
  files.settings.includes(
    '"AI provider (enabled OpenRouter or Gemini)"'
  ) &&
    files.settings.includes(
      'raw.OPENROUTER_ENABLED === "true"'
    ) &&
    files.settings.includes("raw.GEMINI_API_KEY") &&
    !files.settings.includes(
      'label: "AI Brain (Gemini)",\n    description: "Use Google Gemini directly as the AI brain (no OpenRouter required)",\n    required: true'
    )
);

if (failures.length > 0) {
  console.error("FAIL SMIRK chat safety contract");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  "PASS SMIRK chat safety contract (provider failover, bounded input, guarded actions, tenant scope)"
);
