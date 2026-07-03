/**
 * settings.ts — wire crew's context hook into Claude Code's user settings.
 *
 * Adds `crew --hook` under SessionStart (no matcher = every source, including
 * post-compaction re-injection) and UserPromptSubmit, so each session sees
 * what the other running sessions are doing — plus PostToolUse and Stop,
 * which only deliver `crew send` messages (cheap inbox check, silent when
 * empty) so mail reaches a busy agent mid-turn. Merges into the existing
 * settings.json without touching anything else; never writes over a file it
 * could not parse.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export const HOOK_COMMAND = "crew --hook";

export const HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PostToolUse",
  "Stop",
] as const;

export function settingsPath(): string {
  const dir =
    process.env.CLAUDE_CONFIG_DIR ||
    process.env.CLAUDE_HOME ||
    join(homedir(), ".claude");
  return join(dir, "settings.json");
}

interface HookRef {
  type?: string;
  command?: string;
  [k: string]: unknown;
}

interface HookEntry {
  matcher?: string;
  hooks?: HookRef[];
  [k: string]: unknown;
}

function isCrewRef(h: HookRef): boolean {
  return typeof h?.command === "string" && h.command.includes(HOOK_COMMAND);
}

function hasCrewHook(entries: HookEntry[]): boolean {
  return entries.some((e) => Array.isArray(e?.hooks) && e.hooks.some(isCrewRef));
}

function readSettings(path: string): Record<string, any> {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8");
  if (!raw.trim()) return {};
  const parsed = JSON.parse(raw); // throws -> caller aborts; never clobber
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path} is not a JSON object`);
  }
  return parsed;
}

/** True if the crew hook is wired into any supported event. Never throws. */
export function hookInstalled(path = settingsPath()): boolean {
  try {
    const hooks = readSettings(path).hooks;
    if (!hooks || typeof hooks !== "object") return false;
    return HOOK_EVENTS.some(
      (event) => Array.isArray(hooks[event]) && hasCrewHook(hooks[event]),
    );
  } catch {
    return false;
  }
}

export type InstallResult = "installed" | "already-installed";

export function installHook(path = settingsPath()): InstallResult {
  const settings = readSettings(path);
  const hooks = (settings.hooks ??= {});
  if (typeof hooks !== "object" || Array.isArray(hooks)) {
    throw new Error(`"hooks" in ${path} is not an object`);
  }
  let changed = false;
  for (const event of HOOK_EVENTS) {
    const entries: HookEntry[] = (hooks[event] ??= []);
    if (!Array.isArray(entries)) {
      throw new Error(`hooks.${event} in ${path} is not an array`);
    }
    if (hasCrewHook(entries)) continue;
    entries.push({ hooks: [{ type: "command", command: HOOK_COMMAND }] });
    changed = true;
  }
  if (!changed) return "already-installed";
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(settings, null, 2) + "\n");
  return "installed";
}

export type UninstallResult = "removed" | "not-installed";

export function uninstallHook(path = settingsPath()): UninstallResult {
  if (!existsSync(path)) return "not-installed";
  const settings = readSettings(path);
  const hooks = settings.hooks;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) {
    return "not-installed";
  }
  let changed = false;
  for (const event of HOOK_EVENTS) {
    const entries = hooks[event];
    if (!Array.isArray(entries)) continue;
    const kept = entries
      .map((e: HookEntry) => {
        if (!Array.isArray(e?.hooks) || !e.hooks.some(isCrewRef)) return e;
        changed = true;
        return { ...e, hooks: e.hooks.filter((h) => !isCrewRef(h)) };
      })
      .filter((e: HookEntry) => !Array.isArray(e?.hooks) || e.hooks.length > 0);
    if (kept.length === 0) delete hooks[event];
    else hooks[event] = kept;
  }
  if (!changed) return "not-installed";
  if (Object.keys(hooks).length === 0) delete settings.hooks;
  writeFileSync(path, JSON.stringify(settings, null, 2) + "\n");
  return "removed";
}
