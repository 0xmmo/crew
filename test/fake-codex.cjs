const { spawnSync } = require("node:child_process");
const readline = require("node:readline");

const [crew, transcript, cwd, sid] = process.argv.slice(2);

function hook(event) {
  return spawnSync(process.execPath, [crew, "--hook"], {
    env: process.env,
    input: JSON.stringify({
      session_id: sid,
      hook_event_name: event,
      transcript_path: transcript,
      cwd,
      model: "gpt-test",
    }),
    encoding: "utf8",
  });
}

const started = hook("SessionStart");
if (started.status !== 0) {
  process.stderr.write(started.stderr);
  process.exit(started.status ?? 1);
}
process.stdout.write("ready\n");

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (line === "stop") {
    const stopped = hook("Stop");
    process.stdout.write(`hook:${stopped.stdout.trim()}\n`);
  }
});

