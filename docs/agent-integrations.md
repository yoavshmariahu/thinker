# Coding agent compatibility

Thinker supports eight clients through `thinker setup --clients auto` (detected
clients), `--clients all`, or a comma-separated selection. To add the new adapters:

```sh
thinker setup --clients pi,windsurf,copilot,opencode --no-build
```

Restart the host agent after setup so it discovers the generated hooks/extensions.
Project trust and hook enablement remain controlled by the host. New generated project files
are locally excluded from git; existing instruction files retain their visibility. `thinker uninstall`
removes Thinker's entries and preserves other integrations.

## Instructions available before exploration

Setup and `connect` install a short workflow alongside the tools: use injected notes,
ask specific questions with `lookup`, save reusable discoveries, and
correct wrong notes. The code tools `find` and `drilldown` are off unless a repository
turns them on with `thinker tools enable find drilldown`; while off they are neither
offered nor mentioned to the agent. `orient` is off by default too (`thinker tools
enable orient` turns it on): the prompt hook's notes and `lookup` remain. Windsurf and
Copilot CLI, whose notes come through the CLI `orient`, keep it in their rules. Ordinary searches and reads remain available
when Thinker's tools cannot answer the question.

| Client | Persistent workflow location |
| --- | --- |
| Claude Code | `~/.claude/CLAUDE.md` (respects `CLAUDE_CONFIG_DIR`) |
| Codex | `$CODEX_HOME/AGENTS.md`, or existing `AGENTS.override.md` (`CODEX_HOME` defaults to `~/.codex`) |
| Gemini/Agy | `~/.gemini/GEMINI.md` |
| Cursor | `.cursor/rules/thinker.mdc`, always applied |
| Pi | Native extension supplies the workflow before the agent starts |
| Windsurf Cascade | `.windsurf/rules/thinker.md`, or the existing `.devin/rules/` location |
| Copilot CLI | `.github/instructions/thinker.instructions.md` |
| OpenCode | `.opencode/thinker.md`, added to `instructions` by the plugin |

Claude, Codex and Gemini instructions live at user scope, like their hooks and MCP
configuration, so fresh worktrees also receive them. They apply only in repositories
set up with Thinker. Legacy project wiring receives equivalent local instruction
blocks. OpenCode uses an additional instruction file so it does not mask an existing
`AGENTS.md` or `CLAUDE.md` fallback. These locations follow the hosts' native
[Claude memory](https://code.claude.com/docs/en/memory),
[Codex instructions](https://learn.chatgpt.com/docs/agent-configuration/agents-md),
[Gemini context](https://geminicli.com/docs/cli/gemini-md/), and
[OpenCode rules](https://opencode.ai/docs/rules/) mechanisms.

Thinker prepends a marked block to shared instruction files, preserving the user's
text. Reinstalling or upgrading replaces only that block; uninstall removes it.
Symlinked instruction files are left alone with a setup error rather than edited
through the link. Custom host settings that disable or replace native instruction
loading can prevent this workflow from loading.

`thinker update` refreshes existing wiring and its instructions; `thinker rewire`
does it explicitly. Prompt hooks also refresh connected installations. Restart the
host afterward to reload persistent instructions. `thinker uninstall --user` removes
the user-scope blocks; repository uninstall removes project instructions.

Updates repair the environment through the new copy's `rewire` command, including
scheduled checks that find no newer version and `install.sh --update`. Existing
Codex wiring gets subagents enabled and generated hooks reviewed even when the
hook files are unchanged. Entries pointing to missing installations are moved to
the updated copy. Learning preferences and removed/declined clients are preserved.
The repair makes no model calls and does not require a CLI login.

A malformed configuration, a custom hook, or wiring to another live installation
is reported as an incomplete repair; other clients are still checked. Update exits
unsuccessfully and saves details in `~/.thinker/state/environment-repair.json`.
`thinker doctor` and the next terminal notice expose the failure; `thinker rewire`
retries it, and `thinker doctor --fix` can also retry. A later successful repair
clears the error. Older updaters that ignore the repair command's exit status still
leave this record on their first upgrade. Restart open desktop apps after settings
change; pending learning resumes through a later app prompt.

`thinker doctor` checks the install end to end: Node, dependencies, `thinker` on
PATH, each agent's hooks and MCP entry, wiring left by another or a deleted copy,
this checkout's setup and git hooks, the MCP server answering `tools/list`, and the
ranking model. `thinker doctor --fix` repairs what it can (dependencies, missing or
stale wiring, PATH, the model) and checks again.

Pi, Windsurf and Copilot receive CLI commands rather than unavailable MCP tool
names. They save notes with `thinker add note.json --source agent` and correct notes
with `thinker feedback feedback.json` (or JSON on stdin):

```json
{"id":"note-id","useful":false,"correction":"Corrected body with file:Symbol pointers."}
```

The workflow respects disabled learning and tool controls. Installation tests cover
all eight delivery paths, preservation of existing text, repeated installs, upgrade
refresh, dry runs and removal. This verifies delivery, not that every model will
follow every instruction.

## Coverage

| Client | Request context | File context | Learning capture | Follow-up retrieval |
| --- | --- | --- | --- | --- |
| Claude Code | Prompt hook | Post-tool hook | Native transcript | MCP |
| Codex CLI | Prompt hook | Post-tool hook | Hook trace | MCP |
| Gemini CLI | BeforeAgent | AfterTool | Hook trace | MCP |
| Cursor | Prompt hook (`additional_context`; first tool call under `agent -p`) | Post-tool hook | Hook trace | MCP + rule |
| Pi | before_agent_start extension | tool_result extension | Prompt, tools, final answer; shutdown flush | CLI guidance in extension |
| Windsurf Cascade | Always-on rule asks agent to orient | Agent-directed CLI lookup | Prompt, reads, edits, commands, MCP results, response | CLI rule |
| GitHub Copilot CLI | First successful tool after prompt; CLI instruction fallback | postToolUse | Prompt, tools/errors, stop/end | CLI instruction; optional manual MCP |
| OpenCode | chat.message plugin | tool.execute.after plugin | Prompt, successful tools, idle/end | MCP registered by plugin |

File context is enabled with `--late`. Hook recording is enabled by default;
`--no-learn` or `THINKER_NO_LEARN=1` disables it. Learning still requires an
existing Thinker model backend (Anthropic API or a supported model CLI); these
new hook integrations do not add model-provider adapters. Retrieval itself does
not need model credentials.

## Desktop apps: model calls through the app, never a CLI

Inside a desktop app (Claude Desktop, the Codex app, Cursor) thinker runs no agent
CLI. A desktop app's login does not sign in its CLI, and many of its users have
none installed. Every model call thinker makes for such a session goes through
the app's own session instead, on its login and model: thinker queues the calls
(`.thinker/state/session-llm`), and the agent starts a background subagent that
answers them through thinker's `warmup_next` and `warmup_answer` tools.

- **Warm-up.** Answering Warm starts the build with the session provider (about
  twelve merged pull requests, what one subagent's context holds); the answer tells
  the agent to start the subagent. No CLI login is checked.
- **Learning.** The hooks queue what they would have run in the background (a
  session's distill, catch-up learning, maintenance) as jobs in
  `.thinker/state/session-jobs`. On a later prompt in an app session, at most every
  half hour, the prompt hook starts `thinker session-work` on a few of them and asks
  the agent for the subagent. Maintenance a commit starts in a repository worked in
  an app within a day is queued the same way.
  Jobs stay on disk until their command succeeds. Failed attempts retain their error
  and retry after 30 minutes, doubling the delay up to 24 hours; retries still need
  a later app prompt. A stopped worker's jobs are recovered by the next worker.
  Delivery is at least once: the commands' incremental checkpoints avoid repeating
  completed distillation. Work queued during an attempt survives its completion.
- **Detection.** Claude Desktop sets `CLAUDE_CODE_ENTRYPOINT=claude-desktop`; the
  Codex app (inside ChatGPT.app) and Cursor are found among the process's
  ancestors. A CLI in a terminal keeps the CLI path.
- **Codex.** Its subagents (`[features] multi_agent = true` in
  `~/.codex/config.toml`) are turned on when thinker wires Codex, and by
  `thinker doctor` on machines wired before.

Outside the apps, where no agent CLI is signed in, Claude Code, Codex and Cursor
warm up through the session the same way.

`thinker doctor` recognizes a desktop app or recent app activity in the repository.
It checks pending learning jobs, retained failures, the live worker and unanswered
model requests, and reports the last successful answer through the session queue.
It does not start a CLI model probe for this path. An empty queue or installed MCP
alone is not evidence that the app has answered a model request, and an answer is
not proof that a new note was learned. Resume an app session to service waiting
work; inspect `.thinker/state/session-work.log` for job failures. `doctor --fix`
repairs wiring but does not launch background learning or discard failed jobs.

## End-of-turn notices

All eight adapters install a stop callback when hooks are enabled, including with
`--no-learn`. Notices describe notes actually served during that session's turn;
an empty turn produces no cache-hit notice. `THINKER_NOTICE=off` or `notice: false`
in `.thinker/config.json` disables notices without disabling learning.

| Client | Notice display |
| --- | --- |
| Claude Code, Gemini CLI | `systemMessage` |
| Codex | `systemMessage`; desktop inline card available with `noticeCard: true` |
| Pi | Native `ctx.ui.notify` in interactive mode |
| OpenCode | Native `client.tui.showToast` |
| Windsurf Cascade | Stop stdout with `show_output: true` |
| Cursor, Copilot CLI | Stop callbacks run, but their APIs have no passive notice output |

Codex desktop can show a cache-hit card automatically when `noticeCard: true` is
set in `.thinker/config.json`. Prompt/tool hooks and MCP retrieval supply the agent
with a local display reference alongside actual hits; no special user prompt is
needed. The agent includes it once in its final answer. This relies on the agent
following the display instruction and the desktop's inline visualization renderer;
it is not a native MCP tool card or a guarantee from the stop hook. It is opt-in
while host support is being verified. `THINKER_NOTICE_CARD=off` disables cards;
`THINKER_NOTICE=off` disables all notices.

Cards are kept in `.thinker/state/notice-cards/`. One file per session and turn
collects unique served notes and their existing code-size estimate. Misses and
held-out turns create no card. MCP without a hook session link reports only that
retrieval. Previous cards remain on disk for chat history; removing the state
folder may make those old cards unavailable. No extra model call or stop-hook
continuation is used to display a card.

Codex supports the [common stop output fields](https://learn.chatgpt.com/docs/hooks#common-output-fields).
Pi uses its [extension UI](https://pi.dev/docs/latest/extensions), OpenCode its
[TUI SDK](https://opencode.ai/docs/sdk/#tui), and Windsurf its
[visible hook output](https://docs.windsurf.com/windsurf/cascade/hooks).
Windsurf's CLI retrieval must use a `--session` matching the hook's `trajectory_id`
for hits to be attributed to that turn; unassociated CLI/MCP retrieval is not
counted as another session's cache hit.

[Cursor stop](https://cursor.com/docs/hooks) and
[Copilot agentStop](https://docs.github.com/en/copilot/reference/hooks-reference)
can force continuation, but that starts another model turn. Thinker does not do
that just to show a notice. Their callbacks still clear turn state and perform
learning when enabled. There is no claim of a visible stop notice in those hosts.

## Why these additions

Pi and Windsurf were explicitly requested. Copilot and OpenCode are the next
high-reach additions: GitHub reports [20M+ Copilot developers across its product
surfaces](https://github.blog/ai-and-ml/github-copilot/copilot-faster-smarter-and-built-for-how-you-work-now/),
and [OpenCode reports millions of monthly developers](https://opencode.ai/).
These are vendor-reported, different measures, not a comparable CLI market-share
ranking. Claude Code, Codex, Cursor and Gemini already had adapters.

This is broad coverage, not universal lifecycle parity. Aider exposes
[CLI/Python scripting](https://aider.chat/docs/scripting.html), which would need a
separate wrapper design. Cline, Roo, Goose, Amp and other agents are not claimed
as tested automatic integrations by this change. MCP-capable hosts can use
`thinker serve`; merely supporting MCP does not establish hook compatibility.

## Contracts and limitations

All eight agents are wired machine-wide (`thinker connect`, the installer, and an
update for an agent installed later), so every git checkout gets thinker without
`thinker setup` there. For pi, OpenCode, Copilot CLI and Windsurf the files are
`~/.pi/agent/extensions/thinker.js`; `~/.config/opencode/plugins/thinker.js` and
`~/.config/opencode/AGENTS.md`; `~/.copilot/hooks/thinker.json`,
`~/.copilot/mcp-config.json` and `~/.copilot/copilot-instructions.md`; and
`~/.codeium/windsurf/hooks.json` and `~/.codeium/windsurf/memories/global_rules.md`.
The hooks take the checkout from the session (pi's `ctx.cwd`, OpenCode's worktree,
Copilot's `cwd`, Windsurf's workspace working directory). The checkout files named
below are what `thinker setup --shared` and checkouts set up before 2026-10-15 use;
a checkout's own copy moves to the machine-wide one on its next prompt.

- **Pi:** `.pi/extensions/thinker.js` loads Thinker's extension module. It adds a
  custom context message and appends late notes to tool results without replacing
  the original result. Uses the [extension event contracts](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/extensions/types.ts).
  CLI follow-up retrieval works without an MCP extension or SDK dependency.
- **Windsurf:** `.windsurf/hooks.json` records the documented `trajectory_id` and
  nested `tool_info` payloads. [Cascade hooks](https://docs.windsurf.com/windsurf/cascade/hooks)
  do not document successful stdout as model context, so Thinker does not pretend
  it was delivered. An [always-on rule](https://docs.windsurf.com/windsurf/cascade/memories)
  in `.windsurf/rules/thinker.md` asks the agent to use the CLI. Existing preferred
  `.devin/hooks.json` and `.devin/rules/` locations are respected. This adapter
  targets Cascade, not every agent available inside the editor. Read/command
  callbacks lack full results; the final Cascade response adds the supplied
  summary. Retrieval depends on the agent following the rule.
- **Copilot CLI:** `.github/hooks/thinker.json` uses native camelCase events and
  inputs. [Command prompt hooks discard output](https://docs.github.com/en/copilot/reference/hooks-reference),
  so notes wait for a successful tool result, whose output accepts
  `additionalContext`. A task that uses no tools receives no hook bundle; the
  instruction file `.github/instructions/thinker.instructions.md` provides CLI
  retrieval guidance. Hook payloads without a session ID are ignored rather than
  mixing different conversations. The final assistant answer is not supplied by
  the native stop event and is not fabricated. Thinker's MCP server is registered
  in `~/.copilot/mcp-config.json` (a checkout set up for itself: `.github/mcp.json`). Some headless
  modes require explicitly enabling repository hooks. This is a CLI adapter,
  not a claim about every VS Code/cloud Copilot hook runtime.
- **OpenCode:** `.opencode/plugins/thinker.js` uses the documented
  [plugin API](https://opencode.ai/docs/plugins/) and its
  [hook types](https://github.com/anomalyco/opencode/blob/dev/packages/plugin/src/index.ts).
  MCP registration uses the plugin config hook. Idle triggers batch learning;
  ordinary quiet-session catch-up handles sessions without an end event. The
  plugin does not claim to record an assistant answer or failed tool result that
  its subscribed callbacks do not supply.

For Pi, Windsurf and Copilot, the usual MCP setup option enables CLI retrieval
guidance instead of registering a user-wide server. OpenCode registers actual
MCP. `--no-hooks --no-mcp` writes none of these integrations. Extension subprocesses
have bounded execution time and fail open. All inherit Thinker's telemetry and
learning controls.

## Validation

`test/clients.test.js` checks native payload processing, retrieval output,
recording, repeat installation, refresh, local excludes, and uninstall.
`test/integrations.test.js` loads generated Pi/OpenCode modules and invokes their
host contracts, checking session isolation, preservation of tool output, options,
and subprocess failure behavior. These are contract and subprocess tests, not
live authenticated sessions in all four hosts. A release should smoke-test each
supported host version with a known note, a prompt, a file read/edit, and session
end; inspect the trace and confirm the model actually received the context.
