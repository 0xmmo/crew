"use strict";
/**
 * npm postinstall — auto-wire `crew --hook` into Claude Code and Codex.
 *
 * Runs only on global installs (`npm i -g`). Set CREW_NO_HOOK=1 to opt out.
 * Never fails the install: errors are reported and swallowed.
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
    const labels = { claude: "Claude Code", codex: "Codex" };
    for (const agent of ["claude", "codex"]) {
        const shown = (0, settings_1.tildify)((0, settings_1.settingsPath)(agent));
        try {
            if ((0, settings_1.installHook)(agent) === "installed") {
                process.stdout.write(`✓ crew wired into ${labels[agent]} (${shown}).\n`);
            }
        }
        catch (err) {
            process.stdout.write(`crew: couldn't update ${shown} (${err.message}).\n` +
                "crew: run `crew install-hook` to retry, or add the hook manually — see the README.\n");
        }
    }
}
main();
