#!/usr/bin/env node
/**
 * crew — list active Claude Code sessions with status, recap, and a transcript tail.
 *
 * Every interactive Claude Code session writes ~/.claude/sessions/<pid>.json while
 * running. crew reads those, keeps the ones whose pid is still a live `claude`
 * process, then pulls each session's recap (the latest `away_summary`) and a tail
 * of its transcript.
 *
 *   crew                 human view, last 50 transcript entries per session
 *   crew 10              human view, last 10 entries
 *   crew --json          NDJSON: one structured object per session (agent-friendly)
 *   crew --json --full   NDJSON with untruncated tool input/output
 *   crew --help
 */

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";

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

interface Opts {
  format: "text" | "json";
  full: boolean;
  tailN: number;
  dir: string | null;
}

function parseArgs(argv: string[]): Opts {
  const opts: Opts = { format: "text", full: false, tailN: 50, dir: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") opts.format = "json";
    else if (a === "--full") opts.full = true;
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
    } else if (/^\d+$/.test(a)) opts.tailN = parseInt(a, 10);
    else {
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
      "crew — simple multi-agent collaboration for Claude Code",
      "",
      "Usage:",
      "  crew [N]              human view, last N transcript entries (default 50)",
      "  crew --json [N]       NDJSON, one object per session (agent-consumable)",
      "  crew --json --full    NDJSON without tool input/output truncation",
      "  crew --dir [path]     only sessions under <path> (default: current dir)",
      "  crew --help",
      "",
      "Env:",
      "  CLAUDE_HOME           override ~/.claude",
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

// ---------- main ----------

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  if (!existsSync(SESS_DIR)) {
    process.stderr.write(`crew: no sessions dir at ${SESS_DIR}\n`);
    process.exit(1);
  }
  const sessions = collectSessions(opts);
  const out =
    opts.format === "json" ? renderJson(sessions, opts) : renderText(sessions, opts);
  process.stdout.write(out);
}

main();
