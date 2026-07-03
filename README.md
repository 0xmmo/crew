# crew

Let your [Claude Code](https://claude.com/claude-code) agents coordinate and ship multiple features concurrently — no branching, no worktrees.

crew auto-injects what your other running Claude Code sessions are doing — status, recap, and a tail of each transcript — into every session's context. Agents see each other's in-flight work and steer around it, so parallel sessions work from one shared checkout instead of needing a worktree each. Agents can also message each other directly with `crew send`. There's a CLI for watching all of it yourself.

```sh
npm install -g @0xmmo/crew
```

That's the whole setup: installing globally wires the hook into `~/.claude/settings.json` automatically. (If your npm has `ignore-scripts=true`, postinstall can't run — do it with `crew install-hook` once instead.) Requires Node.js ≥ 18. macOS and Linux.

## What your agents see, live

From then on, every Claude Code session starts with (and keeps getting, as things change) a context block like:

```
2 other Claude Code session(s) running on this machine right now. Consider them
before starting overlapping work; run `crew` for the full view.

• 4d3de8db — busy — /Users/you/Projects/api
  recap: Goal was fixing the imagent CPU spin, now resolved and documented.
  17:41 › run the test suite
  17:41 ⚙ Bash: npm test
  17:42 ‹ All 142 tests pass.

• b5e3454f — idle — /Users/you/Projects/web
  recap: Diagnosed the sandbox validator bug; awaiting go-ahead to implement.

You can message any of them: `crew send 4d3de8db "text"` drops the text into
that agent's context within seconds.
```

So when an agent in one session is about to touch files another session is mid-way through, it knows — and it knows how to say something about it. A `crew send` from another agent (or from you in a plain terminal) lands the same way, even mid-turn:

```
📨 Message from 4d3de8db (/Users/you/Projects/api, sent 2m ago):
  heads up — refactoring src/settings.ts, hold off for 20 min
Reply with: `crew send 4d3de8db "text"`
```

## Messaging between agents

Any session — or you, from a plain terminal — can drop a message straight into another agent's context:

```sh
crew send b5e3 "settings.ts is mine for the next 20 min"   # target: shortId prefix, pid, or cwd substring
crew send --all "deploying api to staging now"             # broadcast to every other session
crew send fc22 "npm support replied, name is free" --ttl 2h  # expire undelivered mail (default 24h)
crew inbox                                                 # peek at your own pending mail
```

Sender attribution is automatic: `crew send` walks up the process tree to find which session it was called from, so agents never have to identify themselves.

When it arrives depends on what the target is doing:

| Target state | Delivered |
|---|---|
| busy, mid-turn | after its next tool call — typically seconds |
| finishing a turn | at turn end, and the agent acts on it before going idle |
| idle | on its next user prompt |

An idle session can't be woken externally, so undelivered mail waits in `~/.claude/crew/inbox/` until its TTL expires; the `crew` view shows a 📨 pending count for it in the meantime. Once delivered, a message becomes a permanent part of the target's transcript, like anything else it read. Each message is delivered exactly once, even when hook events race.

## How the injection works

`npm i -g` adds `crew --hook` to four Claude Code hook events:

- **`SessionStart`** — every new session (and every re-start after context compaction) opens knowing what the rest of the crew is doing.
- **`UserPromptSubmit`** — the picture is refreshed before each of your messages, and queued mail is delivered with it.
- **`PostToolUse`** — mail only: a busy agent receives messages between tool calls, within seconds of `crew send`.
- **`Stop`** — mail only: an agent finishing its turn handles waiting messages instead of going idle.

The hook is careful about tokens and safety:

- Emits **nothing** when no other sessions are running, and nothing on `UserPromptSubmit` when the crew status hasn't changed since the last emit (a per-session hash under your temp dir).
- The `PostToolUse`/`Stop` modes fire on every tool call, so they do the bare minimum: one inbox readdir, no session or transcript scanning, total silence when there's no mail.
- Tails are short in hook mode (5 entries per session, truncated) and capped at 8 sessions.
- It always exits 0 — a broken or slow read can never block your prompt, your session, or an agent's turn.
- The auto-install merges into your existing `settings.json` and refuses to write over a file it can't parse.

Managing it:

```sh
crew uninstall-hook              # remove the hook from settings.json
crew install-hook                # add it back (idempotent)
CREW_NO_HOOK=1 npm i -g @0xmmo/crew   # install without touching settings.json
```

Or wire it manually — this is all the auto-install adds:

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "crew --hook" }] }
    ],
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "crew --hook" }] }
    ],
    "PostToolUse": [
      { "hooks": [{ "type": "command", "command": "crew --hook" }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "crew --hook" }] }
    ]
  }
}
```

## The CLI

The same view, for humans:

```sh
crew                  # human view, last 50 transcript entries per session
crew 10               # last 10 entries
crew --json           # NDJSON: one structured object per session
crew --json --full    # NDJSON without tool input/output truncation
crew --dir ~/work     # only sessions whose cwd is under ~/work
crew --dir            # only sessions under the current directory
crew send <t> "msg"   # message a session (t: shortId prefix, pid, cwd substring)
crew inbox            # your own pending messages
crew --help
```

```
🔵  4d3de8db   pid 66643   status: busy
   cwd: /Users/you/Projects/api
   started: 6/28/2026, 4:40:36 PM

   recap: Goal was fixing the imagent CPU spin, now resolved and documented.

   last 3 transcript entries (of 215):
   17:41 › run the test suite
   17:41 ⚙ Bash: npm test
   17:42 ‹ All 142 tests pass.
```

- **status** — `busy` (working), `idle` (awaiting input), `shell` (running a shell command).
- **recap** — the session's most recent built-in recap (`away_summary`).
- **tail** — the last N transcript entries: `›` you, `‹` Claude, `⚙` tool call, `⟲` tool result.

### `--json` for agents

`--json` prints newline-delimited JSON (NDJSON), one object per session, with explicit fields instead of glyphs — built for another agent or script to consume:

```json
{"pid":66643,"sessionId":"4d3de8db-…","shortId":"4d3de8db","status":"busy","cwd":"/Users/you/Projects/api","startedAt":"2026-06-28T23:40:36.000Z","transcript":"/Users/you/.claude/projects/…/4d3de8db-….jsonl","recap":"…","messageCount":215,"tailCount":3,"tail":[{"ts":"…","role":"assistant","kind":"text","text":"All 142 tests pass."}]}
```

Tool input/output is truncated by default; pass `--full` for the complete content.

## How discovery works

Every interactive Claude Code session writes `~/.claude/sessions/<pid>.json` while running. crew reads those, keeps the ones whose pid is still a live `claude` process (skipping stale files and reused pids), then pulls each session's recap and transcript tail from `~/.claude/projects/`. It reads only — it never touches your sessions. In hook mode it additionally excludes the session it's reporting to, so an agent never sees itself listed.

Set `CLAUDE_HOME` to point at a non-default `~/.claude`. The hook installer also honors `CLAUDE_CONFIG_DIR` for locating `settings.json`.

## Development

```sh
git clone https://github.com/0xmmo/crew && cd crew
npm install
npm run build
echo '{"session_id":"x","hook_event_name":"SessionStart"}' | node dist/crew.js --hook
node dist/crew.js --json
```

## License

MIT
