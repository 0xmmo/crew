"use strict";
/**
 * mailbox.ts — file-based messaging between Claude Code sessions.
 *
 * `crew send` drops a JSON file into ~/.claude/crew/inbox/<session-id>/; the
 * target session's `crew --hook` drains its inbox on its next hook event and
 * injects the messages as additionalContext. Claiming a message renames it
 * first, so racing hook events deliver each message at most once.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_TTL_MS = exports.INBOX_ROOT = void 0;
exports.sendMessage = sendMessage;
exports.peekInbox = peekInbox;
exports.pendingCount = pendingCount;
exports.drainInbox = drainInbox;
exports.pruneInboxes = pruneInboxes;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const node_os_1 = require("node:os");
const node_crypto_1 = require("node:crypto");
const CLAUDE_HOME = process.env.CLAUDE_HOME || (0, node_path_1.join)((0, node_os_1.homedir)(), ".claude");
exports.INBOX_ROOT = (0, node_path_1.join)(CLAUDE_HOME, "crew", "inbox");
// Sessions can come back via --resume, so mail is pruned by age, not liveness.
const MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
// A coordination message that arrives a day late is noise; expire undelivered
// mail at delivery time. Senders can shorten/extend with --ttl.
exports.DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
function expired(m) {
    const t = Date.parse(m.expiresAt ?? "");
    return Number.isFinite(t) && t < Date.now();
}
function inboxDir(sid) {
    return (0, node_path_1.join)(exports.INBOX_ROOT, sid);
}
function sendMessage(targetSid, msg) {
    const dir = inboxDir(targetSid);
    (0, node_fs_1.mkdirSync)(dir, { recursive: true });
    const name = `${Date.now()}-${(0, node_crypto_1.randomBytes)(4).toString("hex")}.json`;
    const tmp = (0, node_path_1.join)(dir, `.${name}.tmp`);
    (0, node_fs_1.writeFileSync)(tmp, JSON.stringify(msg));
    (0, node_fs_1.renameSync)(tmp, (0, node_path_1.join)(dir, name));
}
function listMessageFiles(sid) {
    try {
        return (0, node_fs_1.readdirSync)(inboxDir(sid))
            .filter((f) => f.endsWith(".json") && !f.startsWith("."))
            .sort();
    }
    catch {
        return [];
    }
}
/** Read pending messages without claiming them (for `crew inbox` and counts). */
function peekInbox(sid) {
    const out = [];
    for (const f of listMessageFiles(sid)) {
        try {
            const m = JSON.parse((0, node_fs_1.readFileSync)((0, node_path_1.join)(inboxDir(sid), f), "utf8"));
            if (!expired(m))
                out.push(m);
        }
        catch {
            // corrupt or mid-write; skip
        }
    }
    return out;
}
function pendingCount(sid) {
    return peekInbox(sid).length;
}
/** Claim and remove pending messages. Each message is delivered at most once. */
function drainInbox(sid) {
    const out = [];
    for (const f of listMessageFiles(sid)) {
        const path = (0, node_path_1.join)(inboxDir(sid), f);
        const claimed = `${path}.claimed`;
        try {
            (0, node_fs_1.renameSync)(path, claimed); // throws if another drain won the race
            const m = JSON.parse((0, node_fs_1.readFileSync)(claimed, "utf8"));
            if (!expired(m))
                out.push(m); // expired mail is claimed and discarded
        }
        catch {
            continue;
        }
        finally {
            try {
                (0, node_fs_1.unlinkSync)(claimed);
            }
            catch { }
        }
    }
    return out;
}
/** Drop messages older than MAX_AGE_MS and remove emptied inbox dirs. */
function pruneInboxes() {
    let dirs;
    try {
        dirs = (0, node_fs_1.readdirSync)(exports.INBOX_ROOT);
    }
    catch {
        return;
    }
    const cutoff = Date.now() - MAX_AGE_MS;
    for (const d of dirs) {
        const dir = (0, node_path_1.join)(exports.INBOX_ROOT, d);
        try {
            for (const f of (0, node_fs_1.readdirSync)(dir)) {
                const p = (0, node_path_1.join)(dir, f);
                if ((0, node_fs_1.statSync)(p).mtimeMs < cutoff)
                    (0, node_fs_1.unlinkSync)(p);
            }
            if ((0, node_fs_1.readdirSync)(dir).length === 0)
                (0, node_fs_1.rmSync)(dir, { recursive: true });
        }
        catch {
            // another process may be touching this inbox right now; fine
        }
    }
}
