"use strict";
/**
 * mailbox.ts — file-based messaging between Claude Code, Codex, and OpenCode
 * sessions.
 *
 * `crew send` drops a JSON file into /tmp/crew-<uid>/inbox/<session-id>/; the
 * target session's `crew --hook` drains its inbox on its next hook event and
 * injects the messages as additionalContext. Claiming a message renames it
 * first, so racing hook events deliver each message at most once.
 *
 * The mailbox lives in /tmp rather than ~/.crew because sandboxed agents are
 * routinely denied writes under $HOME. That trade is deliberate and visible:
 * mail is temporary, and a reboot or a /tmp sweep takes undelivered messages
 * with it. Config and the session registry stay in ~/.crew, where they last.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.MailboxError = exports.DEFAULT_TTL_MS = void 0;
exports.inspectMailbox = inspectMailbox;
exports.ensureMailboxRoot = ensureMailboxRoot;
exports.legacyPending = legacyPending;
exports.sendMessage = sendMessage;
exports.peekInbox = peekInbox;
exports.pendingCount = pendingCount;
exports.drainInbox = drainInbox;
exports.pruneInboxes = pruneInboxes;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const node_crypto_1 = require("node:crypto");
const home_1 = require("./home");
// Sessions can come back via --resume, so mail is pruned by age, not liveness.
const MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
// A coordination message that arrives a day late is noise; expire undelivered
// mail at delivery time. Senders can shorten/extend with --ttl.
exports.DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
/** A send that failed for a reason worth showing the user verbatim. */
class MailboxError extends Error {
    constructor(message) {
        super(message);
        this.name = "MailboxError";
    }
}
exports.MailboxError = MailboxError;
function mailboxError(dir, err) {
    const code = err?.code;
    if (code === "EPERM" || code === "EACCES") {
        return new MailboxError(`crew: no permission to write the mailbox at ${dir} (${code}).\n` +
            `      A sandbox is denying it. Allow writes to ${(0, home_1.inboxLocation)().base}, ` +
            `or set CREW_INBOX_ROOT to a directory this process can write.`);
    }
    const detail = err?.message ?? String(err);
    return new MailboxError(`crew: cannot use the mailbox at ${dir} — ${detail}`);
}
/**
 * Create `dir` 0700 and refuse to use it unless we own it. The mailbox sits
 * under a world-writable /tmp, where anyone can pre-create our name as a
 * symlink pointing somewhere they can read, or as a directory they can list.
 */
function secureDir(dir) {
    try {
        (0, node_fs_1.mkdirSync)(dir, { recursive: true, mode: 0o700 });
    }
    catch (err) {
        throw mailboxError(dir, err);
    }
    let st;
    try {
        st = (0, node_fs_1.lstatSync)(dir); // lstat, not stat: a symlink must not be followed
    }
    catch (err) {
        throw mailboxError(dir, err);
    }
    if (st.isSymbolicLink()) {
        throw new MailboxError(`crew: mailbox path ${dir} is a symlink; refusing to follow it. ` +
            `Remove it, or set CREW_INBOX_ROOT to a directory you control.`);
    }
    if (!st.isDirectory()) {
        throw new MailboxError(`crew: mailbox path ${dir} is not a directory.`);
    }
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    if (uid === null)
        return; // no ownership model to check against (Windows)
    if (st.uid !== uid) {
        throw new MailboxError(`crew: mailbox path ${dir} is owned by uid ${st.uid}, not ${uid}. ` +
            `Refusing to use it; set CREW_INBOX_ROOT to a directory you own.`);
    }
    if ((st.mode & 0o077) !== 0) {
        try {
            (0, node_fs_1.chmodSync)(dir, 0o700); // ours, just too open — tighten rather than fail
        }
        catch (err) {
            throw mailboxError(dir, err);
        }
    }
}
/**
 * Look at the mailbox without touching it, for `crew doctor`. Mirrors the
 * rules `secureDir` enforces, minus the mkdir and chmod side effects, plus a
 * write probe so a sandbox denial shows up here and not on the first send.
 */
function inspectMailbox() {
    const { base, root } = (0, home_1.inboxLocation)();
    const report = {
        base,
        root,
        absent: false,
        errors: [],
        warnings: [],
    };
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    const dirs = base === root ? [root] : [base, root];
    let existing = 0;
    for (const dir of dirs) {
        let st;
        try {
            st = (0, node_fs_1.lstatSync)(dir);
        }
        catch (err) {
            if (err.code === "ENOENT")
                continue;
            report.errors.push(`${dir}: ${err.message}`);
            continue;
        }
        existing++;
        if (st.isSymbolicLink()) {
            report.errors.push(`${dir} is a symlink; crew refuses to follow it`);
            continue;
        }
        if (!st.isDirectory()) {
            report.errors.push(`${dir} is not a directory`);
            continue;
        }
        if (uid !== null && st.uid !== uid) {
            report.errors.push(`${dir} is owned by uid ${st.uid}, not ${uid}`);
            continue;
        }
        if (uid !== null && (st.mode & 0o077) !== 0) {
            report.warnings.push(`${dir} is mode ${(st.mode & 0o777).toString(8)}, should be 700`);
        }
    }
    if (existing === 0) {
        report.absent = true;
        // Can we create it at all? Probe the parent the same way mkdir would.
        try {
            (0, node_fs_1.accessSync)((0, node_path_1.dirname)(base), node_fs_1.constants.W_OK);
        }
        catch {
            report.errors.push(`${(0, node_path_1.dirname)(base)} is not writable; sends will fail`);
        }
        return report;
    }
    if (report.errors.length === 0) {
        const probe = (0, node_path_1.join)(root, `.doctor-${process.pid}-${Date.now()}`);
        try {
            (0, node_fs_1.mkdirSync)(root, { recursive: true });
            (0, node_fs_1.writeFileSync)(probe, "");
            (0, node_fs_1.unlinkSync)(probe);
        }
        catch (err) {
            report.errors.push(`cannot write ${root} (${err.code ?? err})`);
        }
    }
    return report;
}
/** Create and lock down the mailbox root now instead of on the first send. */
function ensureMailboxRoot() {
    const { base, root } = (0, home_1.inboxLocation)();
    for (const d of base === root ? [root] : [base, root])
        secureDir(d);
}
/** Undelivered mail still sitting in inboxes written by crew <= 0.3.x. */
function legacyPending() {
    return (0, home_1.legacyInboxRoots)()
        .map((root) => ({
        root,
        count: listDirs(root).reduce((n, sid) => {
            try {
                return (n + (0, node_fs_1.readdirSync)((0, node_path_1.join)(root, sid)).filter((f) => f.endsWith(".json")).length);
            }
            catch {
                return n;
            }
        }, 0),
    }))
        .filter((r) => r.count > 0);
}
function inboxDir(sid, root) {
    return (0, node_path_1.join)(root, (0, home_1.safeSessionId)(sid));
}
/** Verify and create the path down to one session's inbox. */
function ensureInboxDir(sid) {
    const { base, root } = (0, home_1.inboxLocation)();
    const dir = inboxDir(sid, root);
    const chain = base === root ? [root, dir] : [base, root, dir];
    for (const d of chain)
        secureDir(d);
    return dir;
}
function expired(m) {
    const t = Date.parse(m.expiresAt ?? "");
    return Number.isFinite(t) && t < Date.now();
}
/** Throws MailboxError if the message could not be published. */
function sendMessage(targetSid, msg) {
    const dir = ensureInboxDir(targetSid);
    const name = `${Date.now()}-${(0, node_crypto_1.randomBytes)(4).toString("hex")}.json`;
    const tmp = (0, node_path_1.join)(dir, `.${name}.tmp`);
    try {
        // Write to a dotfile readers skip, then rename: a reader never sees a
        // partially written message, and the caller is only told "queued" once
        // this rename has returned.
        (0, node_fs_1.writeFileSync)(tmp, JSON.stringify(msg), { mode: 0o600 });
        (0, node_fs_1.renameSync)(tmp, (0, node_path_1.join)(dir, name));
    }
    catch (err) {
        try {
            (0, node_fs_1.unlinkSync)(tmp);
        }
        catch { }
        throw mailboxError(dir, err);
    }
}
function listMessageFiles(sid) {
    const out = [];
    for (const root of (0, home_1.inboxRoots)()) {
        try {
            out.push(...(0, node_fs_1.readdirSync)(inboxDir(sid, root))
                .filter((f) => f.endsWith(".json") && !f.startsWith("."))
                .map((name) => ({ root, name })));
        }
        catch {
            // no inbox in this root
        }
    }
    // Names start with the send timestamp, so this is delivery order across roots.
    return out.sort((a, b) => a.name.localeCompare(b.name));
}
function messagePath(sid, file) {
    return (0, node_path_1.join)(inboxDir(sid, file.root), file.name);
}
function listDirs(root) {
    try {
        return (0, node_fs_1.readdirSync)(root);
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
            const m = JSON.parse((0, node_fs_1.readFileSync)(messagePath(sid, f), "utf8"));
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
        const path = messagePath(sid, f);
        // The claim name carries the claimer's pid. With a shared name, a drainer
        // that lost the rename still ran its cleanup and unlinked the winner's
        // file out from under it mid-read, and that message was gone: claimed by
        // one process, delivered by none.
        const claimed = `${path}.${process.pid}.claimed`;
        try {
            (0, node_fs_1.renameSync)(path, claimed); // throws if another drain won the race
        }
        catch {
            continue; // someone else claimed it first
        }
        // Past the rename this message is ours alone: read it, then drop it.
        try {
            const m = JSON.parse((0, node_fs_1.readFileSync)(claimed, "utf8"));
            if (!expired(m))
                out.push(m); // expired mail is claimed and discarded
        }
        catch {
            // corrupt or truncated; the claim already took it out of circulation
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
    const cutoff = Date.now() - MAX_AGE_MS;
    for (const root of (0, home_1.inboxRoots)()) {
        for (const d of listDirs(root)) {
            const dir = (0, node_path_1.join)(root, d);
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
}
