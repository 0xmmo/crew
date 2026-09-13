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

import { readFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";

/** This build's version, from the package.json one level above dist/. */
export function crewVersion(): string {
  try {
    return JSON.parse(
      readFileSync(join(__dirname, "..", "package.json"), "utf8"),
    ).version;
  } catch {
    return "unknown";
  }
}

/** Product-neutral config and session registry, shared by all three products. */
export function crewHome(): string {
  return resolve(process.env.CREW_HOME || join(homedir(), ".crew"));
}

/** Product state dir used by crew <= 0.2.x; its inbox is kept readable. */
export function legacyCrewHome(): string {
  const claudeHome = process.env.CLAUDE_HOME || join(homedir(), ".claude");
  return resolve(join(claudeHome, "crew"));
}

/**
 * Deliberately not os.tmpdir(): macOS points TMPDIR at a per-login private
 * directory under /var/folders, and sandboxed agents are handed different
 * values again. Every session of one user must agree on a single path or mail
 * lands where nobody reads it, so the literal /tmp is the rendezvous. Windows
 * has no shared equivalent, and its temp dir is already per-user.
 */
function sharedTmp(): string {
  return process.platform === "win32" ? tmpdir() : "/tmp";
}

/** Names the mailbox after the owner so one /tmp holds several users' mail. */
function localUid(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (uid !== null) return String(uid);
  try {
    return safeSessionId(userInfo().username);
  } catch {
    return "user";
  }
}

export interface InboxLocation {
  /** The directory crew owns and locks down to 0700. */
  base: string;
  /** The directory holding one subdirectory of mail per session. */
  root: string;
}

/**
 * Where mail is written. `CREW_INBOX_ROOT` overrides the root outright, for
 * sandboxes that expose neither /tmp nor a usable TMPDIR, and for tests that
 * must not touch the real mailbox.
 */
export function inboxLocation(): InboxLocation {
  const override = process.env.CREW_INBOX_ROOT;
  if (override) {
    const root = resolve(override);
    return { base: root, root };
  }
  const base = join(sharedTmp(), `crew-${localUid()}`);
  return { base, root: join(base, "inbox") };
}

export function inboxRoot(): string {
  return inboxLocation().root;
}

/** Inboxes written by older crews, read (and expired) until they empty out. */
export function legacyInboxRoots(): string[] {
  return [join(crewHome(), "inbox"), join(legacyCrewHome(), "inbox")];
}

/** Every root a reader must check, current first. */
export function inboxRoots(): string[] {
  const roots = [inboxRoot(), ...legacyInboxRoots()];
  return roots.filter((root, i) => roots.indexOf(root) === i);
}

/**
 * Session ids become path components, so they get one harmless segment each.
 * Real ids (uuids, `ses_...`, `019f-...`) pass through untouched, which is
 * what keeps legacy inboxes addressable by the same name.
 */
export function safeSessionId(sid: string): string {
  const safe = sid.replace(/[^a-zA-Z0-9._-]/g, "_");
  return !safe || /^\.+$/.test(safe) ? `_${safe}` : safe;
}
