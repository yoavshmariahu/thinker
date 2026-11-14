# thinker: internals and working context

Reference for agents and contributors working on this repository. The
user-facing summary is in `README.md`; benchmark results are in
`research/bench-history/RESULTS.md`.

```
agent session ──► prompts + answers ──► extract ──► .thinker/local/profile/ledger.jsonl ──► patch ──► profile.json
                                                                                                          │
proxy / desktop mod ──► clears finished tool results ──► savings ledger                  first prompt ◄──┘
```

The knowledge notes (distilled per session, served per prompt, verified against the code) were removed on
2026-11-08 in favour of the session profile; see "Knowledge notes, removed" below for what went and why.

## Working on this repository

**CLI and local page in sync (MANDATORY):**
- `src/ui/` mirrors CLI commands, never duplicates.
- Page defaults and output must match CLI: `thinker context` ↔ Context tab, `thinker report` ↔ Report tab.
- New default or flag: add test to `test/cli-ui-sync.test.js`.

**The proxy and desktop clearing hold one policy (MANDATORY):**
- `src/proxy.js` and `src/integrations/claude-clear` implement the same clearing policy, never two.
- Every `PROXY_DEFAULTS` key honored by mod or exempted with reason in `DESKTOP_POLICY` (`test/claude-clear.test.js`).
- Policy change is judged live on cache writes against 15% holdout, not replays.

**Codex and Claude use the same cut policy (MANDATORY):**
- `src/proxy-responses.js` → `src/cutting.js:decideCut` (Messages).
- `src/proxy-chat.js` → same `decideCut` (Chat Completions, gateways).
- One conversation ratchet under concurrency; decision and refusal reason always from `cutting.js`.

**Pull requests (MANDATORY):**
- Contributor workflow: push task branch, open PR to `main`. Never push `main`.
- Tests disabled; run `npm test` locally, state result in PR, merge via GitHub.
- Local guard enforces `main` no-push until enforcement enabled in GitHub.

**Fresh worktree needs `npm ci` first:**
- Worktree has no `node_modules`. First `npm test` can race and fail on `ERR_MODULE_NOT_FOUND`; treat as nothing.
- Run `npm ci` before tests in new worktree.

**Test selection:**
- `npm test`: files changed vs `origin/main`. Changed code not reached listed on stderr.
- `npm test -- test/file.test.js`: run named files.
- `TEST_BASE=HEAD npm test`: working tree only.
- `--all`: full suite (use for runner or wrong selection).
- Requires Node 20+. `npm test` runs `scripts/test.sh`.

**Desktop apps (MANDATORY):**
- Every model feature works in Claude Desktop, Codex, Cursor, no CLI login.
- Queued jobs get `session-work.js:MAX_ATTEMPTS` (5 tries), then dropped with `maintain.js:reportGaveUp`.
- Tests cover desktop path (`appFn`, missing CLI login).

**The clearing: thinker cuts results itself (MANDATORY, 2026-11-04):**
- Cut and keep newest turn + 3 results. Trigger 140k, floor 60k, payback 25 calls, cold boundary.
- `decideCut` returns `reason` (six branches: `nothing-to-cut` wins, then `below-trigger`, then `below-clear-minimum`, `mid-turn`, `one-cut`, `payback`). Both doors use it.
- Ratchet per conversation (keyed on first user message); write merges, never replaces; turn rises, set advances.
- **No holdout (2026-11-12, the owner's call)**: `SERVICE_HOLDOUT` 0, the mod's `HOLDOUT` with it. A session that got a cut
  is a long session, so "cleared against held out" never compared like with like, and at 50% it cost every install half
  the saving. `proxy: { holdout }` in config puts an arm back for an experiment; the Factory's compression diff then reads it.
- **Re-reads of cleared files are measured per session instead** (`src/rereads.js`, programmatic, no model): the Stop
  hook replays the cut policy over the transcript (a cut at T takes the results of the turns before its own, bar the
  newest `keepMin`, bar those under `MIN_CHARS`) with the session's cut times (`cutTimesFor`: proxy rows where the cleared
  set grew, the mod's `recent`, the log's mirror rows), and a read whose last earlier read was out of the prompt is a
  re-read: the Read tool or a shell line that prints a file (`delegate.js:shellRead`, one parser for both; a `cd <dir>
  &&` in front allowed, a relative path matched to an absolute by its tail). On this machine's 41 cut sessions
  (2026-11-12): 12 re-reads in 6 sessions, $0.56 against $586 cleared at the cache-read rate. `rereads: { reads, tokens, laterTokens }` on the `op: session` row; `delivery.js` prices it at list (its write
  once, its reads after at the cache-read rate) as `cost.reread`, and **net = saved − rewrite − reread** on every door
  (`thinker prs`, the posted comment, the Report's PR rows, telemetry `rereadUsd`/`rereads`/`rereadSessions`). A ceiling:
  a read the model would have made anyway counts too. What it cannot see, an answer gone wrong without a read, is the
  graded Artemis run's question. Sessions logged before this carry no `rereads` and net as before.

**What the clearing saved is shown, three turns on (2026-10-29):**
- `clearedBy` on row; `cleared: 0` if nothing cut. Measured: the cut's own `tokens`, not API's.
- Rate is result's, not prompt's (`RESULT_TOKENS_PER_CHAR`, 0.445).
- Session record: `state/compression/<session>.json`; `compressionHeader` on four doors.
- Desktop clears measure cost from API's `cache_creation_input_tokens` and `cache_read_input_tokens`.

**Proxy never takes over another's route (MANDATORY, 2026-10-28):**
- `routeEvidence` reads every place a route comes from; non-thinker routes left as-is with reason.
- `api.anthropic.com` is not a route (desktops set it; any exact match is dropped on next rewire).
- Stands down with reason if credentials fail or API refuses `AUTH_REFUSALS` times.
- Sits in front of a gateway only on `thinker proxy on --gateway` + user yes; kept in service state, or `proxy: { upstream }` wins.
- On 400 to context-management edit with non-Anthropic upstream: if refusal names field/beta, drop edit rest of proxy's life (`editRejected`, `proxy-edit-rejected` row, `edit-unsupported` read); any other 400 passed once, edit still added next request.

**A request that never reached the API recovers (2026-11-05, `src/proxy-retry.js`):**
- Address cache (`addressBook`, cached 6 h), ladder (`RETRY_WAITS` 0.25–4s), fresh socket for TLS/EHOSTUNREACH.
- Cancellations: `op: 'proxy-cancelled'` (also `aborted` flag while old logs in window).

**One summary, not every turn (2026-11-01):**
- Due when `NOTICE_PROMPTS` (20) prompts AND `NOTICE_HOURS` (24) hours passed since last.
- Cache-held turns only; `notice: { everyPrompts, everyHours }` or `notice: false` in config.
- Card on first turn of cache, else top of next summary.
- Cadence state in `state/notice.json`; pending in cache's `notice-pending.json`.

**What changed in thinker, said once (2026-11-10):**
- `UPDATE_NOTE` in `src/update-note.js` (id, title, lines, more); mirrored by mod (`test/claude-card.test.js`).
- Keyed on note id, never version (`updateNoteShown` in `state/update-note.json`).
- Card where mod runs (end of first turn); Stop hook's summary everywhere else.

**Savings footer (2026-11-06):**
- Dollars from `savings-ledger.js` querying Report's `weeklySavings`, not its own math; never contradicts `thinker report`.
- Session record + proxy log; desktop clears priced from API counts, by session (`compression.js:desktopClearRows`).
- Status row on all clients; mod polls ledger file every 5 s (`LEDGER_POLL_MS`).
- Version on status line (`appVersion()`) alongside savings.

**OpenCode 2 terminal (2026-11-10):**
- Plugin directory (`plugins/thinker/`) with `index.ts` (server) + `tui.tsx` (terminal); v1 single file for major < 2.
- Footer on built-in footer row (`prompt.footer.status`); summary as toast (Stop hook writes `state/notice-last.json`).
- **Served bundle is never on the person's prompt** (2026-11-12): v2's draft has no parts, so the profile goes as a
  synthetic message (`ctx.session.synthetic`, `resume: false`), model-read and screen-hidden (TUI draws
  `description` = `SYNTHETIC_NOTE` alone). Same execution, once a session; refused call falls back to the draft.

**Exploration subagents on Sonnet, off by default (2026-11-08):**
- Off until owner ships: `THINKER_EXPLORE_MODEL=on|<model>` or `agents: { explore: true | "<model>" }`.
- File: `<claude config dir>/agents/Explore.md`, read-only, marker `<!-- thinker-explore -->`, Sonnet 5.5 by default.
- `connect`/`rewire` write it; `uninstall --user` removes; person's own file left alone.
- The delegation nudge it waited for became the trigger below (`src/delegate.js`), and **since 2026-11-12 the
  trigger uses this file**: its denial hands the read to Claude Code's own `Explore` subagent, so while the
  trigger is on the file is written on `delegate.model` even where `agents.explore` is unset
  (`delegate-agents.js:delegateExploreModel`; explore-agent.js is still the only writer of it).

**Models from other providers (2026-11-10):**
- Registry: `<THINKER_HOME>/providers.json`, key never in it (`auth: { env | file }`).
- Route: `thinker/<alias>`, `thinker/<provider>/<model>`; proxy forwards with provider key, without agent's.
- Cut applied first, model swapped, Claude-only fields dropped, Chat translation where needed.
- Subagents: `<claude config dir>/agents/<Name>.md`, marker `thinker-agent`, user scope, `reader` or `worker`.
- Profile: `state/model-profile.json` (per repo, merged on show); routes priced at own model.

**The delegation trigger: a read or a suite run handed to a Sonnet subagent, deterministically (2026-11-11, the owner's
call; `src/delegate.js`, the `hook pretool` subcommand, Claude Code's PreToolUse on `Read|Bash`):**
- The mechanism, **the host's own subagent since 2026-11-12** (the owner's call: "delegation is not supposed to
  happen this way. we need to use native subagents in every harness"). A PreToolUse hook sees every Read and Bash
  call before it runs. A read past the rule (below) or a whole-suite test run is **denied**, and the denial's reason
  tells the model to hand the work to **its own named native subagent**, with a brief thinker has already written
  (`handoff` mode, `executionFor`). The rule stays thinker's -- `decide`, the thresholds, the holdout, the `op:
  delegate` row -- and the execution is the host's. A ranged Read (`offset`/`limit`, under `minRead` 8k tokens) is
  never delegated, so the model still reads the lines it edits. The hook answers in ~0.25 s either way, because it
  starts nothing: the settings entry's timeout is 30 s, and only 300 s while the fallback below is on.
  The brief carries the **person's own request**, read from the transcript (`lastPromptOf`, #777): the last 400 KB
  first, and the whole file when that holds no prompt, since one prompt and a hundred tool calls is a 1.5 MB
  transcript with the request at the top of it (2026-11-12: three firings briefed with an empty request each
  answered with a map of the file instead of the answer). A whole-file read is 12 ms for 1.5 MB, once per firing.
  A handoff needs this as much as the fallback did -- the brief is thinker's text either way -- though there the
  model pastes it from its own turn, so an empty request is recoverable rather than wasted.
- **Why not a subagent of thinker's own.** Until that day the hook spawned `claude -p` itself. That is a second
  billing path and a second credential requirement, invisible to the host and to its transcript, and dead where no
  `claude` CLI and no Anthropic key exist -- a vendor's cloud OpenCode harness on the vendor's own models, which is
  the case it has to work in. The handoff has none of those, and it is **better measured**: the host bills, shows
  and records the subagent like any other, and the Report already prices a subagent conversation at its own model
  (`tool-outputs.js:sessionUsage`). `runSubagent` survives as `delegate: { fallback: true }`, **off by default**,
  for a host with a door but no subagent; with it off such a host simply reads as before (`mode: 'none'`,
  `skipped: 'no-native-subagent'` on the row).
- **A door can only deny, so the words are the whole mechanism** (`denial()`, still the one copy of them). A hook
  cannot invoke the host's subagent itself. The wording therefore says, in the first person, what thinker did and
  why, then the exact call to make (tool, parameter, agent name, label, brief), then that nothing has gone wrong --
  because the live OpenCode check of 2026-11-12 showed a denial read as a fault gets routed around with grep and
  sed. A handoff is an instruction and never a pre-baked report, which is the shape that was distrusted.
- **One handoff of each kind per turn** (`handoffsPerTurn` 1, `decide`'s `spent`, `noteHandoff`), and this is what
  makes a handoff impossible to loop. The subagent reads the files itself, in the same turn, and on OpenCode in a
  child session with an id of its own; those reads must go through. So once a kind is handed over, every later read
  of that kind is allowed and logged (`after: 'handoff'`, `fired: false`) -- which is also the one free signal of
  whether the model obeyed. The budget is per kind, so an exploration handoff does not use up the turn's suite run.
  Beside it, a positive guard: a subagent's own call is never delegated (`fromSubagent` -- Claude Code's
  `agent_type`/`agent_id`, OpenCode's `agent` on every event, where anything but a primary agent fails closed).
- **What each host has** (read off the installed binaries and schemas on 2026-11-12, not from memory):
  `HOSTS[client].subagent`. Claude Code 2.1.323: the **`Agent`** tool (`Task` before 2.1.63), parameter
  `subagent_type`, and `Explore` and `general-purpose` are **built in**, so a handoff there installs nothing; a
  user-scope `agents/Explore.md` overrides the built-in `Explore` and pins its model, so while the trigger is on
  that file is written on `delegate.model` (`delegate-agents.js:delegateExploreModel`, explore-agent.js still the
  only writer of it) and the exploration runs on Sonnet rather than the conversation's model. OpenCode 2.2.7: the
  **`subagent`** tool, parameter `agent`, beside `description` and `prompt`; `experimental.subagent_depth` is 1 so
  a subagent cannot spawn one; and it has **nothing built in** -- `/api/agent` is empty in two directories here,
  and its `agent` parameter tells the model that an unrecognised name "most likely mean[s] a model", so naming an
  agent that does not resolve is worse than naming none. Hence thinker writes the two it names into the directory
  OpenCode scans (`{agent,agents}/**/*.md`), **with no model pinned**: OpenCode names a model `providerID/modelID`
  from the person's own providers, and on a vendor's harness thinker has no business choosing one. A subagent on
  the session's own model still keeps the read out of the lead's context for the rest of the session, which is the
  larger half of the saving and the half that does not depend on which models the person has. Its frontmatter is
  `Config.AgentEncoded`, `additionalProperties: false`: no `name` (the file is the id), `permissions` a list of
  `{action, resource, effect}` and not a map, and no `": "` inside a plain scalar -- any of those three makes the
  file unreadable and the name unresolvable.
- The rule (`decide`): the unit is the **turn's** reads, keyed on Claude Code's `prompt_id`. One read of 35k tokens
  (`threshold`, ~1000 lines of Python) fires at once; smaller reads of 8k+ fire once the turn's reads have passed
  35k. A delegated read never enters the tally, since it never entered the context. Reads are sized from the file
  on disk at `TOKENS_PER_CHAR` (0.445, the proxy's result rate) plus the Read tool's line-number prefix; a `cat`,
  `sed -n` or large `head` of a file counts, anything piped into grep/head/tail/wc does not (the model trimming for
  itself). A shell line that names a range (`sed -n 10,60p`, `head -n 40`, `sedLines`) is sized by the lines it asks
  for, as a ranged Read is, so it falls under `minRead` and is never the thing that fires: a ranged read is the model
  reading the lines it edits, and the denial sends it there (2026-11-12, after an 18-line `sed -n` of a 290-line file
  was delegated). An open range or a pattern (`100,$p`) says nothing about the size, so the whole file counts. A suite
  run is the test program with no path of its own (`suiteCommand`: pytest, npm test, go test ./..., cargo test,
  node --test); a single file's run stays with the model.
- Why those numbers: the stage-delegation bench (43 paired runs on Click and MLflow, 2026-11-10/11; the owner's
  memory notes `delegation-trigger-rules`, `stage-delegation-bench-2026-11-10`). Every run whose inline context
  reached 90k won by delegating (11-50%), every run under 50k lost; the saving is the read's cache write at Sonnet's
  rate instead of Opus's ($4 against $8 a million, paid at once) plus Opus's cache read of it on every later call,
  so a ~35k read pays for its subagent on the write alone. The edits stay with the model: a builder subagent was a
  wash (it re-reads and re-reasons what the lead holds). Replayed over this machine's 30 days the rule projects to
  ~4.6% of spend, 96% of it in sessions that also reach the clearing's trigger -- the two act on the same tokens,
  so their figures are never added; the write half (~$190 of $291 a month here) is delegation's alone.
- Measured from day one: every firing is a log row (`op: delegate`: kind, files, tokens, `mode`, and for a handoff
  the `agent` and `handoffTool` it named; for the fallback the subagent's usage and `total_cost_usd`, its session
  id, `cached`, `error`). A handoff carries no cost of its own on the row **on purpose** -- the host bills it, and
  the Report reads it as a subagent conversation priced at its own model, so a cost here would be counted twice.
  **Half the sessions are held out** (`holdout` 0.5 by hash
  of the session id, `proxy.js:heldOut`, the same rule as the clearing's); a held-out session logs the row with
  `held: true` and reads as it would have. Judge it by cost per exchange, cleared and held-out, over a window, and
  by whether the model re-reads what the explorer summarised (the model-profile's re-read share is the figure).
  The live smoke (2026-11-12): an Opus session told to read core.py (3,681 lines) in full had the Read denied, the
  explorer ran 24 s for $0.21, and Opus answered with the right line numbers from the report, saying so.
- **A structural outline is not what answers a delegated read (2026-11-12, the owner's call: "no I'm convinced
  this won't work well"; the fourth AST attempt here, closed unmerged as #766, the code on branch
  `agent/ast-outline`).** A dependency-free line scanner was built and measured against this hook: 0.09 ms a file
  over 17,445 files, and against Python's own `ast` module on 2,010 files **99.5% recall, 98.2% precision and
  88.8% exact end lines**, naming the right function in both live cases. Capability was not the problem, and the
  measurements are not worth taking again. Two things decided it. Given to the Sonnet explorer the outline cost
  **+16% over 6 cold paired runs**, because the explorer already greps and reads ranges, so the map is only more
  tokens in its brief. And given to the lead instead of a report it makes the model cycle between ranges and
  bodies: four ranged reads of 300 Python lines is ~30k tokens against the 43.7k a whole-file read would have
  cost, plus four turns each re-reading the grown prefix. **An outline is cheap for thinker and expensive for the
  model, because it moves the picking to the costliest place**, which is the same failure as the 2026-10-10
  overuse (turns 31 to 51 on mitmproxy) arriving by another route; a hook fixes who chooses the tool, not where
  the work lands. A subagent does that cycling on Sonnet and hands back a conclusion, so it stays the default. If
  it is ever revived, the one defensible place is the **fallback** where the subagent has failed or timed out and
  the alternative is the whole file, and the revival needs a live session counting the ranged reads that follow
  each denial against the subagent's own turn cost.
- **Off by default (the owner's call, 2026-11-12, for the release that ships it).** On: `THINKER_DELEGATE=on` or
  `delegate: { enabled: true }` in `<THINKER_HOME>/config.json`, then `thinker rewire` for Claude Code (the PreToolUse
  entry is written only while it is on, since a hook that exits at once is still one node process per tool call;
  `PreToolUse` in setHooks's list takes it out again on the next rewire once it is off) and OpenCode started again
  (its plugin reads the switch once at setup). `THINKER_DELEGATE=<model>` or `delegate: { model, threshold, minRead,
  holdout, timeoutMs, handoff, fallback, handoffsPerTurn }` tune it;
  `THINKER_DELEGATE_THRESHOLD`, `THINKER_DELEGATE_HOLDOUT=off` for an experiment arm, and
  `THINKER_DELEGATE_HANDOFF=off` / `THINKER_DELEGATE_FALLBACK=on` to run the old owned-subagent arm instead.
  Under `THINKER_TEST` the hook does nothing unless `THINKER_HOOKS=on`, as every user-scope hook.
- **What is still unmeasured, and the one measurement to make.** Whether the model *obeys* a handoff. The bench
  behind the thresholds compared an Opus lead with Sonnet subagents against Opus inline, which is what a handoff
  now is, so the saving's shape is unchanged -- but a nudge the model may ignore was the thing the trigger was
  built to replace, and a denial that instructs is one step weaker than a report that arrives. The measure is the
  live one this project already uses: over a window of sessions with the trigger on, the share of `op: delegate`
  handoff rows followed in the same turn by a subagent conversation in the host's own transcript (Claude Code
  writes one per subagent; the Report already reads them), against the `after: 'handoff'` rows that say the lead
  read the file itself anyway -- beside cost per exchange on the 50% holdout. Not run here: it spends model
  tokens, which is the owner's to approve. The live smoke before any of it is one `opencode run` and one Claude
  Code session on a 3,000-line file, checking that the named agent resolves and the report comes back.
- **OpenCode 2 is the second door (2026-11-12; `opencode-v2.js`, `delegate.js:HOSTS`, `hostEvent`).** Its plugin
  registers `tool.hook('execute.before')` on `read` and `shell`, sends the call to the same `hook pretool` (the
  runner gives that one hook 300 s), and **throws the denial's reason**, which v2 makes the call's result. Checked
  live on 2.2.7 with a probe plugin: an error-shaped result worded as a report was distrusted ("an odd error
  containing what looks like a pre-baked report") and the model routed around it with grep and sed; the denial's
  own words ("thinker read core.py through a claude-sonnet-5-5 subagent... work from it; a short range is never
  delegated") were accepted, and the model answered from the report and said the read was delegated. So the words
  are the mechanism there, and `denial()` is the one copy of them. OpenCode names its tools in lower case and its
  Read takes `path`; one Read returns at most ~58k characters and tells the model to continue at an offset, so a
  whole file is several reads of ~26k tokens, under the single-read threshold: the first chunk fires when the file
  asked for is over it (`readOf` returns `fileTokens` beside the chunk's `tokens`; `HOSTS.opencode.readCap` sizes a
  chunk as the host returns it), since the model would read the rest anyway. Project-scope plugins load from
  `<repo>/.opencode/plugins/`, user-scope from `~/.config/opencode/plugins/` whatever `XDG_CONFIG_HOME` says, and
  **plugins run in a long-lived OpenCode server process** (one `run=` id in its log for days): the shell that
  starts `opencode run` does not reach them, so a checkout's copy is driven through the plugin config (`id` to
  load beside the installed one, `env` merged over the server's by `runner.js`), never through the shell. The
  live smoke (2026-11-12, `opencode run` on a 3,681-line file): the first read denied, the explorer 12 s for
  $0.20, the model worked from the report, took two ranged reads of 25 and 18 lines, and answered right; the
  same run an hour earlier had fired through the installed plugin and been held out (`held: true` rows in the
  machine log), which is the holdout doing its job.
- **Three more hosts have a door, and none of them is wired yet** (surveyed 2026-11-12; the old line here said
  "no other agent has such a door: Cursor can deny a shell command but not answer for it; Codex's hooks cannot
  deny", and both halves are now false). **Codex 0.166.0** registers `PreToolUse` and `PermissionRequest` as live
  hook events -- this machine's own `~/.codex/config.toml` holds `[hooks.state."…:pre_tool_use:0:0"]` trust
  entries -- and its documented deny JSON is Claude Code's shape exactly, so `denial()` would serve it unchanged;
  its subagents are `spawn_agent` over `~/.codex/agents/*.toml` with built-in `explorer` and `worker`, but an
  agent file **cannot** override the parent's sandbox, so there is no read-only explorer there. **Cursor**'s
  `preToolUse` returns snake_case `{permission: "deny", agent_message}`, and `agent_message` is exactly the
  model-visible channel this needs; its subagent tool is `Task`, built-in `explore`, and it reads
  `~/.claude/agents/` as well as its own, so the Explore.md thinker writes is already picked up there.
  **Gemini CLI**'s `BeforeTool` takes `decision: "deny"` with a `reason` its docs say is "sent to the agent", and
  a subagent is exposed as a tool of its own name from `.gemini/agents/*.md`. What is **not** verified for any of
  the three: that the model obeys the handoff live. Each needs a `HOSTS` entry, a per-host denial envelope (only
  Claude Code's and Codex's are the same JSON) and a hook entry in `clients.js`; none is worth writing before the
  live check, since the wording is the mechanism and only a live run shows whether it is believed.
- Removed on the way (#750): the rules that hooks never run or rewrite test commands and do no side work. What
  stays: the installer is never a hook branch.

**A hook may delegate to a subagent (2026-11-11):**
- Two rules removed: hooks never run test commands; hooks are only for cache, no installs.
- PreToolUse hook can deny a read/test, run subagent, return report.
- Logged, costed per session, judged live on holdout.

**Telemetry and tests (MANDATORY):**
- `THINKER_TEST=1`: blocks production telemetry and background work, keeps logs local.
- `THINKER_OFFERS=on`: restore offers (offer tests only).
- Every child must inherit. Never send test runs to production. Mocked or loopback only.

**Matched models (MANDATORY):**
- Same model and effort per phase (exploration, coding, judging). Agent config fixed except intervention.
- Record model before run. Disable silent fallback. Report correctness, tokens, latency separately.

**Evals run in `bench/` (MANDATORY, 2026-11-14, the owner's call; `bench/README.md`):**
- `node bench/bench.mjs run bench/experiments/<spec>.json`. State the estimate, get a yes, then run; `--dry` starts nothing.
- System of record: `bench/ledger.jsonl`, one line a session, committed. Runs under `bench/runs/` (ignored).
- Spec names the rule before the run; tasks are `turn-N.txt` files at a commit, hashed onto every record (`taskHash`, `armHash`).
- Errored or turn-capped session is `valid: false` and enters no figure. `maxTurns` defaults to 180 (the old runner's 60 voided six PostHog sessions, $25.53, 2026-11-14).
- Arms are project scope only (`--setting-sources project`) and each pins `ANTHROPIC_BASE_URL`: no session inherits this machine's proxy.
- Rates are ratios of sums; arms paired by task and rep.
- **Artemis and kronus are retired.** `~/.artemis/artemis.db` stays as the archive of everything before 2026-11-14, including the website's published numbers; start nothing new there.

**Worktrees (MANDATORY):**
- All changes in isolated worktree. Never edit primary.
- `git worktree add -b agent/<task> .worktrees/<task> HEAD`. On done: `git worktree remove --force`.

**Releases:**
- Tag `vX.Y.Z` on `main`, assets `thinker.tgz`, `version.json`, `install.sh`.
- `npm` publishes at same version. `--hold` for pre-release/`next` tag. `--promote` to stable.
- `scripts/release.sh`, `scripts/pack.sh` (self-host: `pack.sh <base url>`).

## What `setup` does

The installer (`install.sh`) installs the tool wherever it is run and wires it into the agents on this machine
(`thinker connect`). Every git repository on the machine has a cache from then on: the first hook, MCP server or
cache command in a checkout starts one, empty (`store.js:init`, kept out of `git status` through
`.git/info/exclude`), and the profile in it grows from the sessions there. Nothing is built, and nothing is opt-in.
Outside a git repository there is nowhere to keep a cache: the CLI's cache commands stop with that message
(`cli.js:CACHE_COMMANDS`), the MCP server offers no tools and says so in its instructions, and the hooks are quiet.
A prompt is logged as a request whether or not anything is said back (`op: request`, `commands/hooks.js`), so
`thinker usage` and the telemetry count the machine as active.

The wiring lives in the agents' own settings, once per machine, since 2026-10-04 (`clients.js:wiringFiles`, scope
`user`): `~/.claude/settings.json` and `~/.claude.json`, `~/.codex/hooks.json` and `~/.codex/config.toml`,
`~/.gemini/settings.json`, `~/.cursor/hooks.json` and `~/.cursor/mcp.json`. `thinker connect [--clients …]` writes it
and needs no repository; `setup` runs it as its first step, and so does the installer. A hook there names no `--repo`
and reads the checkout from the agent's input (`cwd`, Cursor's `workspace_roots`; `commands/hooks.js`); the MCP entry
pins no `THINKER_REPO` and the server takes the repository from the directory the client starts it in, asking a
client that declares MCP roots for its workspace when that directory is not a repository (`mcp.js`). The checkout's
machine-local wiring of an older copy is taken out by `setup` and by the first hook at user scope that runs there
(`clients.js:stripRepoWiring`), named once at the end of the turn; a hook at user scope yields to a checkout whose
own files run this copy's hooks (`clients.js:repoWiredByCopy`), so nothing fires twice. `thinker uninstall --user`
removes the machine-wide wiring. After an update, `thinker rewire` rewires every known checkout and removes what
each kept of the knowledge notes (`notes-retired.js`).

`thinker setup` connects the agents, adds the repository's own pieces (git hooks, Cursor's always-applied rule,
Codex's trust in the project, `.thinker/`), fetches the ranking model the harness recall uses, and shows where the
agents' context goes, read from their transcripts (`context-machine.js`): on a terminal it asks whether to see what
to cut first in the browser or there (`setup/context-ask.js`), in the browser the page opens on All with the same
suggestions checked. The old cache build (`--build`, `--prs`, `--areas`, `--no-seed` and the rest) is accepted and
ignored; its history is in git before 2026-11-08.

## Pull requests delivered (`thinker prs`, 2026-10-29)

- **Session-PR linking** (`delivery.js:linkFor`): `thinker prs link` (with `--split`), one session per PR. Unlinked sessions never dropped.
- **Two savings types**: `cleared` (measured tokens, `compression.js:clearedBySession`), `reading` (estimated, `usage.js`). `total` sums both.
- **Proxy log consulted** for state files when tail unreached; larger value wins.
- **`merged` = merged with recorded work**. `mergedSeen` shows repository total.
- **Agent tokens = prompt + answer sum**.
- **GitHub read-only** (`gh` login, `delivery.js:syncPrs`): branch, head, base, merge commit, times. Detail/commits only for named PRs (`--pr n`). 20 pages max, newest first.
- **Journal**: `<log dir>/delivery/<digest>.jsonl`, three record kinds, gitignored.
- **Posting** (`delivery-comment.js`): `thinker prs comment --pr n`; `--dry`, `--days 30`. Shows netted figure: clearing at cache-read rate, reading at input rate, minus cache-write cost.
- **Auto-posting** (`delivery-auto.js`): 4-hour job, posts once per merged PR after 20 min quiet if netted dollars ≥ 0. Disabled by `prComments: false`. Receipts in `<THINKER_HOME>/state/pr-comments.json`.
- **Telemetry** (`delivery-telemetry.js`): counts, tokens, dollars, and the policy behind each saving. See the section below.

## What a user's savings are, measured (2026-11-11, the owner's ask)

- **Session clearing tracked per-session, not by denominator:** `sessionsOf` (usage log `op: session` rows) with cleared tokens, cost, prompt count.
- **Every saving names its policy:** `cutting.js:policyId`, format `r<rev>-<settings>` (e.g., `r1-t140k-f60k-p25-deep`). `proxy.js` stamps on log rows; `compression.js:noteCompression` on session record. Unstamped savings never fold into current figures. Policy stamp prevents date-based errors across machines.
- **Dashboard reads stamped policies only** (`scripts/savings-dashboard.mjs:STAMPED`). Pre-stamp clears in separate row. Unstamped clears left out.
- **Two rewrites not charged:** cold cut's own call (`r.clear.cold`) and rewrites from expired cache (no read found). Both doors enforce via `cutting.js:chargedRewrite`, `register.tsx:chargedRewrite`.
- **Factory's two arms:** `telemetry.js:armsMetrics` sends `factory.arms` sums (sessions, exchanges, dollars, rework, cache traffic, merged PRs) per stage/loop, by policy stamp. Schema 1, read by **Diff by feature** dashboard.
- **`sessions` payload groups:** sums not averages. `all`, `cleared`, `uncleared`, `byPolicy`, `byClient`, `netBuckets`. Cost per prompt beside cost per session.
- **`prs` schema 3:** `spendUsd`, `spendPrs` (over PRs with all sessions priced), `clearedPrs`, `byPolicy`, `rows` (newest 50). No PR/repo/session names.
- **`labels`, what an operator says the machine is** (2026-11-12, `src/labels.js`): up to 8 short names from `labels` in `THINKER_HOME/config.json`, `THINKER_LABELS` (JSON or `k=v,k2=v2`) merged over it per key. On the payload always (`{}` = none set, absent = build too old; a fleet must tell those apart) and on the `op: session` row, the one event per session an export reads. Set, never inferred (no hostname, instance id or remote): the only part of a payload where identifying data can appear, so whose it is to put there is the operator's. Repo config is not a source — a checkout is not a trust boundary for fleet attribution. Ingest stores the payload whole, so no deploy.
- **Oversized payload:** `fitPayload`, `PAYLOAD_BUDGET` 56 KB. Drops rows first, sets `rowsDropped`.
- **`byDay` cumulative per snapshot:** day of session's last request or PR merge. Never add snapshots; explode days, add those.
- **Desktop clears outlive card record:** `compression.js:mirrorClearing` writes to `state/compression/<session>.json` (max 200 files, pruned after `PRUNE_AGE` 2 days) and once to log (`op: 'clearing'`). `delivery.js:sessionsOf` reads; `clearedBySession` sums cumulative. Take newest row, never add.
- **Cold cut pricing:** `compression.js:clearingCostBySession` prices at zero (cache expired, rewrite happens anyway). Warm cuts charged their rewrite.
- **Dashboards:** **Savings per session** (`scripts/savings-dashboard.mjs`), **Pull requests delivered** (`scripts/delivery-dashboard.mjs`, `valid` accepts schema 2 or 3). Read from `reports.raw_json`.
- **Limits:** Clearing holdout off since 2026-11-12 (was per-machine baseline, now end). Unstamped clears on current machine until next build. Sessions with no usage (Cursor) counted but no cost. Model per-session reread tracked in `src/rereads.js`.

## Usage history

- Runs append to `~/.thinker/log.jsonl` (under `THINKER_HOME`). Repo key: origin in `.git/config`; no origin: path.
- `THINKER_LOG`: path, `local` (`.thinker/log.jsonl`), or `off`. Harnesses installing real hooks MUST set `THINKER_LOG=local`.
- Log keeps first 200 chars of each request (`op: request`; `orient` rows from before 2026-11-08 count as requests too).
- `thinker usage [--here] [--days n] [--json]`: requests, sessions, agents, what learning spent. The savings are the clearing's (`thinker savings`, the Report).
- MUST NOT show dollar costs or estimate cost from tokens outside `prices.js`'s doors. Provider-reported cost is data only.

## The session profile (2026-11-07, `src/profile.js`; on by default since 2026-11-08)

- **Two stages, one ledger.** Sessions end by pairing each prompt with answers until the next prompt, asking the model for observations: request, approach, outcome (`accepted`, `corrected`, `redirected`, `unknown`), quoted reaction, lesson where supported. Written to `.thinker/local/profile/ledger.jsonl`, 60-day window. Rows carry `at` (session clock) and `seen` (ledger read time).
- **Compile is a daily patch** (`compileHours` 24, `compileBatch` 200). Due when a session enters the ledger and last compile is 24h old. Model shown profile with id on each entry, new observations, and related rows (max 40, `relatedCited`). Returns keep / update / drop / add. Entry with no citations leaves by code. Updates apply floors and window; full compile via `thinker profile compile --full` or changed prompt; backlog longer than 200 patches in steps, oldest first.
- **Citations hold entries to observation window** (`settle`): dropped if window does not hold; entry with none leaves. Counts and dates from cited observations. `howWeWork` line needs two sessions or one stated preference (a lone correction or interruption no longer suffices, 2026-11-12: that is where the narrow lines came from). Workstream leaves if not seen in 21 days. Stated preferences and corrections worth most; repeated rules get marked "in AGENTS.md; still missed".
- **Model: Opus only** (`PROFILE_MODELS`, `completeProfile`). Calls get 10 minutes. Another model set via `learn.profileModel`.
- **Skills** (`exchanges` carries `skills`, `observationSkills`; `/skill` or agent `Skill` call). Extractor sees `SKILLS:` line per exchange. Compile shown tally per skill (sessions, observations, person/agent typed, outcomes) and related observations (max 40, newest). Line per skill: use and person's reaction. Kept only when cited observation ran or named skill; two sessions or person naming it. Rendered `/name: text`. Backfill via `thinker profile backfill [--dry]`.
- **Rendered block** (~1500 tokens, `renderChars`; `renderProfile`, `profileBlock`). Headed with one sentence and session count. **Served text only** (no counts, dates, outcome tallies; use `show --why`). Oldest workstreams first (to 3), least-used skills (to 3), weakest ways of working (to 4), longest last (`TRIM`).
- **Served by prompt hook, held out by session** (deterministic share via `profileHoldoutRate` 0.5, `learn: { profileHoldout }`, env `THINKER_PROFILE_HOLDOUT|THINKER_HOLDOUT`). Block goes first in session; state file holds arm, count, compactions seen (`st.profile`). `profile-served` row logged per injection and once per held-out session.
- **Measure: cost per exchange and recurrence.** Cost is ratio of sums (tokens over exchanges), stratified by model, bootstrapped interval. Recurrence: how often person restates prior preference (`repeats` on observation; extractor shown profile lines and 200 prior distinct prefs/lessons, newest first). Judged `profile` (line held it) or `ledger` (compile failed). `servedRate` is holdout's question; `unlearnedRate` checks extractor. Rows before `repeats` extraction not measured (`measured` field).
- **Line verdicts** (`LINE_VERDICTS`, `shownLines`, `profileTurn` keeps ids in `st.profile.shown`; `thinker profile lines [--why]`). Per-line per-session: `applied`, `ignored` (evidence of violation or silence where line covered work; person restating in prompt is `ignored`), `na` (no bearing). `followRate` over sessions line applied to; `null` where none. Default `na`. Verdict on unseen id or second verdict on same line dropped.
- **Corrections weigh most, lines retire by code, ids are stable** (2026-11-12, the owner's call). `settle` ranks `howWeWork` by the corrections cited behind a line (`isCorrection`: corrected, redirected or interrupted, the Factory's rule), then sessions; the cap and the render's trim take from the bottom. The compile sees a batch's corrections first and each live entry's `corrections` and `use` (shown, applied, followed, ignored, contradicted from `lineReport`), with the rule to reword, move or drop a line applied in a fifth or fewer of five-plus sessions: the fix is at the source, the retire rule is the backstop. The prompt bars state from a workstream (no PR number, merged/unmerged, deployed, on/off, "done"). A line judged `na` in `retireShown` (15) sessions is `retired` (`retireDue`, `retire`): out of the served block the day it happens (`profileBlock`), marked on the profile at compile and listed to the model as RETIRED, never re-added; `thinker profile lines` and `show --why` mark it; `lines.retired` on the metric. Entry ids keep across compiles (`ids` counters on the profile, `idCounters` for one from before), so a verdict keyed on an id is about one line; until then `h1` was the rank.
- **Full compile once a month** (`rebaseDays` 30, `rebasedAt` on profile). `thinker profile [show [--why] | ledger | compile [--full] | extract <transcript> | rebuild [--days 30]]`; `rebuild --dry` lists sessions and chars. Reads all worktrees' sessions.
- Profile under `.thinker/local/`, never committed. Log rows carry counts and tokens, not text.

## Report

- **Weeks**: Last `REPORT_WEEKS` (6), Monday–Sunday, current last.
- **Unit**: Prompt (one model call). Week tokens ÷ prompts in cells/columns.
- `--total`: week sum. Default: per prompt.
- Per-prompt cell = ratio of sums, never mean of session means.
- **Per session**: Model/usage from `transcripts.js:Stats`, `tool-outputs.js:sessionUsage`, state `.thinker/state/tool-outputs.json` (v8). Parts joined by session id: instruction files, custom tools, built-in tools. Each × session model calls. Tool outputs re-read by later calls. Transcript: system prompt per call; tool inputs, thinking, prompts, agent text, attachments. Thinking: `thinking_tokens`, else signature length ÷ 4.3. Instructions attachment is exact. Scaling: parts scaled down where sum exceeds measured input; remainder = "Other input". Output = model output. Total = session tokens.
- **Profile** (2026-11-08): session profile's own measure. Recurrence rate (prompts repeated with profile vs without), cost per prompt, verdict on data sufficiency (pace: measured exchanges ÷ days against 200-a-side floor), profile holdings and per-line usage (rarely/sometimes/frequently as shares). Over 60 days, not weeks. All repositories pools counts; cost interval bootstrapped per repository, no pooling across repositories.
- **Tool output is nobody's choice** (2026-11-04): clearing on by default; removes results agent finished with (88% of output cost). Diet never in Find Savings, weekly question, installer, ACTS, `partChanges`, or `part-explain.js`. Kept: measurement, diet as `thinker context --output-compression <tools> [--level high]`, `describePart({kind:'output'})`, `output` branch of `undoOf`.

**Find Savings: one table, a part a row (2026-11-09)**
- Title, type, per call, used, wasted, action: dropdown + Apply in row. `›` beside title opens description and text.
- Gone: view tabs, Potential savings card, explanatory paragraph, cards view, checkboxes, Apply over table, Over N days and Share columns. Figures stay in opened row and `thinker context`.
- Suggested rows come first with action picked. **Wasted is dollars** (2026-11-08): row's wasted tokens at input token cost (every priced session's input cost ÷ input tokens, Report's rule, over Save window). All repositories adds dollars and tokens. **Colour**: used in <10% of carrying calls = red ≥5k tokens/call, yellow <5k, uncoloured <500 tokens.

**Cost per prompt (2026-10-25)**
- Part sits in prompt, costs its size in every call carrying it. Table: **Per prompt** (`tokens`), **Needed** (`usedShare`), **Over N days** (`window`), **Wasted** (`wastedWindow`). All cells with **?** under 40 words.
- Needed by prompts: tool/skill = calls that called it (`harness.js:readSessionHarness` `usedCalls`), summed `usedPrompts` capped at session calls. Section = calls firing triggers (`instruction-value.js:appliedTurns`), over calls since last change. Output = re-reads before last agent use (`tool-outputs.js` `needed`).
- Real calls: `prompts` = sum of sessions' model calls; section changed inside window costs present size in every call reading file.
- All repositories merges output by tool with current setting (`mergeViews`); dead periods never merged. Live row's `compression` = its own level.
- All repositories sums `usedPrompts`, `prompts`, `window`, never weights. `SUGGEST.minSaving` = 15 per prompt.
- Change's `total` = row's `windowSaving` (wastedWindow), never recomputed.

**Pull request savings (2026-10-30)**
- **Figures are dollars** (2026-11-08; `delivery.js:sessionsOf` prices at list rates by token type, `prices.js:costOf`). Null unless complete; partial cost never shown. **Pull request stats** rows: PR count, Saved per PR, Cost per PR (over PRs with complete counters), in dollars. Recent activity: Sessions, Cost, Saved, Share.
- **Saving is gross, cost beside it** (same day; `savedUsd`, `savedUsdPerPr`, `meanSavedUsd`): cost = every call at list, includes cache writes. Netted figure (`net`, `netPerPr`, `meanNet`) stays in data, `thinker prs`, posted comment.
- View Report: four PR cards (merged work, tokens saved, share of cost, average). PR list in Recent activity under **PR savings**. Report leads with **Pull request stats**, then **Cost by context**, **Compression effectiveness**. **By model**, **By token type** collapsed under **See more metrics**. Defaults Total, weekly table no graph. Weekly follows request dates. Repository = last repo session names.
- 12 rows behind *Show all*, 10 in command (`thinker prs` for rest).
- `report.js:prSavings` folds `delivery.js:deliveryReport` into view; both read one computation. All repositories: counts/tokens add, averages taken again over every row, each row carries repository.
- **Typical PR = average, not median** (2026-11-04; `delivery.js:mean`): denominator = every merged PR in window (zero-saving included) = same as total sum. Per-PR rows show spread.
- **Dollars are netted** (2026-11-04; one rule, one sentence: **cleared at cache-read rate, plus reading avoided at input rate, less cache rewrites after clear at list prices**). `delivery.js`, `thinker prs`, posted comment read one computation. Deduction = `isRewrite` over proxy log, charged from first clear onward. Netted figure (`net`, `netPerPr`, `meanNet`) in data, `thinker prs`, comment. Gross avoided cache reads before cache rewrite costs (Report).

**The Factory: sessions as pipeline (2026-11-08)**
- Six stations (Prompts, Think, Explore, Build, Verify, Merge), loops, first-pass yield.
- **Attribution**: call's tokens → stage of tool called; first call after prompt = Prompts; no tool = Think. Two-stage tool = split evenly. Shell: `bashStage` (commit/push = Merge, read-only = Explore, writes = Build, other = Verify). `transcripts.js` returns `calls`, puts call index on tools (`call`), failure flag (`error`).
- **Loop = event, rework = cost** (2026-11-09). Loop kinds found by code (`LOOP_KINDS`, `detectLoops`); row per kind that fired. Fix loop (test/build fails then passes, keyed by program), correction (interrupt or profile ledger's `corrected`/`redirected`), sent back (commit/push after `gh pr create`), review catch (review skill/reviewer then edits), re-read (file read 20+ calls later). `RULES_VERSION` in cache key.
- **One computation kept with Report** (2026-11-08): `reportView` carries `factory` (over window/sessions), `mergeReports` merges (sums add, shares/verdicts taken again, loop kinds join, PRs keep repository). `report-snapshot.js` hashes `factory.js`. Page reads `/api/report`, `thinker factory` prints kept one (`--refresh` remakes).
- Stage share of rework: good ≤10%, bad ≥35% (first cut).
- **Trend table** (2026-11-09): last four weeks, two rows per metric (cost/rework share for stage, loops/cost for loop). Columns = Report weeks. Sums add, shares taken again. Command prints same.
- **"See diff by"** (2026-11-09; `factory.js:ARMS`, `armsOf`; `--diff profile|compression`): sessions with feature vs held out. Cost/session, cost/exchange, rework share, first-pass yield, rework by stage, loops/session. **Trust**: noise band = 2× relative standard error, greyed as flat <20% good, 20–50% fair, ≥50% low. Profile arm recorded at session start; held-out by `proxy.js:heldOut`. PR counts only if every session on that side. <10 sessions/side = thin.
- **Clearing's "on" side = sessions with actual clear since `CLEARING_SINCE`** (2026-11-10; `delivery.js:clearedFor`): proxy log first, mod's record where log empty. Held-out = hash's. Session on arm but never cleared = on neither. Both sides need trigger reached **and started after `CLEARING_SINCE`**. Guards: cold-boundary cut excluded; mod records pruned after 2 days; current share used for all sessions. **Confidence**: 17% by definition, 19% exact (no tool), 11% by tool, 3% split, **51% on shell command** (`bashStage`). Fix loop keyed on fine program, closes within same/next exchange.
- **Review stage** (2026-11-09): first call after prompt while PR open = Review. Review round (person's prompt opened exchange, from call to last push) or follow-up (opening exchange or harness event opened). Change = any Build call. Totals box on bottom right: cost per merged PR, rework share; diff mode shows both sides.
- **Continued session = one session** (2026-11-09): `transcripts.js:continuations`. Continuation's copied calls/events dropped before Factory reads (`parseTranscript({ since })`), copied rows are context only. Session state v14+ marks original's tail with `continued-in`. Every reader reads from `since`. Stop hook logs from `since` onward.

**Subagent conversations priced at own model** (2026-11-08)
- `<projects>/<slug>/<session>/subagents/agent-<id>.jsonl` + `.meta.json`. Report reads as own rows (`tool-outputs.js:sessionUsage` carries `parent`, `agent`, `type`). Subagent calls = prompts of week, tokens priced at own model. Session never counted, left out `sessionRows`. No usage = skipped.
- PR figures: stop hook's `op: session` carries `subagents` (type, model, counters). Parent counters unchanged. `sessionsOf` keeps `ownTokens`, makes `tokens` = parent + subagents (`subagentTokens`). Tokens add, dollars never do.

**Tables (each ends on `sessionTotals`)**
1. Parts: instruction files, custom tools, built-in tools, outputs, Other input, output total.
2. Models: grouped by provider; per prompt of week.
3. Token types: fresh input, cache writes, cache reads, output.

**Toggles**
- `--share`: Values/Share (row ÷ week total); whole-session total keeps value.
- `--total`: Per session/Total.
- Dollars at list prices only (2026-11-08; `--tokens` accepted, changes nothing). Tokens stay in view and `--json`.

**Colour (parts table)**
- Dollars per priced prompt vs `COST_THRESHOLDS`: green ≤good, red ≥bad, yellow between. Four parts: old token bounds at ~$0.8/M input; Other/total set on this machine 2026-10-26. Good/Bad columns. Verdict uses cost per priced prompt regardless of displayed cell. Command marks ✓ · ✗. No colour in model/token-type tables.

**Sessions without usage** (Cursor): excluded from columns, named left out. Estimated parts shown as `estimated` only.

**Calibration** (`report.js:CALIBRATION`): estimates count chars/4, scaled before overshoot (Anthropic 1.44, OpenAI/Google 1). Override: `.thinker/config.json` `calibration: {Provider: f}`.

**Cache rewrites** (`transcripts.js:cacheRewrites`): first call/subagent, after compaction, after >1h pause, 5–60 min at 5m TTL, model change, mid-conversation. Stored v12; in view/`--json` as `rewrites`, `rewriteTotals`. Not on pages/print.

**Cost (default, only dollars)**: per session, list rates (`prices.js:listPrice`): fresh input, cache reads/writes (1h = 2×, 5m = 1.25×), output. Anthropic: `model-usage.js:relativeRate`; OpenAI/Google: `PRICED_ON`. `.thinker/config.json` `prices` adds/overrides. Part cost = share of session input. Unpriced = left out, named.

**Decisions** (Recent activity, `thinker context --history`): Before, After, Saved (`report.js:actionEffect`, `itemCost`). Window: until revert; merged PR from merge; until later decision. Costs per prompt summed over sessions ÷ their prompts. Section: `context-suggest.js:sectionTokens` (0 after removal), sessions reading file. Tool: per call in sessions loading it. Output: `tool-outputs.js:sessionUsage` `by`; compressed key carries level. Saved: positive = saving. Shading green/red; never coloured text. Caption row: prompt average. `sessionRows` per measured session only. Lent only from report this code made; else `/api/activity` returns `measuring: true`. All repos = `mergeReports`. Output: `report.js:outputComparison`.

**Performance & kept report**
- Page never recomputes on visit. Kept: `.thinker/state/report.json`, all windows under `views`. **One slot per code** (2026-11-09; `byCode`; three servers read each other's stale write without end): reader takes own code's slot first; `views` newest for older; four codes/week max. Fresh checkout reads every session once.
- `thinker report`/`--refresh` write it. Page starts background when >10 min old or other code; shows "measured N min ago, updating…".
- Decisions read live. Save: outgrown kept shown at once, remade behind. Transcripts read on visit only if no kept or action dropped.
- Background one at a time. `usage.js:parse` caches log per process (size, mtime). `transcripts.js:sessionModel` cached.
- **Kept view brought up to date, not made again** (2026-11-08; `ui/scans.js` passes `since`, `scan-worker.js` acts). This code's view older than 10 min checked: worker stats sessions, log, proxy; nothing moved = `unchanged`; something moved = read every session in one pass. Strip counts changed sessions ("N of M changed"; "Updating…"). Stamp = hash of slice (window sessions by file/mtime/size/`since`, this repo's log events, delivery journal, proxy rows/desktop clears of window only). Not watched: other repos' log (only decide if session counts here). `MAX_KEEP_MS` (6 h) backstop.
- **One parse per process for shared logs** (2026-11-10): `compression.js:compressionRecords` keeps proxy log's parsed tail, `usage.js:logEvents` keeps events beside parse, `providers.js:registryPrices` stats `providers.json` ≤1/s. One repo's Report: 1.9 s → 1.25 s.
- **A log append is not a reason to read a session** (2026-11-12; `report.js:logParts`, `refreshLogParts`, `scan-worker.js:logsOnly`). Report has two halves: sessions (parts, models, token types, Factory) and logs (`actions`, `savings`, `prs`, `profile`). Logs are shared and appended every few seconds of a live session, so any visit re-read every session of every repo for figures that could not move. Now: no session moved + a log moved = log half alone, one message, kept view's session half stands. Guard: `sessionsStamp` (`view-sources.js`) kept with the report; shortcut refused unless sessions are the ones it was made from (a *dropped* session has no new mtime). 13 repos here: 2.4 s → 1.4 s a visit.
- **Log rows are shared, never copied per reader** (2026-11-12; `usage.js:parse`). Rows sorted once and `origin` put on each at parse; `all` returns the rows themselves, one repo an array of references. Was: `{...e}` over 35k events per (repo, all) pair, 51 MB of heap a copy, four held. 13 repos: 349 ms/+158 MB → 92 ms/+67 MB, same rows. Readers must not mutate an event. A log whose rows don't all name a repo (`anonymous`) keeps the copying path.
- **A checkout in a tool's area or inside another checkout is nobody's work** (2026-11-12; `machine.js:toolArea`, `insideAnother`, beside the `TMP` rule). Hidden folder of home (`~/.claude/jobs/…`, `~/.artemis/repos/…`) or a *different* repository nested in a checkout's tree (`bench/worktrees/…/posthog/test-wt`). Linked worktree of the same repo stays (compares repo id, not path). This machine: 18 repos listed → 13.
- Save snapshot keyed on settings fields (`context-snapshot.js:settingsKey`), not file bytes. `writeSnapshot` prunes old `context-view-*` and pre-2026-10-24 per-worktree files.
- Instruction sections read transcript once (`instruction-value.js:sessionRecord`), kept as `session-activity`. Re-read only if transcript grew or sections name new code.

**Tool switches across repositories** (2026-10-30)
- Approving from Find Savings/`thinker context --approve` uses machine settings, shared action/undo in `THINKER_HOME/state/machine-actions` (`scoped-state.js`). Skills/sections retain scopes. Page submits one per tool.
- Claude Code uses user-level denies; Codex uses user config with project overrides. Undo keeps fingerprint, refuses discard if changed since switch.
- Recent activity shows shared action once, measures over selected repos' sessions. Old repo-specific remain history.

**Page updates** (`page.html:swapBody`)
- Keep shown table, swap new. Scroll/See more/dropdown picks kept. Body height fixed.
- Save header shows "updating…" in `#c-asof`.
- After Apply: show change at once, re-read decisions, report.
- Spinner only on first read/repo change.
- **Scan progress** (2026-11-07): bottom of viewport, fixed outside sticky nav (2026-11-09). Sessions read/share/left/bar. Each reader calls `onSession` per session; `scan-worker.js:progressOf` counts once all `READERS` pass it, posted ≤200 ms no view revision.

**Section change is pull request** (2026-10-29)
- Every door (`context-suggest.js:approveChanges`): records decision, starts detached `thinker instructions … --job`, opens PR. Until then: only page; others ran inline, held turn, wrote uncommitted.
- Diff in modal. Button: commits to new branch from default via temp index (checkout untouched), pushes, opens PR (`instruction-pr.js:openEditPr`).
- `prAvailable` decides (no GitHub, no `gh`, not logged). If not: working-tree write with reason.
- Preview from base (`instruction-pr.js:baseTexts`). Parent = commit preview read from. Checkout branch, uncommitted, distance don't matter.
- History: `pull request` with `pr` {number, url, branch, state} (`context-suggest.js:applyReviewed`).
- PR state refreshed per `/api/activity` read, `thinker context --history` (≤1/min).
- States: **Pending** (open; row pill linked, unpickable), **Merged**, **Rejected** (closed unmerged; re-suggested), **Unpulled** (merged, not in checkout; yellow banner, tints decisions; test: merge commit not ancestor; cleared when `pr.pulledAt` kept).
- **Close = revert** (`revertDecision`): comment, close, delete branch.
- Command: `thinker instructions --compress <id> --pr`.

**Background job**
- Apply records at once: shared `group`, `job: {state: running, pid, startedAt}` (`context-suggest.js:startSectionJob`, `/api/changes/start`).
- Detached: `thinker instructions --compress|--remove <ids> --pr --job <group>`.
- Page toast where to follow.
- `runSectionJob`: preview, PR (recorded on group, pending until merged) or working tree (kept under group). Failure: `job.state: failed` + reason.
- Running with dead process, no record after 2 min = failed (`changeHistory`, `jobDied`).
- Failed = nothing decided; re-suggested.
- **Retry** (`retryJob`, `/api/changes/retry`, `thinker context --retry <n>`): reruns every section.
- Diff in PR or `git diff`.
- Save rows: under way = *Compressing…*, unpickable; failed = so, pickable.
- Decisions on **Recent activity** (`#tab-activity`, `/api/activity`: history only, one repo or all). Top card: needs person. Rows: Retry, Close PR, Revert. Badge counts incomplete. Polls 30 s, 5 s while running.
- Report's decisions uses `historyFigure`.
- Row: kind line (Built-in/Custom tool/output), what it does (`part-describe.js`). Pill hover explains; decided cell shows time/action/worth.
- Stored as `what`, `about` (older entries derived). No See more/detail. Command prints after title.

**Changed sections are new sections**
- Last change date (`instruction-value.js:sectionAges`, `git blame -w`; uncommitted = write time; cached; `changedAtOf` = newest line, blanks ignored).
- Recent = sessions since change (`applied`). <`RARE.minSessions` = unknown (no pill, not suggested).
- Cost: present size × share of sessions reading file; over window, sessions since change. Row says `changed <date>` and sessions measured. Hand edits count.
- Failed: keeps waste pill, actions; Recent shows failure, Retry.

## Error reports, with consent (2026-10-29, the owner's ask)

- **Recording:** `recordError` called from catch sites; never throws, writes one line. Disabled in test mode (`THINKER_ERRORS_TEST`). Deduplicates, keeps max 20 records over 14 days.
- **Scrubbing:** Replace `<thinker>` (install path), `<repo>` (repository), `~` (home), `<token>` (credentials), `<url>` (URLs), last two segments (other absolute paths). Checked in `test/error-report.test.js`.
- **Consent:** Asked once per machine via agent's question tool, answered through `thinker errors --answer yes|no|never`. Only asked where records exist and telemetry is on.
- **`thinker errors`:** Prints records. Flags: `--send`, `--json`, `--answer`.
- **Endpoint:** `/errors` on metrics API (`infra/metrics/errors.mjs`, `handler.mjs`). Rejects payloads matching `LOOKS_PRIVATE`, `LOOKS_LIKE_URL`, `LOOKS_LIKE_TOKEN`. Requires table and GRANT deploy in `infra/metrics/README.md`.

## Knowledge notes, removed (2026-11-08)

From 2026-09 to 2026-11-08 thinker's learning was a cache of **notes**: 3-12 line rules, maps and how-tos with
`file:Symbol` pointers, distilled from each session's condensed transcript (and, until 2026-10-21, mined from merged
pull requests and read from the code), each resting on dependency hashes that marked it stale when the code moved,
verified by a small model, phrased for retrieval, ranked by BM25 and a cross-encoder, and served by the prompt hook
and the edit hook with a 15% per-turn holdout. Desired behaviors (`behavior` notes a person wrote, that a merge
revised), skill cards (`skill` notes audited against the code), a notes sync server (`thinker-server`), the code
tools (`find`, `drilldown`, the symbol table, tree-sitter boundaries) and the Artemis cache builders (`mine-prs`,
`understand`, `export --dir`, `THINKER_NOTES_DIR`) were parts of it. The owner removed all of it on 2026-11-08, with
the model configuration that served it (`distillModel`, `verifyModel`) and the "reading avoided" savings series, in
favour of the session profile above. Why: on the owner's machine the notes were served on 10% of prompts and 47% of
distillations saved nothing; the profile is always present and never retrieved. What a checkout kept of the notes is
deleted once, by `thinker rewire` and the prompt hook's wiring check (`notes-retired.js`); a committed
`.thinker/notes/` directory is the repository's to remove. The code is in git at `6443bd1ac` and before; the
measurements are in `research/bench-history/RESULTS.md`. Do not bring note serving, verification or mining back
without a live paired measurement.

## Review was removed (2026-10-11)

`thinker review` (a single model call over the diff, the code it touched and the
notes resting on it; later with `usedContext`, the code the change uses) was
removed, with task verification (`--run`), the pull request action, the server's
review worker and the pre-commit option. On held-out bugs, fixes withheld from
the cache, it caught no more with notes than without (mitmproxy 10-11 of 15 either
way, PostHog 5 of 8), and the user's own coding agent reviewing the same change
caught 14 of 15 with or without thinker alongside. Its one distinctive number,
recall of fixes already in the cache, is not a claim this project makes. The
measurements are in `research/regression-heldout` on the `agent/heldout-regression`
branch. What survives: `src/change.js` (the model-free change helpers) for the
diff-keyed serving of notes to a reviewing agent, and two findings for a review
built around the agent: showing the code the change uses lifted the single call
from 7 to 11 of 15, and an input-class checklist to 12 of 15.

## Supported agents

| agent | profile on the first prompt | MCP | user files |
|---|---|---|---|
| Claude Code (incl. desktop) | yes, and again after a compaction | yes | `~/.claude/settings.json`, `~/.claude.json` |
| Codex CLI (incl. desktop) | yes | yes | `~/.codex/hooks.json`, `~/.codex/config.toml` |
| Gemini CLI | yes | yes | `~/.gemini/settings.json` |
| Cursor | yes (`additional_context`); the `agent -p` CLI one tool call late | yes (needs approval) | `~/.cursor/hooks.json`, `~/.cursor/mcp.json`, `.cursor/rules/thinker.mdc` |
| Devin CLI and Devin Desktop's local agent | yes | yes (`learn_next` allowed in `permissions.allow`) | `~/.config/devin/config.json`, `~/.config/devin/mcp_config.json` |
| Pi, Windsurf, Copilot CLI, OpenCode, Factory Droid, Qwen Code, Kiro CLI, Cline, Kilo Code, Auggie, Goose | see `docs/agent-integrations.md` | | agent's own files |

- `--late` and `--no-late` are accepted for compatibility: the edited-file notes they governed went with the knowledge notes.
- **Claude Code gets no `PostToolUse` hook** (2026-11-10, the owner's call). It ran `hook tool` after every Read, Bash,
  Grep, Edit and Write and answered nothing: Claude Code keeps its own transcript, so the hook recorded no trace, and
  the edited-file notes, the instruction sections and the diet it could have served are gone or off. One node process
  per tool call for no output. `installClient` writes none, `inferWiring` reads `late: false` for the client whatever
  the file holds (so an old entry is never carried to another agent as a chosen option), and the event stays in the
  list `setHooks` clears, so `thinker rewire` takes the entry an older copy wrote out of `~/.claude/settings.json`.
  The other agents keep theirs: they have no transcript, and the hook is how their tool calls reach the profile.
- Plugins under `plugins/` run `thinker hook … --plugin` and yield to host hooks (`clients.js:pluginYields`).
- **Orca is a host, not an agent, and wants nothing of thinker's own (2026-11-12, checked live on 1.4.257).**
  It runs the agents' CLIs, one git worktree to a task, and reads each repository's `.claude/` and `.codex/`:
  a terminal pane, Orca's structured chat and a pane on an Orca **managed account** alike serve the profile,
  log the session and route through the proxy. Orca appends its managed hooks to the agents' files instead of
  replacing them and `setHooks` only ever drops thinker's own entries, so neither takes the other's out. A
  managed account's home is `<Orca userData>/claude-profiles/<accountId>/home` (Codex: `codex-accounts/`), and
  Orca **mirrors the person's `~/.claude/settings.json` keys into it**, each key's `JSON.stringify` hashed in
  the account's `settings-sync.json` so it re-syncs when their side changes: `env` -- the proxy's route and the
  mods' plugin directory -- arrives byte-identical, `hooks` arrives with Orca's own added. So thinker must
  **not** write into such a home; that would desync the ledger Orca reconciles by. Its worktrees live in
  `~/orca/workspaces/<repo>/<name>` and are linked, so `store.js:cacheCheckout` already points them at the main
  checkout's cache. #764 wired those homes from a string in Orca's minified bundle that read like an exclusion
  of `settings.json`; one real account disproved it, and it was reverted. Make the state and look at it.
- Pi: `npm/pi/thinker.js`.
- One copy per checkout (`clients.js:pruneInstalls`). `setup` removes other copies' hooks and repoints MCP. Claude Code `--local` empties the shared settings file.
- Prompt hook prunes gone or older copies (`olderOnly`), logs `op: "prune"`. Never delete old copy's files.
- Wiring follows installed version (`clients.js:refreshWiring`, `inferWiring`, `installClient`). Rewrite only this copy's entries; leave hand-tuned commands. Skip temp-dir checkouts.
- `thinker update` runs `thinker rewire`. Manual: `thinker rewire [--here] [--dry]`.
- Cursor: `beforeSubmitPrompt` returns `additional_context`. Headless `agent -p` has no prompt hook, so the profile reaches it one tool call late through `postToolUse`.
- Codex: `setup` sets `default_tools_approval_mode = "approve"` and trusts project and hooks in `config.toml` (`CODEX_HOME`, default `~/.codex`).
  - `--yes` skips the trust prompt; `--no-trust` leaves trust to the user.
  - Without a terminal, nothing is marked unless `--yes`.
  - `uninstall` removes hook entries.
- Cursor MCP: `setup` approves via Cursor's CLI when installed.
- Google AI Studio: unsupported.

### What Codex stores as trust

Codex has no command for this and does not document the format. What follows
was read from the `config.toml` that Codex 0.157 writes after a review in its
own interface, and checked by running `codex exec` 0.157.1 on entries that
thinker wrote. All of it is in Codex's own config (`$CODEX_HOME/config.toml`,
by default `~/.codex/config.toml`), never in the repository.

A trusted project is a table named by the real path of the repository:

```toml
[projects."/Users/me/src/repo"]
trust_level = "trusted"
```

A reviewed hook is a table per handler:

```toml
[hooks.state."/Users/me/src/repo/.codex/hooks.json:user_prompt_submit:0:0"]
trusted_hash = "sha256:6118…1471"
```

- The key is `<real path of hooks.json>:<event>:<group>:<handler>`: the event
  in snake case (`UserPromptSubmit` is `user_prompt_submit`), then the index
  of the group in the event's list and of the handler in the group's `hooks`,
  both from 0. A hook that moves in the file needs a new entry.
- The hash is SHA-256, in hex, of this JSON with no whitespace, keys in
  alphabetical order, and `async` written out as `false` when the hook does
  not set it:

  ```json
  {"event_name":"user_prompt_submit","hooks":[{"async":false,"command":"…","timeout":15,"type":"command"}]}
  ```

  So any change to the command or the timeout makes the entry void, and
  Codex asks for a review again; `setup` writes new entries when it is rerun.
- Checked: handlers of type `command` with a `timeout` and no `matcher`,
  which is what thinker writes, for `UserPromptSubmit`, `PostToolUse` and
  `Stop`. Not known: how a `matcher`, a `statusMessage` or a missing
  `timeout` enter the hash. `trustCodex` leaves a group with a `matcher`
  alone, and hooks that are not thinker's are never marked.
- `codex --dangerously-bypass-hook-trust` runs hooks without these entries
  for one invocation; thinker does not use it.

The code is `clients.js:codexHookHash` and `clients.js:trustCodex`; a hash
that Codex stored is held in `test/clients.test.js`.

### Learning from any agent

Learning works with every agent that gives thinker a session, and with others through the generic path below.
Nothing in it is tied to one vendor:

- **Sessions.** `thinker distill` reads Claude Code, Codex, Cursor and Gemini CLI transcripts (and the streamed output
  of their headless modes) and maps them to one event form: prompt, tool call with result, agent message
  (`transcripts.js`). The profile reads the prompts and the agent's messages alone (`profile.js:exchanges`).
- **When.** Once per session, when it ends (Claude Code's `SessionEnd`, Cursor's `sessionEnd`): an exchange's outcome is
  the prompt after it, so a turn-end read would be guessing. Catch-up covers agents that fire no end: `thinker learn`
  finds every session any of these agents ran in the repository and reads what is new in those quiet for 20 minutes
  (`commands/hooks.js:LEARN_IDLE_MIN`). Hooks start it in the background at most every ten minutes.
- **What the agent's record leaves out.** Where an agent gives no transcript, the hooks record the session themselves
  (`.thinker/state/trace-*.jsonl`).
- **Model.** The profile's reads and compiles run on Opus through the `claude` CLI or `ANTHROPIC_API_KEY`
  (`profile.js:PROFILE_MODELS`; `learn.profileModel` pins another). `THINKER_LLM`, `THINKER_LLM_MODEL`,
  `THINKER_LLM_BASE_URL` and `THINKER_LLM_CMD` still steer `llm.js:complete` for the other model calls (docs/usage.md).
- **Any other agent.** Pipe events to `thinker record <session>` as JSON lines (`{"t":"prompt","text":…}`,
  `{"t":"tool","name":…,"input":…,"result":…}`, `{"t":"say","text":…}`), then run `thinker learn`.

Seen in the live runs of 2026-09-27 (the notes era; the hook wiring is what still stands):

- Codex did not run hooks from a project's `.codex/hooks.json` in `codex exec` with only the project marked trusted,
  but ran the same hooks from the user-level `hooks.json`. With the hooks marked as reviewed too (what `setup` now
  writes), `codex exec` 0.157.1 loaded the project's MCP server and ran the project's hooks.
- Cursor's CLI (`agent -p`) fires `sessionStart`, `postToolUse`, `afterShellExecution` and `sessionEnd`, but not
  `beforeSubmitPrompt` or `stop`, and `postToolUse` carries a summary of the tool's output, not the output. So thinker
  installs both the editor's and the CLI's events and takes shell output from `afterShellExecution`.

## Jev, tried and removed

TypeSafe's Jev (System One: calibrated probabilities for typed questions, no
generated text) was wired into thinker between 2026-10-06 and 2026-10-08 and
taken out entirely on 2026-10-09, at the user's decision. It had ranked the
servings (a hosted proxy on AWS, a personal-key path, `thinker ranker --jev-key`),
narrowed the related notes and gated the optional steps of a review, typed the
drift surface of every note for derived verify verdicts, chosen the passages a
distillation saw, and gated what learning wrote: a catalog scan, a relation
judgment against existing notes, grounding of every claim against the source,
and a fidelity check of each search description, with a deferral queue under
`.thinker/state/learning-pending/` for what the gates held back. The
measurements are in `research/bench-history/RESULTS.md` ("Serving: Jev", "Derived verify
verdicts", "Jev capture selection", "Current Jev versus historical cached
runs") and under `research/jev-*`. What they showed: a strong offline serving
result (2.5x the important notes reached at the same precision on 54 labelled
tasks) that did not pay in live paired runs (costlier in 8 of 8 Click pairs); a
smaller review prompt with the same catches and, with verification, 86% more
tokens; archive triage and every intrinsic note facet at AUC ~0.50; capture
selection that kept 0 of 13 reference facts at three times the tokens; learning
gates whose thresholds discarded most proposals until retuned, with no paired
measurement of the gated cache against a plain one. Only the external-tool
re-baseline in verification was sound, and it covered 5% of stale notes.

What stands in its place is what was there before: the hooks rank with the
cross-encoder and the agent's `orient` and `lookup` by words; learning saves what
the distiller proposes through `saveNotes` (lexical near-duplicate merging, named
`extends` targets honoured), the distiller shown the notes resting on the files a
session or pull request touched; `phraseNotes` keeps the description the writer
returns; every stale note goes to the verify model. The deferral queue is still
written for assessments of notes a session was shown but did not discuss
(`learning-pending.js`). One daily token cap (`dailyTokens`) covers learning and
maintenance. Git holds the removed code at `0cb765c`. Do not bring Jev back
without a live paired measurement on held-out tasks; the offline labels were not
predictive of session cost.
