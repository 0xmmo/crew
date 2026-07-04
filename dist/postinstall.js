"use strict";
/**
 * npm postinstall — auto-wire `crew --hook` into Claude Code's user settings
 * so what your other running sessions are doing is injected into every
 * session's context.
 *
 * Runs only on global installs (`npm i -g`). Set CREW_NO_HOOK=1 to opt out.
 * Never fails the install: any error is reported and swallowed.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const settings_1 = require("./settings");
function main() {
    if (process.env.CREW_NO_HOOK === "1")
        return;
    const isGlobal = process.env.npm_config_global === "true" ||
        process.env.npm_config_location === "global";
    if (!isGlobal)
        return; // local/dev install: don't touch user settings
    const path = (0, settings_1.settingsPath)();
    const shown = (0, settings_1.tildify)(path);
    try {
        if ((0, settings_1.installHook)(path) === "installed") {
            process.stdout.write("✓ crew wired into Claude Code — your sessions now see each other. Undo: crew uninstall-hook\n");
        }
    }
    catch (err) {
        process.stdout.write(`crew: couldn't update ${shown} (${err.message}).\n` +
            "crew: run `crew install-hook` to retry, or add the hook manually — see the README.\n");
    }
}
main();
