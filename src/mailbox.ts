/**
 * mailbox.ts — file-based messaging between Claude Code sessions.
 *
 * `crew send` drops a JSON file into ~/.claude/crew/inbox/<session-id>/; the
 * target session's `crew --hook` drains its inbox on its next hook event and
 * injects the messages as additionalContext. Claiming a message renames it
 * first, so racing hook events deliver each message at most once.
 */

import {
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
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

const CLAUDE_HOME = process.env.CLAUDE_HOME || join(homedir(), ".claude");
export const INBOX_ROOT = join(CLAUDE_HOME, "crew", "inbox");

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
}

function expired(m: Message): boolean {
  const t = Date.parse(m.expiresAt ?? "");
  return Number.isFinite(t) && t < Date.now();
}

function inboxDir(sid: string): string {
  return join(INBOX_ROOT, sid);
}

export function sendMessage(targetSid: string, msg: Message): void {
  const dir = inboxDir(targetSid);
  mkdirSync(dir, { recursive: true });
  const name = `${Date.now()}-${randomBytes(4).toString("hex")}.json`;
  const tmp = join(dir, `.${name}.tmp`);
  writeFileSync(tmp, JSON.stringify(msg));
  renameSync(tmp, join(dir, name));
}

function listMessageFiles(sid: string): string[] {
  try {
    return readdirSync(inboxDir(sid))
      .filter((f) => f.endsWith(".json") && !f.startsWith("."))
      .sort();
  } catch {
    return [];
  }
}

/** Read pending messages without claiming them (for `crew inbox` and counts). */
export function peekInbox(sid: string): Message[] {
  const out: Message[] = [];
  for (const f of listMessageFiles(sid)) {
    try {
      const m: Message = JSON.parse(readFileSync(join(inboxDir(sid), f), "utf8"));
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
    const path = join(inboxDir(sid), f);
    const claimed = `${path}.claimed`;
    try {
      renameSync(path, claimed); // throws if another drain won the race
      const m: Message = JSON.parse(readFileSync(claimed, "utf8"));
      if (!expired(m)) out.push(m); // expired mail is claimed and discarded
    } catch {
      continue;
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
  let dirs: string[];
  try {
    dirs = readdirSync(INBOX_ROOT);
  } catch {
    return;
  }
  const cutoff = Date.now() - MAX_AGE_MS;
  for (const d of dirs) {
    const dir = join(INBOX_ROOT, d);
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
