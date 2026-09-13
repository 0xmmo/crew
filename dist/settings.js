"use strict";
/**
 * settings.ts — wire crew's context hook into Claude Code, Codex, and OpenCode.
 *
 * Claude and Codex use the same hook event/config shape: crew is merged into
 * each user hook file without touching unrelated settings, and never written
 * over a file we cannot parse. OpenCode has no hook file; its "install" is a
 * generated plugin dropped into the global plugins directory (see opencode.ts).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.HOOK_EVENTS = exports.HOOK_COMMAND = exports.AGENT_LABELS = exports.AGENTS = void 0;
exports.tildify = tildify;
exports.settingsPath = settingsPath;
exports.hookState = hookState;
exports.hookInstalled = hookInstalled;
exports.installHook = installHook;
exports.uninstallHook = uninstallHook;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const node_os_1 = require("node:os");
const opencode_1 = require("./opencode");
const home_1 = require("./home");
exports.AGENTS = ["claude", "codex", "opencode"];
exports.AGENT_LABELS = {
    claude: "Claude Code",
    codex: "Codex",
    opencode: "OpenCode",
};
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
    if (agent === "opencode")
        return (0, opencode_1.opencodePluginPath)();
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
/** The generated OpenCode plugin, with crew's runtime paths baked in. */
function renderedOpencodePlugin() {
    return (0, opencode_1.opencodePluginSource)(process.execPath, (0, node_path_1.join)(__dirname, "crew.js"));
}
/** True if the plugin file at path is one crew generated (safe to replace). */
function ownsOpencodePlugin(path) {
    try {
        return (0, node_fs_1.readFileSync)(path, "utf8").includes(opencode_1.OPENCODE_PLUGIN_MARKER);
    }
    catch {
        return false;
    }
}
function hookState(agent = "claude") {
    if (agent === "opencode") {
        const path = (0, opencode_1.opencodePluginPath)();
        if (!(0, node_fs_1.existsSync)(path))
            return "missing";
        if (!ownsOpencodePlugin(path))
            return "foreign";
        // Baked paths may legitimately differ from this build's (the plugin falls
        // back to PATH when they die); only an older template counts as stale.
        try {
            return (0, opencode_1.opencodePluginVersion)((0, node_fs_1.readFileSync)(path, "utf8")) === (0, home_1.crewVersion)()
                ? "installed"
                : "stale";
        }
        catch {
            return "unreadable";
        }
    }
    let hooks;
    try {
        hooks = readSettings(settingsPath(agent)).hooks;
    }
    catch {
        return "unreadable";
    }
    if (!hooks || typeof hooks !== "object")
        return "missing";
    const wired = exports.HOOK_EVENTS.filter((event) => Array.isArray(hooks[event]) && hasCrewHook(hooks[event])).length;
    if (wired === 0)
        return "missing";
    return wired === exports.HOOK_EVENTS.length ? "installed" : "partial";
}
/** True if crew is wired into any supported event for an agent. Never throws. */
function hookInstalled(agent = "claude") {
    if (agent === "opencode")
        return ownsOpencodePlugin((0, opencode_1.opencodePluginPath)());
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
    if (agent === "opencode") {
        const path = (0, opencode_1.opencodePluginPath)();
        const source = renderedOpencodePlugin();
        if ((0, node_fs_1.existsSync)(path)) {
            if (!ownsOpencodePlugin(path)) {
                throw new Error(`${path} exists and isn't crew's — refusing to overwrite`);
            }
            if ((0, node_fs_1.readFileSync)(path, "utf8") === source)
                return "already-installed";
        }
        (0, node_fs_1.mkdirSync)((0, node_path_1.dirname)(path), { recursive: true });
        (0, node_fs_1.writeFileSync)(path, source);
        return "installed";
    }
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
    if (agent === "opencode") {
        const path = (0, opencode_1.opencodePluginPath)();
        if (!ownsOpencodePlugin(path))
            return "not-installed";
        (0, node_fs_1.unlinkSync)(path);
        return "removed";
    }
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
