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
  uninstallHook,
} from "./settings";

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
      "crew — shared context for Claude Code agents",
      "",
      "Hook (auto-injects other sessions into Claude Code context):",
      "  crew --hook [N]       read a hook event on stdin, emit other sessions as",
      "                        additionalContext JSON (default N=5 tail entries)",
      "  crew install-hook     wire `crew --hook` into Claude Code settings.json",
      "  crew uninstall-hook   remove it",
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
    });
  }
  // Most-recently-started first.
  sessions.sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));
  return sessions;
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

function runHook(opts: Opts): void {
  // Never exit non-zero: exit 2 on UserPromptSubmit would block the prompt.
  try {
    const input = readHookInput();
    const event =
      input.hook_event_name === "UserPromptSubmit" ? "UserPromptSubmit" : "SessionStart";
    if (!opts.tailSet) opts.tailN = 5;
    const sid = typeof input.session_id === "string" ? input.session_id : "";
    const sessions = collectSessions(opts).filter(
      (s) => s.sessionId !== sid && s.pid !== process.ppid,
    );
    if (sessions.length === 0) return; // nothing to inject, zero tokens spent
    const context = renderHookContext(sessions);
    if (event === "UserPromptSubmit" && unchangedSinceLastEmit(sid, context)) return;
    rememberEmit(sid, context);
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: event, additionalContext: context },
      }) + "\n",
    );
  } catch {
    // swallow everything; a broken hook must not break the session
  }
}

// ---------- settings commands ----------

function runSettingsCommand(mode: "install-hook" | "uninstall-hook"): void {
  const path = settingsPath();
  try {
    if (mode === "install-hook") {
      const r = installHook(path);
      process.stdout.write(
        r === "installed"
          ? `crew: wired \`${HOOK_COMMAND}\` into ${path} (SessionStart + UserPromptSubmit).\n`
          : `crew: hook already installed in ${path}.\n`,
      );
    } else {
      const r = uninstallHook(path);
      process.stdout.write(
        r === "removed"
          ? `crew: hook removed from ${path}.\n`
          : `crew: no crew hook found in ${path}.\n`,
      );
    }
  } catch (err) {
    process.stderr.write(`crew: ${(err as Error).message}\n`);
    process.exit(1);
  }
}

// ---------- main ----------

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
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
