"use strict";
/**
 * settings.ts — wire crew's context hook into Claude Code and Codex.
 *
 * Both products use the same hook event/config shape. We merge crew into each
 * user hook file without touching unrelated settings and never write over a
 * file we cannot parse.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.HOOK_EVENTS = exports.HOOK_COMMAND = void 0;
exports.tildify = tildify;
exports.settingsPath = settingsPath;
exports.hookInstalled = hookInstalled;
exports.installHook = installHook;
exports.uninstallHook = uninstallHook;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const node_os_1 = require("node:os");
exports.HOOK_COMMAND = "crew --hook";
exports.HOOK_EVENTS = [
    "SessionStart",
    "UserPromptSubmit",
    "PostToolUse",
    "Stop",
];
/** Display a path with the home directory shortened to ~. */
function tildify(path) {
    const home = (0, node_os_1.homedir)();
    return path.startsWith(home) ? "~" + path.slice(home.length) : path;
}
function settingsPath(agent = "claude") {
    if (agent === "codex") {
        const dir = process.env.CODEX_HOME || (0, node_path_1.join)((0, node_os_1.homedir)(), ".codex");
        return (0, node_path_1.join)(dir, "hooks.json");
    }
    const dir = process.env.CLAUDE_CONFIG_DIR ||
        process.env.CLAUDE_HOME ||
        (0, node_path_1.join)((0, node_os_1.homedir)(), ".claude");
    return (0, node_path_1.join)(dir, "settings.json");
}
function isCrewRef(h) {
    return typeof h?.command === "string" && h.command.includes(exports.HOOK_COMMAND);
}
function hasCrewHook(entries) {
    return entries.some((e) => Array.isArray(e?.hooks) && e.hooks.some(isCrewRef));
}
function readSettings(path) {
    if (!(0, node_fs_1.existsSync)(path))
        return {};
    const raw = (0, node_fs_1.readFileSync)(path, "utf8");
    if (!raw.trim())
        return {};
    const parsed = JSON.parse(raw); // throws -> caller aborts; never clobber
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error(`${path} is not a JSON object`);
    }
    return parsed;
}
/** True if crew is wired into any supported event for an agent. Never throws. */
function hookInstalled(agent = "claude") {
    try {
        const hooks = readSettings(settingsPath(agent)).hooks;
        if (!hooks || typeof hooks !== "object")
            return false;
        return exports.HOOK_EVENTS.some((event) => Array.isArray(hooks[event]) && hasCrewHook(hooks[event]));
    }
    catch {
        return false;
    }
}
function installHook(agent = "claude") {
    const path = settingsPath(agent);
    const settings = readSettings(path);
    const hooks = (settings.hooks ??= {});
    if (typeof hooks !== "object" || Array.isArray(hooks)) {
        throw new Error(`"hooks" in ${path} is not an object`);
    }
    let changed = false;
    for (const event of exports.HOOK_EVENTS) {
        const entries = (hooks[event] ??= []);
        if (!Array.isArray(entries)) {
            throw new Error(`hooks.${event} in ${path} is not an array`);
        }
        if (hasCrewHook(entries))
            continue;
        entries.push({ hooks: [{ type: "command", command: exports.HOOK_COMMAND }] });
        changed = true;
    }
    if (!changed)
        return "already-installed";
    (0, node_fs_1.mkdirSync)((0, node_path_1.dirname)(path), { recursive: true });
    (0, node_fs_1.writeFileSync)(path, JSON.stringify(settings, null, 2) + "\n");
    return "installed";
}
function uninstallHook(agent = "claude") {
    const path = settingsPath(agent);
    if (!(0, node_fs_1.existsSync)(path))
        return "not-installed";
    const settings = readSettings(path);
    const hooks = settings.hooks;
    if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) {
        return "not-installed";
    }
    let changed = false;
    for (const event of exports.HOOK_EVENTS) {
        const entries = hooks[event];
        if (!Array.isArray(entries))
            continue;
        const kept = entries
            .map((e) => {
            if (!Array.isArray(e?.hooks) || !e.hooks.some(isCrewRef))
                return e;
            changed = true;
            return { ...e, hooks: e.hooks.filter((h) => !isCrewRef(h)) };
        })
            .filter((e) => !Array.isArray(e?.hooks) || e.hooks.length > 0);
        if (kept.length === 0)
            delete hooks[event];
        else
            hooks[event] = kept;
    }
    if (!changed)
        return "not-installed";
    if (Object.keys(hooks).length === 0)
        delete settings.hooks;
    (0, node_fs_1.writeFileSync)(path, JSON.stringify(settings, null, 2) + "\n");
    return "removed";
}
