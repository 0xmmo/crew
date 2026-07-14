import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Product-neutral state shared by Claude and Codex sessions. */
export function crewHome(): string {
  return resolve(process.env.CREW_HOME || join(homedir(), ".crew"));
}

/** Inbox location used by crew <= 0.2.x; kept readable during migration. */
export function legacyCrewHome(): string {
  const claudeHome = process.env.CLAUDE_HOME || join(homedir(), ".claude");
  return resolve(join(claudeHome, "crew"));
}
