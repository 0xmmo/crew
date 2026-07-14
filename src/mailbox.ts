/**
 * mailbox.ts — file-based messaging between Claude Code and Codex sessions.
 *
 * `crew send` drops a JSON file into ~/.crew/inbox/<session-id>/; the
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
import { randomBytes } from "node:crypto";
import { crewHome, legacyCrewHome } from "./home";

export const INBOX_ROOT = join(crewHome(), "inbox");
const LEGACY_INBOX_ROOT = join(legacyCrewHome(), "inbox");

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

function inboxDir(sid: string, root = INBOX_ROOT): string {
  return join(root, sid);
}

export function sendMessage(targetSid: string, msg: Message): void {
  const dir = inboxDir(targetSid);
  mkdirSync(dir, { recursive: true });
  const name = `${Date.now()}-${randomBytes(4).toString("hex")}.json`;
  const tmp = join(dir, `.${name}.tmp`);
  writeFileSync(tmp, JSON.stringify(msg));
  renameSync(tmp, join(dir, name));
}

interface MessageFile {
  root: string;
  name: string;
}

function inboxRoots(): string[] {
  return INBOX_ROOT === LEGACY_INBOX_ROOT
    ? [INBOX_ROOT]
    : [INBOX_ROOT, LEGACY_INBOX_ROOT];
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
