/**
 * settings.ts — wire crew's context hook into Claude Code, Codex, and OpenCode.
 *
 * Claude and Codex use the same hook event/config shape: crew is merged into
 * each user hook file without touching unrelated settings, and never written
 * over a file we cannot parse. OpenCode has no hook file; its "install" is a
 * generated plugin dropped into the global plugins directory (see opencode.ts).
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import {
  OPENCODE_PLUGIN_MARKER,
  opencodePluginPath,
  opencodePluginSource,
} from "./opencode";

export type Agent = "claude" | "codex" | "opencode";

export const AGENTS = ["claude", "codex", "opencode"] as const;

export const AGENT_LABELS: Record<Agent, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
};

export const HOOK_COMMAND = "crew --hook";

export const HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PostToolUse",
  "Stop",
] as const;

/** Display a path with the home directory shortened to ~. */
export function tildify(path: string): string {
  const home = homedir();
  return path.startsWith(home) ? "~" + path.slice(home.length) : path;
}

export function settingsPath(agent: Agent = "claude"): string {
  if (agent === "opencode") return opencodePluginPath();
  if (agent === "codex") {
    const dir = process.env.CODEX_HOME || join(homedir(), ".codex");
    return join(dir, "hooks.json");
  }
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

/** The generated OpenCode plugin, with crew's runtime paths baked in. */
function renderedOpencodePlugin(): string {
  return opencodePluginSource(process.execPath, join(__dirname, "crew.js"));
}

/** True if the plugin file at path is one crew generated (safe to replace). */
function ownsOpencodePlugin(path: string): boolean {
  try {
    return readFileSync(path, "utf8").includes(OPENCODE_PLUGIN_MARKER);
  } catch {
    return false;
  }
}

/** True if crew is wired into any supported event for an agent. Never throws. */
export function hookInstalled(agent: Agent = "claude"): boolean {
  if (agent === "opencode") return ownsOpencodePlugin(opencodePluginPath());
  try {
    const hooks = readSettings(settingsPath(agent)).hooks;
    if (!hooks || typeof hooks !== "object") return false;
    return HOOK_EVENTS.some(
      (event) => Array.isArray(hooks[event]) && hasCrewHook(hooks[event]),
    );
  } catch {
    return false;
  }
}

export type InstallResult = "installed" | "already-installed";

export function installHook(agent: Agent = "claude"): InstallResult {
  if (agent === "opencode") {
    const path = opencodePluginPath();
    const source = renderedOpencodePlugin();
    if (existsSync(path)) {
      if (!ownsOpencodePlugin(path)) {
        throw new Error(`${path} exists and isn't crew's — refusing to overwrite`);
      }
      if (readFileSync(path, "utf8") === source) return "already-installed";
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, source);
    return "installed";
  }
  const path = settingsPath(agent);
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

export function uninstallHook(agent: Agent = "claude"): UninstallResult {
  if (agent === "opencode") {
    const path = opencodePluginPath();
    if (!ownsOpencodePlugin(path)) return "not-installed";
    unlinkSync(path);
    return "removed";
  }
  const path = settingsPath(agent);
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
