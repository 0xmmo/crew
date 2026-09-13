#!/usr/bin/env node
/**
 * crew — shared context for Claude Code, Codex, and OpenCode agents.
 *
 * First and foremost an agent hook: `crew --hook` reads the hook event on
 * stdin and emits what your other running sessions are doing (status, recap,
 * transcript tail) as additionalContext, so every session automatically sees
 * the rest of the crew. Also a CLI for watching the same thing yourself.
 *
 * Claude sessions are discovered from Claude's live PID registry. All hooks
 * (OpenCode's arrive via its generated crew plugin, see opencode.ts) also
 * maintain a tiny product-neutral live registry, which lets sessions from
 * every product share one view and mailbox.
 *
 *   crew --hook          hook mode: emit other sessions as additionalContext JSON
 *   crew install-hook    wire crew into Claude Code, Codex, and OpenCode
 *   crew uninstall-hook  remove it
 *   crew doctor          check hooks, binary, mailbox, registry; --fix repairs
 *   crew send <t> "msg"  message another session (delivered via its hook)
 *   crew send -k <t> ... kickstart: force the target to act on the message
 *   crew inbox           peek at this session's pending messages
 *   crew                 human view, last 50 transcript entries per session
 *   crew 10              human view, last 10 entries
 *   crew --json          NDJSON: one structured object per session (agent-friendly)
 *   crew --json --full   NDJSON with untruncated tool input/output
 *   crew --help
 */

import {
  readFileSync,
  readdirSync,
  existsSync,
  writeFileSync,
  accessSync,
  constants as fsConstants,
} from "node:fs";
import { join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { createHash } from "node:crypto";
import {
  AGENTS,
  AGENT_LABELS,
  Agent,
  HOOK_COMMAND,
  hookInstalled,
  installHook,
  settingsPath,
  tildify,
  uninstallHook,
} from "./settings";
import { renderDoctorJson, renderDoctorText, runDoctor } from "./doctor";
import { crewVersion } from "./home";
import {
  DEFAULT_TTL_MS,
  MailboxError,
  Message,
  drainInbox,
  peekInbox,
  pendingCount,
  pruneInboxes,
  sendMessage,
} from "./mailbox";
import {
  HookSessionInput,
  parentPid,
  processCommand,
  processExists,
  recordHookSession,
  registeredSessions,
  removeSession,
} from "./registry";
import { Entry, Parsed, clean } from "./transcript";
import { parseOpencodeTranscript } from "./opencode";

const CLAUDE_HOME = process.env.CLAUDE_HOME || join(homedir(), ".claude");
const SESS_DIR = join(CLAUDE_HOME, "sessions");
const PROJ_DIR = join(CLAUDE_HOME, "projects");

// ---------- plugin awareness ----------

function onPath(bin: string): boolean {
  for (const dir of (process.env.PATH || "").split(":")) {
    if (!dir) continue;
    try {
      accessSync(join(dir, bin), fsConstants.X_OK);
      return true;
    } catch {
      // keep looking
    }
  }
  return false;
}

// When crew runs as a Claude/Codex plugin hook and
// there is no global `crew` on PATH, emitted guidance must name a command
// agents can actually run: the plugin's own entry point.
let cachedCliCmd: string | null = null;
function cliCmd(): string {
  if (cachedCliCmd === null) {
    const root = process.env.PLUGIN_ROOT || process.env.CLAUDE_PLUGIN_ROOT;
    cachedCliCmd =
      root && !onPath("crew")
        ? `node "${join(root, "dist", "crew.js")}"`
        : "crew";
  }
  return cachedCliCmd;
}

// ---------- types ----------

interface Session {
  pid: number;
  sessionId: string;
  shortId: string;
  agent: Agent;
  status: string;
  cwd: string;
  startedAt: string | null;
  transcript: string | null;
  recap: string | null;
  messageCount: number;
  tailCount: number;
  tail: Entry[];
  pendingMessages: number;
}

// ---------- args ----------

type Mode = "list" | "hook" | "install-hook" | "uninstall-hook";

interface Opts {
  mode: Mode;
  format: "text" | "json";
  full: boolean;
  tailN: number;
  tailSet: boolean;
  dir: string | null;
}

function parseArgs(argv: string[]): Opts {
  const opts: Opts = {
    mode: "list",
    format: "text",
    full: false,
    tailN: 50,
    tailSet: false,
    dir: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") opts.format = "json";
    else if (a === "--full") opts.full = true;
    else if (a === "--hook") opts.mode = "hook";
    else if (a === "install-hook") opts.mode = "install-hook";
    else if (a === "uninstall-hook") opts.mode = "uninstall-hook";
    else if (a === "--dir") {
      // Optional path; bare `--dir` means the current directory.
      const next = argv[i + 1];
      if (next && !next.startsWith("-") && !/^\d+$/.test(next)) {
        opts.dir = resolve(next);
        i++;
      } else {
        opts.dir = process.cwd();
      }
    } else if (a === "-h" || a === "--help") {
      printHelp();
      process.exit(0);
    } else if (/^\d+$/.test(a)) {
      opts.tailN = parseInt(a, 10);
      opts.tailSet = true;
    } else {
      process.stderr.write(`crew: unknown argument '${a}'\n`);
      printHelp();
      process.exit(2);
    }
  }
  return opts;
}

/** True if cwd is dir or a descendant of it. dir=null matches everything. */
function underDir(cwd: string, dir: string | null): boolean {
  if (!dir) return true;
  const strip = (p: string) => (p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p);
  const c = strip(cwd);
  const d = strip(dir);
  return c === d || c.startsWith(d + "/");
}

function printHelp(): void {
  process.stdout.write(
    [
      "crew — shared context and messaging for Claude Code, Codex, and OpenCode agents",
      "",
      "Hook (auto-injects other sessions into agent context):",
      "  crew --hook [N]       read a hook event on stdin, emit other sessions as",
      "                        additionalContext JSON (default N=5 tail entries)",
      "  crew install-hook     wire crew into Claude Code + Codex (hooks) and",
      "                        OpenCode (a generated plugin)",
      "  crew uninstall-hook   remove it from all three",
      "  crew doctor           check that hooks, the binary on PATH, the mailbox,",
      "                        and the registry are healthy; --fix repairs what",
      "                        crew owns; --json for agents (exit 1 on failure)",
      "",
      "Messaging (delivered into the target agent's context via the hook):",
      '  crew send <t> "msg"   t = shortId prefix, pid, or cwd substring',
      '  crew send --all "msg" broadcast to every other live session',
      "  crew send --ttl 30m   expire undelivered mail (default 24h)",
      "  crew send --kickstart force the target to act on the message (-k): its",
      "                        Stop hook continues it instead of injecting context",
      "  crew inbox            peek at this session's pending messages",
      "",
      "CLI:",
      "  crew [N]              human view, last N transcript entries (default 50)",
      "  crew --json [N]       NDJSON, one object per session (agent-consumable)",
      "  crew --json --full    NDJSON without tool input/output truncation",
      "  crew --dir [path]     only sessions under <path> (default: current dir)",
      "  crew --help",
      "",
      "Env:",
      "  CLAUDE_HOME           override ~/.claude",
      "  CODEX_HOME            override ~/.codex",
      "  XDG_CONFIG_HOME/XDG_DATA_HOME  override OpenCode's plugin/db locations",
      "  CREW_HOME             override config + session registry at ~/.crew",
      "  CREW_INBOX_ROOT       override the mailbox at /tmp/crew-<uid>/inbox",
      "  CREW_NO_HOOK=1        skip hook auto-install on `npm i -g`",
      "",
    ].join("\n"),
  );
}

// ---------- helpers ----------

function trunc(s: string, n: number, full: boolean): string {
  if (full) return s;
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= n ? flat : flat.slice(0, n - 1) + "…";
}

function localHHMM(ts: string | null): string {
  if (!ts) return "     ";
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "     ";
  return d.toTimeString().slice(0, 5);
}

/** Claude encodes a session's cwd into the projects dir name: / and . become -. */
function encodeCwd(cwd: string): string {
  return cwd.replace(/[/.]/g, "-");
}

function findTranscript(cwd: string, sid: string): string | null {
  const derived = join(PROJ_DIR, encodeCwd(cwd), `${sid}.jsonl`);
  if (existsSync(derived)) return derived;
  // Fallback: scan project dirs for <sid>.jsonl.
  let dirs: string[];
  try {
    dirs = readdirSync(PROJ_DIR);
  } catch {
    return null;
  }
  for (const d of dirs) {
    const p = join(PROJ_DIR, d, `${sid}.jsonl`);
    if (existsSync(p)) return p;
  }
  return null;
}

/** Parse a Claude transcript jsonl into the recap and ordered entries. */
function parseClaudeTranscript(path: string | null): Parsed {
  const out: Parsed = { recap: null, total: 0, entries: [] };
  if (!path) return out;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return out;
  }
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    let d: any;
    try {
      d = JSON.parse(s);
    } catch {
      continue;
    }
    const typ = d.type;
    if (typ === "system" && d.subtype === "away_summary") {
      out.recap = d.content ?? "";
      continue;
    }
    if (typ !== "user" && typ !== "assistant") continue;
    const msg = d.message ?? {};
    const role: string = msg.role ?? typ;
    const ts: string | null = d.timestamp ?? null;
    const content = msg.content;
    if (typeof content === "string") {
      const c = clean(content);
      if (c) {
        out.entries.push({ ts, role, kind: "text", text: c });
        out.total++;
      }
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (!b || typeof b !== "object") continue;
      if (b.type === "text") {
        const c = clean(b.text ?? "");
        if (c) {
          out.entries.push({ ts, role, kind: "text", text: c });
          out.total++;
        }
      } else if (b.type === "tool_use") {
        const inp = b.input ?? {};
        const desc =
          inp.description ?? inp.command ?? inp.pattern ?? inp.file_path ?? inp.prompt ?? "";
        out.entries.push({
          ts,
          role,
          kind: "tool_use",
          name: b.name ?? "?",
          summary: String(desc),
        });
        out.total++;
      } else if (b.type === "tool_result") {
        let cont = b.content ?? "";
        if (Array.isArray(cont)) {
          cont = cont
            .filter((x: any) => x && x.type === "text")
            .map((x: any) => x.text ?? "")
            .join(" ");
        }
        const c = clean(String(cont));
        if (c) {
          out.entries.push({ ts, role: "tool", kind: "tool_result", text: c });
          out.total++;
        }
      }
    }
  }
  return out;
}

function textFromCodexOutput(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") return item;
        if (!item || typeof item !== "object") return "";
        const block = item as Record<string, unknown>;
        return typeof block.text === "string"
          ? block.text
          : typeof block.output_text === "string"
            ? block.output_text
            : typeof block.content === "string"
              ? block.content
              : "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    for (const key of ["text", "output", "content"]) {
      if (typeof obj[key] === "string") return obj[key] as string;
    }
    try {
      return JSON.stringify(value);
    } catch {
      return "";
    }
  }
  return "";
}

function codexToolSummary(raw: unknown): string {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  if (!value || typeof value !== "object") return String(value ?? "");
  const obj = value as Record<string, unknown>;
  for (const key of [
    "cmd",
    "command",
    "prompt",
    "query",
    "path",
    "file_path",
    "target",
    "description",
  ]) {
    const candidate = obj[key];
    if (typeof candidate === "string") return candidate;
    if (Array.isArray(candidate)) return candidate.map(String).join(" ");
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

/**
 * Parse the useful, user-visible subset of a Codex rollout. The rollout is a
 * convenience input rather than a stable API, so unknown records are skipped.
 */
function parseCodexTranscript(path: string | null): Parsed {
  const out: Parsed = { recap: null, total: 0, entries: [] };
  if (!path) return out;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return out;
  }
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    let record: any;
    try {
      record = JSON.parse(s);
    } catch {
      continue;
    }
    const ts: string | null = record.timestamp ?? null;
    const payload = record.payload ?? {};
    if (record.type === "event_msg") {
      if (payload.type === "task_complete" && typeof payload.last_agent_message === "string") {
        out.recap = clean(payload.last_agent_message);
        continue;
      }
      if (payload.type !== "user_message" && payload.type !== "agent_message") continue;
      const text = clean(typeof payload.message === "string" ? payload.message : "");
      if (!text) continue;
      out.entries.push({
        ts,
        role: payload.type === "user_message" ? "user" : "assistant",
        kind: "text",
        text,
      });
      out.total++;
      continue;
    }
    if (record.type !== "response_item") continue;
    const type = payload.type;
    if (
      type === "function_call" ||
      type === "custom_tool_call" ||
      type === "local_shell_call" ||
      type === "web_search_call"
    ) {
      out.entries.push({
        ts,
        role: "assistant",
        kind: "tool_use",
        name: payload.name ?? (type === "web_search_call" ? "web_search" : type),
        summary: codexToolSummary(
          payload.arguments ?? payload.input ?? payload.command ?? payload.action ?? "",
        ),
      });
      out.total++;
      continue;
    }
    if (
      type === "function_call_output" ||
      type === "custom_tool_call_output" ||
      type === "local_shell_call_output"
    ) {
      const text = clean(textFromCodexOutput(payload.output));
      if (!text) continue;
      out.entries.push({ ts, role: "tool", kind: "tool_result", text });
      out.total++;
    }
  }
  return out;
}

function parseTranscript(agent: Agent, path: string | null, sessionId = ""): Parsed {
  if (agent === "opencode") return parseOpencodeTranscript(sessionId);
  return agent === "codex"
    ? parseCodexTranscript(path)
    : parseClaudeTranscript(path);
}

// ---------- discovery ----------

function liveClaudePid(pid: number): boolean {
  const command = processCommand(pid);
  if (command !== null) return /(^|[\s/])claude(?:\s|$)/i.test(command);
  return processExists(pid);
}

function collectClaudeSessions(opts: Opts): Session[] {
  let files: string[];
  try {
    files = readdirSync(SESS_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const sessions: Session[] = [];
  for (const f of files) {
    let meta: any;
    try {
      meta = JSON.parse(readFileSync(join(SESS_DIR, f), "utf8"));
    } catch {
      continue;
    }
    const pid = Number(meta.pid);
    if (!pid) continue;
    const cwd: string = meta.cwd ?? "";
    if (!underDir(cwd, opts.dir)) continue; // outside the requested directory

    if (!liveClaudePid(pid)) continue;

    const sid: string = meta.sessionId ?? "";
    const transcript = findTranscript(cwd, sid);
    const parsed = parseTranscript("claude", transcript);
    const tail = parsed.entries.slice(-opts.tailN);

    sessions.push({
      pid,
      sessionId: sid,
      shortId: sid.slice(0, 8),
      agent: "claude",
      status: meta.status ?? "",
      cwd,
      startedAt:
        typeof meta.startedAt === "number"
          ? new Date(meta.startedAt).toISOString()
          : null,
      transcript,
      recap: parsed.recap,
      messageCount: parsed.total,
      tailCount: tail.length,
      tail,
      pendingMessages: pendingCount(sid),
    });
  }
  return sessions;
}

function collectSessions(opts: Opts): Session[] {
  const byId = new Map<string, Session>();
  for (const session of collectClaudeSessions(opts)) {
    byId.set(session.sessionId, session);
  }
  for (const meta of registeredSessions()) {
    if (byId.has(meta.sessionId) || !underDir(meta.cwd, opts.dir)) continue;
    const parsed = parseTranscript(meta.agent, meta.transcript, meta.sessionId);
    const tail = parsed.entries.slice(-opts.tailN);
    byId.set(meta.sessionId, {
      pid: meta.pid,
      sessionId: meta.sessionId,
      shortId: meta.sessionId.slice(0, 8),
      agent: meta.agent,
      status: meta.status,
      cwd: meta.cwd,
      startedAt: meta.startedAt,
      transcript: meta.transcript,
      recap: parsed.recap,
      messageCount: parsed.total,
      tailCount: tail.length,
      tail,
      pendingMessages: pendingCount(meta.sessionId),
    });
  }
  return [...byId.values()].sort((a, b) =>
    (b.startedAt ?? "").localeCompare(a.startedAt ?? ""),
  );
}

// ---------- messaging ----------

interface SessionRef {
  pid: number;
  sessionId: string;
  agent: Agent;
  cwd: string;
  status: string;
}

/** Lightweight cross-product live-session list (no transcript parsing). */
function listSessionRefs(): SessionRef[] {
  const byId = new Map<string, SessionRef>();
  let files: string[];
  try {
    files = readdirSync(SESS_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    files = [];
  }
  for (const f of files) {
    try {
      const meta = JSON.parse(readFileSync(join(SESS_DIR, f), "utf8"));
      const pid = Number(meta.pid);
      if (!pid || typeof meta.sessionId !== "string") continue;
      if (!liveClaudePid(pid)) continue;
      byId.set(meta.sessionId, {
        pid,
        sessionId: meta.sessionId,
        agent: "claude",
        cwd: meta.cwd ?? "",
        status: typeof meta.status === "string" ? meta.status : "",
      });
    } catch {
      continue;
    }
  }
  for (const session of registeredSessions()) {
    if (byId.has(session.sessionId)) continue;
    byId.set(session.sessionId, {
      pid: session.pid,
      sessionId: session.sessionId,
      agent: session.agent,
      cwd: session.cwd,
      status: session.status,
    });
  }
  return [...byId.values()];
}

/**
 * The session this process is running inside, found by walking up the process
 * tree until a pid matches a live session — attributes `crew send` run from an
 * agent's shell to that agent. Null when run from a plain terminal.
 */
function senderSession(refs: SessionRef[]): SessionRef | null {
  const envSid =
    process.env.CREW_SESSION_ID || // set by the OpenCode plugin's shell.env
    process.env.CODEX_THREAD_ID ||
    process.env.CLAUDE_SESSION_ID;
  if (envSid) {
    const exact = refs.find((ref) => ref.sessionId === envSid);
    if (exact) return exact;
  }
  const byPid = new Map(refs.map((r) => [r.pid, r]));
  let pid: number | null = process.ppid;
  for (let depth = 0; pid && depth < 15; depth++) {
    const hit = byPid.get(pid);
    if (hit) return hit;
    pid = parentPid(pid);
  }
  return null;
}

function parseTtl(s: string): number | null {
  const m = /^(\d+)([smhd])$/.exec(s);
  if (!m) return null;
  const mult = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return parseInt(m[1], 10) * mult[m[2] as keyof typeof mult];
}

function listRefsTo(stream: NodeJS.WriteStream, refs: SessionRef[]): void {
  for (const r of refs) {
    stream.write(
      `  ${r.sessionId.slice(0, 8)}  ${r.agent}  pid ${r.pid}  ${r.cwd}\n`,
    );
  }
}

function runSend(argv: string[]): void {
  let all = false;
  let kickstart = false;
  let ttlMs = DEFAULT_TTL_MS;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--all") all = true;
    else if (a === "--kickstart" || a === "-k") kickstart = true;
    else if (a === "--ttl") {
      const parsed = parseTtl(argv[++i] ?? "");
      if (parsed === null) {
        process.stderr.write("crew: --ttl wants e.g. 90s, 30m, 2h, 1d\n");
        process.exit(2);
      }
      ttlMs = parsed;
    } else rest.push(a);
  }
  const target = all ? null : rest.shift();
  const text = rest.join(" ").trim();
  if ((!all && !target) || !text) {
    process.stderr.write(
      'usage: crew send <shortId|pid|cwd-substring> "message" [--ttl 30m] [--kickstart]\n' +
        '       crew send --all "message"\n',
    );
    process.exit(2);
  }
  const refs = listSessionRefs();
  const me = senderSession(refs);
  const others = refs.filter((r) => r.sessionId !== me?.sessionId);
  let targets: SessionRef[];
  if (all) {
    targets = others;
    if (targets.length === 0) {
      process.stderr.write("crew: no other live sessions\n");
      process.exit(1);
    }
  } else {
    const t = target as string;
    const matches = others.filter(
      (r) =>
        r.sessionId.startsWith(t) ||
        String(r.pid) === t ||
        (t.length >= 3 && r.cwd.includes(t)),
    );
    if (matches.length === 0) {
      process.stderr.write(`crew: no live session matches '${t}'. Sessions:\n`);
      listRefsTo(process.stderr, others);
      process.exit(1);
    }
    if (matches.length > 1) {
      process.stderr.write(`crew: '${t}' is ambiguous:\n`);
      listRefsTo(process.stderr, matches);
      process.exit(1);
    }
    targets = matches;
  }
  const now = Date.now();
  const msg: Message = {
    ts: new Date(now).toISOString(),
    from: me?.sessionId ?? "human",
    fromShort: me ? me.sessionId.slice(0, 8) : "human",
    fromCwd: me?.cwd ?? process.cwd(),
    text,
    expiresAt: new Date(now + ttlMs).toISOString(),
    ...(kickstart ? { kickstart: true } : {}),
  };
  // Nothing is reported as queued until its atomic write has returned. A
  // sandbox that denies the mailbox fails here, and saying "queued" anyway
  // would leave the sender believing a message that never landed was sent.
  const delivered: SessionRef[] = [];
  const failed: SessionRef[] = [];
  const errors: string[] = [];
  for (const r of targets) {
    try {
      sendMessage(r.sessionId, msg);
      delivered.push(r);
    } catch (err) {
      failed.push(r);
      const detail =
        err instanceof MailboxError
          ? err.message
          : `crew: send failed — ${(err as Error).message}`;
      if (!errors.includes(detail)) errors.push(detail); // one cause, once
    }
  }
  if (failed.length > 0) {
    for (const detail of errors) process.stderr.write(`${detail}\n`);
    process.stderr.write(
      `crew: NOT queued for ${failed.map((r) => r.sessionId.slice(0, 8)).join(", ")}\n`,
    );
    process.exitCode = 1; // exitCode, not exit(): let queued output flush
  }
  if (delivered.length === 0) return;
  const names = delivered.map((r) => r.sessionId.slice(0, 8)).join(", ");
  if (kickstart) {
    // A kickstart force-continues the target when its Stop hook next fires. A
    // busy agent hits that the moment its current turn ends. An already-idle
    // agent has no upcoming Stop — except OpenCode, whose crew plugin polls
    // the inbox and can wake a stopped session from inside the process.
    for (const r of delivered.filter((t) => t.status === "idle")) {
      if (r.agent === "opencode") {
        process.stdout.write(
          `crew: ${r.sessionId.slice(0, 8)} is idle — its crew plugin will wake it within ~15s.\n`,
        );
      } else {
        process.stderr.write(
          `⚠️  crew: ${r.sessionId.slice(0, 8)} is idle — kickstart can't wake a stopped session ` +
            `from outside. It'll act on this the instant it next runs; queued as normal mail until then.\n`,
        );
      }
    }
    process.stdout.write(
      `crew: kickstart queued for ${names} — force-continues each onto this message when its Stop hook next fires.\n`,
    );
  } else {
    process.stdout.write(
      `crew: queued for ${names} — delivers on their next tool call, turn end, or prompt.\n`,
    );
  }
}

function runInbox(): void {
  const refs = listSessionRefs();
  const me = senderSession(refs);
  if (!me) {
    process.stderr.write("crew: not inside a known agent session — no inbox\n");
    process.exit(1);
  }
  const msgs = peekInbox(me.sessionId);
  if (msgs.length === 0) {
    process.stdout.write("crew: inbox empty\n");
    return;
  }
  for (const m of msgs) {
    process.stdout.write(`${m.ts}  ${m.fromShort} (${m.fromCwd}): ${m.text}\n`);
  }
}

// ---------- rendering ----------

const EMOJI: Record<string, string> = {
  busy: "🔵",
  idle: "⚪",
  shell: "🟡",
};

function renderText(sessions: Session[], opts: Opts): string {
  const lines: string[] = [];
  for (const s of sessions) {
    lines.push(
      "\n════════════════════════════════════════════════════════════════════",
    );
    lines.push(
      `${EMOJI[s.status] ?? "⚫"}  ${s.shortId}   ${s.agent}   pid ${s.pid}   status: ${s.status}`,
    );
    const started = s.startedAt
      ? new Date(s.startedAt).toLocaleString()
      : "?";
    lines.push(`   cwd: ${s.cwd}`);
    lines.push(`   started: ${started}\n`);
    if (s.pendingMessages > 0) {
      lines.push(`   📨 ${s.pendingMessages} pending message(s) awaiting delivery\n`);
    }
    lines.push(`   recap: ${s.recap ?? "(no recap recorded yet)"}`);
    lines.push(
      `\n   last ${s.tailCount} transcript entries (of ${s.messageCount}):`,
    );
    for (const e of s.tail) {
      const t = localHHMM(e.ts);
      if (e.kind === "tool_use") {
        lines.push(`   ${t} ⚙ ${e.name}: ${trunc(e.summary ?? "", 200, opts.full)}`);
      } else if (e.kind === "tool_result") {
        lines.push(`   ${t} ⟲ ${trunc(e.text ?? "", 200, opts.full)}`);
      } else {
        const glyph = e.role === "user" ? "›" : "‹";
        for (const ln of (e.text ?? "").split("\n")) {
          if (ln.trim()) lines.push(`   ${t} ${glyph} ${ln.trimEnd()}`);
        }
      }
    }
  }
  lines.push(
    "\n────────────────────────────────────────────────────────────────────",
  );
  lines.push(`${sessions.length} active session(s).`);
  return lines.join("\n") + "\n";
}

function renderJson(sessions: Session[], opts: Opts): string {
  // NDJSON: one object per line. Tool fields truncated unless --full.
  return (
    sessions
      .map((s) => {
        const tail = s.tail.map((e) => {
          if (e.kind === "tool_use")
            return { ...e, summary: trunc(e.summary ?? "", 200, opts.full) };
          if (e.kind === "tool_result")
            return { ...e, text: trunc(e.text ?? "", 400, opts.full) };
          return e;
        });
        return JSON.stringify({ ...s, tail });
      })
      .join("\n") + "\n"
  );
}

// ---------- hook mode ----------

interface HookInput extends HookSessionInput {}

function readHookInput(): HookInput {
  if (process.stdin.isTTY) return {};
  try {
    const raw = readFileSync(0, "utf8");
    const parsed = raw.trim() ? JSON.parse(raw) : {};
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function renderHookContext(sessions: Session[]): string {
  const MAX_SESSIONS = 8;
  const shown = sessions.slice(0, MAX_SESSIONS);
  const lines: string[] = [
    `${sessions.length} other agent session(s) running on this machine right now. ` +
      `Consider them before starting overlapping work; run \`${cliCmd()}\` for the full view.`,
  ];
  for (const s of shown) {
    lines.push("");
    lines.push(
      `• ${s.shortId} — ${s.agent} — ${s.status || "unknown"} — ${s.cwd}`,
    );
    if (s.recap) lines.push(`  recap: ${trunc(s.recap, 300, false)}`);
    for (const e of s.tail) {
      const t = localHHMM(e.ts);
      if (e.kind === "tool_use") {
        lines.push(`  ${t} ⚙ ${e.name}: ${trunc(e.summary ?? "", 120, false)}`);
      } else if (e.kind === "tool_result") {
        lines.push(`  ${t} ⟲ ${trunc(e.text ?? "", 160, false)}`);
      } else {
        const glyph = e.role === "user" ? "›" : "‹";
        lines.push(`  ${t} ${glyph} ${trunc(e.text ?? "", 200, false)}`);
      }
    }
  }
  if (sessions.length > shown.length) {
    lines.push("");
    lines.push(`…and ${sessions.length - shown.length} more.`);
  }
  lines.push("");
  lines.push(
    `You can message any of them: \`${cliCmd()} send ${shown[0].shortId} "text"\` drops the text into that agent's context within seconds.`,
  );
  return lines.join("\n");
}

function ago(ts: string): string {
  const ms = Date.now() - Date.parse(ts);
  if (!Number.isFinite(ms) || ms < 0) return "";
  const min = Math.round(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function renderMessages(messages: Message[], kickstart = false): string {
  const lines: string[] = [];
  if (kickstart) {
    lines.push(
      "A crew message asked you to keep working rather than go idle. Act on it now:",
    );
  }
  for (const m of messages) {
    const when = ago(m.ts);
    lines.push(
      `📨 Message from ${m.fromShort} (${m.fromCwd}${when ? `, sent ${when}` : ""}):`,
    );
    for (const ln of m.text.split("\n")) lines.push(`  ${ln}`);
  }
  const replyTo = messages.map((m) => m.fromShort).find((s) => s !== "human");
  if (replyTo) {
    lines.push(`Reply with: \`${cliCmd()} send ${replyTo} "text"\``);
  }
  return lines.join("\n");
}

// On UserPromptSubmit the same status would otherwise be re-injected every
// message; remember a hash of the last emit per session and stay silent while
// nothing has changed.
function emitStampPath(sid: string): string {
  const safe = (sid || "unknown").replace(/[^a-zA-Z0-9-]/g, "_");
  return join(tmpdir(), `crew-hook-${safe}`);
}

function contextHash(context: string): string {
  return createHash("sha256").update(context).digest("hex");
}

function unchangedSinceLastEmit(sid: string, context: string): boolean {
  try {
    return readFileSync(emitStampPath(sid), "utf8") === contextHash(context);
  } catch {
    return false;
  }
}

function rememberEmit(sid: string, context: string): void {
  try {
    writeFileSync(emitStampPath(sid), contextHash(context));
  } catch {
    // best effort; worst case we re-emit next prompt
  }
}

const HOOK_EVENT_NAMES = new Set([
  "SessionStart",
  "UserPromptSubmit",
  "PostToolUse",
  "Stop",
  "SessionEnd",
]);

function emitHook(
  agent: Agent,
  event: string,
  context: string,
  forceContinue = false,
): void {
  // Codex Stop always uses a continuation reason rather than additionalContext,
  // which makes pending mail model-visible before the session becomes idle. A
  // kickstart message forces the same continuation on Claude, turning the
  // message into a directive the agent acts on instead of stopping.
  if (event === "Stop" && (agent === "codex" || forceContinue)) {
    process.stdout.write(
      JSON.stringify({ decision: "block", reason: context }) + "\n",
    );
    return;
  }
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: event, additionalContext: context },
    }) + "\n",
  );
}

function runHook(opts: Opts): void {
  // Never exit non-zero: exit 2 on UserPromptSubmit would block the prompt,
  // and on Stop it would force the agent to continue.
  try {
    const input = readHookInput();
    const agent = recordHookSession(input);
    // Installed both ways (plugin + user hook)? Defer to the global hook so
    // context is never injected twice. Only defer when `crew` resolves.
    if (
      (process.env.PLUGIN_ROOT || process.env.CLAUDE_PLUGIN_ROOT) &&
      onPath("crew") &&
      hookInstalled(agent)
    ) {
      return;
    }
    const event = HOOK_EVENT_NAMES.has(input.hook_event_name ?? "")
      ? (input.hook_event_name as string)
      : "SessionStart";
    const sid = typeof input.session_id === "string" ? input.session_id : "";
    if (event === "SessionEnd") {
      // The session is gone (OpenCode reports deletions); nothing to emit.
      removeSession(sid);
      return;
    }
    // An idle OpenCode session can only receive mail by being woken (the
    // plugin prompts it), which only kickstart mail justifies — plain mail
    // stays queued for its next turn instead of being drained into the void.
    if (
      agent === "opencode" &&
      event === "Stop" &&
      !peekInbox(sid).some((m) => m.kickstart)
    ) {
      return;
    }
    const messages = sid ? drainInbox(sid) : [];
    // Mid-turn events fire on every tool call machine-wide, so they only
    // deliver mail: one inbox readdir, no session/transcript scan, and total
    // silence (zero tokens) when there's none.
    if (event === "PostToolUse" || event === "Stop") {
      if (messages.length > 0) {
        // Kickstart only changes the Stop transition: force-continue instead of
        // letting the agent go idle. PostToolUse is mid-turn, so the agent is
        // already active and plain context delivery is enough.
        const kickstart = event === "Stop" && messages.some((m) => m.kickstart);
        emitHook(agent, event, renderMessages(messages, kickstart), kickstart);
      }
      return;
    }
    if (!opts.tailSet) opts.tailN = 5;
    pruneInboxes();
    const sessions = collectSessions(opts).filter((s) => s.sessionId !== sid);
    const status = sessions.length > 0 ? renderHookContext(sessions) : "";
    if (!status && messages.length === 0) return; // nothing to inject, zero tokens spent
    // The unchanged-status throttle only applies to the status block; queued
    // messages always deliver.
    if (
      event === "UserPromptSubmit" &&
      messages.length === 0 &&
      unchangedSinceLastEmit(sid, status)
    ) {
      return;
    }
    if (status) rememberEmit(sid, status);
    emitHook(
      agent,
      event,
      [renderMessages(messages), status].filter(Boolean).join("\n\n"),
    );
  } catch {
    // swallow everything; a broken hook must not break the session
  }
}

// ---------- settings commands ----------

function runSettingsCommand(mode: "install-hook" | "uninstall-hook"): void {
  let failed = false;
  for (const agent of AGENTS) {
    const shown = tildify(settingsPath(agent));
    try {
      if (mode === "install-hook") {
        const result = installHook(agent);
        process.stdout.write(
          result === "installed"
            ? `✓ crew wired into ${AGENT_LABELS[agent]} (${shown}).\n`
            : `✓ ${AGENT_LABELS[agent]} already wired — nothing to change.\n`,
        );
      } else {
        const result = uninstallHook(agent);
        process.stdout.write(
          result === "removed"
            ? `✓ crew hook removed from ${AGENT_LABELS[agent]}.\n`
            : `crew: no hook found in ${shown} — nothing to remove.\n`,
        );
      }
    } catch (err) {
      failed = true;
      process.stderr.write(
        `crew: ${AGENT_LABELS[agent]}: ${(err as Error).message}\n`,
      );
    }
  }
  if (failed) process.exitCode = 1;
}

// ---------- doctor ----------

function runDoctorCommand(args: string[]): void {
  let fix = false;
  let json = false;
  for (const a of args) {
    if (a === "--fix") fix = true;
    else if (a === "--json") json = true;
    else {
      process.stderr.write(
        `crew: unknown argument '${a}'\nusage: crew doctor [--fix] [--json]\n`,
      );
      process.exit(2);
    }
  }
  const checks = runDoctor(fix);
  const version = crewVersion();
  process.stdout.write(
    json ? renderDoctorJson(checks, version) : renderDoctorText(checks, version),
  );
  if (checks.some((c) => c.status === "fail")) process.exitCode = 1;
}

// ---------- main ----------

function main(): void {
  const argv = process.argv.slice(2);
  // `send` takes free-form message text; route it before flag parsing.
  if (argv[0] === "send") {
    runSend(argv.slice(1));
    return;
  }
  if (argv[0] === "inbox") {
    runInbox();
    return;
  }
  if (argv[0] === "doctor") {
    runDoctorCommand(argv.slice(1));
    return;
  }
  const opts = parseArgs(argv);
  if (opts.mode === "install-hook" || opts.mode === "uninstall-hook") {
    runSettingsCommand(opts.mode);
    return;
  }
  if (opts.mode === "hook") {
    runHook(opts);
    return;
  }
  const sessions = collectSessions(opts);
  const out =
    opts.format === "json" ? renderJson(sessions, opts) : renderText(sessions, opts);
  process.stdout.write(out);
  // The whole point of crew is the auto-injected context; npm hides postinstall
  // output (and ignore-scripts blocks it entirely), so the human view is the one
  // reliable place to tell people the hook isn't wired yet. Text mode only —
  // --json output is consumed by agents.
  if (opts.format === "text" && process.env.CREW_NO_HOOK !== "1") {
    const missing = AGENTS.filter((agent) => !hookInstalled(agent)).map(
      (agent) => AGENT_LABELS[agent],
    );
    if (missing.length > 0) {
      process.stderr.write(
        `\ncrew: context hook not installed for ${missing.join(" and ")}.\n` +
          `crew: run \`crew install-hook\` to wire \`${HOOK_COMMAND}\` into every agent.\n`,
      );
    }
  }
}

main();
