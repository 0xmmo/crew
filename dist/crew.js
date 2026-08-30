#!/usr/bin/env node
"use strict";
/**
 * crew — shared context for Claude Code and Codex agents.
 *
 * First and foremost an agent hook: `crew --hook` reads the hook event on
 * stdin and emits what your other running sessions are doing (status, recap,
 * transcript tail) as additionalContext, so every session automatically sees
 * the rest of the crew. Also a CLI for watching the same thing yourself.
 *
 * Claude sessions are discovered from Claude's live PID registry. Claude and
 * Codex hooks also maintain a tiny product-neutral live registry, which lets
 * sessions from both products share one view and mailbox.
 *
 *   crew --hook          hook mode: emit other sessions as additionalContext JSON
 *   crew install-hook    wire `crew --hook` into Claude Code and Codex
 *   crew uninstall-hook  remove it
 *   crew send <t> "msg"  message another session (delivered via its hook)
 *   crew send -k <t> ... kickstart: force the target to act on the message
 *   crew inbox           peek at this session's pending messages
 *   crew                 human view, last 50 transcript entries per session
 *   crew 10              human view, last 10 entries
 *   crew --json          NDJSON: one structured object per session (agent-friendly)
 *   crew --json --full   NDJSON with untruncated tool input/output
 *   crew --help
 */
Object.defineProperty(exports, "__esModule", { value: true });
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const node_os_1 = require("node:os");
const node_crypto_1 = require("node:crypto");
const settings_1 = require("./settings");
const mailbox_1 = require("./mailbox");
const registry_1 = require("./registry");
const CLAUDE_HOME = process.env.CLAUDE_HOME || (0, node_path_1.join)((0, node_os_1.homedir)(), ".claude");
const SESS_DIR = (0, node_path_1.join)(CLAUDE_HOME, "sessions");
const PROJ_DIR = (0, node_path_1.join)(CLAUDE_HOME, "projects");
// ---------- plugin awareness ----------
function onPath(bin) {
    for (const dir of (process.env.PATH || "").split(":")) {
        if (!dir)
            continue;
        try {
            (0, node_fs_1.accessSync)((0, node_path_1.join)(dir, bin), node_fs_1.constants.X_OK);
            return true;
        }
        catch {
            // keep looking
        }
    }
    return false;
}
// When crew runs as a Claude/Codex plugin hook and
// there is no global `crew` on PATH, emitted guidance must name a command
// agents can actually run: the plugin's own entry point.
let cachedCliCmd = null;
function cliCmd() {
    if (cachedCliCmd === null) {
        const root = process.env.PLUGIN_ROOT || process.env.CLAUDE_PLUGIN_ROOT;
        cachedCliCmd =
            root && !onPath("crew")
                ? `node "${(0, node_path_1.join)(root, "dist", "crew.js")}"`
                : "crew";
    }
    return cachedCliCmd;
}
function parseArgs(argv) {
    const opts = {
        mode: "list",
        format: "text",
        full: false,
        tailN: 50,
        tailSet: false,
        dir: null,
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--json")
            opts.format = "json";
        else if (a === "--full")
            opts.full = true;
        else if (a === "--hook")
            opts.mode = "hook";
        else if (a === "install-hook")
            opts.mode = "install-hook";
        else if (a === "uninstall-hook")
            opts.mode = "uninstall-hook";
        else if (a === "--dir") {
            // Optional path; bare `--dir` means the current directory.
            const next = argv[i + 1];
            if (next && !next.startsWith("-") && !/^\d+$/.test(next)) {
                opts.dir = (0, node_path_1.resolve)(next);
                i++;
            }
            else {
                opts.dir = process.cwd();
            }
        }
        else if (a === "-h" || a === "--help") {
            printHelp();
            process.exit(0);
        }
        else if (/^\d+$/.test(a)) {
            opts.tailN = parseInt(a, 10);
            opts.tailSet = true;
        }
        else {
            process.stderr.write(`crew: unknown argument '${a}'\n`);
            printHelp();
            process.exit(2);
        }
    }
    return opts;
}
/** True if cwd is dir or a descendant of it. dir=null matches everything. */
function underDir(cwd, dir) {
    if (!dir)
        return true;
    const strip = (p) => (p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p);
    const c = strip(cwd);
    const d = strip(dir);
    return c === d || c.startsWith(d + "/");
}
function printHelp() {
    process.stdout.write([
        "crew — shared context and messaging for Claude Code and Codex agents",
        "",
        "Hook (auto-injects other sessions into agent context):",
        "  crew --hook [N]       read a hook event on stdin, emit other sessions as",
        "                        additionalContext JSON (default N=5 tail entries)",
        "  crew install-hook     wire `crew --hook` into Claude Code and Codex",
        "  crew uninstall-hook   remove it from both",
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
        "  CREW_HOME             override shared state at ~/.crew",
        "  CREW_NO_HOOK=1        skip hook auto-install on `npm i -g`",
        "",
    ].join("\n"));
}
// ---------- helpers ----------
const STRIP = [
    /<system-reminder>[\s\S]*?<\/system-reminder>/g,
    /<command-[^>]*>[\s\S]*?<\/command-[^>]*>/g,
    /<local-command-[^>]*>[\s\S]*?<\/local-command-[^>]*>/g,
];
function clean(s) {
    for (const r of STRIP)
        s = s.replace(r, "");
    return s.trim();
}
function trunc(s, n, full) {
    if (full)
        return s;
    const flat = s.replace(/\s+/g, " ").trim();
    return flat.length <= n ? flat : flat.slice(0, n - 1) + "…";
}
function localHHMM(ts) {
    if (!ts)
        return "     ";
    const d = new Date(ts);
    if (isNaN(d.getTime()))
        return "     ";
    return d.toTimeString().slice(0, 5);
}
/** Claude encodes a session's cwd into the projects dir name: / and . become -. */
function encodeCwd(cwd) {
    return cwd.replace(/[/.]/g, "-");
}
function findTranscript(cwd, sid) {
    const derived = (0, node_path_1.join)(PROJ_DIR, encodeCwd(cwd), `${sid}.jsonl`);
    if ((0, node_fs_1.existsSync)(derived))
        return derived;
    // Fallback: scan project dirs for <sid>.jsonl.
    let dirs;
    try {
        dirs = (0, node_fs_1.readdirSync)(PROJ_DIR);
    }
    catch {
        return null;
    }
    for (const d of dirs) {
        const p = (0, node_path_1.join)(PROJ_DIR, d, `${sid}.jsonl`);
        if ((0, node_fs_1.existsSync)(p))
            return p;
    }
    return null;
}
/** Parse a Claude transcript jsonl into the recap and ordered entries. */
function parseClaudeTranscript(path) {
    const out = { recap: null, total: 0, entries: [] };
    if (!path)
        return out;
    let raw;
    try {
        raw = (0, node_fs_1.readFileSync)(path, "utf8");
    }
    catch {
        return out;
    }
    for (const line of raw.split("\n")) {
        const s = line.trim();
        if (!s)
            continue;
        let d;
        try {
            d = JSON.parse(s);
        }
        catch {
            continue;
        }
        const typ = d.type;
        if (typ === "system" && d.subtype === "away_summary") {
            out.recap = d.content ?? "";
            continue;
        }
        if (typ !== "user" && typ !== "assistant")
            continue;
        const msg = d.message ?? {};
        const role = msg.role ?? typ;
        const ts = d.timestamp ?? null;
        const content = msg.content;
        if (typeof content === "string") {
            const c = clean(content);
            if (c) {
                out.entries.push({ ts, role, kind: "text", text: c });
                out.total++;
            }
            continue;
        }
        if (!Array.isArray(content))
            continue;
        for (const b of content) {
            if (!b || typeof b !== "object")
                continue;
            if (b.type === "text") {
                const c = clean(b.text ?? "");
                if (c) {
                    out.entries.push({ ts, role, kind: "text", text: c });
                    out.total++;
                }
            }
            else if (b.type === "tool_use") {
                const inp = b.input ?? {};
                const desc = inp.description ?? inp.command ?? inp.pattern ?? inp.file_path ?? inp.prompt ?? "";
                out.entries.push({
                    ts,
                    role,
                    kind: "tool_use",
                    name: b.name ?? "?",
                    summary: String(desc),
                });
                out.total++;
            }
            else if (b.type === "tool_result") {
                let cont = b.content ?? "";
                if (Array.isArray(cont)) {
                    cont = cont
                        .filter((x) => x && x.type === "text")
                        .map((x) => x.text ?? "")
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
function textFromCodexOutput(value) {
    if (typeof value === "string")
        return value;
    if (Array.isArray(value)) {
        return value
            .map((item) => {
            if (typeof item === "string")
                return item;
            if (!item || typeof item !== "object")
                return "";
            const block = item;
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
        const obj = value;
        for (const key of ["text", "output", "content"]) {
            if (typeof obj[key] === "string")
                return obj[key];
        }
        try {
            return JSON.stringify(value);
        }
        catch {
            return "";
        }
    }
    return "";
}
function codexToolSummary(raw) {
    let value = raw;
    if (typeof raw === "string") {
        try {
            value = JSON.parse(raw);
        }
        catch {
            return raw;
        }
    }
    if (!value || typeof value !== "object")
        return String(value ?? "");
    const obj = value;
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
        if (typeof candidate === "string")
            return candidate;
        if (Array.isArray(candidate))
            return candidate.map(String).join(" ");
    }
    try {
        return JSON.stringify(value);
    }
    catch {
        return "";
    }
}
/**
 * Parse the useful, user-visible subset of a Codex rollout. The rollout is a
 * convenience input rather than a stable API, so unknown records are skipped.
 */
function parseCodexTranscript(path) {
    const out = { recap: null, total: 0, entries: [] };
    if (!path)
        return out;
    let raw;
    try {
        raw = (0, node_fs_1.readFileSync)(path, "utf8");
    }
    catch {
        return out;
    }
    for (const line of raw.split("\n")) {
        const s = line.trim();
        if (!s)
            continue;
        let record;
        try {
            record = JSON.parse(s);
        }
        catch {
            continue;
        }
        const ts = record.timestamp ?? null;
        const payload = record.payload ?? {};
        if (record.type === "event_msg") {
            if (payload.type === "task_complete" && typeof payload.last_agent_message === "string") {
                out.recap = clean(payload.last_agent_message);
                continue;
            }
            if (payload.type !== "user_message" && payload.type !== "agent_message")
                continue;
            const text = clean(typeof payload.message === "string" ? payload.message : "");
            if (!text)
                continue;
            out.entries.push({
                ts,
                role: payload.type === "user_message" ? "user" : "assistant",
                kind: "text",
                text,
            });
            out.total++;
            continue;
        }
        if (record.type !== "response_item")
            continue;
        const type = payload.type;
        if (type === "function_call" ||
            type === "custom_tool_call" ||
            type === "local_shell_call" ||
            type === "web_search_call") {
            out.entries.push({
                ts,
                role: "assistant",
                kind: "tool_use",
                name: payload.name ?? (type === "web_search_call" ? "web_search" : type),
                summary: codexToolSummary(payload.arguments ?? payload.input ?? payload.command ?? payload.action ?? ""),
            });
            out.total++;
            continue;
        }
        if (type === "function_call_output" ||
            type === "custom_tool_call_output" ||
            type === "local_shell_call_output") {
            const text = clean(textFromCodexOutput(payload.output));
            if (!text)
                continue;
            out.entries.push({ ts, role: "tool", kind: "tool_result", text });
            out.total++;
        }
    }
    return out;
}
function parseTranscript(agent, path) {
    return agent === "codex"
        ? parseCodexTranscript(path)
        : parseClaudeTranscript(path);
}
// ---------- discovery ----------
function liveClaudePid(pid) {
    const command = (0, registry_1.processCommand)(pid);
    if (command !== null)
        return /(^|[\s/])claude(?:\s|$)/i.test(command);
    return (0, registry_1.processExists)(pid);
}
function collectClaudeSessions(opts) {
    let files;
    try {
        files = (0, node_fs_1.readdirSync)(SESS_DIR).filter((f) => f.endsWith(".json"));
    }
    catch {
        return [];
    }
    const sessions = [];
    for (const f of files) {
        let meta;
        try {
            meta = JSON.parse((0, node_fs_1.readFileSync)((0, node_path_1.join)(SESS_DIR, f), "utf8"));
        }
        catch {
            continue;
        }
        const pid = Number(meta.pid);
        if (!pid)
            continue;
        const cwd = meta.cwd ?? "";
        if (!underDir(cwd, opts.dir))
            continue; // outside the requested directory
        if (!liveClaudePid(pid))
            continue;
        const sid = meta.sessionId ?? "";
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
            startedAt: typeof meta.startedAt === "number"
                ? new Date(meta.startedAt).toISOString()
                : null,
            transcript,
            recap: parsed.recap,
            messageCount: parsed.total,
            tailCount: tail.length,
            tail,
            pendingMessages: (0, mailbox_1.pendingCount)(sid),
        });
    }
    return sessions;
}
function collectSessions(opts) {
    const byId = new Map();
    for (const session of collectClaudeSessions(opts)) {
        byId.set(session.sessionId, session);
    }
    for (const meta of (0, registry_1.registeredSessions)()) {
        if (byId.has(meta.sessionId) || !underDir(meta.cwd, opts.dir))
            continue;
        const parsed = parseTranscript(meta.agent, meta.transcript);
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
            pendingMessages: (0, mailbox_1.pendingCount)(meta.sessionId),
        });
    }
    return [...byId.values()].sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));
}
/** Lightweight cross-product live-session list (no transcript parsing). */
function listSessionRefs() {
    const byId = new Map();
    let files;
    try {
        files = (0, node_fs_1.readdirSync)(SESS_DIR).filter((f) => f.endsWith(".json"));
    }
    catch {
        files = [];
    }
    for (const f of files) {
        try {
            const meta = JSON.parse((0, node_fs_1.readFileSync)((0, node_path_1.join)(SESS_DIR, f), "utf8"));
            const pid = Number(meta.pid);
            if (!pid || typeof meta.sessionId !== "string")
                continue;
            if (!liveClaudePid(pid))
                continue;
            byId.set(meta.sessionId, {
                pid,
                sessionId: meta.sessionId,
                agent: "claude",
                cwd: meta.cwd ?? "",
                status: typeof meta.status === "string" ? meta.status : "",
            });
        }
        catch {
            continue;
        }
    }
    for (const session of (0, registry_1.registeredSessions)()) {
        if (byId.has(session.sessionId))
            continue;
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
function senderSession(refs) {
    const envSid = process.env.CODEX_THREAD_ID || process.env.CLAUDE_SESSION_ID;
    if (envSid) {
        const exact = refs.find((ref) => ref.sessionId === envSid);
        if (exact)
            return exact;
    }
    const byPid = new Map(refs.map((r) => [r.pid, r]));
    let pid = process.ppid;
    for (let depth = 0; pid && depth < 15; depth++) {
        const hit = byPid.get(pid);
        if (hit)
            return hit;
        pid = (0, registry_1.parentPid)(pid);
    }
    return null;
}
function parseTtl(s) {
    const m = /^(\d+)([smhd])$/.exec(s);
    if (!m)
        return null;
    const mult = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
    return parseInt(m[1], 10) * mult[m[2]];
}
function listRefsTo(stream, refs) {
    for (const r of refs) {
        stream.write(`  ${r.sessionId.slice(0, 8)}  ${r.agent}  pid ${r.pid}  ${r.cwd}\n`);
    }
}
function runSend(argv) {
    let all = false;
    let kickstart = false;
    let ttlMs = mailbox_1.DEFAULT_TTL_MS;
    const rest = [];
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--all")
            all = true;
        else if (a === "--kickstart" || a === "-k")
            kickstart = true;
        else if (a === "--ttl") {
            const parsed = parseTtl(argv[++i] ?? "");
            if (parsed === null) {
                process.stderr.write("crew: --ttl wants e.g. 90s, 30m, 2h, 1d\n");
                process.exit(2);
            }
            ttlMs = parsed;
        }
        else
            rest.push(a);
    }
    const target = all ? null : rest.shift();
    const text = rest.join(" ").trim();
    if ((!all && !target) || !text) {
        process.stderr.write('usage: crew send <shortId|pid|cwd-substring> "message" [--ttl 30m] [--kickstart]\n' +
            '       crew send --all "message"\n');
        process.exit(2);
    }
    const refs = listSessionRefs();
    const me = senderSession(refs);
    const others = refs.filter((r) => r.sessionId !== me?.sessionId);
    let targets;
    if (all) {
        targets = others;
        if (targets.length === 0) {
            process.stderr.write("crew: no other live sessions\n");
            process.exit(1);
        }
    }
    else {
        const t = target;
        const matches = others.filter((r) => r.sessionId.startsWith(t) ||
            String(r.pid) === t ||
            (t.length >= 3 && r.cwd.includes(t)));
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
    const msg = {
        ts: new Date(now).toISOString(),
        from: me?.sessionId ?? "human",
        fromShort: me ? me.sessionId.slice(0, 8) : "human",
        fromCwd: me?.cwd ?? process.cwd(),
        text,
        expiresAt: new Date(now + ttlMs).toISOString(),
        ...(kickstart ? { kickstart: true } : {}),
    };
    for (const r of targets)
        (0, mailbox_1.sendMessage)(r.sessionId, msg);
    const names = targets.map((r) => r.sessionId.slice(0, 8)).join(", ");
    if (kickstart) {
        // A kickstart force-continues the target when its Stop hook next fires. A
        // busy agent hits that the moment its current turn ends; an already-idle
        // agent has no upcoming Stop, so warn that it can't be woken from outside.
        const idle = targets.filter((r) => r.status === "idle");
        for (const r of idle) {
            process.stderr.write(`⚠️  crew: ${r.sessionId.slice(0, 8)} is idle — kickstart can't wake a stopped session ` +
                `from outside. It'll act on this the instant it next runs; queued as normal mail until then.\n`);
        }
        process.stdout.write(`crew: kickstart queued for ${names} — force-continues each onto this message when its Stop hook next fires.\n`);
    }
    else {
        process.stdout.write(`crew: queued for ${names} — delivers on their next tool call, turn end, or prompt.\n`);
    }
}
function runInbox() {
    const refs = listSessionRefs();
    const me = senderSession(refs);
    if (!me) {
        process.stderr.write("crew: not inside a known agent session — no inbox\n");
        process.exit(1);
    }
    const msgs = (0, mailbox_1.peekInbox)(me.sessionId);
    if (msgs.length === 0) {
        process.stdout.write("crew: inbox empty\n");
        return;
    }
    for (const m of msgs) {
        process.stdout.write(`${m.ts}  ${m.fromShort} (${m.fromCwd}): ${m.text}\n`);
    }
}
// ---------- rendering ----------
const EMOJI = {
    busy: "🔵",
    idle: "⚪",
    shell: "🟡",
};
function renderText(sessions, opts) {
    const lines = [];
    for (const s of sessions) {
        lines.push("\n════════════════════════════════════════════════════════════════════");
        lines.push(`${EMOJI[s.status] ?? "⚫"}  ${s.shortId}   ${s.agent}   pid ${s.pid}   status: ${s.status}`);
        const started = s.startedAt
            ? new Date(s.startedAt).toLocaleString()
            : "?";
        lines.push(`   cwd: ${s.cwd}`);
        lines.push(`   started: ${started}\n`);
        if (s.pendingMessages > 0) {
            lines.push(`   📨 ${s.pendingMessages} pending message(s) awaiting delivery\n`);
        }
        lines.push(`   recap: ${s.recap ?? "(no recap recorded yet)"}`);
        lines.push(`\n   last ${s.tailCount} transcript entries (of ${s.messageCount}):`);
        for (const e of s.tail) {
            const t = localHHMM(e.ts);
            if (e.kind === "tool_use") {
                lines.push(`   ${t} ⚙ ${e.name}: ${trunc(e.summary ?? "", 200, opts.full)}`);
            }
            else if (e.kind === "tool_result") {
                lines.push(`   ${t} ⟲ ${trunc(e.text ?? "", 200, opts.full)}`);
            }
            else {
                const glyph = e.role === "user" ? "›" : "‹";
                for (const ln of (e.text ?? "").split("\n")) {
                    if (ln.trim())
                        lines.push(`   ${t} ${glyph} ${ln.trimEnd()}`);
                }
            }
        }
    }
    lines.push("\n────────────────────────────────────────────────────────────────────");
    lines.push(`${sessions.length} active session(s).`);
    return lines.join("\n") + "\n";
}
function renderJson(sessions, opts) {
    // NDJSON: one object per line. Tool fields truncated unless --full.
    return (sessions
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
        .join("\n") + "\n");
}
function readHookInput() {
    if (process.stdin.isTTY)
        return {};
    try {
        const raw = (0, node_fs_1.readFileSync)(0, "utf8");
        const parsed = raw.trim() ? JSON.parse(raw) : {};
        return typeof parsed === "object" && parsed !== null ? parsed : {};
    }
    catch {
        return {};
    }
}
function renderHookContext(sessions) {
    const MAX_SESSIONS = 8;
    const shown = sessions.slice(0, MAX_SESSIONS);
    const lines = [
        `${sessions.length} other agent session(s) running on this machine right now. ` +
            `Consider them before starting overlapping work; run \`${cliCmd()}\` for the full view.`,
    ];
    for (const s of shown) {
        lines.push("");
        lines.push(`• ${s.shortId} — ${s.agent} — ${s.status || "unknown"} — ${s.cwd}`);
        if (s.recap)
            lines.push(`  recap: ${trunc(s.recap, 300, false)}`);
        for (const e of s.tail) {
            const t = localHHMM(e.ts);
            if (e.kind === "tool_use") {
                lines.push(`  ${t} ⚙ ${e.name}: ${trunc(e.summary ?? "", 120, false)}`);
            }
            else if (e.kind === "tool_result") {
                lines.push(`  ${t} ⟲ ${trunc(e.text ?? "", 160, false)}`);
            }
            else {
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
    lines.push(`You can message any of them: \`${cliCmd()} send ${shown[0].shortId} "text"\` drops the text into that agent's context within seconds.`);
    return lines.join("\n");
}
function ago(ts) {
    const ms = Date.now() - Date.parse(ts);
    if (!Number.isFinite(ms) || ms < 0)
        return "";
    const min = Math.round(ms / 60_000);
    if (min < 1)
        return "just now";
    if (min < 60)
        return `${min}m ago`;
    const h = Math.round(min / 60);
    if (h < 24)
        return `${h}h ago`;
    return `${Math.round(h / 24)}d ago`;
}
function renderMessages(messages, kickstart = false) {
    const lines = [];
    if (kickstart) {
        lines.push("A crew message asked you to keep working rather than go idle. Act on it now:");
    }
    for (const m of messages) {
        const when = ago(m.ts);
        lines.push(`📨 Message from ${m.fromShort} (${m.fromCwd}${when ? `, sent ${when}` : ""}):`);
        for (const ln of m.text.split("\n"))
            lines.push(`  ${ln}`);
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
function emitStampPath(sid) {
    const safe = (sid || "unknown").replace(/[^a-zA-Z0-9-]/g, "_");
    return (0, node_path_1.join)((0, node_os_1.tmpdir)(), `crew-hook-${safe}`);
}
function contextHash(context) {
    return (0, node_crypto_1.createHash)("sha256").update(context).digest("hex");
}
function unchangedSinceLastEmit(sid, context) {
    try {
        return (0, node_fs_1.readFileSync)(emitStampPath(sid), "utf8") === contextHash(context);
    }
    catch {
        return false;
    }
}
function rememberEmit(sid, context) {
    try {
        (0, node_fs_1.writeFileSync)(emitStampPath(sid), contextHash(context));
    }
    catch {
        // best effort; worst case we re-emit next prompt
    }
}
const HOOK_EVENT_NAMES = new Set([
    "SessionStart",
    "UserPromptSubmit",
    "PostToolUse",
    "Stop",
]);
function emitHook(agent, event, context, forceContinue = false) {
    // Codex Stop always uses a continuation reason rather than additionalContext,
    // which makes pending mail model-visible before the session becomes idle. A
    // kickstart message forces the same continuation on Claude, turning the
    // message into a directive the agent acts on instead of stopping.
    if (event === "Stop" && (agent === "codex" || forceContinue)) {
        process.stdout.write(JSON.stringify({ decision: "block", reason: context }) + "\n");
        return;
    }
    process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: event, additionalContext: context },
    }) + "\n");
}
function runHook(opts) {
    // Never exit non-zero: exit 2 on UserPromptSubmit would block the prompt,
    // and on Stop it would force the agent to continue.
    try {
        const input = readHookInput();
        const agent = (0, registry_1.recordHookSession)(input);
        // Installed both ways (plugin + user hook)? Defer to the global hook so
        // context is never injected twice. Only defer when `crew` resolves.
        if ((process.env.PLUGIN_ROOT || process.env.CLAUDE_PLUGIN_ROOT) &&
            onPath("crew") &&
            (0, settings_1.hookInstalled)(agent)) {
            return;
        }
        const event = HOOK_EVENT_NAMES.has(input.hook_event_name ?? "")
            ? input.hook_event_name
            : "SessionStart";
        const sid = typeof input.session_id === "string" ? input.session_id : "";
        const messages = sid ? (0, mailbox_1.drainInbox)(sid) : [];
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
        if (!opts.tailSet)
            opts.tailN = 5;
        (0, mailbox_1.pruneInboxes)();
        const sessions = collectSessions(opts).filter((s) => s.sessionId !== sid);
        const status = sessions.length > 0 ? renderHookContext(sessions) : "";
        if (!status && messages.length === 0)
            return; // nothing to inject, zero tokens spent
        // The unchanged-status throttle only applies to the status block; queued
        // messages always deliver.
        if (event === "UserPromptSubmit" &&
            messages.length === 0 &&
            unchangedSinceLastEmit(sid, status)) {
            return;
        }
        if (status)
            rememberEmit(sid, status);
        emitHook(agent, event, [renderMessages(messages), status].filter(Boolean).join("\n\n"));
    }
    catch {
        // swallow everything; a broken hook must not break the session
    }
}
// ---------- settings commands ----------
function runSettingsCommand(mode) {
    const labels = { claude: "Claude Code", codex: "Codex" };
    let failed = false;
    for (const agent of ["claude", "codex"]) {
        const shown = (0, settings_1.tildify)((0, settings_1.settingsPath)(agent));
        try {
            if (mode === "install-hook") {
                const result = (0, settings_1.installHook)(agent);
                process.stdout.write(result === "installed"
                    ? `✓ crew wired into ${labels[agent]} (${shown}).\n`
                    : `✓ ${labels[agent]} already wired — nothing to change.\n`);
            }
            else {
                const result = (0, settings_1.uninstallHook)(agent);
                process.stdout.write(result === "removed"
                    ? `✓ crew hook removed from ${labels[agent]}.\n`
                    : `crew: no hook found in ${shown} — nothing to remove.\n`);
            }
        }
        catch (err) {
            failed = true;
            process.stderr.write(`crew: ${labels[agent]}: ${err.message}\n`);
        }
    }
    if (failed)
        process.exitCode = 1;
}
// ---------- main ----------
function main() {
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
    const sessions = collectSessions(opts);
    const out = opts.format === "json" ? renderJson(sessions, opts) : renderText(sessions, opts);
    process.stdout.write(out);
    // The whole point of crew is the auto-injected context; npm hides postinstall
    // output (and ignore-scripts blocks it entirely), so the human view is the one
    // reliable place to tell people the hook isn't wired yet. Text mode only —
    // --json output is consumed by agents.
    if (opts.format === "text" &&
        process.env.CREW_NO_HOOK !== "1" &&
        (!(0, settings_1.hookInstalled)("claude") || !(0, settings_1.hookInstalled)("codex"))) {
        const missing = ["claude", "codex"]
            .filter((agent) => !(0, settings_1.hookInstalled)(agent))
            .map((agent) => (agent === "claude" ? "Claude Code" : "Codex"))
            .join(" and ");
        process.stderr.write(`\ncrew: context hook not installed for ${missing}.\n` +
            `crew: run \`crew install-hook\` to wire \`${settings_1.HOOK_COMMAND}\` into both agents.\n`);
    }
}
main();
