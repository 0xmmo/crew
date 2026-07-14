const assert = require("node:assert/strict");
const { mkdtempSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { test } = require("node:test");

const root = resolve(__dirname, "..");
const crew = join(root, "dist", "crew.js");

function homes() {
  const root = mkdtempSync(join(tmpdir(), "crew-test-"));
  return {
    root,
    env: {
      ...process.env,
      CLAUDE_HOME: join(root, "claude"),
      CODEX_HOME: join(root, "codex"),
      CREW_HOME: join(root, "crew"),
    },
  };
}

function run(args, env, input) {
  return spawnSync(process.execPath, [crew, ...args], {
    cwd: root,
    env,
    input,
    encoding: "utf8",
  });
}

test("install-hook merges both products and uninstall preserves other settings", () => {
  const h = homes();
  mkdirSync(h.env.CLAUDE_HOME, { recursive: true });
  writeFileSync(
    join(h.env.CLAUDE_HOME, "settings.json"),
    JSON.stringify({ theme: "dark" }),
  );

  assert.equal(run(["install-hook"], h.env).status, 0);
  for (const path of [
    join(h.env.CLAUDE_HOME, "settings.json"),
    join(h.env.CODEX_HOME, "hooks.json"),
  ]) {
    const config = JSON.parse(readFileSync(path, "utf8"));
    for (const event of ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"]) {
      assert.equal(config.hooks[event][0].hooks[0].command, "crew --hook");
    }
  }
  assert.equal(
    JSON.parse(readFileSync(join(h.env.CLAUDE_HOME, "settings.json"), "utf8")).theme,
    "dark",
  );

  assert.equal(run(["uninstall-hook"], h.env).status, 0);
  const remaining = JSON.parse(
    readFileSync(join(h.env.CLAUDE_HOME, "settings.json"), "utf8"),
  );
  assert.deepEqual(remaining, { theme: "dark" });
});

test("Codex hooks register, parse, receive mail, and drain on Stop", async (t) => {
  const h = homes();
  const sid = "019f-test-codex-session";
  const codexSessions = join(h.env.CODEX_HOME, "sessions", "2026", "07", "14");
  mkdirSync(codexSessions, { recursive: true });
  const transcript = join(codexSessions, `rollout-test-${sid}.jsonl`);
  const records = [
    {
      timestamp: "2026-07-14T07:00:00.000Z",
      type: "session_meta",
      payload: { id: sid, cwd: root, source: "cli" },
    },
    {
      timestamp: "2026-07-14T07:00:01.000Z",
      type: "event_msg",
      payload: { type: "user_message", message: "fix the parser" },
    },
    {
      timestamp: "2026-07-14T07:00:02.000Z",
      type: "response_item",
      payload: {
        type: "function_call",
        name: "exec_command",
        arguments: JSON.stringify({ cmd: "npm test" }),
      },
    },
    {
      timestamp: "2026-07-14T07:00:03.000Z",
      type: "response_item",
      payload: { type: "function_call_output", output: "all tests pass" },
    },
    {
      timestamp: "2026-07-14T07:00:04.000Z",
      type: "event_msg",
      payload: { type: "agent_message", message: "Parser fixed." },
    },
    {
      timestamp: "2026-07-14T07:00:05.000Z",
      type: "event_msg",
      payload: { type: "task_complete", last_agent_message: "Parser fixed." },
    },
  ];
  writeFileSync(transcript, records.map(JSON.stringify).join("\n") + "\n");

  const fake = spawn(
    process.execPath,
    [join(root, "test", "fake-codex.cjs"), crew, transcript, root, sid, "codex"],
    { cwd: root, env: h.env, stdio: ["pipe", "pipe", "pipe"] },
  );
  t.after(() => fake.kill());

  let output = "";
  fake.stdout.setEncoding("utf8");
  fake.stdout.on("data", (chunk) => (output += chunk));
  await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error("fake Codex did not start")), 3000);
    fake.stdout.on("data", () => {
      if (output.includes("ready\n")) {
        clearTimeout(timer);
        resolvePromise();
      }
    });
  });

  const listed = run(["--json", "10"], h.env);
  assert.equal(listed.status, 0, listed.stderr);
  const session = JSON.parse(listed.stdout.trim());
  assert.equal(session.sessionId, sid);
  assert.equal(session.agent, "codex");
  assert.equal(session.recap, "Parser fixed.");
  assert.deepEqual(
    session.tail.map((entry) => entry.kind),
    ["text", "tool_use", "tool_result", "text"],
  );
  assert.equal(session.tail[1].summary, "npm test");

  const sent = run(["send", sid.slice(0, 8), "coordinate first"], h.env);
  assert.equal(sent.status, 0, sent.stderr);
  fake.stdin.write("stop\n");
  await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error("Stop hook did not return")), 3000);
    fake.stdout.on("data", () => {
      if (output.includes("hook:")) {
        clearTimeout(timer);
        resolvePromise();
      }
    });
  });
  const hookLine = output.split("\n").find((line) => line.startsWith("hook:"));
  const result = JSON.parse(hookLine.slice(5));
  assert.equal(result.decision, "block");
  assert.match(result.reason, /coordinate first/);

  const after = JSON.parse(run(["--json"], h.env).stdout.trim());
  assert.equal(after.pendingMessages, 0);
  assert.equal(after.status, "idle");
});

