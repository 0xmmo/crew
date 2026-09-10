/**
 * A small product-neutral live-session registry maintained by crew's hooks.
 *
 * Claude has its own PID registry; Codex intentionally exposes session data to
 * hooks instead. Recording the common hook fields gives both products one
 * discovery mechanism without scanning historical Codex rollouts or relying
 * on platform-specific open-file tools.
 */

import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { crewHome, safeSessionId } from "./home";
import { Agent } from "./settings";

const SESSION_ROOT = join(crewHome(), "sessions");
const MAX_STALE_MS = 36 * 60 * 60 * 1000;

export interface RegisteredSession {
  pid: number;
  sessionId: string;
  agent: Agent;
  status: string;
  cwd: string;
  startedAt: string;
  lastSeen: string;
  transcript: string | null;
}

export interface HookSessionInput {
  session_id?: string;
  transcript_path?: string | null;
  cwd?: string;
  hook_event_name?: string;
  model?: string;
}

/** Returns the process command line, or null when dead or inaccessible. */
export function processCommand(pid: number): string | null {
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

export function parentPid(pid: number): number | null {
  try {
    const out = execFileSync("ps", ["-p", String(pid), "-o", "ppid="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const parent = parseInt(out, 10);
    return Number.isFinite(parent) && parent > 1 ? parent : null;
  } catch {
    return null;
  }
}

/** EPERM still proves a PID exists inside an agent sandbox. */
export function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function agentForCommand(command: string): Agent | null {
  if (/(^|[\s/])opencode(?:\s|$)/i.test(command)) return "opencode";
  if (/(^|[\s/])codex(?:\s|$)|Codex\.app\//i.test(command)) return "codex";
  if (/(^|[\s/])claude(?:\s|$)|Claude\.app\//i.test(command)) return "claude";
  return null;
}

function isAgent(value: unknown): value is Agent {
  return value === "claude" || value === "codex" || value === "opencode";
}

/**
 * crew's own adapters (the OpenCode plugin) identify themselves via env when
 * spawning `crew --hook`, which beats process-tree guessing and still works
 * where `ps` is blocked.
 */
function envAgent(): { pid: number; agent: Agent } | null {
  const agent = process.env.CREW_AGENT;
  const pid = Number(process.env.CREW_PID);
  if (!isAgent(agent) || !Number.isFinite(pid) || pid <= 0) return null;
  return { pid, agent };
}

function agentAncestor(): { pid: number; agent: Agent } | null {
  let pid: number | null = process.ppid;
  for (let depth = 0; pid && depth < 15; depth++) {
    const agent = agentForCommand(processCommand(pid) ?? "");
    if (agent) return { pid, agent };
    pid = parentPid(pid);
  }
  return null;
}

/** Infer the product even if process inspection is blocked. */
export function hookAgent(input: HookSessionInput, ancestorAgent?: Agent): Agent {
  const declared = envAgent();
  if (declared) return declared.agent;
  const transcript = input.transcript_path ?? "";
  if (
    (process.env.CODEX_THREAD_ID &&
      process.env.CODEX_THREAD_ID === input.session_id) ||
    /[/\\]\.codex[/\\]sessions[/\\]/.test(transcript) ||
    /[/\\]rollout-[^/\\]+\.jsonl$/.test(transcript)
  ) {
    return "codex";
  }
  return ancestorAgent ?? agentAncestor()?.agent ?? "claude";
}

function registryPath(sid: string): string {
  return join(SESSION_ROOT, `${safeSessionId(sid)}.json`);
}

function readRegistered(path: string): RegisteredSession | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (
      !value ||
      typeof value.sessionId !== "string" ||
      !isAgent(value.agent) ||
      !Number.isFinite(value.pid)
    ) {
      return null;
    }
    return value as RegisteredSession;
  } catch {
    return null;
  }
}

/** Refresh the current top-level hook session and return its product. */
export function recordHookSession(input: HookSessionInput): Agent {
  const ancestor = envAgent() ?? agentAncestor();
  const inferred = hookAgent(input, ancestor?.agent);
  const sid = typeof input.session_id === "string" ? input.session_id : "";
  if (!sid) return inferred;

  const agent = ancestor?.agent ?? inferred;
  // A short-lived shell/Node hook PID is not useful for liveness. If ancestry
  // cannot be inspected, leave any previous good record in place.
  if (!ancestor) return agent;

  const path = registryPath(sid);
  const previous = readRegistered(path);
  const now = new Date().toISOString();
  const event = input.hook_event_name ?? "";
  const status = event === "Stop" ? "idle" : event === "SessionStart" ? "idle" : "busy";
  const session: RegisteredSession = {
    pid: ancestor.pid,
    sessionId: sid,
    agent,
    status,
    cwd: typeof input.cwd === "string" ? resolve(input.cwd) : previous?.cwd ?? "",
    startedAt: previous?.startedAt ?? now,
    lastSeen: now,
    transcript:
      typeof input.transcript_path === "string"
        ? input.transcript_path
        : previous?.transcript ?? null,
  };
  try {
    mkdirSync(SESSION_ROOT, { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(session));
    renameSync(tmp, path);
  } catch {
    // Registration is best-effort; hooks must never block an agent.
  }
  return agent;
}

/** Drop a session's registry record (its product reported the session ended). */
export function removeSession(sid: string): void {
  if (!sid) return;
  try {
    unlinkSync(registryPath(sid));
  } catch {
    // already gone or never registered
  }
}

/** List live hook-registered sessions and prune dead/stale records. */
export function registeredSessions(): RegisteredSession[] {
  let files: string[];
  try {
    files = readdirSync(SESSION_ROOT).filter((file) => file.endsWith(".json"));
  } catch {
    return [];
  }
  const live: RegisteredSession[] = [];
  const cutoff = Date.now() - MAX_STALE_MS;
  for (const file of files) {
    const path = join(SESSION_ROOT, file);
    const session = readRegistered(path);
    const seen = Date.parse(session?.lastSeen ?? "");
    if (
      !session ||
      !Number.isFinite(seen) ||
      seen < cutoff ||
      !processExists(session.pid)
    ) {
      try {
        unlinkSync(path);
      } catch {}
      continue;
    }
    live.push(session);
  }
  return live;
}
