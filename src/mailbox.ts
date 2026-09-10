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

import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { inboxLocation, inboxRoots, safeSessionId } from "./home";

// Sessions can come back via --resume, so mail is pruned by age, not liveness.
const MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

// A coordination message that arrives a day late is noise; expire undelivered
// mail at delivery time. Senders can shorten/extend with --ttl.
export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export interface Message {
  ts: string;
  from: string; // sender session id, or "human" for a plain terminal
  fromShort: string;
  fromCwd: string;
  text: string;
  expiresAt?: string;
  // When set, the target's Stop hook force-continues (decision: block) instead
  // of passively injecting context, so an agent about to go idle acts on the
  // message as a directive. A truly-idle agent has no upcoming Stop to catch,
  // so this is best-effort — see runSend's idle warning.
  kickstart?: boolean;
}

/** A send that failed for a reason worth showing the user verbatim. */
export class MailboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MailboxError";
  }
}

function mailboxError(dir: string, err: unknown): MailboxError {
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === "EPERM" || code === "EACCES") {
    return new MailboxError(
      `crew: no permission to write the mailbox at ${dir} (${code}).\n` +
        `      A sandbox is denying it. Allow writes to ${inboxLocation().base}, ` +
        `or set CREW_INBOX_ROOT to a directory this process can write.`,
    );
  }
  const detail = (err as NodeJS.ErrnoException)?.message ?? String(err);
  return new MailboxError(`crew: cannot use the mailbox at ${dir} — ${detail}`);
}

/**
 * Create `dir` 0700 and refuse to use it unless we own it. The mailbox sits
 * under a world-writable /tmp, where anyone can pre-create our name as a
 * symlink pointing somewhere they can read, or as a directory they can list.
 */
function secureDir(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (err) {
    throw mailboxError(dir, err);
  }
  let st;
  try {
    st = lstatSync(dir); // lstat, not stat: a symlink must not be followed
  } catch (err) {
    throw mailboxError(dir, err);
  }
  if (st.isSymbolicLink()) {
    throw new MailboxError(
      `crew: mailbox path ${dir} is a symlink; refusing to follow it. ` +
        `Remove it, or set CREW_INBOX_ROOT to a directory you control.`,
    );
  }
  if (!st.isDirectory()) {
    throw new MailboxError(`crew: mailbox path ${dir} is not a directory.`);
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (uid === null) return; // no ownership model to check against (Windows)
  if (st.uid !== uid) {
    throw new MailboxError(
      `crew: mailbox path ${dir} is owned by uid ${st.uid}, not ${uid}. ` +
        `Refusing to use it; set CREW_INBOX_ROOT to a directory you own.`,
    );
  }
  if ((st.mode & 0o077) !== 0) {
    try {
      chmodSync(dir, 0o700); // ours, just too open — tighten rather than fail
    } catch (err) {
      throw mailboxError(dir, err);
    }
  }
}

function inboxDir(sid: string, root: string): string {
  return join(root, safeSessionId(sid));
}

/** Verify and create the path down to one session's inbox. */
function ensureInboxDir(sid: string): string {
  const { base, root } = inboxLocation();
  const dir = inboxDir(sid, root);
  const chain = base === root ? [root, dir] : [base, root, dir];
  for (const d of chain) secureDir(d);
  return dir;
}

function expired(m: Message): boolean {
  const t = Date.parse(m.expiresAt ?? "");
  return Number.isFinite(t) && t < Date.now();
}

/** Throws MailboxError if the message could not be published. */
export function sendMessage(targetSid: string, msg: Message): void {
  const dir = ensureInboxDir(targetSid);
  const name = `${Date.now()}-${randomBytes(4).toString("hex")}.json`;
  const tmp = join(dir, `.${name}.tmp`);
  try {
    // Write to a dotfile readers skip, then rename: a reader never sees a
    // partially written message, and the caller is only told "queued" once
    // this rename has returned.
    writeFileSync(tmp, JSON.stringify(msg), { mode: 0o600 });
    renameSync(tmp, join(dir, name));
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {}
    throw mailboxError(dir, err);
  }
}

interface MessageFile {
  root: string;
  name: string;
}

function listMessageFiles(sid: string): MessageFile[] {
  const out: MessageFile[] = [];
  for (const root of inboxRoots()) {
    try {
      out.push(
        ...readdirSync(inboxDir(sid, root))
          .filter((f) => f.endsWith(".json") && !f.startsWith("."))
          .map((name) => ({ root, name })),
      );
    } catch {
      // no inbox in this root
    }
  }
  // Names start with the send timestamp, so this is delivery order across roots.
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function messagePath(sid: string, file: MessageFile): string {
  return join(inboxDir(sid, file.root), file.name);
}

function listDirs(root: string): string[] {
  try {
    return readdirSync(root);
  } catch {
    return [];
  }
}

/** Read pending messages without claiming them (for `crew inbox` and counts). */
export function peekInbox(sid: string): Message[] {
  const out: Message[] = [];
  for (const f of listMessageFiles(sid)) {
    try {
      const m: Message = JSON.parse(readFileSync(messagePath(sid, f), "utf8"));
      if (!expired(m)) out.push(m);
    } catch {
      // corrupt or mid-write; skip
    }
  }
  return out;
}

export function pendingCount(sid: string): number {
  return peekInbox(sid).length;
}

/** Claim and remove pending messages. Each message is delivered at most once. */
export function drainInbox(sid: string): Message[] {
  const out: Message[] = [];
  for (const f of listMessageFiles(sid)) {
    const path = messagePath(sid, f);
    // The claim name carries the claimer's pid. With a shared name, a drainer
    // that lost the rename still ran its cleanup and unlinked the winner's
    // file out from under it mid-read, and that message was gone: claimed by
    // one process, delivered by none.
    const claimed = `${path}.${process.pid}.claimed`;
    try {
      renameSync(path, claimed); // throws if another drain won the race
    } catch {
      continue; // someone else claimed it first
    }
    // Past the rename this message is ours alone: read it, then drop it.
    try {
      const m: Message = JSON.parse(readFileSync(claimed, "utf8"));
      if (!expired(m)) out.push(m); // expired mail is claimed and discarded
    } catch {
      // corrupt or truncated; the claim already took it out of circulation
    } finally {
      try {
        unlinkSync(claimed);
      } catch {}
    }
  }
  return out;
}

/** Drop messages older than MAX_AGE_MS and remove emptied inbox dirs. */
export function pruneInboxes(): void {
  const cutoff = Date.now() - MAX_AGE_MS;
  for (const root of inboxRoots()) {
    for (const d of listDirs(root)) {
      const dir = join(root, d);
      try {
        for (const f of readdirSync(dir)) {
          const p = join(dir, f);
          if (statSync(p).mtimeMs < cutoff) unlinkSync(p);
        }
        if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true });
      } catch {
        // another process may be touching this inbox right now; fine
      }
    }
  }
}
