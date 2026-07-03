#!/usr/bin/env node
/**
 * crew — shared context for Claude Code agents.
 *
 * First and foremost a Claude Code hook: `crew --hook` reads the hook event on
 * stdin and emits what your other running sessions are doing (status, recap,
 * transcript tail) as additionalContext, so every session automatically sees
 * the rest of the crew. Also a CLI for watching the same thing yourself.
 *
 * Every interactive Claude Code session writes ~/.claude/sessions/<pid>.json while
 * running. crew reads those, keeps the ones whose pid is still a live `claude`
 * process, then pulls each session's recap (the latest `away_summary`) and a tail
 * of its transcript.
 *
 *   crew --hook          hook mode: emit other sessions as additionalContext JSON
 *   crew install-hook    wire `crew --hook` into Claude Code settings.json
 *   crew uninstall-hook  remove it
 *   crew send <t> "msg"  message another session (delivered via its hook)
 *   crew inbox           peek at this session's pending messages
 *   crew                 human view, last 50 transcript entries per session
 *   crew 10              human view, last 10 entries
 *   crew --json          NDJSON: one structured object per session (agent-friendly)
 *   crew --json --full   NDJSON with untruncated tool input/output
 *   crew --help
 */

import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  HOOK_COMMAND,
  hookInstalled,
  installHook,
  settingsPath,
  tildify,
  uninstallHook,
} from "./settings";
import {
  DEFAULT_TTL_MS,
  Message,
  drainInbox,
  peekInbox,
  pendingCount,
  pruneInboxes,
  sendMessage,
} from "./mailbox";

const CLAUDE_HOME = process.env.CLAUDE_HOME || join(homedir(), ".claude");
const SESS_DIR = join(CLAUDE_HOME, "sessions");
const PROJ_DIR = join(CLAUDE_HOME, "projects");

// ---------- types ----------

type Kind = "text" | "tool_use" | "tool_result";

interface Entry {
  ts: string | null;
  role: string;
  kind: Kind;
  text?: string; // text / tool_result
  name?: string; // tool_use
  summary?: string; // tool_use raw input summary
}

interface Session {
  pid: number;
  sessionId: string;
  shortId: string;
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
      "crew — shared context and messaging for Claude Code agents",
      "",
      "Hook (auto-injects other sessions into Claude Code context):",
      "  crew --hook [N]       read a hook event on stdin, emit other sessions as",
      "                        additionalContext JSON (default N=5 tail entries)",
      "  crew install-hook     wire `crew --hook` into Claude Code settings.json",
      "  crew uninstall-hook   remove it",
      "",
      "Messaging (delivered into the target agent's context via the hook):",
      '  crew send <t> "msg"   t = shortId prefix, pid, or cwd substring',
      '  crew send --all "msg" broadcast to every other live session',
      "  crew send --ttl 30m   expire undelivered mail (default 24h)",
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
      "  CREW_NO_HOOK=1        skip hook auto-install on `npm i -g`",
      "",
    ].join("\n"),
  );
}

// ---------- helpers ----------

const STRIP: RegExp[] = [
  /<system-reminder>[\s\S]*?<\/system-reminder>/g,
  /<command-[^>]*>[\s\S]*?<\/command-[^>]*>/g,
  /<local-command-[^>]*>[\s\S]*?<\/local-command-[^>]*>/g,
];

function clean(s: string): string {
  for (const r of STRIP) s = s.replace(r, "");
  return s.trim();
}

function trunc(s: string, n: number, full: boolean): string {
  if (full) return s;
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= n ? flat : flat.slice(0, n - 1) + "…";
}

/** Returns the process command line for pid, or null if no such process. */
function processCommand(pid: number): string | null {
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
    }).trim();
  } catch {
    return null;
  }
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

interface Parsed {
  recap: string | null;
  total: number;
  entries: Entry[];
}

/** Parse a transcript jsonl into the recap and an ordered list of entries. */
function parseTranscript(path: string | null): Parsed {
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

// ---------- discovery ----------

function collectSessions(opts: Opts): Session[] {
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

    const cmd = processCommand(pid);
    if (cmd === null) continue; // dead / stale session file
    if (!cmd.includes("claude")) continue; // pid reused by something else

    const sid: string = meta.sessionId ?? "";
    const transcript = findTranscript(cwd, sid);
    const parsed = parseTranscript(transcript);
    const tail = parsed.entries.slice(-opts.tailN);

    sessions.push({
      pid,
      sessionId: sid,
      shortId: sid.slice(0, 8),
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
  // Most-recently-started first.
  sessions.sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));
  return sessions;
}

// ---------- messaging ----------

interface SessionRef {
  pid: number;
  sessionId: string;
  cwd: string;
}

/** Lightweight session list (no transcripts): live claude pids only. */
function listSessionRefs(): SessionRef[] {
  let files: string[];
  try {
    files = readdirSync(SESS_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const refs: SessionRef[] = [];
  for (const f of files) {
    try {
      const meta = JSON.parse(readFileSync(join(SESS_DIR, f), "utf8"));
      const pid = Number(meta.pid);
      if (!pid || typeof meta.sessionId !== "string") continue;
      const cmd = processCommand(pid);
      if (!cmd || !cmd.includes("claude")) continue;
      refs.push({ pid, sessionId: meta.sessionId, cwd: meta.cwd ?? "" });
    } catch {
      continue;
    }
  }
  return refs;
}

function parentPid(pid: number): number | null {
  try {
    const out = execFileSync("ps", ["-p", String(pid), "-o", "ppid="], {
      encoding: "utf8",
    }).trim();
    const p = parseInt(out, 10);
    return Number.isFinite(p) && p > 1 ? p : null;
  } catch {
    return null;
  }
}

/**
 * The session this process is running inside, found by walking up the process
 * tree until a pid matches a live session — attributes `crew send` run from an
 * agent's shell to that agent. Null when run from a plain terminal.
 */
function senderSession(refs: SessionRef[]): SessionRef | null {
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
    stream.write(`  ${r.sessionId.slice(0, 8)}  pid ${r.pid}  ${r.cwd}\n`);
  }
}

function runSend(argv: string[]): void {
  let all = false;
  let ttlMs = DEFAULT_TTL_MS;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--all") all = true;
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
      'usage: crew send <shortId|pid|cwd-substring> "message" [--ttl 30m]\n' +
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
  };
  for (const r of targets) sendMessage(r.sessionId, msg);
  const names = targets.map((r) => r.sessionId.slice(0, 8)).join(", ");
  process.stdout.write(
    `crew: queued for ${names} — delivers on their next tool call, turn end, or prompt.\n`,
  );
}

function runInbox(): void {
  const refs = listSessionRefs();
  const me = senderSession(refs);
  if (!me) {
    process.stderr.write("crew: not inside a Claude Code session — no inbox\n");
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
      `${EMOJI[s.status] ?? "⚫"}  ${s.shortId}   pid ${s.pid}   status: ${s.status}`,
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

interface HookInput {
  session_id?: string;
  hook_event_name?: string;
}

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
    `${sessions.length} other Claude Code session(s) running on this machine right now. ` +
      "Consider them before starting overlapping work; run `crew` for the full view.",
  ];
  for (const s of shown) {
    lines.push("");
    lines.push(`• ${s.shortId} — ${s.status || "unknown"} — ${s.cwd}`);
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
    `You can message any of them: \`crew send ${shown[0].shortId} "text"\` drops the text into that agent's context within seconds.`,
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

function renderMessages(messages: Message[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    const when = ago(m.ts);
    lines.push(
      `📨 Message from ${m.fromShort} (${m.fromCwd}${when ? `, sent ${when}` : ""}):`,
    );
    for (const ln of m.text.split("\n")) lines.push(`  ${ln}`);
  }
  const replyTo = messages.map((m) => m.fromShort).find((s) => s !== "human");
  if (replyTo) {
    lines.push(`Reply with: \`crew send ${replyTo} "text"\``);
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
]);

function emitHook(event: string, context: string): void {
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
    const event = HOOK_EVENT_NAMES.has(input.hook_event_name ?? "")
      ? (input.hook_event_name as string)
      : "SessionStart";
    const sid = typeof input.session_id === "string" ? input.session_id : "";
    const messages = sid ? drainInbox(sid) : [];
    // Mid-turn events fire on every tool call machine-wide, so they only
    // deliver mail: one inbox readdir, no session/transcript scan, and total
    // silence (zero tokens) when there's none.
    if (event === "PostToolUse" || event === "Stop") {
      if (messages.length > 0) emitHook(event, renderMessages(messages));
      return;
    }
    if (!opts.tailSet) opts.tailN = 5;
    pruneInboxes();
    const sessions = collectSessions(opts).filter(
      (s) => s.sessionId !== sid && s.pid !== process.ppid,
    );
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
    emitHook(event, [renderMessages(messages), status].filter(Boolean).join("\n\n"));
  } catch {
    // swallow everything; a broken hook must not break the session
  }
}

// ---------- settings commands ----------

function runSettingsCommand(mode: "install-hook" | "uninstall-hook"): void {
  const path = settingsPath();
  const shown = tildify(path);
  try {
    if (mode === "install-hook") {
      const r = installHook(path);
      process.stdout.write(
        r === "installed"
          ? "✓ crew wired into Claude Code — your sessions now see each other. Undo: crew uninstall-hook\n"
          : "✓ already wired — nothing to change.\n",
      );
    } else {
      const r = uninstallHook(path);
      process.stdout.write(
        r === "removed"
          ? "✓ crew hook removed.\n"
          : `crew: no hook found in ${shown} — nothing to remove.\n`,
      );
    }
  } catch (err) {
    process.stderr.write(`crew: ${(err as Error).message}\n`);
    process.exit(1);
  }
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
  const opts = parseArgs(argv);
  if (opts.mode === "install-hook" || opts.mode === "uninstall-hook") {
    runSettingsCommand(opts.mode);
    return;
  }
  if (opts.mode === "hook") {
    runHook(opts);
    return;
  }
  if (!existsSync(SESS_DIR)) {
    process.stderr.write(`crew: no sessions dir at ${SESS_DIR}\n`);
    process.exit(1);
  }
  const sessions = collectSessions(opts);
  const out =
    opts.format === "json" ? renderJson(sessions, opts) : renderText(sessions, opts);
  process.stdout.write(out);
  // The whole point of crew is the auto-injected context; npm hides postinstall
  // output (and ignore-scripts blocks it entirely), so the human view is the one
  // reliable place to tell people the hook isn't wired yet. Text mode only —
  // --json output is consumed by agents.
  if (
    opts.format === "text" &&
    process.env.CREW_NO_HOOK !== "1" &&
    !hookInstalled()
  ) {
    process.stderr.write(
      "\ncrew: context hook not installed — your Claude Code sessions can't see each other yet.\n" +
        `crew: run \`crew install-hook\` to wire \`${HOOK_COMMAND}\` into ${settingsPath()}.\n`,
    );
  }
}

main();
