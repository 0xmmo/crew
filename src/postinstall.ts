/**
 * npm postinstall — auto-wire `crew --hook` into Claude Code's user settings
 * so what your other running sessions are doing is injected into every
 * session's context.
 *
 * Runs only on global installs (`npm i -g`). Set CREW_NO_HOOK=1 to opt out.
 * Never fails the install: any error is reported and swallowed.
 */

import { HOOK_COMMAND, installHook, settingsPath } from "./settings";

function main(): void {
  if (process.env.CREW_NO_HOOK === "1") return;
  const isGlobal =
    process.env.npm_config_global === "true" ||
    process.env.npm_config_location === "global";
  if (!isGlobal) return; // local/dev install: don't touch user settings
  const path = settingsPath();
  try {
    if (installHook(path) === "installed") {
      process.stdout.write(
        `crew: wired \`${HOOK_COMMAND}\` into ${path} (context + messaging hooks).\n` +
          "crew: your Claude Code sessions now see each other. Remove with `crew uninstall-hook`;\n" +
          "crew: install with CREW_NO_HOOK=1 to skip this step.\n",
      );
    }
  } catch (err) {
    process.stdout.write(
      `crew: could not update ${path} (${(err as Error).message}).\n` +
        "crew: run `crew install-hook` to retry, or add the hook manually — see the README.\n",
    );
  }
}

main();
