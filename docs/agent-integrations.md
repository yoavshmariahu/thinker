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

Setup and `connect` install a short workflow alongside the tools: use injected notes
or `orient`, ask specific questions with `lookup`, navigate code with `find` and
`drilldown`, save reusable discoveries, and correct wrong notes. An injected bundle
replaces only the initial `orient` call. Ordinary searches and reads remain available
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
| Cursor | First tool after prompt | Post-tool hook | Hook trace | MCP + rule |
| Pi | before_agent_start extension | tool_result extension | Prompt, tools, final answer; shutdown flush | CLI guidance in extension |
| Windsurf Cascade | Always-on rule asks agent to orient | Agent-directed CLI lookup | Prompt, reads, edits, commands, MCP results, response | CLI rule |
| GitHub Copilot CLI | First successful tool after prompt; CLI instruction fallback | postToolUse | Prompt, tools/errors, stop/end | CLI instruction; optional manual MCP |
| OpenCode | chat.message plugin | tool.execute.after plugin | Prompt, successful tools, idle/end | MCP registered by plugin |

File context is enabled with `--late`. Hook recording is enabled by default;
`--no-learn` or `THINKER_NO_LEARN=1` disables it. Learning still requires an
existing Thinker model backend (Anthropic API or a supported model CLI); these
new hook integrations do not add model-provider adapters. Retrieval itself does
not need model credentials.

## End-of-turn notices

All eight adapters install a stop callback when hooks are enabled, including with
`--no-learn`. Notices describe notes actually served during that session's turn;
an empty turn produces no cache-hit notice. `THINKER_NOTICE=off` or `notice: false`
in `.thinker/config.json` disables notices without disabling learning.

| Client | Notice display |
| --- | --- |
| Claude Code, Gemini CLI | `systemMessage` |
| Codex | `systemMessage`, surfaced by the host as a UI/event-stream warning |
| Pi | Native `ctx.ui.notify` in interactive mode |
| OpenCode | Native `client.tui.showToast` |
| Windsurf Cascade | Stop stdout with `show_output: true` |
| Cursor, Copilot CLI | Stop callbacks run, but their APIs have no passive notice output |

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
  the native stop event and is not fabricated. MCP can be configured manually
  with `/mcp add`; setup does not change user-wide MCP settings. Some headless
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
