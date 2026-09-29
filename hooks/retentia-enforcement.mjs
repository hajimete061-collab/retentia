#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const STATE_DIR =
  process.env.RETENTIA_HOOK_STATE_DIR || join(homedir(), ".retentia", "hooks", "state");
const ACTIVE_TURN_DIR = join(STATE_DIR, "active-turns");
const RETENTIA_READ_MARKERS = [
  "memory_search",
  "memory_context",
  "dashboard_snapshot",
];
const RETENTIA_WRITE_MARKERS = ["memory_add", "agent_event"];
const TOOL_DISCOVERY_MARKERS = ["tool_search", "tools_search"];
const RETENTIA_REPAIR_MARKERS = [
  "diagnos",
  "repair",
  "restore",
  "fix",
  "broken",
  "fail",
  "unavailable",
  "connectivity",
  "connection",
  "transport",
  "transporter",
  "config",
  "mcp",
  "fallisce",
  "falliscono",
  "rotto",
  "ripara",
  "ripristina",
  "connettiv",
];
const RETENTIA_POLICY_MESSAGE =
  "Retentia is non-blocking telemetry and project memory. Inspect or write Retentia when appropriate, then immediately continue the active task. Retentia reads, writes, checkpoints, and availability never block tools, stop work, or create a completion boundary. If Retentia is unavailable, continue the task and report the telemetry failure only in the final response. Return control only when the complete task is done or a genuine project blocker requires user input.";

function readPayload() {
  try {
    const raw = readFileSync(0, "utf8").trim();
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function output(payload) {
  process.stdout.write(JSON.stringify(payload));
}

function hash(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 16);
}

function cleanToken(value, fallback) {
  const raw = String(value || fallback || "unknown").trim() || fallback || "unknown";
  const cleaned = raw.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 96);
  return cleaned || fallback || "unknown";
}

function sessionKey(payload) {
  const raw =
    payload.session_id ||
    payload.sessionId ||
    payload.transcript_path ||
    payload.cwd ||
    "unknown-session";
  return cleanToken(raw, "unknown-session") + "-" + hash(raw);
}

function incomingTurnId(payload) {
  return (
    payload.turn_id ||
    payload.turnId ||
    payload.request_id ||
    payload.requestId ||
    payload.message_id ||
    payload.messageId ||
    ""
  );
}

function activeTurnPath(session) {
  return join(ACTIVE_TURN_DIR, session + ".json");
}

function readJsonFile(path, fallback) {
  try {
    if (!existsSync(path)) {
      return fallback;
    }
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonFile(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = path + ".tmp";
  writeFileSync(tempPath, JSON.stringify(value));
  renameSync(tempPath, path);
}

function startTurn(payload) {
  const session = sessionKey(payload);
  const rawTurn =
    incomingTurnId(payload) ||
    Date.now() + "-" + hash(payload.prompt || JSON.stringify(payload));
  const turn = cleanToken(rawTurn, "unknown-turn");
  writeJsonFile(activeTurnPath(session), { turn });
  return { session, turn };
}

function resolveTurn(payload) {
  const session = sessionKey(payload);
  const directTurn = incomingTurnId(payload);
  if (directTurn) {
    return { session, turn: cleanToken(directTurn, "unknown-turn") };
  }

  const active = readJsonFile(activeTurnPath(session), {});
  return {
    session,
    turn: cleanToken(active.turn || "unknown-turn", "unknown-turn"),
  };
}

function statePath(payload) {
  const { session, turn } = resolveTurn(payload);
  return turnStatePath(session, turn);
}

function turnStatePath(session, turn) {
  return join(STATE_DIR, session + "__" + turn + ".json");
}

function defaultState() {
  return {
    retentiaInspected: false,
    retentiaUpdated: false,
    pendingUpdate: false,
    substantiveToolUsed: false,
    retentiaRepairTask: false,
  };
}

function loadState(path) {
  return { ...defaultState(), ...readJsonFile(path, defaultState()) };
}

function saveState(path, state) {
  writeJsonFile(path, state);
}

function textFromPayload(payload) {
  const direct = [
    payload.prompt,
    payload.message,
    payload.input,
    payload.text,
    payload.user_prompt,
    payload.userPrompt,
  ]
    .filter((value) => typeof value === "string")
    .join(" ");

  if (direct.trim()) {
    return direct;
  }

  try {
    return JSON.stringify(payload).slice(0, 8000);
  } catch {
    return "";
  }
}

function isRetentiaRepairTask(payload) {
  const text = textFromPayload(payload).toLowerCase();
  return (
    text.includes("retentia") &&
    RETENTIA_REPAIR_MARKERS.some((marker) => text.includes(marker))
  );
}

function cleanupState(payload, path) {
  try {
    unlinkSync(path);
  } catch {}

  const { session, turn } = resolveTurn(payload);
  const activePath = activeTurnPath(session);
  const active = readJsonFile(activePath, {});
  if (active.turn === turn) {
    try {
      unlinkSync(activePath);
    } catch {}
  }
}

function isRetentiaTool(toolName) {
  const normalized = String(toolName || "").toLowerCase();
  return (
    normalized.startsWith("mcp__retentia__") ||
    normalized.includes("retentia")
  );
}

function isRetentiaRead(toolName) {
  const normalized = String(toolName || "").toLowerCase();
  return (
    isRetentiaTool(normalized) &&
    RETENTIA_READ_MARKERS.some((marker) => normalized.includes(marker))
  );
}

function isRetentiaWrite(toolName) {
  const normalized = String(toolName || "").toLowerCase();
  return (
    isRetentiaTool(normalized) &&
    RETENTIA_WRITE_MARKERS.some((marker) => normalized.includes(marker))
  );
}

function isToolDiscoveryTool(toolName) {
  const normalized = String(toolName || "").toLowerCase();
  return TOOL_DISCOVERY_MARKERS.some((marker) => normalized.includes(marker));
}

function isSubstantiveTool(toolName) {
  return (
    Boolean(toolName) &&
    !isRetentiaTool(toolName) &&
    !isToolDiscoveryTool(toolName)
  );
}

function userPromptSubmit(payload) {
  const { session, turn } = startTurn(payload);
  const path = turnStatePath(session, turn);
  const state = loadState(path);
  state.retentiaRepairTask = isRetentiaRepairTask(payload);
  saveState(path, state);

  output({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: RETENTIA_POLICY_MESSAGE,
    },
  });
}

function preToolUse(payload) {
  const toolName = payload.tool_name || payload.toolName || "";
  if (
    isRetentiaTool(toolName) ||
    isToolDiscoveryTool(toolName) ||
    !isSubstantiveTool(toolName)
  ) {
    return;
  }

  const path = statePath(payload);
  const state = loadState(path);
  // Retentia is telemetry only. Never deny an active task's substantive tool.
  // The state is still tracked for optional memory usage and diagnostics.
}

function postToolUse(payload) {
  const toolName = payload.tool_name || payload.toolName || "";
  const path = statePath(payload);
  const state = loadState(path);

  if (isSubstantiveTool(toolName)) {
    state.substantiveToolUsed = true;
  }
  if (isSubstantiveTool(toolName) && !isRetentiaTool(toolName)) {
    state.pendingUpdate = true;
  }
  if (isRetentiaRead(toolName)) {
    state.retentiaInspected = true;
  }
  if (isRetentiaWrite(toolName)) {
    state.retentiaUpdated = true;
    state.pendingUpdate = false;
  }

  saveState(path, state);
}

function stop(payload) {
  const path = statePath(payload);
  const state = loadState(path);

  if (payload.stop_hook_active || payload.stopHookActive) {
    cleanupState(payload, path);
    return;
  }

  // Stop is not a Retentia completion boundary. Do not block or ask Codex to
  // yield because inspection or terminal logging is missing.
  cleanupState(payload, path);
}

const command = process.argv[2] || "";
const payload = readPayload();

if (command === "user-prompt-submit") {
  userPromptSubmit(payload);
} else if (command === "pre-tool-use") {
  preToolUse(payload);
} else if (command === "post-tool-use") {
  postToolUse(payload);
} else if (command === "stop") {
  stop(payload);
}


