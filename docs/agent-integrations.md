# Coding agent compatibility

Thinker supports fifteen clients through `thinker setup --clients auto` (detected
clients), `--clients all`, or a comma-separated selection. To add the newer adapters:

```sh
thinker connect --clients droid,qwen,kiro,cline,kilo,augment,goose
```

Every client is wired machine-wide, in the agent's own files; `thinker update` wires an
agent installed later once. Copilot in VS Code needs no client of its own: its Local
harness runs the Copilot CLI's hook files (`~/.copilot/hooks`), and thinker tells its
payloads apart (`clients.js:hookClient`, client `vscode`).

Restart the host agent after setup so it discovers the generated hooks/extensions.
Project trust and hook enablement remain controlled by the host. New generated project files
are locally excluded from git; existing instruction files retain their visibility. `thinker uninstall`
removes Thinker's entries and preserves other integrations.

## No instructions, no agent tools

Since 2026-10-22 thinker writes nothing into the agents' instruction files and offers the agent no MCP
tools: the notes reach it through the prompt hook, under one line saying what they are. The workflow block
earlier versions wrote (in `~/.claude/CLAUDE.md`, `$CODEX_HOME/AGENTS.md`, `~/.gemini/GEMINI.md`, Cursor's
`.cursor/rules/thinker.mdc`, Windsurf's and Copilot's rules and the other agents' global files) is taken out
by the next `thinker update` (its `rewire`) and by the prompt hook's wiring check, leaving the rest of each
file as it was. The MCP server stays registered: it answers thinker's own questions (coverage, harness) and,
in a desktop app, carries the learning queue (`learn_next`). Windsurf, which runs no prompt hook, gets no
notes.
| Factory Droid | `~/.factory/AGENTS.md` |
| Qwen Code | `~/.qwen/QWEN.md` (respects `QWEN_HOME`) |
| Kiro CLI | `~/.kiro/steering/thinker.md` |
| Cline | `~/Documents/Cline/Rules/thinker.md` |
| Kilo Code | `~/.config/kilo/AGENTS.md` |
| Auggie | `~/.augment/rules/thinker.md` |
| Goose | `~/.config/goose/.goosehints` |

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
| Codex CLI | Prompt hook | Post-tool hook | Native transcript (the hook trace where it has no tool events) | MCP |
| Gemini CLI | BeforeAgent | AfterTool | Native transcript | MCP |
| Cursor | Prompt hook (`additional_context`; first tool call under `agent -p`) | Post-tool hook | Hook trace | MCP |
| Pi | before_agent_start extension | tool_result extension | Prompt, tools, final answer; shutdown flush | none |
| Windsurf Cascade | None (no prompt hook) | None | Prompt, reads, edits, commands, MCP results, response | none |
| GitHub Copilot CLI | First successful tool after prompt | postToolUse | Prompt, tools/errors, stop/end | optional manual MCP |
| OpenCode | chat.message plugin | tool.execute.after plugin | Prompt, successful tools, idle/end | MCP registered by plugin |
| Copilot in VS Code (Local) | First tool call after the prompt (its UserPromptSubmit takes no context) | PostToolUse `hookSpecificOutput` | Prompt, tools, stop | MCP through the Copilot CLI's `mcp-config.json` (VS Code discovers it) |
| Factory Droid | UserPromptSubmit, plain stdout (`~/.factory/hooks.json`, else the `hooks` of `settings.json`) | PostToolUse | Prompt, tools, stop/end | MCP (`~/.factory/mcp.json`) |
| Qwen Code | UserPromptSubmit, plain stdout (`~/.qwen/settings.json`) | PostToolUse | Prompt, tools, stop/end | MCP (same file) |
| Kiro CLI | UserPromptSubmit, plain stdout (V3 engine: `~/.kiro/hooks/thinker.json`) | none: Kiro ignores PostToolUse output | Prompt, tools, stop/end | MCP (`~/.kiro/settings/mcp.json`) |
| Cline | UserPromptSubmit `contextModification` (extension); in the CLI, whose prompt hook fires only for its own `[SYSTEM]` nudges (3.0.73), the first tool call after the prompt | PostToolUse `contextModification` | Prompt, tools, task complete/cancel, shutdown | MCP (`~/.cline/data/settings/cline_mcp_settings.json`) |
| Kilo Code | OpenCode's plugin (`~/.config/kilo/plugin/thinker.js`): chat.message | tool.execute.after | as OpenCode | MCP registered by plugin |
| Auggie | none: Auggie has no prompt hook | PostToolUse `hookSpecificOutput` (`.sh` wrappers in `~/.augment/thinker`) | Tools; the prompt from the Stop hook's conversation data | MCP (`~/.augment/settings.json`) |
| Goose | none: hooks give the model nothing | none | Prompt, tools (no output), stop/end, with learning on | MCP extension in `~/.config/goose/config.yaml` |

Claude Code, Codex and Cursor are also wired for a pre-tool event on shell commands, which does
nothing unless a repository sets `tests: { nudge: true }` in `.thinker/config.json`: it then asks
for a test run to go through `thinker test` (see docs/usage.md). Claude Code's and Codex's
`PreToolUse` take `updatedInput`, so the command is rewritten and the host's own permission flow
still runs on it; Cursor's `beforeShellExecution` cannot rewrite a command, so it is denied once
with the command to run in `agent_message`. The other five hosts have no pre-tool event Thinker
can answer on and are not wired for one.

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
answers them through thinker's `learn_next` tool.

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
learn through the session the same way.

`thinker doctor` recognizes a desktop app or recent app activity in the repository.
It checks pending learning jobs, retained failures, the live worker and unanswered
model requests, and reports the last successful answer through the session queue.
It does not start a CLI model probe for this path. An empty queue or installed MCP
alone is not evidence that the app has answered a model request, and an answer is
not proof that a new note was learned. Resume an app session to service waiting
work; inspect `.thinker/state/session-work.log` for job failures. `doctor --fix`
repairs wiring but does not launch background learning or discard failed jobs.

## End-of-turn notices

All adapters install a stop callback when hooks are enabled, including with
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
| Qwen Code, Auggie, Copilot in VS Code | `systemMessage` |
| Factory Droid, Kilo Code | Stop stdout (shown in the transcript) / the OpenCode toast |
| Cursor, Copilot CLI, Kiro CLI, Cline, Goose | Stop callbacks run, but their APIs have no passive notice output |

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

## Plugins, the pi package and the proxy

Three more doors to the same hooks, each a pointer to the thinker installed on the machine
(`npx @zerotimedev/thinker`, in `~/.thinker/app`); nothing of thinker runs from any of them, and a
plugin on a machine without thinker does nothing.

- **Host plugins** (`plugins/`, since 2026-10-22): one per host. Claude Code's (`plugins/claude-code`,
  `.claude-plugin/plugin.json` and `hooks/hooks.json`, listed by `.claude-plugin/marketplace.json` at the
  repository root: `claude plugin marketplace add yoavshmariahu/thinker`, then `claude plugin install
  thinker@thinker`); Codex's (`plugins/codex`, the portable `plugin.json` and `hooks/hooks.json`, listed by
  `.agents/plugins/marketplace.json`: `codex plugin marketplace add yoavshmariahu/thinker`, `codex plugin
  add thinker@thinker`); Cursor's (`plugins/cursor`, `.cursor-plugin/plugin.json` and scripts under `bin/`,
  listed by `.cursor-plugin/marketplace.json`; installed from the Customize panel, the Cursor CLI loads no
  plugins). Every hook is the same shim (`bin/hook.mjs`): it runs the installed copy's `thinker hook
  <event> --client <host> --user --plugin`. The hooks are for the cache and nothing else (the owner's rule, 2026-10-22): without an
  installed thinker they do nothing. Installing is the plugin's command, run by the person (`/thinker:install`
  in Claude Code, the `thinker-install` skill in Codex, Cursor's `install` command), which runs
  `npx -y @zerotimedev/thinker --clients <host> --no-modify-path --no-ui --yes`: that host alone is wired, no
  shell file is edited. The installer writes the host's settings hooks, so from the next
  session the plugin yields and the installed copy does the work. A plugin's hooks run beside the host's own settings hooks (Claude
  Code collapses duplicates between its settings files only), so `--plugin` yields where the settings already
  run thinker's prompt hook (`clients.js:pluginYields`): one copy serves. Codex runs plugin lifecycle hooks for
  plugins installed by hand in its desktop app, with the same trust review as its own hooks, and its public
  directory takes no plugin with hooks; all three are from the hosts' documentation, none has been run live
  yet. The marketplaces live in this repository, which is public, so `claude plugin marketplace add
  yoavshmariahu/thinker` works for anyone (run live on 2026-10-22: added and installed; the plugin yields
  only once the installed copy carries `--plugin`, from the release after 0.2.0). The listing icon the
  directories want is `icon.png` beside each manifest (the site's mark, three circles, 1024 px).
- **The pi package** (`npm/pi/thinker.js`, shipped in `@zerotimedev/thinker` through its `pi` field):
  `pi install npm:@zerotimedev/thinker` adds an extension that loads the installed copy's
  `src/integrations/pi.js` on the first event and serves every checkout as `thinker connect`'s extension
  does. Where that extension is in place (`~/.pi/agent/extensions/thinker.js`) the package stays quiet;
  without an installed thinker it says so once a session through pi's own notice.
- **Notes through the proxy** (`thinker proxy --notes [--repo path]`, or `proxy: { notes: true }` in
  `.thinker/config.json`; `src/proxy-notes.js`): for an agent that runs no prompt hook but honours a base
  URL (Goose's `ANTHROPIC_HOST`, Aider's `ANTHROPIC_BASE_URL` and `OPENAI_BASE_URL`, any OpenAI-compatible
  client; `--upstream` names the provider). Each request is the whole conversation: its last user turn is
  the prompt, served once per conversation as the hook serves it (fresh notes, once, the holdout turn,
  logged as client `proxy`) and put in front of that message's text; every later request of the
  conversation gets the same text at the same turn, so the prompt cache keeps its prefix. A request
  carrying a Claude Code session id is left to its hooks. Not reached: an agent whose calls go through its
  vendor's servers (Windsurf, Auggie). Not covered: learning, since the proxy records no session. Off until
  an experiment, like the rest of the proxy.
- **Clearing old tool results through the proxy** (`thinker proxy --port n [--keep n|turn] [--trigger n]
  [--clear-at-least n]`): for any agent that speaks the Anthropic Messages API at a base URL the person can set
  (Claude Code's `ANTHROPIC_BASE_URL`, in the shell or in the `env` block of `~/.claude/settings.json`, which the
  IDE extensions read too but the Claude desktop app's Code tab does not, Desktop setting the variable itself; pi's `providers.anthropic.baseUrl` in
  `~/.pi/agent/models.json`; OpenCode's `provider.anthropic.options.baseURL`; Goose's `ANTHROPIC_HOST`; Aider's,
  Cline's and Droid's Anthropic base URL), each request carries the
  API's `clear_tool_uses` edit, with the beta header it needs added when the agent does not send it (Claude Code
  does; the others do not, so until 2026-10-24 the proxy served Claude Code alone), so the server drops old tool results from the context on its side once they
  amount to `--clear-at-least` (80k tokens) and the context has reached `--trigger` (100k). `--keep` says
  what a clear leaves: `turn`, the default since 2026-10-22, the tool uses of the request's current turn
  (never under `--keep-min`, 3), so only results fetched by earlier turns are cleared; or a count of the
  newest tool uses (`--keep 3`, the default before). `thinker proxy
  replay [--days n] [--policies spec] [--repo path]` costs the policies over a checkout's Claude Code sessions
  with no model call (`src/proxy-replay.js`; research/output-lifetime-2026-10-22). **On by default since 2026-10-24**
  (`src/proxy-service.js`): `thinker connect` keeps the proxy running (launchd on macOS, a systemd user unit on Linux, the
  prompt hook everywhere, which starts it when nothing listens) and writes its URL for Claude Code (the settings `env`),
  pi (`models.json`) and OpenCode (`opencode.json`); Goose, Aider, Cline, Droid, Copilot CLI with your own key, Qwen
  Code on an Anthropic provider and Kilo's CLI take it by hand at the keys above; Codex, Cursor, Gemini CLI, Kiro,
  Windsurf and Auggie have no Anthropic URL to point at it. `thinker proxy status|off|on`, `connect --no-proxy`.

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

## Reducing tool and plugin context

`thinker harness` and the local page read recorded listings and usage, then offer
sources loaded in at least three sessions, used in fewer than 10%, and costing at
least 100 estimated tokens. They change the harness's configuration when you choose
sources with the page, `--off`, or an answer to `--suggest`. A prompt telling the
agent to ignore a tool does not remove its description from context.

| Harness | Recorded evidence | Mechanical switch | Scope |
| --- | --- | --- | --- |
| Claude Code | Deferred tools, MCP instructions, skill listings, tool/skill calls | `enabledPlugins`, `disabledMcpServers`, `disabledMcpjsonServers`, `skillOverrides` | Existing Claude project/local settings; user/local MCP switches cover worktrees |
| Claude desktop app (Code tab) | The Claude Code transcript, plus the app's session record (`claude-code-sessions/…/local_<id>.json`): connectors' always-loaded tools, the app's appended instructions | The Claude Code switches above (the app runs Claude Code with `--setting-sources=user,project,local`); a connector by the app's Connectors switch, flipped by the agent with `ccd_connectors` `set_session_connector_enabled` | Settings: as Claude Code. Connectors: every new session on this machine (the app makes the switch its default) |
| Codex CLI and desktop app | Recorded developer skill catalog and deferred namespaces (including desktop `world_state`), direct and `functions.exec` tool calls, skill file reads, child sessions | `mcp_servers.<name>.enabled = false`, `plugins."name@marketplace".enabled = false`, `[[skills.config]]` with path and `enabled = false` | This trusted checkout's `.codex/config.toml`, from new sessions |
| Other harnesses | No context-reduction adapter yet | None | Report/switch support must be implemented per harness |

The desktop app adds to each session what its transcript does not record: the
claude.ai connectors it passes in and its own instructions (starting other sessions,
the task list, the built-in browser, the simulator), about 5k tokens a session read
on Claude 2.42304.2. Thinker reads both from the app's record of the session and
reports them. A connector is offered only in a desktop session, since only the agent
there can flip the app's switch, and its savings are counted in desktop sessions only.
The app's own instructions and built-in tools are switched in the app's Settings, not
by Thinker; the definitions of its built-in tools (browser pane, simulator, session
tools) are not in any record and are not counted.

Codex support uses the same settings layer in the CLI and app. An untrusted project
ignores that layer. It does not shrink an existing chat or automatically reload its
tools. User-level configuration is read (respecting `CODEX_HOME`), never changed.
Known local plugins can be disabled as a unit; cloud connectors, built-in skills,
and plugin sources without a verified local switch remain report-only. Unknown
plugin tool ownership is treated conservatively when an MCP tool was used.

Token counts estimate only the text present in transcripts; Codex logs do not
always contain full tool schemas. Missing inventory is unknown, not evidence of a
saving. Savings compare subsequent sessions of the same harness with the relevant
inventory present. Reported input-token savings are estimates across recorded
model calls, not provider billing measurements. Combined source totals are not a
claim that every agent loaded every source.

Each config edit is backed up with private permissions. TOML values unrelated to
the switch are retained, though TOML serialization normalizes formatting and
comments. `thinker harness --undo` restores only the settings Thinker changed and
preserves later edits. The page uses qualified source keys so identically named
Claude and Codex tools can be restored separately. A newly created project config
is excluded from Git. Symlinks pointing outside the checkout are refused.

Switched-off tool reminders (recall) are on wherever the harness is on, at the owner's
decision (2026-10-19): switching a source off is fair only if a request that needs it is
told that it is off and how to bring it back. `--recall off` (or `harness: { recall: false }`)
turns them off. On 4,511 replayed prompts they rarely fired wrongly but caught few of the
turns that needed a tool, so they are a reminder, not a guarantee. The question every two weeks
is on with the harness (`--recurring off` turns it off).

The question and the report give what a source costs a session: its tokens, which every
model call reads again, times the model calls of a typical session here (the median, per
agent), mostly as prompt-cache reads. Cursor records no model calls, so its sources are
given by size alone. The question carries at most five sources, each with what it is in
its own words, its use among the sessions that carried it, and what off means; built-in
tools are never among them (switch one off from the Context tab, which shows its
description), and the question names the page for everything it left out.
Codex suggestions use its available question tool or prose, and wait for an
explicit answer. To support another harness, add evidence parsing, native scoped
config changes, restoration, and post-change evidence together; a generic hook
message alone cannot implement context reduction.

The Codex controls are documented in the [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
and [plugin settings](https://developers.openai.com/plugins/build/plugins).
They were also verified through Codex 0.162.1’s app server's `config/read`
with an isolated temporary home and trusted repository, without a model call.
