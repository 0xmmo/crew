"use strict";
/**
 * A small product-neutral live-session registry maintained by crew's hooks.
 *
 * Claude has its own PID registry; Codex intentionally exposes session data to
 * hooks instead. Recording the common hook fields gives both products one
 * discovery mechanism without scanning historical Codex rollouts or relying
 * on platform-specific open-file tools.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.processCommand = processCommand;
exports.parentPid = parentPid;
exports.processExists = processExists;
exports.hookAgent = hookAgent;
exports.recordHookSession = recordHookSession;
exports.removeSession = removeSession;
exports.registeredSessions = registeredSessions;
const node_fs_1 = require("node:fs");
const node_child_process_1 = require("node:child_process");
const node_path_1 = require("node:path");
const home_1 = require("./home");
const SESSION_ROOT = (0, node_path_1.join)((0, home_1.crewHome)(), "sessions");
const MAX_STALE_MS = 36 * 60 * 60 * 1000;
/** Returns the process command line, or null when dead or inaccessible. */
function processCommand(pid) {
    try {
        return (0, node_child_process_1.execFileSync)("ps", ["-p", String(pid), "-o", "command="], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        }).trim();
    }
    catch {
        return null;
    }
}
function parentPid(pid) {
    try {
        const out = (0, node_child_process_1.execFileSync)("ps", ["-p", String(pid), "-o", "ppid="], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        const parent = parseInt(out, 10);
        return Number.isFinite(parent) && parent > 1 ? parent : null;
    }
    catch {
        return null;
    }
}
/** EPERM still proves a PID exists inside an agent sandbox. */
function processExists(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (err) {
        return err.code === "EPERM";
    }
}
function agentForCommand(command) {
    if (/(^|[\s/])opencode(?:\s|$)/i.test(command))
        return "opencode";
    if (/(^|[\s/])codex(?:\s|$)|Codex\.app\//i.test(command))
        return "codex";
    if (/(^|[\s/])claude(?:\s|$)|Claude\.app\//i.test(command))
        return "claude";
    return null;
}
function isAgent(value) {
    return value === "claude" || value === "codex" || value === "opencode";
}
/**
 * crew's own adapters (the OpenCode plugin) identify themselves via env when
 * spawning `crew --hook`, which beats process-tree guessing and still works
 * where `ps` is blocked.
 */
function envAgent() {
    const agent = process.env.CREW_AGENT;
    const pid = Number(process.env.CREW_PID);
    if (!isAgent(agent) || !Number.isFinite(pid) || pid <= 0)
        return null;
    return { pid, agent };
}
function agentAncestor() {
    let pid = process.ppid;
    for (let depth = 0; pid && depth < 15; depth++) {
        const agent = agentForCommand(processCommand(pid) ?? "");
        if (agent)
            return { pid, agent };
        pid = parentPid(pid);
    }
    return null;
}
/** Infer the product even if process inspection is blocked. */
function hookAgent(input, ancestorAgent) {
    const declared = envAgent();
    if (declared)
        return declared.agent;
    const transcript = input.transcript_path ?? "";
    if ((process.env.CODEX_THREAD_ID &&
        process.env.CODEX_THREAD_ID === input.session_id) ||
        /[/\\]\.codex[/\\]sessions[/\\]/.test(transcript) ||
        /[/\\]rollout-[^/\\]+\.jsonl$/.test(transcript)) {
        return "codex";
    }
    return ancestorAgent ?? agentAncestor()?.agent ?? "claude";
}
function registryPath(sid) {
    return (0, node_path_1.join)(SESSION_ROOT, `${(0, home_1.safeSessionId)(sid)}.json`);
}
function readRegistered(path) {
    try {
        const value = JSON.parse((0, node_fs_1.readFileSync)(path, "utf8"));
        if (!value ||
            typeof value.sessionId !== "string" ||
            !isAgent(value.agent) ||
            !Number.isFinite(value.pid)) {
            return null;
        }
        return value;
    }
    catch {
        return null;
    }
}
/** Refresh the current top-level hook session and return its product. */
function recordHookSession(input) {
    const ancestor = envAgent() ?? agentAncestor();
    const inferred = hookAgent(input, ancestor?.agent);
    const sid = typeof input.session_id === "string" ? input.session_id : "";
    if (!sid)
        return inferred;
    const agent = ancestor?.agent ?? inferred;
    // A short-lived shell/Node hook PID is not useful for liveness. If ancestry
    // cannot be inspected, leave any previous good record in place.
    if (!ancestor)
        return agent;
    const path = registryPath(sid);
    const previous = readRegistered(path);
    const now = new Date().toISOString();
    const event = input.hook_event_name ?? "";
    const status = event === "Stop" ? "idle" : event === "SessionStart" ? "idle" : "busy";
    const session = {
        pid: ancestor.pid,
        sessionId: sid,
        agent,
        status,
        cwd: typeof input.cwd === "string" ? (0, node_path_1.resolve)(input.cwd) : previous?.cwd ?? "",
        startedAt: previous?.startedAt ?? now,
        lastSeen: now,
        transcript: typeof input.transcript_path === "string"
            ? input.transcript_path
            : previous?.transcript ?? null,
    };
    try {
        (0, node_fs_1.mkdirSync)(SESSION_ROOT, { recursive: true });
        const tmp = `${path}.${process.pid}.tmp`;
        (0, node_fs_1.writeFileSync)(tmp, JSON.stringify(session));
        (0, node_fs_1.renameSync)(tmp, path);
    }
    catch {
        // Registration is best-effort; hooks must never block an agent.
    }
    return agent;
}
/** Drop a session's registry record (its product reported the session ended). */
function removeSession(sid) {
    if (!sid)
        return;
    try {
        (0, node_fs_1.unlinkSync)(registryPath(sid));
    }
    catch {
        // already gone or never registered
    }
}
/** List live hook-registered sessions and prune dead/stale records. */
function registeredSessions() {
    let files;
    try {
        files = (0, node_fs_1.readdirSync)(SESSION_ROOT).filter((file) => file.endsWith(".json"));
    }
    catch {
        return [];
    }
    const live = [];
    const cutoff = Date.now() - MAX_STALE_MS;
    for (const file of files) {
        const path = (0, node_path_1.join)(SESSION_ROOT, file);
        const session = readRegistered(path);
        const seen = Date.parse(session?.lastSeen ?? "");
        if (!session ||
            !Number.isFinite(seen) ||
            seen < cutoff ||
            !processExists(session.pid)) {
            try {
                (0, node_fs_1.unlinkSync)(path);
            }
            catch { }
            continue;
        }
        live.push(session);
    }
    return live;
}
