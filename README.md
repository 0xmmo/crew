# crew

Simple multi-agent collaboration for [Claude Code](https://claude.com/claude-code). `crew` lets one Claude see what your other running Claudes are doing — every live session's status, recap, and a tail of its transcript — from the terminal, or as NDJSON another agent can consume to coordinate. Installs the `crew` binary.

```sh
npm install -g @0xmmo/crew
```

Requires Node.js ≥ 18. macOS and Linux.

```sh
crew                  # human view, last 50 transcript entries per session
crew 10               # last 10 entries
crew --json           # NDJSON: one structured object per session
crew --json --full    # NDJSON without tool input/output truncation
crew --help
```

## What it shows

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

## How it works

Every interactive Claude Code session writes `~/.claude/sessions/<pid>.json` while running. `crew` reads those, keeps the ones whose pid is still a live `claude` process (skipping stale files and reused pids), then pulls each session's recap and transcript tail from `~/.claude/projects/`. It reads only — it never touches your sessions.

Set `CLAUDE_HOME` to point at a non-default `~/.claude`.

## `--json` for agents

`--json` prints newline-delimited JSON (NDJSON), one object per session, with explicit fields instead of glyphs — built for another agent or script to consume:

```json
{"pid":66643,"sessionId":"4d3de8db-…","shortId":"4d3de8db","status":"busy","cwd":"/Users/you/Projects/api","startedAt":"2026-06-28T23:40:36.000Z","transcript":"/Users/you/.claude/projects/…/4d3de8db-….jsonl","recap":"…","messageCount":215,"tailCount":3,"tail":[{"ts":"…","role":"assistant","kind":"text","text":"All 142 tests pass."}]}
```

Tool input/output is truncated by default; pass `--full` for the complete content.

## Development

```sh
git clone https://github.com/0xmmo/crew && cd crew
npm install
npm run build
node dist/crew.js --json
```

## License

MIT
