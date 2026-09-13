"use strict";
/**
 * doctor.ts — `crew doctor`: is this machine wired up so crew actually works?
 *
 * Every failure crew has produced in the field looked healthy from the
 * outside: hooks silently not installed because npm skipped postinstall, a
 * global install symlinked to a working tree, mail written where no reader
 * looked, a sandbox denying the mailbox. Each check here is one of those
 * lessons, and each fix is the command that repaired it. Report-only by
 * default; `--fix` applies the repairs crew owns (its own hooks, its own
 * mailbox, its own registry) and never touches anything else.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.runDoctor = runDoctor;
exports.renderDoctorText = renderDoctorText;
exports.renderDoctorJson = renderDoctorJson;
const node_child_process_1 = require("node:child_process");
const node_fs_1 = require("node:fs");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const settings_1 = require("./settings");
const mailbox_1 = require("./mailbox");
const registry_1 = require("./registry");
const opencode_1 = require("./opencode");
const MIN_NODE_MAJOR = 18;
function nodeCheck() {
    return {
        id: "node",
        label: "Node.js",
        run() {
            const major = parseInt(process.versions.node.split(".")[0], 10);
            return major >= MIN_NODE_MAJOR
                ? { status: "ok", detail: `v${process.versions.node} at ${process.execPath}` }
                : {
                    status: "fail",
                    detail: `v${process.versions.node}; crew needs ${MIN_NODE_MAJOR}+`,
                };
        },
    };
}
function isExecutable(path) {
    try {
        (0, node_fs_1.accessSync)(path, node_fs_1.constants.X_OK);
        return true;
    }
    catch {
        return false;
    }
}
function realpathOrSelf(path) {
    try {
        return (0, node_fs_1.realpathSync)(path);
    }
    catch {
        return path;
    }
}
/**
 * Which `crew` do hooks actually run? The hook command is the bare word
 * `crew`, so whatever is first on PATH wins — and that may not be this build.
 */
function binaryCheck() {
    return {
        id: "binary",
        label: "crew on PATH",
        run() {
            const dirs = (process.env.PATH ?? "").split(node_path_1.delimiter).filter(Boolean);
            const found = dirs
                .map((d) => (0, node_path_1.join)(d, "crew"))
                .filter((p) => (0, node_fs_1.existsSync)(p) && isExecutable(p));
            if (found.length === 0) {
                return {
                    status: "fail",
                    detail: "no `crew` on PATH; hooks run `crew --hook` and will fail",
                    fix: "npm install -g @0xmmo/crew",
                };
            }
            const running = realpathOrSelf((0, node_path_1.join)(__dirname, "crew.js"));
            const first = realpathOrSelf(found[0]);
            const notes = [];
            let status = "ok";
            if (first !== running) {
                status = "warn";
                notes.push(`first on PATH is ${(0, settings_1.tildify)(found[0])} → ${(0, settings_1.tildify)(first)}, ` +
                    `but this run is ${(0, settings_1.tildify)(running)}`);
            }
            if (!/[\\/]node_modules[\\/]/.test(first)) {
                status = "warn";
                notes.push(`${(0, settings_1.tildify)(first)} is outside node_modules, so the global install ` +
                    "is linked to a working tree; a mid-edit checkout breaks every " +
                    "session's hook. Install a copy: `npm pack && npm i -g ./<tarball>`");
            }
            const others = found.slice(1).map(settings_1.tildify);
            if (others.length > 0) {
                notes.push(`shadowed: ${others.join(", ")}`);
            }
            return {
                status,
                detail: [`${(0, settings_1.tildify)(found[0])}`, ...notes].join("; "),
            };
        },
    };
}
function ignoreScripts() {
    const rc = process.env.NPM_CONFIG_USERCONFIG || (0, node_path_1.join)((0, node_os_1.homedir)(), ".npmrc");
    try {
        return /^\s*ignore-scripts\s*=\s*true\s*$/m.test((0, node_fs_1.readFileSync)(rc, "utf8"));
    }
    catch {
        return false;
    }
}
function hookCheck(agent) {
    const label = settings_1.AGENT_LABELS[agent];
    return {
        id: `hook:${agent}`,
        label: `${label} hook`,
        run() {
            const path = (0, settings_1.tildify)((0, settings_1.settingsPath)(agent));
            const state = (0, settings_1.hookState)(agent);
            const fix = "crew install-hook";
            switch (state) {
                case "installed":
                    return { status: "ok", detail: path };
                case "partial":
                    return {
                        status: "warn",
                        detail: `${path} wires crew into some events but not all four`,
                        fix,
                    };
                case "stale":
                    return {
                        status: "warn",
                        detail: `${path} was generated by an older crew; re-render it`,
                        fix,
                    };
                case "foreign":
                    return {
                        status: "fail",
                        detail: `${path} exists but crew didn't generate it; move it aside`,
                    };
                case "unreadable":
                    return {
                        status: "fail",
                        detail: `${path} isn't valid JSON; crew won't touch it until it is`,
                    };
                case "missing": {
                    const why = ignoreScripts()
                        ? " (npm has ignore-scripts=true, so postinstall never ran)"
                        : "";
                    return { status: "fail", detail: `not wired${why}`, fix };
                }
            }
        },
        repair() {
            const state = (0, settings_1.hookState)(agent);
            if (state === "foreign" || state === "unreadable")
                return; // not ours
            (0, settings_1.installHook)(agent);
        },
    };
}
function mailboxCheck() {
    return {
        id: "mailbox",
        label: "Mailbox",
        run() {
            const r = (0, mailbox_1.inspectMailbox)();
            const where = (0, settings_1.tildify)(r.root);
            if (r.errors.length > 0) {
                return {
                    status: "fail",
                    detail: r.errors.join("; "),
                    fix: "set CREW_INBOX_ROOT to a writable directory you own",
                };
            }
            if (r.warnings.length > 0) {
                return { status: "warn", detail: r.warnings.join("; "), fix: "crew doctor --fix" };
            }
            return {
                status: "ok",
                detail: r.absent ? `${where} (created on first send)` : `${where} writable`,
            };
        },
        repair() {
            (0, mailbox_1.ensureMailboxRoot)();
        },
    };
}
function legacyMailCheck() {
    return {
        id: "mailbox:legacy",
        label: "Legacy inboxes",
        run() {
            const pending = (0, mailbox_1.legacyPending)();
            if (pending.length === 0)
                return { status: "ok", detail: "empty" };
            return {
                status: "warn",
                detail: pending
                    .map((p) => `${p.count} message(s) in ${(0, settings_1.tildify)(p.root)}`)
                    .join("; ") + "; still delivered, expired ones are swept on --fix",
                fix: "crew doctor --fix",
            };
        },
        repair() {
            (0, mailbox_1.pruneInboxes)();
        },
    };
}
function registryCheck() {
    return {
        id: "registry",
        label: "Session registry",
        run() {
            const r = (0, registry_1.inspectRegistry)();
            const where = (0, settings_1.tildify)(r.root);
            const parts = [`${r.live} live`];
            if (r.stale)
                parts.push(`${r.stale} stale`);
            if (r.corrupt)
                parts.push(`${r.corrupt} unreadable`);
            const detail = `${where}: ${parts.join(", ")}`;
            return r.stale || r.corrupt
                ? { status: "warn", detail, fix: "crew doctor --fix" }
                : { status: "ok", detail };
        },
        repair() {
            (0, registry_1.registeredSessions)(); // prunes as a side effect
        },
    };
}
function claudeSessionsCheck() {
    return {
        id: "claude:sessions",
        label: "Claude Code sessions dir",
        run() {
            const home = process.env.CLAUDE_CONFIG_DIR ||
                process.env.CLAUDE_HOME ||
                (0, node_path_1.join)((0, node_os_1.homedir)(), ".claude");
            const dir = (0, node_path_1.join)(home, "sessions");
            if (!(0, node_fs_1.existsSync)(dir)) {
                return {
                    status: "warn",
                    detail: `${(0, settings_1.tildify)(dir)} not found; Claude Code sessions won't be listed until one runs`,
                };
            }
            try {
                const n = (0, node_fs_1.readdirSync)(dir).filter((f) => f.endsWith(".json")).length;
                return { status: "ok", detail: `${(0, settings_1.tildify)(dir)}: ${n} record(s)` };
            }
            catch (err) {
                return {
                    status: "fail",
                    detail: `${(0, settings_1.tildify)(dir)}: ${err.message}`,
                };
            }
        },
    };
}
function sqliteCheck() {
    return {
        id: "opencode:sqlite",
        label: "OpenCode transcripts",
        run() {
            if ((0, settings_1.hookState)("opencode") === "missing") {
                return { status: "ok", detail: "skipped (OpenCode plugin not installed)" };
            }
            let version;
            try {
                version = (0, node_child_process_1.execFileSync)("sqlite3", ["-version"], {
                    encoding: "utf8",
                    stdio: ["ignore", "pipe", "ignore"],
                })
                    .trim()
                    .split(" ")[0];
            }
            catch {
                return {
                    status: "warn",
                    detail: "sqlite3 not on PATH; OpenCode sessions list as status-only, no transcript tail",
                    fix: "install sqlite3 (macOS ships it; `apt install sqlite3` elsewhere)",
                };
            }
            const db = (0, opencode_1.opencodeDbPath)();
            return (0, node_fs_1.existsSync)(db)
                ? { status: "ok", detail: `sqlite3 ${version}, ${(0, settings_1.tildify)(db)}` }
                : {
                    status: "warn",
                    detail: `sqlite3 ${version}; ${(0, settings_1.tildify)(db)} not found yet (created by OpenCode's first run)`,
                };
        },
    };
}
function probes() {
    return [
        nodeCheck(),
        binaryCheck(),
        ...settings_1.AGENTS.map(hookCheck),
        mailboxCheck(),
        legacyMailCheck(),
        registryCheck(),
        claudeSessionsCheck(),
        sqliteCheck(),
    ];
}
/** Run every check; with `fix`, repair what crew owns and re-check. */
function runDoctor(fix) {
    const out = [];
    for (const p of probes()) {
        let r;
        try {
            r = p.run();
        }
        catch (err) {
            r = { status: "fail", detail: `check crashed: ${err.message}` };
        }
        if (fix && p.repair && r.status !== "ok") {
            try {
                p.repair();
                const again = p.run();
                r =
                    again.status === "ok"
                        ? { ...again, status: "fixed", detail: `${again.detail} (was: ${r.detail})` }
                        : again;
            }
            catch (err) {
                r = {
                    status: "fail",
                    detail: `${r.detail}; fix failed: ${err.message}`,
                    fix: r.fix,
                };
            }
        }
        out.push({ id: p.id, label: p.label, ...r });
    }
    return out;
}
const MARK = {
    ok: "✓",
    fixed: "✓",
    warn: "⚠",
    fail: "✗",
};
function renderDoctorText(checks, version) {
    const width = Math.max(...checks.map((c) => c.label.length));
    const lines = [`crew ${version}`, ""];
    for (const c of checks) {
        const tag = c.status === "fixed" ? " (fixed)" : "";
        lines.push(`${MARK[c.status]} ${c.label.padEnd(width)}  ${c.detail}${tag}`);
        if (c.fix && c.status !== "ok" && c.status !== "fixed") {
            lines.push(`  ${"".padEnd(width)}  → ${c.fix}`);
        }
    }
    const fails = checks.filter((c) => c.status === "fail").length;
    const warns = checks.filter((c) => c.status === "warn").length;
    const fixed = checks.filter((c) => c.status === "fixed").length;
    const summary = [];
    if (fails)
        summary.push(`${fails} failing`);
    if (warns)
        summary.push(`${warns} warning(s)`);
    if (fixed)
        summary.push(`${fixed} fixed`);
    lines.push("", summary.length ? summary.join(", ") : "all checks passed");
    return lines.join("\n") + "\n";
}
function renderDoctorJson(checks, version) {
    const ok = checks.every((c) => c.status !== "fail");
    return JSON.stringify({ schema: 1, version, ok, checks }) + "\n";
}
