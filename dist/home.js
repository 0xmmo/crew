"use strict";
/**
 * home.ts — the single source of truth for every path crew touches.
 *
 * Config and the live-session registry live in ~/.crew: durable, private, and
 * only ever written by the CLI and hooks. The mailbox does not live there.
 * Agents commonly run under sandboxes that deny writes anywhere under $HOME,
 * so `crew send` would fail with EPERM while discovery and context hooks kept
 * working — crew looked healthy while messaging was dead. Mail therefore goes
 * to a per-uid directory under /tmp, which sandboxes conventionally leave
 * writable.
 *
 * The CLI, the hooks, and the generated OpenCode plugin all resolve through
 * here. A message written where its reader is not looking is a silent drop,
 * so there is exactly one definition of each location.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.crewVersion = crewVersion;
exports.crewHome = crewHome;
exports.legacyCrewHome = legacyCrewHome;
exports.inboxLocation = inboxLocation;
exports.inboxRoot = inboxRoot;
exports.legacyInboxRoots = legacyInboxRoots;
exports.inboxRoots = inboxRoots;
exports.safeSessionId = safeSessionId;
const node_fs_1 = require("node:fs");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
/** This build's version, from the package.json one level above dist/. */
function crewVersion() {
    try {
        return JSON.parse((0, node_fs_1.readFileSync)((0, node_path_1.join)(__dirname, "..", "package.json"), "utf8")).version;
    }
    catch {
        return "unknown";
    }
}
/** Product-neutral config and session registry, shared by all three products. */
function crewHome() {
    return (0, node_path_1.resolve)(process.env.CREW_HOME || (0, node_path_1.join)((0, node_os_1.homedir)(), ".crew"));
}
/** Product state dir used by crew <= 0.2.x; its inbox is kept readable. */
function legacyCrewHome() {
    const claudeHome = process.env.CLAUDE_HOME || (0, node_path_1.join)((0, node_os_1.homedir)(), ".claude");
    return (0, node_path_1.resolve)((0, node_path_1.join)(claudeHome, "crew"));
}
/**
 * Deliberately not os.tmpdir(): macOS points TMPDIR at a per-login private
 * directory under /var/folders, and sandboxed agents are handed different
 * values again. Every session of one user must agree on a single path or mail
 * lands where nobody reads it, so the literal /tmp is the rendezvous. Windows
 * has no shared equivalent, and its temp dir is already per-user.
 */
function sharedTmp() {
    return process.platform === "win32" ? (0, node_os_1.tmpdir)() : "/tmp";
}
/** Names the mailbox after the owner so one /tmp holds several users' mail. */
function localUid() {
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    if (uid !== null)
        return String(uid);
    try {
        return safeSessionId((0, node_os_1.userInfo)().username);
    }
    catch {
        return "user";
    }
}
/**
 * Where mail is written. `CREW_INBOX_ROOT` overrides the root outright, for
 * sandboxes that expose neither /tmp nor a usable TMPDIR, and for tests that
 * must not touch the real mailbox.
 */
function inboxLocation() {
    const override = process.env.CREW_INBOX_ROOT;
    if (override) {
        const root = (0, node_path_1.resolve)(override);
        return { base: root, root };
    }
    const base = (0, node_path_1.join)(sharedTmp(), `crew-${localUid()}`);
    return { base, root: (0, node_path_1.join)(base, "inbox") };
}
function inboxRoot() {
    return inboxLocation().root;
}
/** Inboxes written by older crews, read (and expired) until they empty out. */
function legacyInboxRoots() {
    return [(0, node_path_1.join)(crewHome(), "inbox"), (0, node_path_1.join)(legacyCrewHome(), "inbox")];
}
/** Every root a reader must check, current first. */
function inboxRoots() {
    const roots = [inboxRoot(), ...legacyInboxRoots()];
    return roots.filter((root, i) => roots.indexOf(root) === i);
}
/**
 * Session ids become path components, so they get one harmless segment each.
 * Real ids (uuids, `ses_...`, `019f-...`) pass through untouched, which is
 * what keeps legacy inboxes addressable by the same name.
 */
function safeSessionId(sid) {
    const safe = sid.replace(/[^a-zA-Z0-9._-]/g, "_");
    return !safe || /^\.+$/.test(safe) ? `_${safe}` : safe;
}
