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
- Holdout 50%, per session by hash; `proxy: { holdout }` in config overrides.

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

**Exploration subagents on Sonnet, off by default (2026-11-08):**
- Off until owner ships: `THINKER_EXPLORE_MODEL=on|<model>` or `agents: { explore: true | "<model>" }`.
- File: `<claude config dir>/agents/Explore.md`, read-only, marker `<!-- thinker-explore -->`, Sonnet 5.5 by default.
- `connect`/`rewire` write it; `uninstall --user` removes; person's own file left alone.

**Models from other providers (2026-11-10):**
- Registry: `<THINKER_HOME>/providers.json`, key never in it (`auth: { env | file }`).
- Route: `thinker/<alias>`, `thinker/<provider>/<model>`; proxy forwards with provider key, without agent's.
- Cut applied first, model swapped, Claude-only fields dropped, Chat translation where needed.
- Subagents: `<claude config dir>/agents/<Name>.md`, marker `thinker-agent`, user scope, `reader` or `worker`.
- Profile: `state/model-profile.json` (per repo, merged on show); routes priced at own model.

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

**Evals only through Artemis (MANDATORY):**
- `~/src/artemis` (web, MCP). `.agents/skills/run-evals/SKILL.md`: `create_pr_set`, `plan_experiment`, user approves, `start_experiment`.
- thinker CLI only: `thinker mcp`, `hook`, `version`.
- Artemis config: `"thinker"` → tested build.

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
- **Telemetry** (`delivery-telemetry.js`): counts and tokens only.

## Usage history

- Runs append to `~/.thinker/log.jsonl` (under `THINKER_HOME`). Repo key: origin in `.git/config`; no origin: path.
- `THINKER_LOG`: path, `local` (`.thinker/log.jsonl`), or `off`. Harnesses installing real hooks MUST set `THINKER_LOG=local`.
- Log keeps first 200 chars of each request (`op: request`; `orient` rows from before 2026-11-08 count as requests too).
- `thinker usage [--here] [--days n] [--json]`: requests, sessions, agents, what learning spent. The savings are the clearing's (`thinker savings`, the Report).
- MUST NOT show dollar costs or estimate cost from tokens outside `prices.js`'s doors. Provider-reported cost is data only.

## The session profile (2026-11-07, `src/profile.js`; on by default since 2026-11-08)

What replaced the knowledge notes (the owner's call, 2026-11-08): what the person here is working on and how it
goes, learned from a session's **prompts and the agent's answers alone** and loaded into a session at its start.
`learn: { profile: false }` in `.thinker/config.json` turns it off for a repository; `THINKER_PROFILE=on|off` wins.
Measured before it was built: inputs and outputs are 5% of a session's text here (median 1k chars of prompts,
13k of answers, 255k of tool text over 40 sessions), the notes were served on 10% of prompts in 30 days and 47%
of distillations saved nothing. The profile is the opposite bet, always present and never retrieved, and it is
judged the same way the owner set for it: a per-session holdout, by corrections, prompts to done and tokens.

- **Two stages, one ledger between them.** The end of a session (`distillFile` in profile mode; a turn-end
  `--batch` waits, since an exchange's outcome is the prompt after it) pairs each prompt with the answers until
  the next prompt (`exchanges`) and asks the model for observations: request, approach, **outcome read from
  the following prompt** (`accepted`, `corrected`, `redirected`, `unknown`; the agent's own "done" is a claim, and
  `unknown` is the default, never a quiet acceptance), the quoted reaction, a lesson only where the reaction supports it, stated preferences
  (`kind` and the bug line went on 2026-11-08: nothing read the one, and the section that read the other is gone). They go to `.thinker/local/profile/ledger.jsonl`, 60 days, with the session and the directories its tool
  calls' *paths* name (`sessionDirs`, never their content; per-directory profiles are on hold until the one profile has been rolled out and read, the owner's call on 2026-11-08). A row's `at` is
  **the session's own clock** (the prompt's stamp, which every parser now puts on the prompt event; `exchanges`
  carries it, `observationTimes` dates each observation by its turn) and `seen` is when it was read into the ledger:
  the window and every date in the profile go by `at`, whether a compile is due by `seen`. The first build stamped
  rows with the extraction time, so every workstream and bug read as that night's and the recency rules meant nothing;
  the 483 rows were redated from their transcripts without a model call. **A compile is a patch, once a day**
  (`compileStep`, `applyPatch`, `PATCH_SCHEMA`; 2026-11-08): due when a session was read into the ledger and the last
  compile is `compileHours` (24) old (`compileDue`; first after one observation; it was once per session for a day,
  and at this repository's pace, sessions in parallel across worktrees, the profile moved several times a day, so the
  owner set it to a day behind), the model is shown the profile as it stands with an id on every entry
  (`w1`, `h2`, `s3`), the new observations, and the observations behind the entries those might touch (sharing a
  topic or a directory with a new row, at most 40, `relatedCited`), and returns keep / update / drop / add. An entry it
  does not name is kept, an update adds its observation ids and changes only the fields it names, a drop needs a
  reason, and `settle` then applies the floors and the window to the merged result, so an entry nothing supports any
  more leaves by code, never by the model's silence. A backlog longer than `compileBatch` (200) is patched in steps,
  oldest first, each written as it lands; a full compile (`thinker profile compile --full`, `rebuild`; a changed prompt)
  is the same step from an empty profile. Why a patch: the first steady-state look at a rewriting compile put it at
  roughly 60k tokens for ten new observations (the profile, up to 200 cited rows and every entry written again), twice
  what extracting the sessions cost, and every rewrite could lose or reword an entry with no new evidence behind the
  change; the first build also showed the compile only the newest 150 of 483 observations, which is where most of
  the 110 corrections went. Replayed on this repository's ledger the same day (a full compile with the last five
  sessions held out, then each patched in alone): a patch ran 12k to 22k tokens (the profile's own JSON is a third
  of the input, the related evidence most of the rest, the output under 2k), a session of one observation with no
  reaction yet became a Working on line, the next session on the same work updated that line rather than adding one,
  and five new observations with two corrections added a workstream, a what-went-wrong line, a bug and twelfth-session
  evidence to "validate fixes live". The full compile over the same rows cost 153k tokens in three steps against the
  rewriting form's 189k. One difference to know: built by patches, the recurring patterns ("answer short and plain",
  "validate live, not mocks", "don't call a capability impossible") land in `howWeWork` with their counts (12, 12, 6),
  and `whatFails` holds the specific recent corrections, newest replacing the oldest at the cap; the rewriting form
  put the patterns in `whatFails` with the quotes. The monthly full compile below is that rebase. Three sections:
  `workingOn`, `howWeWork`, `skills` (below). `whatWorks` went on 2026-11-08 morning ("an approach accepted after a
  correction" is the `instead` of a `whatFails` entry, and on its own it held one line in four that two sessions
  supported); `whatFails` and `recentBugs` went the same evening (the sharpening bullet below).
- **Every entry cites observation ids, and the code holds it to them** (`settle`): a citation the window does not
  hold is dropped, an entry with none goes, counts and dates come from the cited observations (count is distinct
  sessions), a `howWeWork` line needs two **sessions** or one observation that states the preference in so many words
  (`prefs`), corrects it with the person's reaction, or was interrupted by the person (the first build's floor counted
  observations, and two from one session passed), and a workstream not seen in 21 days leaves. The compile is told the
  caps, that `approach` is the agent's own account, that an `unknown` outcome supports `workingOn` and `skills` and
  `howWeWork` through `prefs` alone, that an interrupted observation is a correction whatever its outcome says, that stated preferences and corrections repeated across sessions are the lines
  worth most and that it need not ration since the code drops thin lines, and that a rule the instruction files
  state and agents still broke is kept and marked ("in AGENTS.md; still missed"): a line a fresh agent gains most
  from. Reviewed three times before the first build (2026-11-07): `abandoned` and `weight` went, the first because
  no next prompt tells "moved on" from "dropped", the second because nothing read it. A prompt can be changed and the profile recompiled from
  the ledger without reading a transcript again (`thinker profile compile --full`), and `thinker profile show --why`
  prints each line over the observations it cites, which is how a compile is judged.
- **Models** (`PROFILE_MODELS`, `completeProfile`): Opus and nothing else (the owner's call, 2026-11-07). A ladder of
  Opus, GPT-SOL and Gemini was built first and taken out the same day, after the first build timed one session out on
  Opus and read it with two other models: a profile built by three models is not one profile. The id names its
  provider so `complete` pins it there, never the tier table's Luna fallback on Codex; `learn.profileModel` pins
  another model. The calls get ten minutes, since a long session took Opus past the default five.
- **Codex's approval assessor is not a session** (`ASSESSOR_PROMPT`, `ASSESSOR_SAY`): Codex writes a rollout of its
  own in the same cwd whose prompts are the agent's history and whose answers are a risk verdict in JSON; one such
  file here had 79 of 79 answers so, 845k chars of prompts. `exchanges` drops both, so a file of them is zero
  exchanges and no call. The note distiller still reads those files (not changed here).
- **Skills: which are run here, by whom, and how it went** (2026-11-08, the owner's ask; `exchanges` carries `skills`,
  `observationSkills`, `skillTally`, the `skills` section). Each exchange records the skills it ran -- the agent's
  `Skill` call, or a `/skill` the person typed, which Claude Code records as a command block (`clean` strips it, so a
  prompt that is only the command keeps `/name args` as its text; Claude Code's own commands, `BUILTIN_COMMANDS`, and
  `thinker-*` are not skills) -- as `{name, by: person|agent}`, two calls of one skill in one exchange being one use.
  The extraction sees a `SKILLS:` line per exchange, never the call's arguments, and is told a reaction to such an
  exchange is a reaction to the skill's result; the skills of an observation are attached **by code** from the
  exchanges it spans, never written by the model. The compile is shown a computed tally per skill (sessions,
  observations, how many the person typed, outcomes) and the observations that ran a skill that are not otherwise in
  its sight (at most 40, newest first), and writes one line per skill: what it is used for and what the person said.
  `settle` keeps a skills line only when a cited observation ran or named the skill (a pref, the request or the
  reaction), takes its counts from those observations alone (`count` sessions, `used`, `accepted`, `corrected`), and
  applies the usual floor: two sessions, or the person naming it. Rendered as `/name: text` (the tallies are `show
  --why`'s since 2026-11-08 evening); trimmed after the workstreams (to three), before the ways of working. Measured on this machine before it was built: 22 of 396 sessions in 60 days ran a skill (29 calls), and on
  the ledger 18 of 116 sessions, `plugin-authoring` corrected 4 of 7 and `dataviz` 2 of 6 -- so the section is often
  empty and that is right. `thinker profile backfill [--dry]` attaches skills and interrupts to rows read before the
  ledger recorded them, from the transcripts by turn, no model call (676 rows here). Codex and Cursor sessions carry no
  skill calls yet. Not done: the skills available and never run, which the Find Savings rows already measure.
- **Rendered** (`renderProfile`, `profileBlock`) within about 1500 tokens (`renderChars`, the owner's call on 2026-11-08 after seeing what 1000 dropped; 800 until that day, when
  the trim cut the ways of working from ten lines to two before touching the weaker sections), headed with one
  sentence and the session count. **A served line is its text and nothing else** (the owner's call, 2026-11-08
  evening): the count or dates on every line and the skills' outcome tallies were a fifth of the block and told the
  agent nothing it could act on; `show --why` carries them, with the evidence. When it does not fit: the oldest
  workstreams go first (to three), then the least-used skills (to three), then the weakest ways of working (to four),
  then whatever is longest (`TRIM`).
- **Sharpened after reading this repository's own profile (2026-11-08 evening, the owner's call).** The rendered
  block was read line by line against `--why` and the ledger, and six things changed:
  - **`whatFails` went.** It was the `howWeWork` rule in negative form and the compile wrote both: the three top
    pairs ("answer short and plain" against "avoid jargon and tables", 15 sessions each; "one netted dollar figure"
    against "avoid token counts and ranges"; "verify live" against "avoid mock-only tests") were about 1,700 of the
    6,000 served characters saying what the block had already said. The `instead` of a failure *is* the rule. A
    correction now feeds a `howWeWork` line written in the imperative, saying what to do; the compile prompt says so,
    and the floor admits one correction with the person's reaction, as `whatFails` did.
  - **`recentBugs` went.** The lines were the agent's own account of a fix ("PR #684 hot-swapped and confirmed")
    rendered as fact, for a session that seldom meets the symptom again; the `bug` field and `kind` (written on every
    row, read by nothing but the ledger's header) went with it.
  - **The served block is text alone** (above). On this repository's profile the block went from 6,143 to 3,512
    characters and shows six workstreams where the budget had trimmed it to three.
  - **The compile is daily** (above).
  - **Directories are the repository's, whichever checkout** (`sessionDirs`, `mainCheckout`). The path was stripped
    of the store's own path alone, so a session in `.worktrees/<x>` or a scratch directory labelled its rows `/Users`
    or `/private` (219 and 22 of 689 rows) and 442 had nothing, and `relatedCited` matched evidence on `/Users`. A
    path is now placed by the git checkout holding it, counts when that checkout is the repository or one of its
    worktrees (a worktree's `.git` file names its home), and a worktree removed since the session (152 of the 291
    paths in the last 40 sessions here) places under the main checkout with its `.worktrees/<name>/` prefix dropped.
    Another repository's paths, and paths outside any, are nobody's. Only 291 of 5,436 tool calls in those sessions
    carried a path at all (the rest were Bash), so the labels stay sparse by nature.
  - **An interruption is a correction** (`transcripts.js` emits `interrupt`; `exchanges` marks the exchange it cut
    short; `extractionInput` prints an `INTERRUPTED` line; `observationSkills` counts `interrupts` on the row by code;
    `settle` admits a line on one; `backfill` attaches them to older rows). Esc in Claude Code writes "[Request
    interrupted by user]" (or "... for tool use") as a user message, a refused tool call answers with a tool_result
    that says so, and Codex writes `turn_aborted`; 216 of the markers sit in this checkout's transcripts, 29 in the
    last 40 sessions, and every one arrived as a USER line the extractor was told was nobody speaking. The extractor
    is now told the outcome of an interrupted exchange is never `accepted`: the next prompt says whether it was a
    correction or a redirection, and the lesson is always written. `accepted` was tightened in the same edit: a
    reaction that approves one part and changes or objects to another is never an acceptance, and a question is
    `unknown` unless it objects (the ledger had "ignore that mandatory rule. actually remove it please. hold off on
    the ledger cost line." as one).
  - Found the same evening and **not** changed: the installed app is 0.2.27 (#709), ten commits before the profile
    shipped, so the hooks on this machine have served it to no session yet and every ledger row is from `rebuild`;
    `instructionHeadings` sees `#` headings alone while this file's rules are bold paragraphs, so the "in AGENTS.md"
    marking cannot fire and "work in a worktree" is served beside the MANDATORY rule; seven of ten `howWeWork` lines
    are about the person rather than the repository and are relearned from zero in every other repository; a
    60-exchange session gets about 2,000 characters an exchange in the extraction while 58 of 177 extractions on
    one-prompt sessions produced nothing; `workingOn` has no way to say "decided against" (the effort-routing
    workstream was an investigation that ended in a no).
- **Served by the prompt hook, and held out by session** (2026-11-08; `profileTurn`, `profileArm`, `compactionsSince`,
  `holdoutReport`; `thinker profile holdout`). With `learn.mode` on, the block goes into a session's first prompt ahead
  of everything else the hook says, and again after each compaction, since a compaction summary keeps none of it: the
  hook counts `compact_boundary` lines written to the Claude Code transcript since the byte it last read (a few bytes a
  prompt, never a parse), and the other agents get it on the first prompt alone. A deterministic share of sessions
  (`profileHoldoutRate`) is held out **whole**, not by turn as the notes are, because the block is one injection that
  the rest of the session reads. The arm lives in the session's state file
  (`st.profile`: arm, how many times told, compactions seen), the Stop hook's `session` row carries it (`profile:
  shown|holdout`), one `profile-served` row is logged per injection and once for a held-out session (counts, never
  the text), and **every observation extracted from the session carries its arm**, so the ledger is the measure.
  What it cannot tell apart: a correction the profile caused from one it failed to prevent; read the lines with
  `show --why` before blaming it.
- **Half the sessions, and the measure is cost per exchange** (2026-11-08, the owner's call; `PROFILE.holdoutRate`
  0.5, `learn: { profileHoldout }`, `THINKER_PROFILE_HOLDOUT`, `THINKER_HOLDOUT` over both; `perExchange`,
  `ratioInterval`, `compare`). It shipped the day before at the notes' 15%, judged **corrected and redirected per
  session**, and neither could have answered the question. **The goal is to spend fewer tokens, so the metric is the
  tokens a unit of work costs and nothing stands in for it**: a session's tokens over its exchanges, which takes the
  length of a session out of the comparison (cv 0.97 against 1.96 for a session's tokens, over 111 measured sessions
  here). Three rules, each from a measurement on this repository's first ledger:
  - **A ratio of sums, never a mean of ratios** (the Report's own rule). The ratio of sums is $5.97 an exchange and
    the mean of the per-session ratios $13.93: the mean weighs a cheap three-exchange session like a 40-exchange one.
  - **Stratified by model, pooled by exchanges.** The models in play differ threefold an exchange (Astra $5.99,
    Opus 5 $18.35, Fable $19.95), so an arm that drew more Astra sessions would read as a saving. Within-model ratios
    weighted by each stratum's exchanges cut the bootstrap standard error from 11.3% to 9.6% on the same sessions.
  - **The interval is bootstrapped, not assumed**: a ratio of two sums has no closed-form standard error worth
    trusting on 111 skewed sessions, so `ratioInterval` resamples sessions inside each stratum on a fixed seed.
  What it can see, at 7.8% standard error and 5 sessions a day: **a 30% drop in 235 sessions (47 days)**, 20% in 529
  (105 days), 10% in 2118 (420 days). Why 50/50: at 85/15 the small side wastes most of the information, and an
  unbalanced split is for catching a regression in something already known to work, which is where this goes when it
  ships. `verdict` is `cheaper` / `costlier` / `inconclusive` / `too-early` off the interval, never a p-value dressed
  as a decision.
- **The lead measure is recurrence: the person saying again what they said before** (2026-11-08, the owner's
  call; `repeats` on every observation, `priorStatements`, `recurrence`, `compareRates`; `thinker profile holdout`
  leads with it). The profile's own counts said what the goal is: in 23 days here "answer short and plain" was
  said in 17 sessions, "validate fixes live" in 13, "work in a worktree" in 8 -- **80 repeats across 118
  sessions**, one in every nine exchanges spent telling a fresh agent what the last one was told. The profile
  exists so that never happens, so its score is how often it still does. Why this and not cost: it is the
  mechanism itself, not an echo of it, so the expected effect is large (the agent has the literal line) where
  cost-per-exchange was hunting for 3-12%; the direction is unambiguous; a novel mistake is out of scope by
  construction; and "did the person say X again" is read from the prompts alone, in the call that already runs,
  and is a far surer judgement than "did the agent follow X".
  - **Against the ledger, not the profile** (the owner's point, the same day): the profile is what survived the
    compile's two-session floor, per-section caps and trim, so a repeat judged only against its lines would never
    see what the compile failed to learn -- a profile that learned nothing would score perfectly. The extractor is
    shown the profile's lines and, behind them, every distinct preference and lesson another session recorded
    (`priorMax` 200, newest first, the session's own rows left out), and each repeat is kept as `profile` (a line
    held it: the serving failed) or `ledger` (no line held it: the compile failed). Both count. The residual
    survivorship is the ledger's own: what the extractor missed the first time, or outside the 60-day window.
  - **`servedRate` is the holdout's question, `unlearnedRate` is a check on the extractor.** The agent saw the
    unlearned statement in neither arm, so that rate must come out the same on both sides; a gap there is the
    judge drifting, not the profile. Rows from before `repeats` was extracted are not measured (`measured`), so
    the pre-profile baseline is the held-out arm, not the old ledger; `thinker profile rebuild` re-reads sessions
    with the field if a backfilled baseline is ever wanted.
  - Cost per exchange stays as the second figure, read the same way.
- **Corrections are a diagnostic, not the measure** (the same day). They were the headline for a day and should not
  have been: they are a proxy for cost where the cost itself is measurable, and `redirected` does not mean what the
  metric needed it to. Hand-read against the ledger's quoted reactions, `corrected` (141 rows) is clean, but of 12
  sampled `redirected` (72 rows) about a third are the person moving on rather than the agent failing -- *"can you
  make me a visual tool to play around with?"*, *"I'm going to move this convo over in the thinkerall repo"*,
  *"when does the quota open?"* -- and `accepted` absorbs some failures (*"retry"*, *"ok please fix so that we stop
  getting worse costs"*). The error has a **direction**: a profile that gets things right faster produces more
  moving-on per session, which a corrected+redirected numerator counts as failure, so a working profile could read as
  harm. `rate` stays on the report beside the cost figure, and 36 of 680 rows hand-read is a smell test, not a
  validation -- that needs ~60 rows labelled blind and scored against the extractor, which nobody has done.
- **Every session's last exchange is unmeasured.** An outcome is read from the *next* prompt, so the final exchange of
  a session is always `unknown` (94 of 116 sessions end on one) -- and a person who gives up and closes the terminal
  produces no correction at all. It falls on both arms alike so it does not bias the comparison, but it caps what any
  outcome read from this ledger can mean.
- **What a session did with each line it was shown** (2026-11-08, the owner's ask; `LINE_VERDICTS`, `shownLines`,
  `appendLineVerdicts`, `lineReport`; `thinker profile lines [--why]`). The first question about a line is not
  whether it improved anything, it is whether the agent read it -- a note was assessed that way from the start
  (`confirmed` / `unused` / `contradicted` per serving) and the profile had nothing of the kind for its first two
  days: a block of ten lines went into every prompt of every shown session and no record said whether one of them
  was ever used. It is the opposite of the holdout on every axis: one row per line per session rather than one
  number for the whole block, so a week here is hundreds of rows against the holdout's forty; it needs no arms and
  no waiting; and it says *which* lines earn their place, which matters because `renderChars` is a fixed budget and
  a dead line is holding a live one out.
  - **The same model call, not a second one** (`extractObservations`'s `shown`): the extractor already has the
    whole session in front of it, so the lines it was shown ride along in that prompt for a few hundred tokens.
  - **Only what a session actually saw may be judged on it.** `fitProfile` trims the block to `renderChars`, so
    `renderProfile` alone could not say what went in; it now returns the surviving entry ids beside the text, one
    function doing the fitting so the two can never disagree, and `profileTurn` keeps them on the session's state
    (`st.profile.shown`, across injections, since a compaction can bring a changed block back) and counts them on
    the `profile-served` row. A verdict on an id the session was never shown is dropped, as is a second verdict on
    the same line.
  - **`na` is the default, and `applied` is the denominator.** Most lines have no bearing on most sessions, and
    counting those as ignored would make every line look dead; `followRate` is followed over the sessions the line
    had any bearing on, and `null` where none did, because 0 of 0 is an untested line and not a failing one.
    `ignored` needs evidence that the agent did the thing the line forbade or failed to do what it asked in work
    the line covered -- not merely that it never mentioned it, since a line can be followed silently. A line the
    person restated in their own prompt is `ignored` with their prompt as the evidence: that is the person doing
    the profile's job, which is the thing most worth knowing.
  - What it cannot tell: `ignored` from `na` is a judgement, and it is the model's. Read `--why`, which prints the
    quote behind every verdict, before cutting a line on this.
- **A profile read may not ask `store.exists()`** (found building the above): it tests the **notes** directory,
  which the profile does not use, and both `shownLines` and `profileArmOf` were gated on it. In a profile-only
  checkout -- which is what the notes' removal makes ordinary -- `profileArmOf` would have answered null with the
  arm sitting in the state file, so every observation would have been saved with no arm and the holdout would have
  measured nothing at all, silently. Reading a session's own state file needs no notes.
- **The cheaper check, which moves faster than the holdout** (the same day): of the 213 corrections and redirects in
  the first ledger, the share a profile line whose cited evidence *predates* them plausibly covers -- excluding the
  corrections that are themselves that line's evidence -- is **25% on a loose word match and 3% on a tight one**. The
  lines read as retrospective descriptions of corrections already made rather than predictions of the next one, which
  is the mechanism's own ceiling and is free to recompute from the ledger with no model call. If that ceiling stays
  near 3% the holdout cannot pay for itself whatever it says, and the honest answer is to stop.
- **Not measured, and known**: the extractor is the judge, and it is only partly blinded -- `clean` strips
  `<thinker-profile>` from the prompts it reads, but the agent's own answers can name the profile, so the arm can
  still leak through them. Nobody has counted how often.
- **A full compile once a month** (`rebaseDays` 30, `rebasedAt` on the profile, carried by every patch): a compile that
  finds the last from-nothing compile older than that starts from nothing over the whole window, so wording the patches
  have carried for weeks is derived again from the rows. At this repository's volume that is 150k tokens of Opus;
  `thinker profile rebuild --full` does it by hand, and a rebuild without `--full` patches the sessions it read into the
  profile as their own ends would have.
- The profile is this machine's: under `.thinker/local/`, never committed, and the log rows (`op: profile`,
  `profile-compile`) carry counts and token figures, never its text. `thinker profile [show [--why]|ledger|compile [--full]|extract
  <transcript>|rebuild --days 30]`; `rebuild --dry` lists the sessions and the chars it would read, and reads the
  sessions of every worktree of the repository, since the cache is the main checkout's.

## Report

**Tabs and entry**
- Tabs: Find Savings (`--tab save`), View Report (`--tab report`). Old `tab=context|changes|cache` open replacement view.
- CLI only: `thinker profile`, `thinker usage`. Removed: `/api/usage`, `/api/cache`, `/api/behaviors`.
- `thinker ui` opens `repo=all`; `--here` opens `repo=here`; `--all` accepted.
- Page reads `repo=` (`page.html:hashRepo`). Link naming a repo id wins (`context-suggest.js:suggestionsUrl`).

**Report (`thinker report`, `report.js:reportView`)**
- Weeks: last `REPORT_WEEKS` (6), Monday–Sunday, current last.
- Unit: prompt (one model call). Week tokens over its prompts (`transcripts.js` `turns`, kept as `prompts` on cells/columns).
- `--total`: week sum. Default: per prompt.
- Per-prompt cell = ratio of sums, never mean of session means.
- Per session:
  - Model/usage: `transcripts.js:Stats`, `tool-outputs.js:sessionUsage`, state `.thinker/state/tool-outputs.json` (v8).
  - Parts joined by session id: instruction files, custom tools (skills, MCP, plugins), built-in tools. Each × session model calls. Tool outputs re-read by later calls.
  - Transcript (`transcripts.js:parseClaude`, `carried`, Claude Code only, v10): system prompt per call; tool inputs, thinking, prompts, agent text, attachments. Re-read by later calls since last compaction.
  - Thinking: `thinking_tokens`, else signature length ÷ 4.3. Kept (`clear_thinking keep: all`).
  - `instructions` attachment, when present, is exact (replaces estimate).
- Scaling: parts scaled down where sum exceeds measured input. Remainder = "Other input". Output = model output. Total = session tokens.
- **Profile** (2026-11-08, the owner's ask; `profile-metric.js`, `report.js:profileLines`, `page.html:profileFigure`): the
  session profile's own measure, under Compression effectiveness on both doors, framed as what a person would ask of it
  (the owner, the same evening): **with the profile against without**, how often they had to repeat themselves (the
  served recurrence rate as a share of prompts, "7.1% of prompts") and what a prompt costs, a verdict in words
  (`report.js:PROFILE_VERDICTS`) that says when there will be enough data at the repository's own pace (`pace`: measured
  exchanges over the days they span against the 200-a-side floor), and what the profile holds and how its lines fared
  (`lines`, from profile.js:lineReport: the lines by how often they are used, `lineBands`: rarely (a fifth or fewer of the
  sessions shown to), sometimes, frequently (four fifths or more), as shares of the lines judged; the question is which
  parts of the profile go unused, and the per-line table in `thinker profile lines` names them). The arms' counts, the unlearned share and the intervals stay in `thinker profile holdout`, which reads the
  same `holdoutFromLog`. Over the ledger's 60 days, not the weeks, so a figure and not a weekly table. All repositories pools the arms' counts (the rates
  are ratios of the pooled counts, tokens an exchange weighted by exchanges); the cost interval is bootstrapped over a
  repository's own sessions and is not pooled, so across repositories it carries the delta and no verdict. The notes'
  "Cache hits · notes served" row went the same day: it read a series removed with the notes and showed zeros.

**A tool's output is nobody's choice (MANDATORY, 2026-11-04, the owner's call):**
- The clearing is thinker's compression and it is on by default (`src/cutting.js`, applied by `proxy.js` on every
  request, and the desktop mod beside it). It takes out the results the agent has finished with, which is where the
  cost is: 88% of what output costs a session is re-reads past the agent's last use of the result.
- So per-tool compression (`diet.js`) is offered nowhere a person can see it: no row on Find Savings (the **Tool
  outputs** view is gone), no line in the weekly question, no option in the installer's picker, no `ACTS` entry, no
  `output` change out of `partChanges`, no card out of `part-explain.js:viewParts`. It only shrank what was still
  live -- the moderate cap took 7.5% of output cost over this machine's 38 most recent sessions, and the one arm
  measured in agent sessions (a 4k cap, PostHog/Opus, 2026-10-28) saved nothing, because the agent fetches again
  what was trimmed. A row asking for that decision cost a person a decision and bought what the clearing already had.
- What stays: the measurement (`tool-outputs.js`, the Report's parts table and `totals.outputs`), the diet itself as
  `thinker context --output-compression <tools> [--level high]` for an experiment arm, `describePart({kind:'output'})`
  and the `output` branch of `undoOf`, so a decision someone made before this is still theirs to Revert.
- What set it off: on 2026-11-04 a Claude Desktop session was interrupted mid-answer with a picker reading
  "1 -- compress repeated tool output, or none?" -- the thinnest question thinker has ever put to anyone.

**Find Savings is one table, a part a row (2026-11-09, the owner's ask; `page.html:renderRows`, `wireRows`)**
- Title, type, per call, used, wasted, action: the action is a dropdown and an Apply in the row, and the `›` beside the
  title opens the one-line description (the model's sentence where `thinker explain` has written one, else
  part-describe.js's line, asked for when the row is opened and never for the rows nobody opens) and the part's text.
- Gone, since the top half of the page was not a row anyone could act on: the view tabs (All, Instruction files, Custom
  tools, Built-in tools), the Potential savings card on each, the explanatory paragraph, the cards view and its page-ahead
  explanation writing, the checkboxes and the Apply over the table, the Over N days and Share columns. The figures stay
  on the opened row and in `thinker context`; `thinker context --cards` is still the terminal's card view.
- A door's suggested rows (the installer's, the weekly question's) come first with their action picked (`preselectRows`,
  `PRETOP`, `PREACT`), where they came checked. `applyRows` still takes a list, one row long. **Wasted is dollars** (the same day): the row's wasted tokens at what an input token cost the window's sessions at list prices, `context-view.js:inputRate` (every priced session's input cost over its input tokens, the Report's own rule for a part, over the Save window; All repositories adds the dollars and the tokens), the tokens in the cell's hover and the opened row; `thinker context` prints the same column. **A row's colour is one rule on both doors** (`flagOf`, pinned together by `test/cli-ui-sync.test.js`): a part used in under 10% of the calls that carried it is red at 5,000 tokens a call or more, yellow under that, and uncoloured under 500 tokens; the command marks them `!!` and `!`. A section's title shows without anything in parentheses, and the change date left the type cell for the used-share hover.

**Find Savings: one cost rule, per prompt (2026-10-25, the owner's ask)**
- A part sits in the prompt, so it costs its size in every model call that carries it. The table's four numbers are four readings of that, each with a **?** under forty words (the owner: if it needs more, the calculation is wrong).
- **Per prompt** (`tokens`): its size, what it adds to every prompt that carries it. **Needed** (`usedShare`): of those prompts, the share the agent acted on it in. **Over N days** (`window`): per prompt × every prompt that carried it (`prompts`). **Wasted** (`wastedWindow`; `wasted` a prompt): window × (1 − needed). The savings card leads with the window figure. `perPrompt` (window ÷ every prompt of the window) stays in the data for the tab strip, the totals and `wasteLevel`, not in the table.
- Needed is by prompts, not sessions (the owner's ask the same day; until then `used / loaded` sessions, and a judge's session verdicts for sections). Each transcript tool event carries `turn`, the model call it was made in (`transcripts.js`, Claude Code and Codex). A tool or skill: the calls that called it, `harness.js:readSessionHarness` `usedCalls` and `harness-codex.js` (a typed `/skill` or `$skill` is one), summed as `usedPrompts` capped at the session's calls; Cursor one a session. A section: the calls that fired its triggers, `instruction-value.js:appliedTurns`, over the calls of the sessions that read it since its last change (`promptsSince`; `use()` takes `prompts` and `appliedPrompts`); the judge's verdicts stay as the section's value (`valueOf`), not in the share. An output: the re-reads before the agent last used it, `tool-outputs.js` `needed` = (input − unneeded) / input. `session-harness` and `session-activity` disk caches are v2 for it.
- Real calls, not a median: `prompts` on every source is the sum of its sessions' model calls; `contextView` `viewPrompts` is the window's. A section changed inside the window costs its present size in every call that read its file; the change governs what its use is measured over, nothing else.
- All repositories merges an output row by tool, setting **and** whether that setting is the repository's current one (`mergeViews`, `outKey`): a row measured under an earlier setting is a dead period, never merged with a repository where the same setting is live. Grouping on name and level alone, past only where every repository said so, made the month before `mcp:artemis` was compressed here into a live row and the machine's top output suggestion (33M, action `uncompress`) — fixed 2026-10-26.
- A live merged row's `compression` is its own level, so the action offered and the saving beside it are the same thing in every repository it covers. An output row carries no repository: the page applies one to every repository (`page.html`).
- All repositories sums `usedPrompts`, `prompts` and `window` (`mergeViews`), never weights one repository's figure by another's sessions. `context-machine.js` and `context-suggest.js` say "needed in N% of prompts"; `SUGGEST.minSaving` is 15 a prompt (500 a session before).
- A change's `total` is the row's own window figure, never recomputed (`partChanges` carries `windowSaving`: `wastedWindow`, an output's `saveModerateWindow`). Recomputing it as `saving × prompts` divided by the window's prompts and multiplied by the part's: right only for a part every prompt carries, 0.55× for Artifact here (2026-10-26). A report without the figure falls back to the old reckoning.
- The weekly message leads per prompt, the window total beside it (`contextSuggestOffer`): a week of a 25k-token file over 7,600 calls is ~190M, true and unplaceable.
- Until then every figure was tokens × the *median* calls of a session, which weighed every session alike and mixed two denominators (a section was averaged over the sessions that read its file, a tool was not).

**Pull request savings (2026-10-30)**
- **A pull request's figures are dollars, never tokens** (2026-11-08, the owner's call: "token is too ambiguous because it
  doesn't account for writes, outputs, reads, cache"). `delivery.js:sessionsOf` prices every session's calls at list
  rates by token type from the log's `session` row (`prices.js:costOf` over fresh input, cache reads, cache writes by
  TTL, output), each subagent at its own model, as `cost.spend`; null unless the counters are complete and every model
  has a price, and a pull request's `cost.spendComplete` needs every session priced, so a partial cost is never shown as
  whole. The Report's **Pull request stats** rows are Number of PRs, Saved per PR (over the PRs with a priced model) and
  Cost per PR (over the PRs whose every session is priced), in dollars under either toggle; the Recent activity list
  shows Sessions, Its cost, Saved and Share (saved over cost); `thinker report` prints the same. The token figures
  (`agent`, `cleared`, `savedPerPr`, `tokensPerPr`) stay in the view and `--json` and in `thinker prs`.
  **On the Report the saving is gross and the cost stands beside it** (the owner, the same day: "saved per PR doesn't
  need to be negative"; `savedUsd`, `savedUsdPerPr`, `meanSavedUsd`): the cost is every call at list prices, so it
  already holds the cache writes the calls after a clear paid for, and netting them out of the saving as well would
  charge them to the pull request twice. Each door names the writes as part of the cost where it shows the saving. The
  netted figure (below) stays in the data (`net`, `netPerPr`, `meanNet`), in `thinker prs` and in the posted comment,
  where no cost column stands beside it.
- View Report keeps four PR summary cards: merged with work here, tokens saved,
  share of their cost, and the average one. Both sets of cards show labels and values, without descriptions.
  The PR list lives in Recent activity under **PR savings**, beside the default **Action savings** tab.
  The report leads with **Pull request stats**, followed by **Cost by context** and **Compression effectiveness**; **By model** and **By token type** are collapsed under **See more metrics**. The page defaults to Total and displays savings as a weekly table without a graph. Weekly savings (`report-savings.js`) follow request dates and the report toggles: cache estimates subtract note context; compression dollars are gross avoided cache reads at the model's price, before cache rewrite costs. A request belongs to the last repository its session hooks named, so All repositories counts it once.
  It reads the same `/api/report` data and lists merged PRs newest first: number, title, sessions, cost,
  cleared, share, net. `thinker report` still prints both summaries and the list. (The reading-avoided column went with the knowledge notes, 2026-11-08.)
  12 rows on the page behind *Show all*, 10 in the command, which points at `thinker prs` for the rest.
- `report.js:prSavings` folds `delivery.js:deliveryReport` into the view as `prs`, so both doors read one
  computation and the page recomputes nothing on a visit. `mergePrSavings` is All repositories: counts and
  tokens add (a pull request belongs to one repository, a session to one pull request), the averages are
  taken again over every row rather than averaged into an average of averages, and each row carries its
  repository, since two repositories both number from 1.
- **The typical pull request is the average one, not the median one** (2026-11-04, the owner's call;
  `delivery.js:mean`, `summary.meanSavedPerMergedPr`, `meanTokensPerMergedPr`, `meanHoursToMerge`, carried
  to the doors as `prSavings`'s `meanSaved`/`meanAgent`/`meanHours`). On this repository's last 14 days 32
  of 77 merged pull requests had any saving at all -- the rest had no clearing and no note acted on -- so
  the median landed on a zero and every door said `0 on the median one` under a window total of 541M
  tokens. The denominator is unchanged: every pull request merged in the window that a session here worked
  on, zero-saving ones included, which is the same set the total is summed over and the same one
  `weeklyPrStats` has always averaged (`savedPerPr`, `tokensPerPr`). What the average hides is the spread --
  five pull requests were 336M of that 541M -- and the per-PR rows are where that shows.
- A row of `prSavings` carries its own `hours`, so All repositories averages the time to merge over every
  pull request. Before this it took a median of each repository's median, which weighed a repository with
  one pull request like one with fifty; `test/report.test.js` pins the three figures apart (1h on one
  repository's single pull request and 4h on each of another's two is 3h, never 2.5h).
- **Pull request stats** is a weekly table matching the other Report tables, with metrics as rows and weeks
  as columns; no graphs. It leads the Report, above **Cost by context** and **Cache/compression effectiveness**,
  and stays outside **See more metrics**. `report.js:weeklyPrStats` groups the
  recorded PR rows by merge week into `prWeekly`: PR count, mean tokens saved per PR, and mean recorded
  input + output tokens per PR. The cost mean uses only PRs with complete counters and exposes that count;
  missing counters never read as zero cost. Empty weeks have zero PRs and null averages. All repositories
  recomputes from all PR rows, never averages repository averages. The CLI prints the same weekly values.
- **The dollars are netted, and that is the figure (2026-11-04, the owner's call; `compression.js:clearingCostBySession`).**
  Tokens cannot answer "was it worth it", because the clearing's saving and the clearing's cost are not the
  same kind of token: a cleared token saved a **cache read** at a fortieth of the input price, and the calls
  after that clear wrote the prefix into the cache again at **twice** it. So one rule, in one sentence:
  **cleared at the cache-read rate, plus reading avoided at the input rate, less what the calls after a clear
  wrote into the cache again, at list prices.** `thinker prs` and the posted comment read that one computation in
  `delivery.js`; no door prices a token itself. The Report showed it too until 2026-11-08, when its PR figures became
  a cost column and a gross saving beside it (above), the writes counted once, in the cost.
  - The deduction is `isRewrite` over the proxy log, charged to a session only from its **first clear onward**:
    a rewrite before one cannot be the clear's doing. It is deliberately conservative -- the held-out side
    rewrites on 1-3% of long calls anyway, and those are charged to the clearing too.
  - The token figures stay beside it, and `measured` (cleared) is never silently added to `estimate`
    (reading avoided). What may not come back is a **gross** dollar figure: until this date the posted comment
    showed one, and priced at the input rate this machine's 202M cleared tokens read as thousands of dollars
    it never saved.
  - A loss reads as a loss. `meanNetPerMergedPr` is a **signed** mean (`delivery.js:meanSigned`): the ordinary
    `mean` filters on `n >= 0` for token counts, and it silently dropped every negative net, so a −$940
    fortnight averaged to +$0.59 a pull request. The automatic pass never posts a pull request whose net is a
    loss (`delivery-auto.js`); `thinker prs comment --pr n` still does, by hand, under a heading that says so.
  - **What it said when it was first switched on**, over this repository's own merged work: the 14 days to
    2026-11-04, mostly the API-side clearing, came to **−$940** on 75 merged pull requests, 7 of them net
    positive -- the loss `thinker proxy report` was already warning about (prefix rewrites on 15% of long
    calls after a clear against 2% held out). The window since the cut landed and the service restarted
    (#610, #612, #615) came to **+$15**, with the rewrite rate at 3% after a clear against 3% before one.
    Judge a change here the same way: cache **write** tokens, against the 15% holdout, over a window that
    starts after the change.
- `report-snapshot.js`'s code key hashes `delivery.js` and `compression.js` too, so a kept report made before
  the band is remade rather than served without it.

**The Factory: the sessions read as a pipeline (2026-11-08, the owner's direction; `src/factory.js`, the page's Factory tab, `thinker factory`)**
- Per-session and per-PR cost could not say which stage ate the tokens, what was rework, or how much work merged first
  time. The Factory answers those three: six stations (Prompts, Think, Explore, Build, Verify, Merge), the loops where
  work came back to an earlier station, and the first-pass yield of the merged pull requests. The UI came first (a
  flat line, then an isometric floor, then the pipeline canvas the owner picked from a reference design); the
  measurement over this machine's sessions came the same day, below.
- **One attribution rule, in one sentence, on both doors**: a call's tokens go to the stage of the tool it called; the
  first call after a prompt is Prompts; a call with no tool is Think. A call that made tools of two stages is split
  evenly. `transcripts.js` now returns every model call's usage (`calls`) and puts the call's index on each tool event
  (`call`) and a failure flag on a result (`error`, from `is_error`) for this. A shell command is staged by what it does
  (`bashStage`): a commit or push is Merge, a read-only program at the head of the line is Explore, a line that writes is
  Build, anything else is running something to see what happens, Verify. Verify is the agent checking the work by running
  it. Review is the work being read before it merges (below; it was left out on the first day because with no human
  reviewer it would have priced the agent's own tokens as a review).
- **The words (the owner, 2026-11-09, after "rework" read as unclear on the page and a "redo" rename was tried and
  dropped):** a **loop** is the event, work that came back to an earlier stage after something failed; **rework** is what
  it cost, the calls inside the loop, spent after the failure. Not "the same work twice": a fix loop's Build calls are
  the fix itself. Both doors define a loop in one line and tie rework to it.
- **Loops are data, found by code, never by a model** (`LOOP_KINDS`, `detectLoops`). Each kind is a detector over the
  session's events and the view carries every kind that fired, so a new detector shows on the page with no change
  there; each says the rule that finds it. A loop's cost is the cost of the calls it spans; a stage's rework is the cost
  of its calls inside any loop, counted once. The first detectors: a fix loop (a test or build program fails and later
  passes; keyed by program, since the same command rarely repeats verbatim), a correction (an interrupt marker, or the
  profile ledger's `corrected`/`redirected` on the exchange before; the loop is the exchange that redid the work), sent
  back (a commit or push after `gh pr create`, the window closing at the next branch or pull request, since a session
  here goes on to the next piece of work), a review catch (a review skill or reviewer subagent, then edits before the
  next prompt), and a re-read (a file read again twenty or more calls later). A failed query or a mistyped command is
  not a loop yet. `RULES_VERSION` is in the per-session cache key: a changed rule must read every session again, which
  the first run after a change did not and served the old loops for a round.
- **One computation, kept with the Report**: `reportView` carries `factory` (over the Report's window and sessions),
  `mergeReports` merges it (sums add, shares and verdicts are taken again, loop kinds join by key, pull request rows keep
  their repository), `report-snapshot.js` hashes `factory.js` into its code key, the page's Factory tab reads it off
  `/api/report`, and `thinker factory` prints the kept one (`--refresh` first makes it again). A stage is judged on its
  share of rework (`REWORK_THRESHOLDS`, good at or under 10%, bad at or over 35%; a first cut on this machine).
- **What this machine's last 30 days looked like on the first run** (2026-11-08, after the detectors were tightened):
  286 sessions, 35k calls, $7.3k at list; Explore 26%, Build 24%, Prompts 17% (the first call of a turn re-reads the
  whole prefix), Verify 13%, Think 11%, Merge 9%. Rework 45%: fix loops $1.4k in 112 sessions, corrections $0.9k in 92,
  sent back $0.9k in 95 (follow-up commits on an open pull request are this repository's habit), re-reads negligible.
  First-pass yield 23% of 152 measured merged pull requests; a first-pass PR cost $8, a looped one $56. The first cut of
  the sent-back detector fired in 159 of 162 sessions because a memory-file write after the pull request counted as an
  edit and the window never closed; the stage shares were the same under both, the loop figures were not. Judge a
  detector change by inspecting the loops it finds in a real session before trusting its total.
- **A stage or a loop opens on its trend (2026-11-09, the owner's ask): a small table under the card, the last four
  weeks in two rows (cost and rework share for a stage, loops and cost for a loop)**; it was a wide modal with a bar chart
  per metric for an hour, and the owner asked for the numbers in place instead. The view keeps every Report week (`factory.js:weeklyTally`, `mergeWeekly`; `weekly` on the view; `page.html:fxTrend`).
  The columns are the Report's own (`report.js:weekColumns`, Monday to Sunday, the current week last) and a session is
  placed in the week of its last request as the Report places it, so the trend and View Report agree on what a week
  holds. A stage shows cost, share of the week's tokens, rework share and calls; a loop shows loops, cost, share and the
  sessions it fired in. Sums add across sessions and repositories; a share is taken again over its week. The command
  prints the same cells as a weekly table. Nothing is recomputed on the page: the cells ride the kept report.
- **"See diff by": the Factory split by a feature's two sides (2026-11-09, the owner's ask; `factory.js:ARMS`,
  `armTally`, `armsOf`, `armRows`; the page's select and `thinker factory --diff profile|compression`).** The sessions a
  feature reached against the ones held out from it, on the same mix of work: sessions, cost per session and per exchange,
  rework share, first-pass yield, rework by stage, loops per session, each a ratio of sums per side with the difference
  coloured where a direction is better, and **how far to trust a difference is computed, not asserted** (`trust`, the
  owner's ask the same day: a "thin" pill said too little): a noise band of twice the relative standard error of the ratio
  of the two means, each side's spread read from its session costs (`cost2`), rows inside the band greyed as flat, and a
  level in words at the top (good under 20%, fair under 50%, else low; under ten sessions a side, too few to read). The
  profile's arm is the one recorded on the session's state file at its start
  (`profile.js:profileArmOf`); a session from before the profile shipped has none and is left out of that split, never
  given one by recomputing the hash, since it never saw the block. The clearing's side is `proxy.js:heldOut` over the
  session id with the service's share (`proxy-service.js:SERVICE_HOLDOUT`, half since 2026-11-09, unless the machine config says), so every
  session has one; a subagent conversation takes its parent's. A pull request counts on a side only when every session
  on it was on that side. Under ten sessions on a side the table is marked thin. On the day it was built this machine had
  5 session state files carrying a profile arm, so the profile split showed next to nothing: that is the honest state,
  and the split is where the profile's effect on rework will first show as the arms fill.
- **The clearing's split is over the sessions that reached its trigger, and says how many were actually cleared (superseded below, 2026-11-10)**
  (2026-11-09; `armsOf` takes `peak`, `treated` on the arm cell, the "Of them actually cleared" row). The first table
  read as if the clearing raised cost and rework across the board: $26 against $15 a session, 23% against 14% rework.
  It did not. Only 19 of the 249 sessions on the clearing's side had ever had a clear, because the clearing fires past
  140k of context; the 160 sessions on that side that were never cleared carried the same 23% rework, which the clearing
  cannot have caused; the held-out 42 were a lighter sample by chance (medians $10 against $8; per exchange $1.68
  against $1.68 among sessions past the trigger). Where a clear actually happened, its known cost showed and nothing
  else did: cache writes 5% of cache traffic against 2%. So an arm is an assignment and not a treatment, a side holds
  only sessions the feature could have touched, the table leads with cost per exchange (a session's length is out of
  it) and carries the cache-write share, and a difference on under ten sessions a side is marked thin. The same
  reading applies to the profile's split once its arms fill: a session shown the block is not a session that acted on it.
  The canvas carries a **totals box on its bottom right** (the owner's ask, 2026-11-09: on the chart, not in the flow;
  a Merged dock at the end of the line was tried first): the cost per merged pull request and the rework share, and in
  diff mode the two sides' figures; the loop pills and the loops table carry each side's loops per
  session in diff mode, and the comparison table has a cost-per-merged-pull-request row. A pull request counts on a side
  only when every session on it was on that side.
- **The clearing's "on" side is the sessions a clear actually happened in, since the current cut policy landed
  (2026-11-10, the owner's ask; `armsOf` takes `cleared` and `start`, `CLEARING_SINCE`; the "Of them actually cleared"
  row and `treated` went).** The split above still compared the arm, and the arm is an assignment: on 2026-11-10 the
  table read +75% cost a session and +50% rework on the clearing's side, over 177 sessions of which 19 had ever been
  cleared. Read as treatments the same day's merged pull requests were flat: the four with a clear cost $38.9 each
  against $37.8 for the 23 without, twenty cents a model call on both. So the on side is now the sessions with a clear
  (`delivery.js:clearedFor`: the proxy's log first, the mod's record where the log has no rows), the held-out side the
  hash's, and a session on the clearing's arm that was never cleared is on neither, since nothing touched it. Two
  guards, both the owner's point that a new feature must not be judged on old data: both sides need the trigger
  reached, as before, **and a session started after `CLEARING_SINCE`** (the merge of #693, 2026-11-06 19:30 UTC: the
  60k floor after #688's payback of 25, the policy the proxy and the mod run today); a session cleared under the
  API-side clearing or an earlier cut policy was a different feature, measured as a loss, and is never pooled with
  this one. Known gaps: a cold-boundary cut below the trigger is left out with the rest of the sub-trigger sessions;
  the mod's records are pruned after two days, so a desktop clear the proxy's log never saw is on the cleared side
  only while its record stands; and the current share is used for every session, which is safe only while the share
  rises (a session held out at 15% is held out at 50%). The sides are now a few sessions each at this repository's
  pace, and the table says so (`thin`); it fills from here.
- **Where the confidence is, measured the same day.** Of the cost, 17% is placed by definition (the first call of a
  turn), 19% is exact (no tool: Think), 11% is exact by tool name, 3% is split between two stages, and **51% rests on
  reading a shell command** (`bashStage`). That half is where the rules moved: the first cut staged a line by its first
  program, so `echo start && npm test` was Explore and a fix loop keyed on `node` counted an analysis script's failure
  as a test fix, with spans to 338 calls. Now a line is staged by its strongest segment (merge, then a test or build
  program, then a write, then read-only), a fix loop is keyed on the fine program (`node --test`, not `node`) and must
  close within the same or the next exchange. On the same 43 days that moved Explore 27%→16%, Verify 13%→21%, fix loops
  from 144 long ones ($958) to 463 short ones ($643), rework 38%→34%, yield 25%→18%. The loop totals are directional,
  each with a named failure mode (`redirected` in the ledger is a third moving on; sent back cannot tell a fix from new
  scope; a review catch has never fired here); a model's judgement on an exchange, if ever wanted, should ride the
  profile extraction's one call per session and be shown beside the code's verdict, never in place of it.
- **The fix-loop detector, audited against its own loops (2026-11-09; `isBoundary`, `DENIED_RE`, `SCRIPT_CRASH`;
  `transcripts.js:continuations`, `afterContinuation`).** The first cycle of improving a stage is to read the loops the
  detector finds before trusting the number, and on this machine's 37 days it was the detector that moved: of 467 fix
  loops ($647), 30 ($48) were a session Claude Code had continued in a new one -- the continuation's file carries the
  original's rows (the same message uuids, the new session id) ahead of its own, so both files reported the same calls;
  48 ($201) ran past a commit, a push or a `git worktree add` to a pass in the next piece of work, $70 of them before
  that event; and 21 counted Claude Code refusing to run the line, or the agent's own python heredoc crashing (`File
  "<stdin>"`), as a test failure. So: a `continued-in` row in the original's tail names the continuation, whose copied
  calls and events are dropped before the Factory reads it (and, the same day, before every other reader of a session's file -- the Report's usage, the harness and
  instruction readers, the Stop hook's `session` row; "A continued session is one session" under Report); a fix loop closes unresolved at a commit, a push, a new branch or `gh pr create`, unless that very
  line was the failing run (`npm test && git commit`, where the commit never ran); and a denial or a `<stdin>` crash is
  not a failure. The honest figure is about $450, 6% of spend. What the real loops are: the red/green cycle at about a
  dollar each, Verify 56% of the cost inside them -- and Verify is inside every fix loop by construction, since the loop
  starts and ends with a test run, so its verdict is partly the definition. A third of the cost edited tests alone (a
  pinned test updated after an intended change); edits here are shell heredocs, so the Edit tool is no measure of what
  a loop changed. The fresh-worktree dependency race was one loop of seven module-not-found ones. Not changed: the
  correction loop still spans its whole exchange, and the other kinds were not read the same way yet.
- **The Review stage, and the sent-back loop read the same way (2026-11-09, the owner's ask; `STAGES` `review`,
  `isReviewTool`, `timeline`'s `reviews` and `personExchanges`, the `sentback` and `followup` kinds; `RULES_VERSION` 8).**
  The sent-back loops over this machine's 37 days (153, $877) were read loop by loop: 49 of them ($10) had no change
  after `gh pr create` at all, a push of the branch the pull request was just opened from; and of the rest, the person
  had asked for the follow-up commit in 78% of the cost, in the session, on the open pull request -- seven rounds on
  the Report page's pull request alone were $217, a quarter of the whole ("highlight the grid cell", "don't show saved
  as negative", "it's stuck measuring"). Code opened with no suite run first was 7 loops, $74. So "sent back" was not
  an agent failure the suite-before-PR rule could prevent; it was the person's review, happening in the chat, and
  opening the pull request later would move that cost rather than remove it. That is the human reviewer the first cut
  said the Factory had none of, so Review is a station now: the first call after a prompt of the person's while a pull
  request is open (`gh pr create` to the next branch or pull request; a task notification is not the person,
  `session-state.js:isHarnessEvent`) is Review rather than Prompts, and so is the agent reading the change -- a review
  skill, a reviewer subagent, `gh pr view` or `gh pr diff`. A change to the open pull request is a **review round**
  (`sentback`: the person's prompt opened the exchange; one loop per round, from their prompt's call to the round's last
  push) or the agent's **own follow-up** (`followup`: the opening exchange itself, or one a harness event opened); a
  change is any Build call, so a heredoc edit counts; a push with nothing changed behind it is neither. On the same
  window: Review $540, 8% of spend, 26% of it rework; review rounds 139 loops, $642, in 56 sessions; follow-ups 64,
  $120. **A review round holds its Review call by construction** (it starts at the prompt), as a fix loop holds its
  Verify calls, so that stage's rework share is partly the definition and the figure to watch is rounds per pull
  request. "Fix merge conflicts" on an open pull request reads as a review round under this rule; it is the person
  asking, so it stays. The levers for review rounds are not the detector's: a round that repeats a preference the person
  has stated before is the profile's to prevent, and each round re-reads a long context, which is the clearing's.

**A continued session is one session (2026-11-09; `transcripts.js:continuations`, `continuedSince`, `parseTranscript`'s `since`)**
- Claude Code can continue a session in a new one: the original's last rows carry `continued-in` naming the new session,
  and the new file opens with the original's rows copied under the new id (the same message uuids and timestamps) ahead
  of its own. Every reader that took a file for a session counted the copied calls twice: on this machine 25 pairs, 9%
  of the Factory's cost, and the Report's session counts and the PR figures carried the same. `findRepoSessions` marks a
  continuation with `since`, the moment it was continued, and every reader parses it from there: `parseTranscript(file,
  { since })` makes the rows at or before it context alone -- their text is what the continuation's calls carry, so the
  parts are still right -- and no call, usage, turn, tool call, model vote or event of the continuation's own
  (`continued: { at, dropped }` on the result). `tool-outputs.js:sessionRecords` (v14), `instruction-value.js:sessionRecord`,
  `harness.js:sessionHarness` (what was loaded still counts, since it is in the context; the calls and the uses are the
  original's) and the Factory read it so, each with `since` in its cache key. The Stop hook has no list of sessions to
  mark, so it looks for the original beside the running session's file (`continuedSince`: the siblings written since this
  file was made, read at their tails, a few per turn) and logs the `session` row from `since`, so `thinker prs` and
  `thinker usage` count a continuation's own calls from the first turn after this lands; rows logged before carry the
  copy. Not done: the profile's extraction and `thinker learn` read the continuation whole, so a copied exchange can be
  observed twice; and a session continued on another machine, or whose original is gone, is read whole.

**Subagent conversations are costed at their own model (2026-11-08; `transcripts.js:subagentSessions`)**
- A Claude Code subagent (Explore, general-purpose, a fork) is a conversation of its own beside its parent's transcript
  (`<projects dir>/<slug>/<session>/subagents/agent-<id>.jsonl`, with a `.meta.json` naming its type), with its own prefix,
  its own cache and often its own model (`src/explore-agent.js` puts Explore on Sonnet). Until this landed `findSessions`
  listed the top-level files alone, so the Report never saw them: 7% of this machine's calls, and every Explore run, went
  uncounted, and there was no way to show what the Sonnet file saves.
- The Report reads them as rows of their own (`tool-outputs.js:sessionUsage` carries `parent`, `agent`, `type`): a
  subagent's calls count as prompts of the week and its tokens are priced at its own model in the models table; its
  session is never counted (one session is one session, however many subagents it ran), it is left out of `sessionRows`
  (the Decisions table measures the person's own sessions), and a subagent that reports no usage is skipped rather than
  counted unmeasured. `findSessions` itself is unchanged: the learning, instruction and harness readers take the
  sessions as before, since a subagent reads no CLAUDE.md and is distilled through its parent.
- The pull request figure has them too (2026-11-08; `transcripts.js:subagentStats`, `delivery.js:sessionsOf`). The stop
  hook's `op: session` row carries `subagents`: one entry a subagent with its type, its own model and its own counters,
  read from the transcripts beside the parent's at every turn. The parent's own counters are unchanged, so every reader
  of the row before this reads what it read. `sessionsOf` keeps the parent's figure as `ownTokens` and makes `tokens`
  the parent's plus the subagents' (`subagentTokens`; a subagent with no counter is left out, never counted as zero),
  so a pull request's agent tokens are every model call made for the work, and the `thinker prs` session line says how
  many of them were in subagents. Tokens add across models; dollars never do, and the PR figure's dollars are the
  savings alone, as before.

**Tables** (each ends on `sessionTotals`; all three sum to same figure)
1. Parts (`report.js:PARTS`): instruction files, custom tools, built-in tools, tool outputs; then **Other input** row (`otherInput`, folded, kinds via `OTHERS`); then output.
2. Models (`prices.js:providerOf`): grouped by provider; provider subtotal folds models. Each model over every prompt of week.
3. Token types (`report.js:TOKEN_TYPES`): fresh input, cache writes, cache reads, output (`transcripts.js:Stats`). Clamp cache reads/writes exceeding input.

**Toggles**
- `--share`: Values/Share (row ÷ week total, `formatShare`); whole-session total keeps value.
- `--total`: Per session/Total.
- Dollars at list prices and nothing else (2026-11-08, the owner: "only costs"). The Cost/Tokens toggle of 2026-10-26 (cost the default, `--tokens` / the page's Tokens for tokens without bounds) went that day: a token count adds fresh input, cache reads, cache writes and output as if they were one thing. The tokens stay in the view and `--json`; `--tokens` and `--cost` are accepted and change nothing.

**Colour (parts table)**
- Every row of the parts table (four parts, Other input and each kind, output, total) coloured by dollars per priced prompt vs `report.js:COST_THRESHOLDS`: green ≤ good, red ≥ bad, yellow between.
- Four parts: the old token bounds (12k/30k, 4k/15k, 22k/36k, 30k/72k) at ~$0.8/M input. Other rows set on this machine's two weeks to 2026-10-26; total = sum of the rows. First cut, one machine.
- Good/Bad columns beside each row. Verdict uses cost per priced prompt regardless of displayed cell (Total, Share).
- The token view (gone 2026-11-08) had no bounds, columns or colour (owner's call 2026-10-26: models count tokens too differently; `THRESHOLDS` removed).
- No colour in the model and token-type tables. No percentage in cell; zero cell blank.
- Command prints same columns, marks ✓ · ✗.

**Sessions without usage**
- Agents with no usage report (Cursor): excluded from all columns, named as left out. Estimated parts shown only as `estimated`.

**Calibration (`report.js:CALIBRATION`, `calibrationOf`)**
- Estimates count chars/4; scaled before overshoot check: Anthropic 1.44, OpenAI and Google 1.
- Override: `calibration: {Provider: f}` in `.thinker/config.json`. Thinking not scaled. Caption names factors.

**Cache rewrites**
- `transcripts.js:cacheRewrites` names each call's cause from per-call usage.
- Causes: first call of session/subagent; after compaction; after >1h pause; after 5–60 min pause at 5m TTL; after model change; mid-conversation, no pause.
- Stored `tool-outputs.js` (v12); in view and `--json` as `rewrites`, `rewriteTotals`. Not shown on pages or print.

**Cost (default view, only place dollars appear)**
- Per session, list rates (`prices.js:listPrice`): fresh input, cache reads, cache writes, output.
- Cache writes by TTL (`prices.js:writeCost`): 1h = 2× input, 5m = 1.25×. Split from `Stats` `cacheWrite1hTokens` (v13).
- Anthropic: `model-usage.js:relativeRate` at Opus 5.5 input price. OpenAI/Google: `PRICED_ON`.
- `prices` in `.thinker/config.json` adds/overrides.
- Part cost = its share of session input cost.
- Labelled list price (metered key), not subscription.
- Unpriced model: left out of average, named, never zero.

**Decisions (not on Report)**
- Shown on Recent activity and `thinker context --history`. Columns Before, After, Saved (`report.js:actionEffect`, `itemCost`; `report-snapshot.js:historyEffects`).
- Window (`effectSpan`): until revert; merged PR from merge; until later decision on same thing.
- Costs per prompt, each side = sum over sessions ÷ their prompts:
  - Section: `context-suggest.js:sectionTokens` (0 after removal), sessions reading file.
  - Skill, MCP, plugin, built-in tool: per call in sessions loading it (`harness.js` `loaded`).
  - Tool output: `tool-outputs.js:sessionUsage` `by`; compressed key carries level.
- Saved: positive = saving, negative = cost. Share of `whole.before`. Cell shading green/red (`page.html` `shadeOf`); never coloured text.
- Caption row: prompt average (`report.js:promptAverage`, `promptAverageHere`; merged for All). `--history` prints same line first.
- No text under table; hovers explain. PR column links PR.
- `sessionRows` per measured session; not sent to page.
- Rows lent only from report this code made (`report-snapshot.js:keptRows`). Otherwise `/api/activity` returns `measuring: true`, starts background refresh; page checks every 5 s (`page.html:activityCheckBack`). `thinker context --history` says run `thinker report --refresh`.
- All repos = `mergeReports`.
- Output compression: `report.js:outputComparison`; tool row vs prior row (`tool-outputs.js:aggregateOutputs`). Saving green first, cost red. Same two lines under action in `thinker report`.

**Performance and kept report**
- Page never recomputes on visit.
- Kept report: `.thinker/state/report.json`, all windows under `views`. One per repo, shared by worktrees. **One slot per
  code** (`byCode`, 2026-11-09): three page servers on one machine, each from its own checkout, each took the others'
  write for a stale report, read every session again and wrote its own, without end (the owner: "we keep looping to
  process the sessions"). A reader takes its own code's slot first; `views` stays the newest write for older readers;
  four codes at most, a week at most. A fresh checkout still reads every session once.
- `thinker report` and `--refresh` write it. Page starts `thinker report --refresh --all` in background when older than `REFRESH_MS` (10 min) or made by other code; shows "measured n min ago, updating…".
- Decisions under tables read live (`report.js:reportActions`).
- Save page: outgrown kept report shown at once, remade behind (`context-snapshot.js:lastSnapshot`). Transcripts read on visit only if no kept report or action dropped it.
- Background refreshes run one at a time (`ui/server.js:serialSpawner`).
- `usage.js:parse` caches machine log per process (size, mtime). `transcripts.js:sessionModel` cached in `disk-cache.js`.
- **A kept view is brought up to date, not made again** (2026-11-08; `ui/scans.js` passes `since`, `scan-worker.js`
  acts on it). A view this code made (`mine` on `context-snapshot.js:lastSnapshot` and `report-snapshot.js:readReport`)
  that is older than REFRESH_MS is checked, not re-read: the worker stats the window's sessions and, for the Report, the
  machine's log and the proxy's; nothing moved answers `unchanged`, with no strip and no read for another REFRESH_MS;
  something moved reads every session in one pass (the unchanged ones are the readers' cache hits) and the strip counts
  the changed sessions alone ("N of M changed sessions"; "Updating the figures from the log…" when only a log moved). The
  doubling batches stay for a cold read, where nothing is on the screen yet. Until then every visit past ten minutes read
  every session of the window in doubling batches and the strip counted cache hits as sessions read, which is what made
  the page look as if it cached nothing (the owner, 2026-11-08); the sessions themselves were cached all along
  (`session-activity`, `session-harness`, `tool-outputs.json`).
- **A refresh over a repository where nothing moved keeps the view it has** (2026-11-10, the owner: the page "still
  seems like it needs to always re-read all files"; `src/view-sources.js`). The rule above brought the page's own worker
  up to date, but the background commands the page starts (`thinker context --refresh`, `thinker report --refresh
  --all`) still worked every view out from scratch every ten minutes, in every repository the page lists: 15.5 s of CPU
  over nineteen repositories here, almost all of it adding up per-session records that had not changed. A snapshot now
  carries `stamp`, a hash of its sources, and a refresh that finds the same stamp writes the view back under a new `at`
  without reading one record (`refreshSnapshots` answers `kept`, `refreshReport` `{ kept: weeks }`, the worker's
  `unchanged` re-stamps on disk so the page stops asking and starts nothing). Over nineteen repositories with nothing
  moved: 15.5 s → 1.45 s; a full rebuild of all nineteen: 15.5 s → 5.7 s (the memoizing below).
  - **The stamp is of this repository's slice, never a shared file's mtime.** The machine's log and the proxy's are one
    file for every repository and are appended to all day; stamped by size and mtime (the first cut of the change) every
    repository rebuilt every time, exactly as before. So: the window's sessions by file, mtime, size and `since`; this
    repository's own events in the machine's log (count and last `t`); its delivery journal; and for the Report the proxy
    rows and desktop clear records **of the window's sessions alone**.
  - What the stamp does not watch is another repository's log events, which only ever decide whether a session counts as
    this repository's. `MAX_KEEP_MS` (6 h) is the backstop: a view older than that is made again whatever the stamp says,
    so a gap is wrong for hours at most and never for ever. The code key and `inputs` checks are unchanged and still come
    first; a view written before the stamp existed is made again once.
- **One parse a process for the shared logs** (2026-11-10, the same change): `compression.js:compressionRecords` keeps the
  proxy log's parsed tail by size and mtime (the Report reads it three times a repository: 8 MB parsed fifty times over
  a `--all` run, 2.3 s here), `usage.js:logEvents` keeps the events each reader asks for beside the parse rather than
  re-mapping, filtering and sorting 35,000 of them on all five calls a report makes (3 s), and
  `providers.js:registryPrices` stats `providers.json` at most once a second instead of once per priced row (18,640
  stats, 0.42 s, for one repository's Report). One repository's Report: 1.9 s → 1.25 s. The events and rows are read,
  never written, so every caller shares one array; `logEvents` keeps the last four slices asked for, since a copy of the
  log is tens of megabytes and a `--all` run asks for two a repository.
- The Save snapshot is keyed on the settings fields the view reads (`context-snapshot.js:settingsKey`: the denies, the
  disabled servers, the plugins, the skill overrides), not the files' bytes: Claude Code and `rewire` write other fields
  of `~/.claude/settings.json`, and every release dropped every repository's snapshot. `writeSnapshot` prunes the
  `context-view-*` files of windows the tab no longer offers and the per-worktree files of before 2026-10-24
  (`pruneSnapshots`; eleven of them, half a megabyte each, sat in this repository's state for a month).
- Instruction sections read transcript once (`instruction-value.js:sessionRecord`), kept in `disk-cache.js` as `session-activity` (no output).
- Re-read only if transcript grew or sections name new code (`coversCode`).

**Tool switches across repositories (2026-10-30, the owner's request)**
- Approving a tool switch from Find Savings or `thinker context --approve` uses machine settings, with
  one shared action and undo in `THINKER_HOME/state/machine-actions` (`scoped-state.js`). Skills and
  instruction sections retain their existing scopes. The page submits one request per tool.
- Claude Code uses user-level permission denies for built-in tools and MCP server tools. Codex uses
  user config, with existing project enable overrides covered by the same undo; a project-only MCP
  server needs its valid transport carried into the disabled user entry. Undo keeps a fingerprint,
  never its credentials, and refuses to discard a server entry changed since the switch.
- Recent activity shows a shared action once and measures it over the selected repositories' sessions.
  Old repository-specific actions remain history. Revert is available from any repository.

**Page updates (`page.html:swapBody`)**
- Refreshes keep shown table on screen, swap in new one. Keep scroll, See more rows (`data-dk`), dropdown picks. Body keeps height.
- Save header shows `updating…` in `#c-asof` (fixed-height line).
- After Apply: show change at once (`patchContext`), re-read decisions, then report.
- Overtaken loads render nothing. In-place refresh error = toast, table stays.
- Spinner only on first read of tab and on repo/window change.
- While session data is read, a strip along the bottom of the window (`page.html:scanProgress`; 2026-11-07, the owner's ask; moved from under the header to the bottom on 2026-11-09, the owner's ask: fixed to the viewport, outside the nav since its backdrop-filter would hold a fixed child): the sessions read of those found, the share done, what is left and a bar along its lower edge, on every tab including Recent activity (`/api/activity` carries `scan`). It is absolutely positioned off the sticky nav's bottom edge, so it overlays the page and moves nothing below it when it comes and goes; the first cut was a near-black band above the brand, which shoved the whole page down (the owner: bad). Before either it was a 4px grey line under the tabs. The count moves inside a batch: the worker's checkpoints double (1, 2, 4 … total), so the last one read half of every session with the count frozen at the previous power of two; now each of the view's three readers (`instruction-value.js`, `harness.js`, `tool-outputs.js`) calls `onSession` per session and `scan-worker.js:progressOf` counts a new session as read once all `READERS` have passed it, posted at most every 200 ms with no view, and `scans.js` bumps no revision for it, so the stamp moves and no table is fetched.
- `loadContext`, `loadActivity`, `loadReport` must not wipe body to "Reading…".

**Section change is a pull request**
- Every door, not only the page (2026-10-29): `context-suggest.js:approveChanges` sends a section (`compress`/`remove`) to `startSectionJob` and makes nothing itself but a switch-off or a compression level. So the weekly suggestion answered in the session (the MCP `context` tool), `thinker context --approve` and the installer's multi-select all record the decision at once, start the detached `thinker instructions … --job`, and open a PR. Until then only the page did: the other three ran `previewEdit`/`applyEdit` inline, holding the person's turn through the model call — in a desktop app that call queues for a subagent of the session blocked on it — and wrote the file uncommitted with no PR, no Retry and nothing in Recent activity.
- Diff opens in modal (`page.html:previewSections`, `openEditModal`). Button:
  - commits to new branch from default branch via temporary index (checkout untouched);
  - pushes;
  - opens PR with `gh` (`instruction-pr.js:openEditPr`).
- `prAvailable` decides (no GitHub origin, no `gh`, not logged in). If not, page offers working-tree write with reason.
- Preview from base branch text (`instruction-pr.js:baseTexts`; `runSectionJob`, `thinker instructions --pr`). Parent = commit preview read from. Checkout branch, uncommitted edits, distance behind origin do not matter.
- Preview keeps old/new (`instruction-edit.js:previewEdit`, `edits`). Applied to base file where differs (`textOnBase`); refused if section not found. `textOnBase` ignores blank-line differences.
- History records `pull request` with `pr` {number, url, branch, state} (`context-suggest.js:applyReviewed`).
- PR state refreshed on each `/api/activity` read and `thinker context --history` (`refreshPrStates`, ≤1/min).
- States:
  - **PR pending**: open; row pill linked, not pickable.
  - **Merged**.
  - **Rejected**: closed unmerged; re-suggested (`currentChanges`).
  - **Unpulled** (`changeHistory`): merged, not in checkout. Test: merge commit (`pr.mergeCommit`) not ancestor of `HEAD`; without commit, removed section still in file. No row on page. Recent activity shows yellow pull banner (`pullFrom`: PR base, else `instruction-pr.js:defaultBranch`), tints waiting decisions. `thinker context --history` prints same. Cleared when `pr.pulledAt` kept.
- **Close PR** = revert (`revertDecision`, `instruction-pr.js:closePr`): comment, close, delete branch.
- Command: `thinker instructions --compress <id> --pr`.

**Background job**
- Apply records decision at once: shared `group`, `job: {state: running, pid, startedAt}` (`context-suggest.js:startSectionJob`, `/api/changes/start`).
- Detached: `thinker instructions --compress|--remove <ids> --pr --job <group>`. Uses `--apply` where no PR (`instruction-pr.js:prAvailable`).
- Page toast says where to follow.
- `runSectionJob`: preview, then PR (recorded on every group entry, pending until merged) or working tree (files kept under group for Revert). Failure: `job.state: failed` plus reason.
- Running job with dead process, or no record after 2 min: failed on next history read (`changeHistory`, `jobDied`).
- Failed job decided nothing: re-suggested.
- **Retry** (`retryJob`, `/api/changes/retry`, `thinker context --retry <n>`) reruns over every section of change.
- Diff: in PR, or `git diff`.
- Save rows: under way shows *Compressing…*, not pickable; failed shows so, pickable.
- Save's History view removed. Decisions on third tab **Recent activity** (`#tab-activity`, `/api/activity`: history only, one repo or all; `thinker context --history` same states).
  - Top card: what needs the person.
  - Rows: Retry, Close PR, or Revert.
  - Tab badge counts incomplete items across repos (`changeHistory` `attention`: job running/failed, PR open).
  - Polls every 30 s, every 5 s while job runs (`page.html:pollActivity`).
- Report's decisions table uses `historyFigure`.
- Row kind line: `Built-in tool`, `Custom tool · MCP server`, `Custom tool · skill`, or output by tool. Second line: what it does (`part-describe.js`).
- Stored as `what`, `about` (`changeHistory` derives for older entries). `--history` prints after title.
- No See more or detail row. Pill hover explains outcome; decided cell hover shows time, action, worth.

**Changed sections are new sections**
- Sections carry last change date (`instruction-value.js:sectionAges`, `git blame -w`; uncommitted = file write time; cached by text and HEAD; `changedAtOf` = newest line, blanks ignored).
- Section changed in window (`recent`) measured only over sessions since change (`applied`, judge verdicts). Under `RARE.minSessions` → unknown: no pill, not suggested.
- Cost: present size × share of sessions reading file; over window, only sessions since change (`sessionsSince`, Over N days, savings `window`).
- Row says `changed <date>` and sessions measured. `thinker context` prints same.
- Hand edits count: a line fixed resets measurement.
- Failed change: row keeps waste pill and actions; Recent activity shows failure and Retry.

## Error reports, with consent (2026-10-29, the owner's ask)

thinker swallows its own failures by design: a hook must never fail a tool call, so each is wrapped in a bare
`catch {}`, and a command that dies prints a stack to a terminal nobody reads again. A fault that hits many
machines is therefore invisible: the Codex 404 of 2026-10-24 ran four days on the owner's own machine, and the
installer leaving a shell with no working directory was found by reading a container log.

`error-report.js` records those failures locally, asks once whether to send them, and sends nothing until the
person says yes.

- **What a record is.** `{at, op, version, node, platform, name, code, message, frames}`. `recordError` is called
  from the catch sites that used to swallow (`hook.pre`, `hook.proxy`, and `cli.<command>` from `main().catch`);
  it never throws, writes one line, and does nothing at all in test mode (`THINKER_ERRORS_TEST` forces it on
  for the tests). The same failure again counts up (`seen`) instead of filling the file; at most `ERRORS.keep`
  (20) records, `keepDays` (14).
- **What it may not carry** (`scrub`, and `test/error-report.test.js` is mostly about this): thinker's own
  install path becomes `<thinker>` and the repository `<repo>`, the home directory `~`, a credential `<token>`,
  a URL `<url>`, and any absolute path left keeps its last two segments. So `proxy-service.js:ensureProxy` stays
  readable — that is the whole value of the record — and the person, their employer's repository and their
  gateway do not appear.
- **The question** is the second owner-approved exception to "one suggestion, not three", and the same shape as
  the first: asked once per machine, after the proxy repair in the hook's one-question chain, through the agent's
  own question tool, answered through thinker's `errors` MCP tool or `thinker errors --answer yes|no|never`. It is
  asked only where there is something to send, and never where telemetry is off — one switch covers both. No
  answer sends nothing: there is no reminder and no default yes.
- **`thinker errors`** prints the records exactly as they would be sent, which is the only honest way to ask for
  consent: a person can read what would leave their machine before agreeing. `--send` sends now, `--json` is the
  data, `--answer` records a decision.
- **The endpoint** is `/errors` on the metrics API (`infra/metrics/errors.mjs`, `handler.mjs`), one row per error
  in `error_reports` so one fault can be counted across installs. It refuses a payload that still looks like a
  path, a URL or a credential (`LOOKS_PRIVATE`, `LOOKS_LIKE_URL`, `LOOKS_LIKE_TOKEN`), so a client with a
  scrubbing bug cannot store one either. The API was made with quick-create, so `$default` already routes the
  new path; the table and the `GRANT` need a deploy (`infra/metrics/README.md`).

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
