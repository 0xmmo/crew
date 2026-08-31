<div align="center">

# crew

**Let agents talk to each other.**

<sub><b>Claude Code · Codex · opencode</b></sub>

<sub>Ship features in parallel, no branches, no worktrees. Hand off work between sessions,<br>steer around each other's in-flight edits, announce deploys to every running agent.</sub>

[![npm version](https://img.shields.io/npm/v/@0xmmo/crew?style=flat-square&color=e8a33d&labelColor=1a1a23)](https://www.npmjs.com/package/@0xmmo/crew)
[![downloads](https://img.shields.io/npm/dm/@0xmmo/crew?style=flat-square&color=e8a33d&labelColor=1a1a23)](https://www.npmjs.com/package/@0xmmo/crew)
[![node](https://img.shields.io/node/v/@0xmmo/crew?style=flat-square&color=e8a33d&labelColor=1a1a23)](https://www.npmjs.com/package/@0xmmo/crew)
[![license](https://img.shields.io/npm/l/@0xmmo/crew?style=flat-square&color=e8a33d&labelColor=1a1a23)](https://github.com/0xmmo/crew/blob/main/LICENSE)

<br>

<img src="https://raw.githubusercontent.com/0xmmo/crew/main/assets/demo.gif" alt="Two coding agents in the same checkout: crew injects each session's live status into the other, one steers around the other's in-flight refactor, and a crew send message lands mid-turn." width="830">

</div>

<br>

crew auto-injects what your other running [Claude Code](https://claude.com/claude-code), [Codex](https://developers.openai.com/codex/), and [opencode](https://opencode.ai) sessions are doing (status, recap, and a tail of each transcript) into every session's context. All three products share one crew, so any of them can see and message the others. Agents steer around in-flight work while parallel sessions operate from one checkout instead of needing a worktree each. There's also a CLI for watching all of it yourself.

*Just like autonomous cars don't need stoplights, agents don't need worktrees.*

- **Shared context, live** — every session knows what the rest of the crew is doing, refreshed as it changes.
- **Agent-to-agent mail** — `crew send` drops a message into another agent's context within seconds, even mid-turn.
- **A human view** — one command shows every session's status, recap, and transcript tail; `--json` for scripts and agents.
- **Zero config** — `npm i -g` wires all three products, or install it as a plugin. Token-frugal and fail-safe by design; reads transcripts, never modifies them.

## Install

```sh
npm install -g @0xmmo/crew
```

That's the whole setup: installing globally wires the hook into `~/.claude/settings.json` and `~/.codex/hooks.json`, and drops a generated crew plugin into `~/.config/opencode/plugins/`, automatically. (If your npm has `ignore-scripts=true`, postinstall can't run; do it with `crew install-hook` once instead.) Requires Node.js ≥ 18. macOS and Linux.

Codex reviews user-installed command hooks before running them. Start a new Codex session, open `/hooks`, and trust crew when prompted. Claude Code uses the hook immediately.

### Or as a Claude Code plugin

```
/plugin marketplace add 0xmmo/crew
/plugin install crew@0xmmo
```

Same thing, zero `settings.json` edits: the plugin ships the four hooks and its own copy of the binary (fetched from npm), and `/plugin` manages updates. The repository also includes a native Codex plugin manifest for Codex marketplaces and local plugin installs. When the global `crew` command isn't installed, injected guidance points agents at the plugin's own entry point instead, so messaging still works. Pick either path; if you end up with both, the plugin defers to the global install so nothing is injected twice. The global install is still the way to get `crew` on your own PATH and automatically cover both products.

## What your agents see, live

From then on, every Claude Code and Codex session starts with (and keeps getting, as things change) a context block like:

```yaml
2 other agent session(s) running on this machine right now. Consider them
before starting overlapping work; run `crew` for the full view.

• 4d3de8db — claude — busy — /Users/you/Projects/api
  recap: Goal was fixing the imagent CPU spin, now resolved and documented.
  17:41 › run the test suite
  17:41 ⚙ Bash: npm test
  17:42 ‹ All 142 tests pass.

• b5e3454f — codex — idle — /Users/you/Projects/web
  recap: Diagnosed the sandbox validator bug; awaiting go-ahead to implement.

You can message any of them: `crew send 4d3de8db "text"` drops the text into
that agent's context within seconds.
```

So when an agent in one session is about to touch files another session is mid-way through, it knows, and it knows how to say something about it. A `crew send` from another agent (or from you in a plain terminal) lands the same way, even mid-turn:

```yaml
📨 Message from 4d3de8db (/Users/you/Projects/api, sent 2m ago):
  heads up — refactoring src/settings.ts, hold off for 20 min
Reply with: `crew send 4d3de8db "text"`
```

## Messaging between agents

Any session (or you, from a plain terminal) can drop a message straight into another agent's context:

```sh
crew send b5e3 "settings.ts is mine for the next 20 min"   # target: shortId prefix, pid, or cwd substring
crew send --all "deploying api to staging now"             # broadcast to every other session
crew send fc22 "npm support replied, name is free" --ttl 2h  # expire undelivered mail (default 24h)
crew send 4d3d "prod is broken, stop deploying" --kickstart  # force the target to act on it (-k)
crew inbox                                                 # peek at your own pending mail
```

Sender attribution is automatic: `crew send` walks up the process tree to find which session it was called from, so agents never have to identify themselves.

When it arrives depends on what the target is doing:

| Target state | Delivered |
|---|---|
| busy, mid-turn | after its next tool call, typically seconds |
| finishing a turn | at turn end, and the agent acts on it before going idle |
| idle | on its next user prompt — or within ~15s for a kickstart to opencode |

An idle Claude or Codex session can't be woken externally, so undelivered mail waits in `~/.crew/inbox/` until its TTL expires; the `crew` view shows a 📨 pending count for it in the meantime. Once delivered, a message becomes part of the target's context, like anything else it read. Each message is delivered exactly once, even when hook events race. In Codex, pending mail at `Stop` deliberately continues the turn once so the agent can act on it before becoming idle.

**`--kickstart` (`-k`)** turns a message from passive context into a directive. Normally mail delivered as a session finishes its turn is injected as context the agent *may* act on; a kickstart message instead force-continues the agent (via the `Stop` hook's `decision: block`), so it keeps working and acts on the message rather than going idle — the same continuation Codex mail already does, made explicit and on demand for Claude too. It catches the target the moment it *would* stop; a Claude or Codex session already sitting idle has no upcoming `Stop` to catch, so `crew send` warns you and the message waits like normal mail until the session next runs. An **opencode** target is the exception: crew's plugin runs inside the opencode process and can prompt an idle session from within, so a kickstart wakes it within ~15 seconds — plain mail still waits politely for its next turn.

### Waking a fully-idle agent

An idle **opencode** session just wakes: send with `--kickstart` and the crew plugin's poller prompts it from inside the process within ~15 seconds.

For Claude and Codex, a session sitting idle at its prompt can't be woken by a hook — its `Stop` already fired, and Claude Code exposes no API to inject a prompt into a running interactive session ([open feature request](https://github.com/anthropics/claude-code/issues/27441)). Writing bytes to its terminal doesn't help either: Claude's input uses bracketed-paste mode, so a piped carriage return is swallowed as a literal newline rather than submitting.

The one mechanism that works is a terminal multiplexer, which owns the pty and can deliver a *standalone* Enter key event. If you run agents inside **tmux**, you can wake an idle one yourself:

```sh
tmux send-keys -t <target> -l -- "$(crew inbox)"   # or your own text
sleep 0.4                                           # keep Enter a separate key event
tmux send-keys -t <target> Enter                    # fires submit
```

(GNU `screen` has the equivalent `screen -S <sess> -X stuff`.) There's no clean, focus-free equivalent for VS Code integrated terminals or a bare terminal, so for those a kickstart message waits until the session next runs on its own.

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
crew send <t> "msg" -k  # kickstart: force the target to act on the message
crew inbox            # your own pending messages
crew --help
```

```yaml
🔵  4d3de8db   codex   pid 66643   status: busy
   cwd: /Users/you/Projects/api
   started: 6/28/2026, 4:40:36 PM

   recap: Goal was fixing the imagent CPU spin, now resolved and documented.

   last 3 transcript entries (of 215):
   17:41 › run the test suite
   17:41 ⚙ Bash: npm test
   17:42 ‹ All 142 tests pass.
```

- **agent** — `claude`, `codex`, or `opencode`.
- **status** — `busy` (working), `idle` (awaiting input), or Claude's `shell` state.
- **recap** — the session's most recent completion/recap, when available.
- **tail** — the last N transcript entries: `›` you, `‹` the agent, `⚙` tool call, `⟲` tool result.

### `--json` for agents

`--json` prints newline-delimited JSON (NDJSON), one object per session, with explicit fields instead of glyphs — built for another agent or script to consume:

```json
{"pid":66643,"sessionId":"4d3de8db-…","shortId":"4d3de8db","agent":"codex","status":"busy","cwd":"/Users/you/Projects/api","startedAt":"2026-06-28T23:40:36.000Z","transcript":"/Users/you/.codex/sessions/…/rollout-….jsonl","recap":"…","messageCount":215,"tailCount":3,"tail":[{"ts":"…","role":"assistant","kind":"text","text":"All 142 tests pass."}]}
```

Tool input/output is truncated by default; pass `--full` for the complete content.

## How the injection works

`npm i -g` adds `crew --hook` to the same four lifecycle events in Claude Code and Codex (a plugin install registers them inside the plugin instead of user settings):

- **`SessionStart`** — every new session (and every re-start after context compaction) opens knowing what the rest of the crew is doing.
- **`UserPromptSubmit`** — the picture is refreshed before each of your messages, and queued mail is delivered with it.
- **`PostToolUse`** — mail only: a busy agent receives messages after supported tool calls, typically within seconds of `crew send`.
- **`Stop`** — mail only: an agent finishing its turn handles waiting messages instead of going idle. A `--kickstart` message force-continues the turn here (`decision: block`) so the agent acts on it rather than injecting it as passive context.

**opencode has no hook file; it gets a generated plugin instead** (`~/.config/opencode/plugins/crew.js`), a thin adapter that runs inside the opencode process and shells back out to `crew --hook` with the same payloads: `chat.message` maps to `UserPromptSubmit` (context lands as a synthetic message part), `tool.execute.after` to `PostToolUse` (mail is appended to the tool result), and `session.idle` to `Stop`. It also tags every shell command with `CREW_SESSION_ID` so sender attribution works even though one opencode process hosts many sessions, and polls the inbox of idle sessions so a kickstart can wake them via the SDK. All behavior lives in the crew CLI the plugin calls, so upgrading crew upgrades running plugins without a reinstall. At `Stop`, plain mail is deliberately left queued — draining it into a session that's about to go idle would lose it — and only a pending kickstart triggers the wake.

The hook is careful about tokens and safety:

- Emits **nothing** when no other sessions are running, and nothing on `UserPromptSubmit` when the crew status hasn't changed since the last emit (a per-session hash under your temp dir).
- The `PostToolUse`/`Stop` modes do the bare minimum: refresh the live registry and check one inbox, with no transcript scan and total silence when there's no mail.
- Tails are short in hook mode (5 entries per session, truncated) and capped at 8 sessions.
- It always exits 0, so a broken or slow read can never block your prompt, your session, or an agent's turn.
- The auto-install merges into existing Claude/Codex hook settings and refuses to write over a file it can't parse.

Managing it:

```sh
crew uninstall-hook              # remove it from all three products
crew install-hook                # add it to Claude Code, Codex, and opencode (idempotent)
CREW_NO_HOOK=1 npm i -g @0xmmo/crew   # install without touching hook settings
```

Or wire it manually; this hook object works in both `~/.claude/settings.json` and `~/.codex/hooks.json`:

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

## How discovery works

Every interactive Claude Code session writes `~/.claude/sessions/<pid>.json` while running. crew reads that native registry and pulls the corresponding transcript tail from `~/.claude/projects/`.

Codex supplies `session_id`, `transcript_path`, `cwd`, and lifecycle state to hooks. crew records those fields in a small live registry under `~/.crew/sessions/`, verifies the owning process is still alive, and parses the useful user/assistant/tool subset of the rollout. Top-level interactive and `codex exec` sessions are included; internal Codex subagents are intentionally not listed as separate crew members because they share their parent's lifecycle and mailbox. Codex documents its transcript format as non-stable, so crew skips unknown rollout records defensively.

opencode sessions register in the same `~/.crew/sessions/` registry via the generated plugin, which identifies itself over env (`CREW_AGENT`/`CREW_PID`) rather than process-tree guessing. Transcripts are read on demand from opencode's SQLite store (`~/.local/share/opencode/opencode.db`, message/part tables) through the `sqlite3` CLI — read-only, degrading to a status-only listing when `sqlite3` isn't available. Like the Codex rollout, that schema is treated as a convenience input, not a stable API. Subagent (child) sessions are skipped, as are crew's own injected context parts, and deleted sessions are dropped from the registry immediately.

All discovery paths are read-only with respect to agent state and transcripts. In hook mode crew excludes the session it is reporting to, so an agent never sees itself listed.

Set `CLAUDE_HOME` or `CODEX_HOME` for non-default product state directories. The Claude hook installer also honors `CLAUDE_CONFIG_DIR`; opencode paths follow `XDG_CONFIG_HOME`/`XDG_DATA_HOME`; set `CREW_HOME` to move shared registry/mailbox state from `~/.crew`.

## Development

```sh
git clone https://github.com/0xmmo/crew && cd crew
npm install
npm run build
echo '{"session_id":"x","hook_event_name":"SessionStart"}' | node dist/crew.js --hook
echo '{"session_id":"x","hook_event_name":"SessionStart","cwd":"'$PWD'","transcript_path":"/tmp/rollout-x.jsonl","model":"gpt-5"}' | node dist/crew.js --hook
node dist/crew.js --json

# regenerate the demo GIF (assets/demo.html is the storyboard)
node assets/record.mjs /tmp/crew-frames 12
ffmpeg -framerate 12 -i /tmp/crew-frames/f%05d.png -vf "scale=960:-1:flags=lanczos,palettegen=max_colors=128:stats_mode=diff" /tmp/crew-palette.png
ffmpeg -framerate 12 -i /tmp/crew-frames/f%05d.png -i /tmp/crew-palette.png -lavfi "scale=960:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" -loop 0 assets/demo.gif
```

## License

MIT
