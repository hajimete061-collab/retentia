import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const trackedHook = join(process.cwd(), "hooks", "retentia-enforcement.mjs");
const installedHook = "C:/Users/david/.retentia/hooks/retentia-enforcement.mjs";
const stateDirs: string[] = [];

function run(command: string, payload: Record<string, unknown>) {
  return execFileSync(process.execPath, [trackedHook, command], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: {
      ...process.env,
      RETENTIA_HOOK_STATE_DIR: stateDirs[stateDirs.length - 1],
    },
  });
}

function startPayload() {
  return {
    session_id: `retentia-hook-test-${randomUUID()}`,
    turn_id: randomUUID(),
    prompt: "Continue the active technical task.",
  };
}

describe("Retentia hook non-blocking contract", () => {
  afterEach(() => {
    const stateDir = stateDirs.pop();
    if (stateDir) rmSync(stateDir, { recursive: true, force: true });
  });

  it("allows substantive tools before Retentia inspection", () => {
    stateDirs.push(mkdtempSync(join(tmpdir(), "retentia-hook-")));
    const payload = startPayload();
    run("user-prompt-submit", payload);

    expect(
      run("pre-tool-use", { ...payload, tool_name: "exec_command" }),
    ).not.toContain('"permissionDecision":"deny"');
  });

  it("does not block Stop when terminal logging is pending", () => {
    stateDirs.push(mkdtempSync(join(tmpdir(), "retentia-hook-")));
    const payload = startPayload();
    run("user-prompt-submit", payload);
    run("post-tool-use", { ...payload, tool_name: "exec_command" });

    expect(run("stop", payload)).not.toContain('"decision":"block"');
  });

  it("does not block when Retentia is unavailable", () => {
    stateDirs.push(mkdtempSync(join(tmpdir(), "retentia-hook-")));
    const payload = startPayload();

    expect(run("stop", payload)).not.toContain('"decision":"block"');
  });

  it("does not turn a Retentia event into a completion boundary", () => {
    stateDirs.push(mkdtempSync(join(tmpdir(), "retentia-hook-")));
    const payload = startPayload();
    run("user-prompt-submit", payload);
    run("post-tool-use", { ...payload, tool_name: "exec_command" });
    run("post-tool-use", {
      ...payload,
      tool_name: "mcp__retentia__agent_event",
    });

    expect(run("stop", payload)).not.toContain('"decision":"block"');
  });

  it("keeps the installed hook aligned with the tracked source", () => {
    expect(existsSync(trackedHook)).toBe(true);
    expect(existsSync(installedHook)).toBe(true);
    expect(readFileSync(installedHook, "utf8").trimEnd()).toBe(
      readFileSync(trackedHook, "utf8").trimEnd(),
    );
  });

  it("makes the installer read the tracked hook source", () => {
    const installer = readFileSync(
      join(process.cwd(), "scripts", "vscode-install.mjs"),
      "utf8",
    );
    expect(installer).toContain(
      'readFileSync(join(ROOT_DIR, "hooks", "retentia-enforcement.mjs"), "utf8")',
    );
  });
});
