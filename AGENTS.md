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
- `src/ui/` is a second door to the same commands, never a second implementation.
- Page defaults must use the constants the command reads: `DEFAULT_DISTILL_MODEL` (`src/llm.js`), `buildAgent` (`src/setup/agents.js`).
- Page reports must match command output: `thinker context` and Save tab; `thinker context --machine` and All repositories; `thinker report` and Report tab.
- Page actions run the CLI with the flags a person would type.
- Any new default or flag: add a line to `test/cli-ui-sync.test.js`.

**The proxy and the desktop door hold one clearing policy (MANDATORY, 2026-11-02):**
- `src/proxy.js` and `src/integrations/claude-clear` are two implementations of the clearing, never two
  policies. The proxy asks the API to clear; the mod rewrites the conversation inside the session, because a
  desktop session never reaches the proxy. Mechanism differs, policy does not.
- Every key of `PROXY_DEFAULTS` must be honoured by the mod, or exempted with a written reason, in
  `DESKTOP_POLICY` (`test/claude-clear.test.js`). The suite fails on a new key until one of the two is done,
  and a changed default fails it until the mod's mirrored constant moves too. Editing `src/proxy.js` selects
  that test, so `npm test` is enough.
- Why it is a rule: PR #588 turned `clearDeep` on in `proxy.js` alone and the suite stayed green, because the
  test pinned four constants by hand and knew nothing of a fifth key. Desktop sessions kept a policy the
  replay had measured as a loss for a release, found only by reading the two files side by side (#590).
- What the guard cannot check is that the two behave alike: it pins the policy surface, not the mechanism.
  The mod's behaviour is `claude plugin test src/integrations/claude-clear`, and a policy change is judged on
  both doors the same way -- by cache writes, against the 15% holdout, never by a replay alone.

**Codex and Claude share the cut policy (MANDATORY, 2026-11-04):**
- `src/proxy-responses.js` adapts Responses tool outputs to `src/cutting.js:decideCut`, the same decision used by Claude's Messages proxy. Never rederive a new cut set on each Codex request.
- Both paths reserve every turn-boundary decision, including a refusal, and persist the cut ids through the shared store. Within a turn, keep applying that exact set; a proxy restart must not restore old results or add new cuts. Protocol-specific serialization and token calibration may differ, policy does not.
- `test/proxy-responses.test.js` checks candidate parity, payback/threshold decisions, within-turn stability, one-cut mode, and HTTP restart behavior. Missing session identity passes through: no session means no reliable ratchet.
- The historical Django/Astra visualization used the earlier per-request policy (24 new cut events, 19 mid-turn); it is not evidence for this correction. Savings under the shared policy require a new matched Artemis experiment.

**Pull requests (MANDATORY):**
- Thinker contributor workflow only. Setup must not install a repo policy guard or require PRs in user repos.
- Push task branches, open a GitHub PR to `main`. Never push `main`, including fast-forward.
- Never bypass the pre-push guard or disable hooks to push `main`.
- `tests` workflow is disabled; don't wait for it. Run `npm test` locally, state the result in the PR, merge via GitHub, then update local `main` from the merged remote.
- Until GitHub enforcement is enabled (needs Pro; API 403), the local guard and this policy are the enforcement.

**A fresh worktree needs its dependencies before the suite means anything:**
- A worktree has no `node_modules` of its own. The first `npm test` there can race whatever puts them in place and fail about 9 spawn-based tests with `ERR_MODULE_NOT_FOUND` on a real dependency (`smol-toml`, imported by `proxy-codex.js`), then pass on every later run. Seen twice on 2026-10-28, in two worktrees, with `node_modules/.package-lock.json` written in the middle of the failing run.
- Run `npm ci` in a new worktree before the suite, and treat a first run with those failures as nothing. What installed them is not confirmed; if it turns out to be a prompt hook, that breaks the rule that hooks do no installs or side work (2026-10-22), and is worth chasing.

**Test selection:**
- `npm test` runs test files reached by the change vs `origin/main` (commits since merge base, working tree, untracked).
- Changed code no test reaches is named on stderr.
- Full suite runs when `package.json`, lockfile, `scripts/test.sh` or `scripts/select-tests.mjs` changes (version-only bump excluded), when nothing changed, or with `npm test -- --all`.
- `npm test -- test/rank.test.js`: run named files as given.
- `TEST_BASE=HEAD npm test`: select against working tree only.
- `scripts/select-tests.mjs --why`: show which file selected each test.
- Use `--all` for test-runner changes or wrong selection.
- Requires Node 20+. `npm test` runs `scripts/test.sh` (`node --test`, `THINKER_TEST=1`).

**Desktop apps (MANDATORY):**
- Every model-backed feature must work in Claude Desktop, Codex app, Cursor, and anywhere no agent CLI is signed in.
- Those sessions have no CLI login: model calls queue in `.thinker/state`; a background subagent answers via `learn_next` (`session-work.js`, `session-llm.js`).
- A queued job gets `session-work.js:MAX_ATTEMPTS` (5) tries and is then given up on, dropped, and
  named once at the end of a turn (`maintain.js:reportGaveUp`). It used to retry for ever on a
  24-hour backoff with nothing said: one job on a user's machine reached ten attempts, and the only
  trace was a line in `state/session-work.log`. The work is not lost — the next session's hook queues
  the distillation again, `thinker learn` runs the catch-up by hand.
- "Sign in a CLI" alone does not finish a feature.
- Tests cover the desktop path (`appFn`, missing CLI login) beside the CLI path.

**Serving and policy changes need an experiment (MANDATORY):**
- A change to what a session is shown (the profile's sections, floors, budget or cadence) or to the clearing's policy ships off by default behind a config switch, or is judged by its own holdout.
- Enable by default only after a measurement: the profile by its per-session holdout (`thinker profile holdout`), the clearing by cache writes against the proxy's 15% holdout. Offline replays are not evidence on their own.
- Default-on switch = its own PR citing the measurement.
- Owner-approved exception (2026-11-08): the session profile is on by default without an Artemis experiment; its per-session holdout is the measurement, and Artemis task benchmarks do not fit a per-person profile.
- Owner-approved exception (2026-11-01, `devin-compaction.js`): Devin's own compaction threshold is written into its user config (`agent.compaction_threshold_tokens`) at `DEVIN_COMPACT_AT`, the proxy's trigger (140k), **on by default** with no experiment. Devin has no model endpoint, so its compactor is the only context reduction it can have; `devin: { compactAt: 0 }` (`THINKER_DEVIN_COMPACT_AT=off`) turns it off and restores what was there. Proven live at 140k: six turns of heavy reads peaked at 143k and fell to ~100k at each applied compaction, where the same workload without the key climbed to 297k (`docs/agent-integrations.md`). Savings claims still need an experiment: judge by summary calls and cache rewrites, not tokens removed.
- Owner-approved exception (2026-10-25): Codex proxy tool-output clearing is on by default via install/connect/setup/update. `proxy-codex.js` wires a managed provider without reading credentials. `/codex` routes ChatGPT-account requests to the ChatGPT backend, API-key requests to OpenAI. Custom providers stay as configured. `thinker proxy off` restores prior selection. Savings claims still need an Artemis experiment.

**The proxy never takes over someone else's route (MANDATORY, 2026-10-28):**
- Many people run Claude Code against a model server of their own (smart routing to models) through `ANTHROPIC_BASE_URL` and a token minted for it. The proxy forwards to `api.anthropic.com`, so writing its URL into such a harness sends that token to Anthropic and every model call fails ("invalid bearer token"). That happened; it must not happen again.
- Before writing, every place Claude Code can take a route from is read (`proxy-route.js:routeEvidence`): the settings' `env` block, the process environment, `~/.claude/settings.local.json`, the enterprise policy file, a project's `.claude/settings*.json`, and the shell startup files (a line naming a route variable counts, wrapper or alias included). Any route that is not thinker's own leaves Claude Code exactly as it is, with the reason named. The settings `env` block is applied over the shell's variables, so the shell case is the one that breaks; and once thinker has written its URL, a hook's own environment can no longer see the person's.
- **Anthropic's own host is not a route** (2026-11-01, `proxy-route.js:isAnthropicHost`): the Claude desktop app sets `ANTHROPIC_BASE_URL=https://api.anthropic.com` itself in the environment of every local session it starts (code.claude.com/docs/en/desktop: "Desktop sets those variables itself"). On 2026-11-01 the prompt hook inside one such session took that for a model server of the person's own, stood the whole machine's service down (`proxy-standdown`, "ANTHROPIC_BASE_URL is https://api.anthropic.com in your environment"), and the repair question in `proxy-offer.js` then offered `--gateway` "in front of" api.anthropic.com; a yes stored it as the upstream and `thinker proxy status` called it "a model server of your own". Exactly `api.anthropic.com` (http or https, trailing slash or `/v1`, no port, no subdomain) is now no evidence in `envRoute`, `shellRoute`, `claudeBlocker` and `routeAppeared`, never what `ownGateway` finds, and `proxyThrough`/`enableProxyService` read it as no upstream, so a state left by that yes is dropped on the next `thinker proxy on`. A desktop session goes straight to the API regardless, bypassing the proxy (checked the same day: the session's id has no rows in the proxy log), so there was never anything there to protect.
- Taking the URL out by hand is an answer (`proxy-service.js:removedByHand`): the next prompt hook stands the service down instead of writing it back, which `thinker update`'s rewire used to do the next day.
- A route that turns up after the wiring stands the service down at the next prompt, before a call fails (`routeAppeared`). A service enabled before the record existed takes what the settings hold now as its baseline, and an absence nothing explains as a removal (`trackClaude`).
- A stand-down (`standDown`) takes the URL out of every agent's file, removes the service entry, and keeps the reason. `thinker proxy on` is the only thing that turns it back on: an install, `connect` and a rewire leave it off.
- The proxy stands itself down when a request carries credentials that cannot be Anthropic's, or when the API refuses them `AUTH_REFUSALS` times running (`proxy.js:authWatch`), judged only where it forwards to `api.anthropic.com`. It forwards the request as it is either way; the API's own answer reaches the agent.
- The proxy is break-even at list prices, so when in doubt it steps aside. Never trade a person's working harness for it.
- **It can sit in front of a route of the person's own, only when they ask** (2026-10-28, the owner's call): `thinker proxy on --gateway` (and a yes to the question in `proxy-offer.js`) finds the model server this machine routes Claude Code through (`proxy-route.js:ownGateway`) and forwards there instead of `api.anthropic.com` (`proxyThrough`, kept in the service's own state; `proxy: { upstream }` in the machine config still wins). Without that, the proxy never puts itself in front of a gateway. A route it forwards to is not a blocker (`isOwnRoute`): every request still ends up where it did, with the same credentials, plus the edit.
- A gateway need not speak the API's context-management beta. On a 400 to a request carrying the edit, with an upstream that is not Anthropic's, the proxy reads the refusal before anything reaches the agent (`refusesEdit`, at most `REFUSAL_BODY`): a refusal that names the field or the beta header means the same request goes again as the agent wrote it and the edit is dropped for the rest of the proxy's life (`editRejected`, logged `proxy-edit-rejected`, rows then read `edit-unsupported`); any other 400 is passed on exactly as it came, once, and the edit is still added to the next request. Taking every 400 for a refusal switched the clearing off over an unrelated error and sent the failing request twice (LiteLLM 1.106.5 over a model name it did not know, 2026-10-28).
- Whether the answer spoke about the edit at all is recorded on the row (`editAcknowledged`), since a gateway that strips the field looks exactly like a request whose trigger was never met. Nothing is claimed from it yet: whether a conforming API always echoes `applied_edits` when it clears nothing is unverified.
- The refusal count judges the model calls alone (`MESSAGES_PATH`): an agent sends more than those through the proxy, and a 200 on one of the others reset the count, so three refusals in a row never arrived.

**What the clearing saved is shown, three turns on (2026-10-29):**
- The proxy cleared and nothing said so. The cleared set is cumulative within a conversation, so adding up what each
  prompt was shorter by over a session is the whole of the saving: **the tokens left out of each prompt since the
  clear, added up**. Measured, not modelled, and gross like the cache-hit card's -- a clear also writes the prompt
  cache again, which `thinker proxy replay` prices.
- **The figure is the cut's own** (2026-11-05; `proxy.js:applyCut` returns `tokens`, `clearedBy` puts it on the row).
  It used to be the API's: the API-side edit answered every cleared request with `cleared_input_tokens`, and every
  door read `cleared` off the row from there. The cut asks the API for nothing, so from 2026-11-04 `usageTap`
  returned `cleared: 0` on every request while the field the cut filled instead (`clientCut`) was read by nobody
  outside `proxy.js` -- and `applyCut` did not even return the `tokens`, `inputChars` and `thinking` that row named.
  So **every saving the cut made went unrecorded for a day**: no session record was written after 2026-11-04 04:01,
  and the `proxy-cut` rows after it account for 666,516 tokens this machine took out that reached no card, no
  `thinker proxy report` and no pull request. Both sides of the ledger gate on `cleared > 0`
  (`clearedBySession`, `clearingCostBySession`), so a cut session was not reading as a loss -- it was reading as
  nothing at all. Only a request the cut actually shortened carries the fields, and the figure is tied to the
  characters it replaced, so a result left in place for being under `CUT_MIN_CHARS` is never claimed as a saving
  (`test/proxy.test.js`, the two savings tests; the first fails against the code it replaced).
- Written per session beside the log (`<THINKER_HOME>/state/compression/<session>.json`, `compression.js:noteCompression`
  from `startProxy`'s `log`), because the log is a megabyte within a week and no card may read it on a turn.
- Not at the clear: the first cleared call saves nothing anybody would notice, since the saving is every *later* call
  that reads the shorter prefix, and a card then would show the rewrite and none of the return. `TURNS_AFTER` is 3,
  counted in the person's turns (`markCompressionTurn` for the hooks, the mod's own counter inside Claude Code).
- Four doors, one sentence (`compressionHeader`): the Claude Code card mod, the Codex desktop card's second section,
  the Stop hook's line where no mod runs (`usage.js:compressionNotice`), and `thinker proxy report`.
  `test/claude-card.test.js` holds the mod's copy of the sentence, the wait and the breakdown to `compression.js`.
- **The detail is in the prompt, not behind a link** (`compressionBlock`, a `<thinker-compression>` block from the
  prompt hook; the owner's call, 2026-10-29): the figure's first question is what was cleared, so the agent is told
  the session's saving, the actions whose results are out of the prompt now by tool, and the last eight clears, and
  told to read a file again rather than rely on remembering it. Once a session (`told`), the turn it comes due: a
  block whose figures changed every turn would rewrite the prompt cache the clearing exists to spare.
- `clearedActions` (`proxy.js`) names those actions from the request the proxy is already scanning -- every tool use
  but the newest `keep`, its result at `TOKENS_PER_CHAR` -- because the API reports how much and how many it
  cleared, never which. `saved` sums across requests, `tools` never does: each request clears the same cumulative
  set, so summing counts one call many times; it is the latest prompt's set. `CARD_TOOLS`/`shortTool` keep an MCP
  tool's long name from pushing a card's line off the screen.

**The desktop door of the clearing (2026-11-01, `src/integrations/claude-clear`):**
- The Claude desktop app sets `ANTHROPIC_BASE_URL` itself and Claude Code ignores the settings' value when the variable
  is already set (its docs say so), so a desktop session never reaches the proxy: checked live that day, zero rows in the
  proxy log for a desktop session. A settings hook cannot help either: PreCompact only blocks, and no hook reaches the
  request. Claude Code 2.1.316 itself carries a flag-gated server-side clearing ("tool result clearing after idle",
  `tengu_jiggly_blossom`, off by default, no setting), which will overlap this when it rolls out.
- So the clearing runs as a mod inside the session, wired beside the card in `CLAUDE_CODE_PLUGIN_DIRS`
  (`claude-card.js:claudeClearDir`; `thinker connect` writes it, uninstall takes it out). At the end of a turn it reads
  the context (`$.session.usage()`) and past the proxy's trigger queues the engine's own `/compact` from a timer; its
  `session.compact` hook answers that compaction itself with the old tool results replaced in place by a placeholder,
  and, as the proxy does, the call text emptied and the earlier thinking dropped from the turns before the newest (a
  rebuilt assistant row sheds its thinking with its handle); no summary written, the newest turn never touched. The
  timer is not a flourish: to the engine
  a desktop session is headless, where `$.session.compact()` is refused and compaction runs only as a `/compact` turn,
  and nothing may start one from the hook holding the turn. Tested live in Claude Desktop on 2026-11-01 (Claude Code
  2.1.309 bundled with the app): 3 results, 106k chars cleared, the next Opus 5.5 call answered with its thinking, no
  400; the model saw the placeholders and said so. The deep clear the same evening: 40 assistant rows rebuilt without
  thinking and with empty arguments, 6 results and 62k tokens cleared, the next call answered with thinking of its
  own, no 400, a 129.5k cache write for the rewrite. The API lets a previous turn's thinking go; the October
  breakage was an in-place edit of the history with no compaction boundary.
- **The folder a session loads is never one an update replaces** (2026-11-06; `claude-card.js:installClaudeMods`,
  `modDir`). Claude Code watches a mod's files and reloads it in every open session when they move, printing
  "plugin.json changed -- reloaded" under the answer and running `session.start` again; it keys on the file event,
  not the bytes. Every update renames a new tree over `~/.thinker/app`, where both mods lived, so every release
  reloaded both mods in every open session -- three times in one session in a day, twice for a manifest whose bytes
  had not changed. Reproduced live in tmux: a swap of the folder with identical bytes printed the line a second
  later. So on an installed app `connect` and `rewire` copy each mod to `<THINKER_HOME>/plugins/<name>-<8 hex of
  its files>`, renamed into place whole, and the settings name that folder. The same bytes give the same folder and
  nothing is written, so a release that leaves a mod alone is silent; a changed mod gets a new folder and the
  settings are repointed, which a session reads at its start, so an open session keeps what it loaded and gets the
  new mod when next started, as it gets a changed hook. Folders no setting names go after `PRUNE_DAYS` (14). A git
  checkout keeps naming its own source, so editing a mod there still reloads it live. Claude Code's own files in
  the folder (`.claude-plugin/types`, `tsconfig.json`) are neither copied nor counted. `thinker uninstall --user`
  removes the copies. The first rewire after this lands repoints the settings away from the app folder; the open
  sessions of that day still watch the app and are reloaded one last time by the next update.
- Same policy as the proxy (`PROXY_DEFAULTS`: trigger 140k, clear at least 60k, keep the newest turn and 3 results,
  the service's 15% holdout; `test/claude-clear.test.js` holds them together), read from the same `proxy` block of the
  machine config; `proxy: { desktop: false }` keeps the automatic clearing off, `/thinker-clear` runs one by hand. The
  first desktop session on a machine is told once, in a toast, that the clearing reaches it now (`INTRO`; the
  terminal had the proxy all along, so it is not told). It
  stays idle where thinker's own proxy serves the session (a loopback `ANTHROPIC_BASE_URL`), under `THINKER_TEST`, and
  in a held-out session. `clearInputs` and `clearThinking` from the same block switch the two piggybacks off, as for
  the proxy. Replayed on this repository's last 14 days (138 sessions) the policy matters: results alone at 140k/100k
  saved 5.1% billed-equivalent and 1.6% at list; with the call text and the thinking 13.9% and 6.5%. A results-only
  clear at a 60k floor reached nearly every result the full clear does (5.8M of 5.9M) and still saved half as much:
  the rewrite is paid either way, and the inputs and the thinking ride on it for nothing.
  **One policy, this door's measure** (`clearPays`, `remainingCalls`, `WRITE_RATIO`, `COLD_MS` in `register.tsx`,
  pinned by `test/claude-clear.test.js`; the same `proxy: { clearDeep }` key): a clear here rewrites the conversation in
  place, so the write it costs is the context after the first row it changes (`clearOld` returns `prefixChars`) less
  what it drops, and it is made at `turn.complete` when the reads it saves over the session's likely remaining requests
  repay that write, as the proxy decides (`src/cutting.js`, the section below). What was cleared stays cleared: a
  placeholder is never touched again, so a later clear only takes what came after. The pause that makes a clear free is
  measured from the end of the last turn to the first request of this one, not from one turn's end to the next, which
  made a turn longer than the cache's hour look like a cold pause. `/thinker-clear` is never held back. Until
  2026-11-02 the mod held one clear per cached stretch (`holdsBlock`) and before that cleared again every 20k of
  growth; both went with the proxy's freeze and thaw.
- It writes the proxy's own record (`compression.js:noteCompression`'s shape, `state/compression/<session>.json`),
  counting `saved` on every later model request (`turn.step`) as the proxy counts it per request, so the card, the Stop
  hook's line and `thinker proxy report` read it unchanged. The whole of a clear is measured, not estimated: the
  context the API reported before the clear less what the first request after it was answered over (a floor, since
  that request carries the new prompt). Beside the proxy's fields the record keeps `kinds`: the results and the
  emptied call text estimated from their characters, and the thinking as the measured remainder, since a mod never
  sees a thinking block. What is not measured: the holdout's question, whether the model reads again what was
  cleared; judge any change to the policy here as the proxy's is judged, by cache writes.
- **What a desktop clear cost is measured too, from the record (2026-11-06; `register.tsx:charge`, `isRewrite`,
  `LONG_CONTEXT`; `compression.js:desktopClearingCost`).** The netted figure (`clearingCostBySession`, read by
  `delivery.js:rewriteCostFor` for `thinker prs`) charged a clear with the prompt-cache writes of the calls after
  it, read from the proxy log's rows alone, so a desktop session's clear had no cost side and read as gross -- the
  one figure the owner's rule forbids. The engine reports every request's usage to `turn.step` in the API's own
  counts (`cache_creation_input_tokens`, `cache_read_input_tokens`, `input_tokens`, and the `model` that
  answered), so on every request from the first clear onward the mod applies the proxy's own definition of a
  rewrite (a context of `LONG_CONTEXT` or more, over half of it written; `test/claude-clear.test.js` holds the
  mirror to `cutting.js` on sample calls) and keeps `cost: { rewrites, write }` and `model` on the record.
  `clearingCostBySession` takes the card's state directory (`dir`) and reads those for the sessions the log has
  no rows for, priced at the one-hour write rate as the proxy's rows are; `desktopClearRows` prices the saving
  from the record's model before the log's `op: session` rows. Measured, not modelled: the writes are the API's
  counts, and as on the proxy side a rewrite the clearing did not cause is charged to it anyway. Not measured: a
  record from before this carries no `cost` and gets no cost figure (never a zero that reads as free), the card's
  state files are pruned after two days where the log keeps months, and the ledger's clearing series is still
  gross by design, as the Report's is; the netted figure lives in `thinker prs` and the PR comment.

**The clearing: thinker cuts the context itself (MANDATORY, 2026-11-04; `src/cutting.js`, `src/proxy.js:applyCut`):**
- The proxy replaces older tool results with a placeholder in the request it forwards. Nothing is asked of the
  API, and nothing else in the prompt is touched: not the call text, not the thinking, not the person's prompts,
  not the agent's own words. Measured composition of one real request (642,444 chars): older results 60.7%, the
  live turn's results 17.9%, prompts 7.0%, agent text 5.4%, tool definitions 4.7%, system prompt 1.1%, call text
  0.8%. The results are the only part worth reaching.
- **A cut costs the tail, not the prompt** (`cutCandidates`). The rewrite is the messages from the first replaced
  result onward, as they will be sent -- placeholders, not the full results the agent resent. Pricing it as the
  whole prompt over-stated the cost 3.1x, 7.9x and 14.9x on the second, third and fourth cut of a 28-turn
  session, because every result cut earlier was still counted at full size; the policy then refused cuts whose
  real paybacks were 10, 8 and 6 calls. The API's own writes on those calls were 47k, 58k, 56k, 52k -- flat,
  because the band runs to the protection boundary and everything between is itself replaced.
- **The decision is at a turn boundary, and that is also the cheapest moment** (`decideCut`). Before the turn has
  made a tool call there is nothing protected in the tail: measured over one session, a cut priced at the first
  call of a turn has a tail of 3k-14k and repays in 3-7 calls, where the same cut one call later carries the
  turn's own results in its tail (44k-58k) and repays in 18-94. The sweet spot is not a tuning knob; it falls
  out of pricing the tail honestly.
- **A cut must repay inside `PAYBACK` (25) later calls**, and nothing is assumed about how long the session runs.
  The horizon this replaced (`REMAINING`, 40 rising to 90 with calls made) grew the longer a session had run,
  so the latest and largest cuts were valued the most generously. Tight on purpose: a refused cut costs only
  the saving it would have made, a wrong one pays a full prefix rewrite up front.
- **A cold boundary cuts everything eligible, whatever the size** (2026-11-06; `decideCut`, the `cold` branch
  before the trigger). Past the cache's hour the request writes its whole context again whether or not anything
  is replaced, so the tail is free and the trigger and `clearAtLeast` have nothing to protect at that moment.
  Replayed over this machine's last 14 days (145 sessions of 40+ calls, rebuilt from their transcripts; the
  candidates match the proxy's own priced boundaries of 2026-11-05 within 0.5%), 41 cold boundaries had something
  to cut and 9 cleared the 100k floor: the other 32 were refused for a cost of zero, and taking them is +12% net
  at list prices with no session made worse off. The mod does not follow: its clear is a compaction turn queued
  after the turn completes, so the request that would have been free has already gone and the cache is warm
  again when it acts; its idle rule waives the payback alone (`register.tsx:clearPays`, the note above it).
  The same replay, for the record: the trigger moves nothing (110k is +$3 on $452, since the size floor is what
  gates and needs ~300k of context to be met), the payback floor buys $7-8 at 30 or 40 and adds sessions that
  lose, and the size floor is the lever (60k is +14%; 80k less, because it admits the band where the fixed part
  of the tail -- the live turn and the protected results -- weighs most). A refusal for size now carries
  `candidate` on its row, so the next such question is read off the log rather than rebuilt from transcripts.
- **The size floor is 60k, from 100k** (2026-11-06; `PROXY_DEFAULTS.clearAtLeast`, mirrored by the mod's
  `CLEAR_AT_LEAST`). The floor, not the trigger, is what gates a cut: old results are about a third of a
  conversation's context on this machine, so 100k of them needs roughly 300k of context, and every boundary the
  proxy priced in the five days to 2026-11-06 sat at 200k or more while 43 past the trigger were refused for size.
  The payback ratio of a boundary is nearly independent of its size (cut over tail ran 0.62-0.75 at every context
  measured), so a lower floor prices more boundaries at the same odds rather than worse ones. Replayed over the
  same 145 sessions as the cold rule above: 60k is +14% net at list prices with no session made worse off; 80k is
  less (+7%) and adds three losers, because it admits the band where the fixed part of the tail (the live turn
  and the protected results, 44-58k here) weighs most against what is removed. With the cold rule the two together
  are +18%. Not moved: the trigger (no effect, since the floor gates) and the payback floor (+$7-8 at 30 or 40,
  with more losing sessions). Judge it by cache writes against the holdout over a window after it lands; each
  extra cut is a cache break, and the cut arm's unexplained extra rewrites in the 28-turn pairing are still
  unexplained.
- **The floor is the whole policy, and at 20 it cut nothing** (2026-11-06). In the two days after the cut landed
  this machine's Claude path made no cut at all: 30 priced boundaries in 4 conversations, every one refused at a
  payback of 21 to 64. The floor is the only reason -- the cost side is not overstated (one cut's predicted tail
  of 566,723 against the 548,009 the API then wrote), and there is no cheaper moment to wait for: priced along the
  whole of one 960-message conversation the paybacks run 23, 25, 27, 32, 28, never lower, because at a 400k
  context the results are spread through the history and the tail from the first replaced one is always larger
  than what the cut takes out. Those boundaries sat in sessions that went on to make 283, 81 and 53 further
  calls, so the first boundary of the longest would have returned 2,729,718 tokens against its write. 25 is the
  smallest value that makes any cut here, and it re-admits none of the cuts that lost: the four of the +38%
  session needed 14, 32, 66 and 82 calls.
- **What was tried instead and thrown away** (2026-11-06): crediting a cut with the write it spares as well as
  the read (`savedPerCall(model, ttl, share)`, the share of its context a conversation is measured to write
  back). It is arithmetically right -- counting the read alone is right only for a conversation that never
  rewrites its context, and 84.5% of this machine's write tokens are in calls rewriting 85% of theirs -- but it
  changed 0 of those 30 decisions, because the conversations that reach the trigger are the ones that rewrite
  least: median share 4.60% under 140k of context, 1.96% at 140k-300k, 0.81% over 300k, where the cheapest
  boundary needed 1.05%. It cost two constants, three record fields, evidence gathering in `cutResponse`, a
  monotone merge and a documented divergence between the two doors, for no change in behaviour. If it comes
  back it must be measured per conversation and never as a machine-wide constant -- and it can only lower a
  payback, so it never refuses a cut the read alone would make.
- **Growth inside a turn is invisible to both the trigger and the decision**, and on this machine's agents that
  is most of the growth. `measurePrompt` reports the prompt less the turn in progress, and `decideCut` only
  decides at a boundary, so a turn that runs 139 calls is one decision: the first boundaries of the three
  refused conversations sat at 337,692, 278,106 and 139,609 tokens of context -- the last of them 391 tokens
  under the trigger. Not changed here, because a mid-turn cut moves the set inside a turn, which is the
  MANDATORY invariant above and a measured failure (4 mid-turn moves before `conversationKey`, 0 after). It is
  the next thing to look at if the floor is not enough, and it needs the holdout and cache-write judgement.
- **The ratchet is the conversation's, and it is held under concurrency** (2026-11-05; `proxy.js:conversationKey`,
  `cutting.js:mergeCut`, `cutStore.update`). One machine runs many agents through one proxy, and the record the
  ratchet lives in was keyed on `x-claude-code-session-id`, which Claude Code sends for everything a session does:
  the person's thread, each subagent's, and the small side calls beside them. So one record held several
  conversations. Two failures followed, both reproduced end to end against the real proxy process on 240
  requests, 12 conversations under 3 session ids (`test/proxy.test.js`, the two concurrency tests):
  a title call's `turn: 1` landed in the person's record, and the next request of their turn read itself as a new
  boundary and **cut mid-turn** -- 4 moves in that run, 0 after; and an overlapping request's late answer
  persisted the record it had read before the reservation, **putting the set back** -- 9 rollbacks, 0 after. The
  records themselves told the rest: 3 records holding 23 to 26 ids from conversations they did not belong to, and
  29 calls counted where 70 happened, against 12 records of 10 ids and every call counted.
  So: the record is named by the conversation's own first user message (its text alone, because Claude Code moves
  `cache_control` between calls), a write merges with what is stored instead of replacing it and only ever goes
  forward (the turn rises, the set is the furthest-on turn's, no counter falls), the counters are incremented
  read-modify-write, and the file is renamed into place so a reader never sees half a record. Two conversations
  opened with the same words still share a record; that is the residue.
- **One session replaces a running proxy, not all of them** (`proxy-service.js:claimRestart`, `RESTART_GRACE_MS`
  30s). `thinker update` moves the version for the whole machine, and then every session's next prompt had a
  reason to restart the proxy -- each a SIGTERM to a process streaming another session's answer, each new process
  racing the service manager for the port: 105 recorded starts against 26,245 EADDRINUSE lines in this machine's
  log. The first hook to arrive claims the restart in a file created with `wx`, keyed on what it is restarting
  *to*, and the rest find the proxy they wanted on their next prompt. The claim is left to expire rather than
  released, because the window that matters is between the SIGTERM and the new process recording its own version,
  where every other hook still reads the old state. Only the replacement of a **running** proxy is gated: a port
  with nothing on it is a broken route for every session and may never wait on another session's claim.
- **A restart is a gap, so it happens only for a reason, and it has to actually come back** (2026-11-06;
  `proxy-service.js:replaceReason`, `bootOutAgent`, `bootstrapAgent`). On this machine the proxy was taken down
  seven times in a day with nothing listening on its port for 13 to 100 seconds each time -- ECONNREFUSED in
  every other session's model calls, read as "the proxy is flaking" -- and the cause was two things together.
  `thinker rewire` restarted the service whenever the proxy was on, and the background update runs rewire every
  four hours whether or not it installed anything; so now rewire asks the same question the prompt hook asks
  (`replaceReason`: is the running service this version with these flags) and restarts nothing that answers no.
  And the restart itself did not come back: `launchctl bootout` answers before the proxy has drained the answers
  it is streaming, launchd refuses a `bootstrap` of the label while it is still registered ("Bootstrap failed: 5:
  Input/output error"), and the `load` fallback prints "Load failed" and exits 0, which `run` took for success.
  Reproduced on a throwaway label. So the bootout waits for the label to leave (`BOOTOUT_WAIT_MS`, 25 s, past
  launchd's own 20 s ExitTimeOut), bootstrap's own exit code is read, and `load` is believed only when `launchctl print` then names a
  running instance that is not the one being replaced (`agentInstance`): the label answering is not enough, since
  the old instance answers it too while it drains. The proxy's SIGTERM handler drains (`server.close`), which is what makes
  the gap as long as the longest answer in flight; that is kept, since cutting an answer mid-stream is the worse
  failure. `test/proxy-service.test.js` runs both against a fake `launchctl` with launchd's shape.
- **An update restarts the proxy when it is idle, not now** (2026-11-06; `proxy-service.js:requestRestart`,
  `restartDue`, `idleRestartWatcher`; the watcher runs in the service's own process, `commands/proxy.js`). Even a
  restart that comes back is a gap: the old process stops listening, drains the answers it is streaming (up to
  launchd's 20 s cutoff), the new one boots, and every session's model calls are refused in between. Measured on
  this machine: launchd's KeepAlive brings a cleanly exited process back in 0.93 s (7 s when it had run under ten
  seconds), and Claude Code retries a refused connection by itself with a visible "Retrying in" line. So where the
  service manager would start the same program line again -- an update, since the program is the app's path --
  `restartService` writes `state/proxy-restart-wanted.json` and answers `pending` instead of booting out; the
  proxy counts what it has in flight (`server.load()`), and at the first moment with nothing in flight and nothing
  finished for `RESTART_IDLE_MS` (3 s) it closes its listener and exits 0, launchd starting it again on the new
  code. Past `RESTART_PATIENCE_MS` (15 min) the first empty moment will do; past `RESTART_DEADLINE_MS` (1 h) it
  drains as a bootout did. A proxy with no manager starts its own replacement before it exits (`respawn`). The
  new instance clears the marker when it listens (`recordProxyListening`), and a marker that asks for what the
  running process already is (same version, same flags) is cleared and ignored, so a hook repeating the ask every
  prompt is harmless; `requestRestart` keeps the first ask's time so the patience runs from it. Booting out is kept
  for what the manager cannot do: a changed program line (another port, other flags), a stand-down, and a port
  with nothing listening on it (`whenIdle: false`, the dead-port branch of `ensureProxy` and of rewire). Not done:
  a true handoff with no gap at all. Node on macOS refuses `reusePort` (ENOTSUP), so two proxies cannot share the
  port; a supervisor holding the socket and passing it to a child over IPC would do it, at the cost of a process
  whose own updates still need this path. The row is `proxy-restart-idle` in the proxy log. The instance that listens records `idleRestart: true` in the
  service state; one from before this (nothing recorded) is booted out as before, since a marker left for it would
  wait for ever -- so the first restart after this lands is still a bootout, and every one after it is idle.
- **The ratchet.** A cut is a set of `tool_use` ids kept per conversation on disk (`cutStore`). The agent resends the
  whole conversation on every request and knows nothing of this, so the set is re-applied to each one -- 1.9 ms
  on a 1 MB body, no tokens, and no rewrite, because the same ids give the same bytes. Within a turn the set
  never moves, which is what keeps the prompt cache. Stopping is free: keep applying the set and cut no more.
- Proven live (2026-11-04): 16 of 16 calls answered 200 with a conversation thinker had edited, thinking
  included and no compaction boundary, so the October 2026 breakage does not reproduce. The ratchet held 26
  turns with 0 mid-turn moves and 0 refusals. On the realistic 14-turn pairing, 0 of 95 requested values were
  omitted, where the API-side path omitted 5 of 47.
- Not settled: the 28-turn pairing measured +38% against its control, and the cuts' own writes account for 213k
  of a 1.32M excess. The cut arm writes on 89% of calls against the control's 44%, and the proxy's own output is
  byte-consistent (consecutive requests of a session differ only where Claude Code moves its own `cache_control`
  marker), so the cause is not yet known. Judge any change here by cache **write** tokens, against the 15%
  holdout, and dump both arms (`THINKER_PROXY_DUMP`) before trusting a figure.

**A request that never reached the API is the proxy's to recover (2026-11-05; `src/proxy-retry.js`):**
- Measured on this machine's log, the 12 days to 2026-11-05 (20,749 rows, 830 error rows): 174 of those rows
  are the person pressing Esc, and of the 650 real failures **487 are a name that did not resolve** -- three
  quarters of everything that goes wrong. The rest: 106 a TLS record that did not authenticate (82 on a
  reused keep-alive socket), 23 a reset that was not a cancellation, 34 the remainder. The error rate does
  **not** rise with concurrency (1.5% at one active session, 1.4% at four, 0.7-1.8% at six to eleven), so
  parallel agents are not what breaks a request.
- The single 250 ms retry this replaces ran **110 times and recovered 1** since retries began on 2026-10-29:
  every `retried: true` row is followed by its own failure row. `afterMs` is a median of 4, so nothing times
  out -- the resolver refuses at once and refuses again 250 ms later. 46 of 58 bursts hold their errors inside
  5 seconds; 6 long ones (1-6 minutes) hold 173 between them.
- So two things. **The address the host last answered on** (`addressBook`, `cachingLookup`, wired as the
  request's `lookup`): recorded from the lookups requests make anyway, never a lookup of thinker's own, read
  only after the resolver has already refused, forgotten after `KNOWN_FOR` (6h), logged `proxy-dns-fallback`.
  A stale address costs a failed connect, which is where the request already was. And **a ladder**
  (`RETRY_WAITS`, 0.25/0.5/1/2/4s, ~8s in all), abandoned the moment the agent leaves; with an address in hand
  the first rung waits for nothing. Past the ladder the 502 is the agent's to see: a six-minute outage is not
  thinker's to paper over.
- A fresh socket is the whole remedy for the reused-socket class, so the TLS record failure (`RETRY_TLS`,
  matched on the code's text because Node builds it from OpenSSL's string) and `EHOSTUNREACH` join
  `RETRY_CODES` rather than getting a mechanism of their own; attempt 1 already opens its own connection.
  Not done, deliberately: lowering the keep-alive idle timeout. Node applies an agent timeout to active
  sockets too, so a wrong value kills a streaming answer mid-thinking -- a worse failure than the 46 resets
  it would save. It needs the upstream's real idle timeout measured first.
- **A cancellation is not an error** (`op: 'proxy-cancelled'`): 174 of 830 rows were the person changing their
  mind, and while `aborted` has flagged them since October every reader had to know to look for it --
  `thinker proxy report --verify-usage` did not, and called the accounting incomplete over it. The flag stays
  beside the new op while logs written before this are still in the window.
- Judge a change here by three numbers, all in the telemetry's proxy block: DNS errors against requests,
  502s the agent actually saw (`errors.failed`), and **`errors.recovered`** -- retries that then answered,
  which is what showed the old policy was pure cost and which nothing was counting.

**One summary, not a line a turn (2026-11-01, the owner's call):**
- thinker said something at the end of nearly every turn: the notes served in it, what the clearing
  saved (`compressionNotice` had no guard at all, so from three turns past a clear it printed under
  every answer with the same figure), what maintenance did, the weekly line. A line under every answer
  is noise, and every figure in it is on the Report page and in `thinker usage` anyway.
- A summary comes due when `NOTICE_PROMPTS` (20) prompts have passed since the last one **and**
  `NOTICE_HOURS` (24) have gone by (`notice-cadence.js`). Both floors: a day of heavy work carries one
  summary, and a quiet week still gets one once 20 prompts add up. The first turn of a fresh cache
  speaks at once -- there is nothing to be quiet about yet, and that is how a person learns it is there.
- Nothing is dropped by waiting. A held turn's servings go to `holdNotice` as a set (a note served in
  three held turns is one note), `maintenanceNotice` is not called while a summary waits because reading
  its lines clears them, and the clearing's own clock (`markCompressionTurn`) is still read every turn.
  The line says the span it speaks for ("3 notes over the last 24 prompts"), counted in this cache's
  held turns, not the machine's prompts.
- The floors start again only once the person has actually been told: an empty summary, or a client
  with no message at the end of a turn (`clients.js:stopOutput` returns nothing for Cursor and Cline),
  leaves it waiting. Cursor's door is its prompt-time footnote, which holds back the same way.
- The cadence is the machine's (`THINKER_HOME/state/notice.json`, beside the weekly marker), since the
  person sees one stream of messages however many checkouts they work in; what waits to be said is the
  cache's own (`<cache>/state/notice-pending.json`). `notice: { everyPrompts, everyHours }` in
  `.thinker/config.json` moves either floor and 0 drops it; `notice: false` is still the off switch.
- The cards come due the same way, since a box under every answer is the same noise: the Claude Code
  mod reads and stamps the same state file (its own copy of the floors, `NOTICE_PROMPTS`/`NOTICE_HOURS`
  in `register.tsx`, held together by `test/claude-card.test.js`), keeps a held turn's notes in `served`
  and says the span in its header; the Codex desktop card waits for the next summary before drawing a
  new one, while a card whose reference is already in the turn's answer is still kept up to date. The
  hooks count the prompts and the cards only read the count: both run in every turn, and counting twice
  would halve the floor. One thinker message, whichever door it comes through.

**The savings footer: money, on the one surface that keeps it (2026-11-06, the owner's call):**
- What thinker has saved is shown as dollars, today and over the whole log, in every client it has a
  door into: the Claude Code status row (the terminal) and the status line under the prompt (the desktop app), the Codex desktop card, the
  Cursor table, and the end-of-turn line for Codex CLI and a Claude Code without the mod.
- **Dollars are the exception, and stay honest by construction.** `prices.js` records the 2026-10-04
  decision that the product counts tokens, never dollars, because most agents run on a subscription.
  The footer is the second exception after the Report page, so it is not allowed its own arithmetic:
  `savings-ledger.js` asks `report-savings.js:weeklySavings` -- the Report's own two series, avoided
  reading at each request's observed input mix and cleared context at the prompt-cache read rate --
  for two windows instead of six weeks. A figure under a prompt can never contradict `thinker report`,
  and `test/savings-ledger.test.js` holds the two together over one window.
- Clearing moves far more tokens than avoided reading, at a fortieth of its price, so it dominates the
  lifetime total (on this machine: $827 of $849). Every surface that has room shows the split, and
  `thinker savings` prints it with the caveat; the one-line form is a total, never a claim about a bill.
- **A hook may not count it.** The full pass is a read of the machine's log and of every session its
  savings records name -- about a second on a 16 MB log. The Stop hook starts `thinker savings
  --refresh` in the background at most every `REFRESH_MS` (10 min) under a lock, and every surface
  reads the kept ledger (`THINKER_HOME/state/savings.json`): the machine's, like the notice cadence,
  since lifetime means every checkout. No model call, so it runs the same inside a desktop app.
- **The figures ride the engine's own status row, not a row of their own** (the owner's ask,
  2026-11-06: that row has empty space, and a row of thinker's own does not earn one). The door is
  `PromptHint`'s `tail`: the engine keeps its line and its live pills and draws the tail after them,
  cut where the row ends. **Where on the row, and in what colour, is the engine's and not the mod's**:
  it collapses every whitespace run in the tail to one space, trims it, and draws it in one
  `<Text dimColor wrap="truncate">` behind a dim separator. So the tail is the line and nothing else
  (`statusTail`) -- padding it to the right edge was tried, and the engine strips the padding; a green
  figure is not available there either, and a mod that wants colour must draw its own tree (a card, or
  the `AbovePrompt` band). `$.ui.status` was the first home and cannot be placed at all -- it takes
  text and nothing else. thinker still writes no `statusLine` into the agent's settings: that surface
  is the person's, and often already theirs.
- **The desktop app draws no tail, so there the line is the engine's status line under the prompt**
  (2026-11-06; `register.tsx:showStatus`, `/thinker-hide`). The engine's own types say of `tail`: "no other
  surface draws it yet", and the Claude desktop app's Code tab draws neither the hint line nor the mode
  labels at all (a screenshot: nothing under the input but the model picker), so the tail door, a
  `SessionMode` label and a rewritten `PromptHint` hint all showed nothing there; the band above the input
  (`AbovePrompt`) does draw, and a pane does, and both were turned down (the owner's call: the band is in
  the wrong place, the pane far too big). What the desktop does draw under the input box is `$.ui.status`,
  checked live with a probe mod the same day: text alone, pinned per plugin, cleared with `undefined`. So
  on `surface: 'desktop'` the line goes through it, read at session start and after every turn as the
  tail is, and the tail is set on the terminal alone, so no surface shows the figure twice. The repository
  note that `$.ui.status` "cannot be placed" stands for the terminal, where it never showed. A status line
  carries no button, so the dismissal is `/thinker-hide`, registered on the desktop alone: it clears the
  line for the rest of the day, the day kept in the mod's store (`HIDDEN_KEY`) across sessions, and the
  next day the line is back. The app heads a pinned line with the plugin's name, which the mod cannot
  suppress, so the card mod is named `thinker` (it was `thinker-card`) and the desktop line drops its own
  `thinker: ` (`desktopStatus`): `thinker  saved today ~$1.14 · lifetime ~$849`, never thinker twice.
- **The status line says the name, not the brain** (the owner's ask, 2026-11-06): `thinker: ...`, where
  the rest of thinker's lines carry `🧠 thinker:`. The row is small type beside the host's own, where a
  lone glyph is a puzzle. `savingsStatus` writes it in both copies (src and the mod), held together by
  `test/claude-card.test.js`.
- **The two windows count servings differently, and say so.** Lifetime is the confirmed estimate the
  Report page shows. Today is the running session's rule (`summarize`'s `onProvisional`): served, not
  yet judged, minus anything judged unused or contradicted, priced from the model the session's
  transcript names. Measured on this machine: only 15% of the sessions ever served notes have been
  assessed at all, and of those the median is assessed 72 minutes after its first serving, one in ten
  past ten hours -- confirmed-only, a daily figure would read $0 all morning and then show a fraction
  of the day. `provisionalSince` keeps that second pass to the sessions that can still matter: asking
  it of every session took the ledger from 1.2 s to 7 s on a 611-session log.
- A ledger whose `day` has passed says lifetime alone rather than yesterday's figure as today's.
  Notices off (`THINKER_NOTICE=off`, `notice: false`) silences the status row too.
- Where the card mod runs, the Stop hook leaves the money out of its line: the status row already has
  it, and one figure gets one voice per client.
- **A clear the proxy never saw is in the ledger too** (2026-11-06; `compression.js:desktopClearRows`,
  `clearingRows`). The ledger and the Report priced cleared tokens from the proxy's log alone, and a
  desktop session never reaches the proxy: the clearing mod writes `state/compression/<session>.json` and
  no log row, so its clears were on the card under the answer and in `thinker proxy report` and nowhere
  money is said -- one desktop session's 7.8M cleared tokens, in no footer and no Report. Now the records
  of the sessions the log has no rows for are read as one row each, dated the session's last request
  (`saved` accrues through the session), priced from the model the session's own `op: session` log rows
  name, unpriced where none does; a session the log does have rows for is left to the log, since the proxy
  writes the same record beside its rows. Devin's compactor records count the same way. Still not in the
  ledger: what those clears cost, since only the proxy's log sees cache writes (`clearingCostBySession`).

**Exploration subagents run on Sonnet (2026-11-08, the owner's call; `src/explore-agent.js`):**
- Claude Code's built-in Explore subagent runs on the main conversation's model, so on an Opus or Fable session a
  delegated exploration is billed at that model's rates. A user or project subagent named `Explore` overrides the
  built-in one and keeps its own `model` (code.claude.com/docs/en/sub-agents), so `thinker connect` and `rewire` write
  `<claude config dir>/agents/Explore.md` at user scope with `model: claude-sonnet-5-5` (the full id: the `sonnet` alias
  resolved to Sonnet 5 on Claude Code 2.1.319, checked live), read-only (`disallowedTools`), starting
  without CLAUDE.md as the built-in does, with a `<!-- thinker-explore -->` marker. Only a file carrying the marker is
  ever rewritten or removed; a person's own Explore.md is left alone and named once in connect's output; a project's
  `.claude/agents/Explore.md` wins in Claude Code's own order and is never touched. `thinker uninstall --user` removes
  it. Off, or another model: `THINKER_EXPLORE_MODEL=off|haiku|<id>`, or `agents: { explore: false | "<model>" }` in
  `THINKER_HOME/config.json`; the environment wins.
- Why Sonnet (measured 2026-11-07, 13 of this machine's own exploration turns replayed as an exploration subagent
  through `claude -p`, read-only, judged by recall of the files the parent went on to edit or name): Sonnet 5.5 and
  Opus 5.5 tied (core recall 0.77 each, Sonnet ahead on precision and turns) at 43% of Opus's cost; Haiku 5.5 was 7
  points of recall behind both at 8% of the cost. The parent's saving is the same whichever model explores, since the
  results stay out of its prefix, so the explorer only has to be as good as the main model, and Sonnet was. Caveats:
  13 tasks, one repository, HEAD already holding the fixes those turns produced.
- Why it is worth having: on this machine's 28 days exploration results were ~10% of parent prefix dollars after the
  cut, concentrated in turns of 10+ reads (8% of turns, 60% of the volume), and Explore had run 3 times, on Opus.
  Subagents were 4% of spend, nearly all general-purpose on the parent's model. The judge of this change is the same
  as the clearing's: exploration's share of parent prefix dollars and subagent usage over a window after it lands,
  never the replay. Effort as a lever was measured and dropped the same week (a ceiling of 5-10% of high-effort spend,
  and a top-level effort change breaks the prompt cache; the per-message form only moves at a turn boundary).

**Hooks never run or rewrite test commands (MANDATORY, 2026-10-30):**
- Thinker is the cache and context reduction harness. The test wrapper and its automatic command interception have been removed.
- Legacy `hook pre` calls do nothing; wiring refresh removes those hooks while preserving other hooks.

**Telemetry and tests (MANDATORY):**
- Set `THINKER_TEST=1` for tests, benchmarks, eval harnesses, scratch experiments, and their setup/install steps (`npm test` sets it).
- It blocks production telemetry and automatic background work, keeps usage logs local, silences machine-wide hooks, and suppresses the offers.
- `THINKER_OFFERS=on`: restore offers, offer tests only.
- `THINKER_TELEMETRY=off`: extra telemetry-only control.
- Every child process must inherit these settings.
- Never send these runs to the production telemetry endpoint or count them as usage.
- Telemetry tests use mocked requests or isolated loopback only. Never contact production.

**Benchmark caches are gone (2026-11-08):** `mine-prs`, `understand`, `export --dir`, `THINKER_NOTES_DIR`, `thinker served` and `thinker guide` went with the knowledge notes, so Artemis has no thinker-cache arm to build or read. Its config and the run-evals skill in `~/src/artemis` need a matching change; until then a plan that names a cache arm cannot run.

**Matched models (MANDATORY):**
- Compare arms only with the same exact model and reasoning effort within each compared phase: exploration, coding, judging.
- Keep agent config fixed except the declared intervention.
- Record every phase's model before running. Disable silent provider/model fallback. A model or effort mismatch between the coding arms invalidates their comparison.
- Prefer executable tests for correctness. Report correctness, tokens, latency separately.
- Different models or reasoning settings go in separate cohorts, never one ranking.

**Evals only through Artemis (MANDATORY):**
- Run, follow, read benchmarks only via Artemis (`~/src/artemis`; start with `bin/artemis-up`; web app and MCP server).
- Follow `.agents/skills/run-evals/SKILL.md`: `create_pr_set` (freeze PRs); `plan_experiment`; user approves each plan; `start_experiment`; read with `get_experiment`, `get_session`.
- Never start the task runner (`~/src/task-runner`) by hand.
- Never report numbers computed by hand from run files.
- Artemis and task runner use thinker only via CLI: `thinker mcp`, `hook`, `version` (`src/commands/external.js`). Changing their output or input is an interface change: stay compatible or change Artemis in step.
- Artemis's `"thinker"` entry in `~/.artemis/config.json` is the tested build; point it at a worktree to test a branch.

**Worktrees (MANDATORY):**
- All code changes, scratch experiments and benchmark runs happen in an isolated worktree. Never edit the primary tree.
- Create: `git worktree add -b agent/<task-name> .worktrees/<task-name> HEAD` (gitignored). Work only inside it.
- On merge, push, abort or cancel: `git worktree remove --force <path>`; if unneeded, `git branch -D agent/<task-name>`.

**Model calls:**
- Anthropic SDK when `ANTHROPIC_API_KEY` is set. Otherwise first installed agent CLI: `claude`, `codex`, `gemini`, `agent`.
- `claude -p` uses a replaced system prompt (`--system-prompt`, `--setting-sources ''`, `--disable-slash-commands`; `llm.js:viaCliOnce`). Never append.

**Releases:**
- Release = GitHub release on tag `vX.Y.Z` on a `main` commit, assets `thinker.tgz`, `version.json` (version, commit, archive sha256), `install.sh`.
- `install.sh` (`npx thinkersh`) and `thinker update` (`src/update.js`) read `releases/latest/download/version.json`. `thinker update vX.Y.Z` pins.
- Cut: `bash scripts/release.sh X.Y.Z`. `scripts/release.mjs` tests a version-only bump in a temp worktree, opens a PR, waits for the user to merge. Never merges or pushes `main`.
- After merge: `scripts/pack.sh` packages the merged commit; runner tags, publishes release and three assets, verifies public download, publishes npm installer at same version.
- Rerun resumes from the exact tag. Never overwrite public assets or npm versions. No version = resume current `origin/main` version.
- `--hold`: GitHub pre-release and npm tag `next`. Promote: `bash scripts/release.sh X.Y.Z --promote`.
- Prerequisites, auth, `--no-wait`: `docs/releases.md`.
- Nothing uploads to zerotime.dev. `scripts/pack.sh <base url>` builds a self-hosted set.

**Layout:**

| path | contents |
|---|---|
| `src/cli.js` | entry: parsing, help, prelude, handler table |
| `src/commands/` | `notes.js`, `cache.js`, `learn.js`, `hooks.js`, `setup.js`, `telemetry.js`, `benchmark.js`, `shared.js` |
| `src/mcp.js` | MCP server: `context` and coverage answer tools, `learn_next` queue |
| `src/setup.js`, `src/setup/` | `runSetup`; `ui.js`, `agents.js`, `estimate.js`, `steps.js`, `pr-benchmark.js` |
| `src/clients.js`, `src/integrations/` | client adapters, extension handlers (`docs/agent-integrations.md`) |
| `src/transcripts.js` | transcripts, one event form |
| `src/prs.js` | PR mining |
| `src/session-state.js` | a session's turn counter, state file and lock for the hooks; the holdout share |
| `src/profile.js`, `src/commands/profile.js` | the session profile: extraction, ledger, patch compile, render, serving and holdout |
| `src/notes-retired.js` | removes what a checkout kept of the knowledge notes, once |
| `src/disk-cache.js` | machine-wide results cache (`~/.thinker/cache`) |
| `src/rank.js`, `src/dense.js` | BM25 and the cross-encoder the harness recall ranks with |
| `src/maintain.js` | background maintenance, daily cap |
| `src/skills.js`, `src/commands/skills.js` | SKILL.md cards; `thinker skills` (`docs/skills.md`) |
| `src/instruction-value.js`, `src/context-view.js`, `src/commands/context.js` | `thinker context`, Context tab |
| `src/guard.js` | anchoring guard |
| `src/update.js` | self and background updates |
| `src/usage.js` | usage log summary |
| `src/delivery.js`, `src/delivery-journal.js`, `src/commands/prs.js` | `thinker prs`: the pull requests the sessions here produced, what each cost and what was saved on it, in tokens and in netted dollars |
| `src/delivery-telemetry.js` | the same as counts and tokens, for the telemetry payload's `prs` block |
| `src/explore-agent.js` | the user-scope Explore subagent on Sonnet: written by connect/rewire, removed by uninstall --user, never a person's own file |
| `src/proxy*.js`, `src/commands/proxy.js` | context proxy; `thinker proxy on\|off\|status`; `proxy-route.js` leaves a routed harness alone; clearing results, call text and earlier thinking all on by default (2026-10-28), `--no-clear-inputs`, `--no-clear-thinking` off |
| `src/cutting.js` | the clearing: the cut set, the ratchet, the priced decision at a turn boundary, the session record |
| `src/proxy-retry.js` | a request that never reached the upstream: the retryable codes, the ladder a dead resolver gets, the address a host last answered on |
| `src/compression.js` | what the clearing saved, per session, shown as a cache hit is (`TURNS_AFTER`, `compressionHeader`); and what it cost, as the cache writes of the calls after a clear (`clearingCostBySession`) |
| `src/devin-compaction.js` | Devin has no model endpoint for the proxy: its own compaction threshold, written by policy (`devin.compactAt`, off by default), and what each compaction took out, read from Devin's session database |
| `src/notice-cadence.js` | how often thinker says anything at the end of a turn: one summary every 20 prompts and at most one a day |
| `src/savings-ledger.js` | what the footers say: the Report's two savings series over today and the whole log, kept in `THINKER_HOME/state/savings.json` |
| `src/report.js`, `src/prices.js`, `src/commands/report.js` | Report page; `thinker report`; `prices.js` only place dollars appear |
| `src/store.js`, `src/llm.js` | note storage; model access |
| `src/server/` | `thinker-server`: `index.js`, `repos.js`, `auth.js`, `worker.js` |
| `infra/sync/` | EC2 server: CloudFormation, bootstrap, deploy |
| `src/change.js` | change review, no model call; `selectNotes`, `usedContext` |
| `test/` | unit tests (`node --test`) |
| `research/bench-history/` | old results (`RESULTS.md`) |
| `.thinker/` | notes about this repo |

Benchmarks are not in this repo. Artemis (`~/src/artemis`) holds task sets, PR sets, caches, runs, data. Task runner (`~/src/task-runner`) runs sessions. `bench/` in a checkout is ignored local leftovers.

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
  the next prompt (`exchanges`) and asks the model for observations: request, kind, approach, **outcome read from
  the following prompt** (`accepted`, `corrected`, `redirected`, `unknown`; the agent's own "done" is a claim, and
  `unknown` is the default, never a quiet acceptance), the quoted reaction, a lesson only where the reaction supports it, stated preferences, a bug line for
  a fix. They go to `.thinker/local/profile/ledger.jsonl`, 60 days, with the session and the directories its tool
  calls' *paths* name (`sessionDirs`, never their content; per-directory profiles are on hold until the one profile has been rolled out and read, the owner's call on 2026-11-08). A row's `at` is
  **the session's own clock** (the prompt's stamp, which every parser now puts on the prompt event; `exchanges`
  carries it, `observationTimes` dates each observation by its turn) and `seen` is when it was read into the ledger:
  the window and every date in the profile go by `at`, whether a compile is due by `seen`. The first build stamped
  rows with the extraction time, so every workstream and bug read as that night's and the recency rules meant nothing;
  the 483 rows were redated from their transcripts without a model call. **A compile is a patch, once per session**
  (`compileStep`, `applyPatch`, `PATCH_SCHEMA`; 2026-11-08): due whenever a session was read into the ledger
  (`compileDue`; first after one observation), the model is shown the profile as it stands with an id on every entry
  (`w1`, `h2`, `f3`, `b4`), the new observations, and the observations behind the entries those might touch (sharing a
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
  put the patterns in `whatFails` with the quotes. The monthly full compile below is that rebase. Four sections: `workingOn`,
  `howWeWork`, `whatFails`, `recentBugs`. `whatWorks`
  was a fifth until 2026-11-08: "an approach accepted after a correction" is the `instead` of a `whatFails` entry, and
  on its own it held one line in four that two sessions supported.
- **Every entry cites observation ids, and the code holds it to them** (`settle`): a citation the window does not
  hold is dropped, an entry with none goes, counts and dates come from the cited observations (count is distinct
  sessions), a `howWeWork` line needs two **sessions** or one observation that states the preference in so many words
  (`prefs`), a `whatFails` line two sessions or one correction with its reaction (the first build's floor counted
  observations, and two from one session passed), a workstream
  not seen in 21 days and a bug not seen in 14 leave. The compile is told the caps, that `approach`
  is the agent's own account, that an `unknown` outcome supports `workingOn`, `recentBugs` and (through `prefs`)
  `howWeWork` but never `whatFails`, that stated preferences and corrections repeated across sessions are the lines
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
- **Rendered** (`renderProfile`, `profileBlock`) within about 1500 tokens (`renderChars`, the owner's call on 2026-11-08 after seeing what 1000 dropped; 800 until that day, when
  the trim cut the ways of working from ten lines to two before touching the weaker sections), headed with the dates
  the sessions span, counted in sessions, and headed as learned, not instructions. When it does not fit: the oldest
  workstreams go first (to three), then the oldest bugs (to three), then the weakest of what went wrong (to four), then
  of the ways of working (to four), then whatever is longest (`TRIM`).
- **Served by the prompt hook, and held out by session** (2026-11-08; `profileTurn`, `profileArm`, `compactionsSince`,
  `holdoutReport`; `thinker profile holdout`). With `learn.mode` on, the block goes into a session's first prompt ahead
  of everything else the hook says, and again after each compaction, since a compaction summary keeps none of it: the
  hook counts `compact_boundary` lines written to the Claude Code transcript since the byte it last read (a few bytes a
  prompt, never a parse), and the other agents get it on the first prompt alone. A deterministic share of sessions
  (`holdoutRate`, the notes' 15% by default; `THINKER_HOLDOUT`) is held out **whole**, not by turn as the notes are,
  because the block is one injection that the rest of the session reads. The arm lives in the session's state file
  (`st.profile`: arm, how many times told, compactions seen), the Stop hook's `session` row carries it (`profile:
  shown|holdout`), one `profile-served` row is logged per injection and once for a held-out session (counts, never
  the text), and **every observation extracted from the session carries its arm**, so the ledger is the measure:
  `thinker profile holdout` puts corrected and redirected per session on each side beside prompts and tokens per
  session from the log. Fewer than `holdoutMinSessions` (20) on a side is too few to read. What it cannot tell apart:
  a correction the profile caused from one it failed to prevent; read the lines with `show --why` before blaming it.
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
  wrote into the cache again, at list prices.** `thinker prs`, the Report band, the page's Net column and the
  posted comment all read that one computation in `delivery.js`; no door prices a token itself.
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
- Not yet: the stop hook's `op: session` log row and `delivery.js:sessionsOf` (the `thinker prs` figure and the savings
  footer) still carry the parent's totals alone, so a subagent's cost is in the Report and not in the PR figure.

**Tables** (each ends on `sessionTotals`; all three sum to same figure)
1. Parts (`report.js:PARTS`): instruction files, custom tools, built-in tools, tool outputs; then **Other input** row (`otherInput`, folded, kinds via `OTHERS`); then output.
2. Models (`prices.js:providerOf`): grouped by provider; provider subtotal folds models. Each model over every prompt of week.
3. Token types (`report.js:TOKEN_TYPES`): fresh input, cache writes, cache reads, output (`transcripts.js:Stats`). Clamp cache reads/writes exceeding input.

**Toggles**
- `--share`: Values/Share (row ÷ week total, `formatShare`); whole-session total keeps value.
- `--total`: Per session/Total.
- Cost (list prices) is the default view on both doors (2026-10-26). `--tokens` / the page's Tokens: tokens instead, no bounds. `--cost` still accepted, no-op.

**Colour (parts table, cost view only)**
- Every row of the parts table (four parts, Other input and each kind, output, total) coloured by dollars per priced prompt vs `report.js:COST_THRESHOLDS`: green ≤ good, red ≥ bad, yellow between.
- Four parts: the old token bounds (12k/30k, 4k/15k, 22k/36k, 30k/72k) at ~$0.8/M input. Other rows set on this machine's two weeks to 2026-10-26; total = sum of the rows. First cut, one machine.
- Good/Bad columns beside each row. Verdict uses cost per priced prompt regardless of displayed cell (Total, Share).
- Token view: no bounds, columns or colour (owner's call 2026-10-26: models count tokens too differently; `THRESHOLDS` removed).
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
- Kept report: `.thinker/state/report.json`, all windows under `views`. One per repo, shared by worktrees.
- `thinker report` and `--refresh` write it. Page starts `thinker report --refresh --all` in background when older than `REFRESH_MS` (10 min) or made by other code; shows "measured n min ago, updating…".
- Decisions under tables read live (`report.js:reportActions`).
- Save page: outgrown kept report shown at once, remade behind (`context-snapshot.js:lastSnapshot`). Transcripts read on visit only if no kept report or action dropped it.
- Background refreshes run one at a time (`ui/server.js:serialSpawner`).
- `usage.js:parse` caches machine log per process (size, mtime). `transcripts.js:sessionModel` cached in `disk-cache.js`.
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
- While session data is read, a strip just under the header (`page.html:scanProgress`, 2026-11-07, the owner's ask): the sessions read of those found, the share done, what is left and a bar along its lower edge, on every tab including Recent activity (`/api/activity` carries `scan`). It is absolutely positioned off the sticky nav's bottom edge, so it overlays the page and moves nothing below it when it comes and goes; the first cut was a near-black band above the brand, which shoved the whole page down (the owner: bad). Before either it was a 4px grey line under the tabs. The count moves inside a batch: the worker's checkpoints double (1, 2, 4 … total), so the last one read half of every session with the count frozen at the previous power of two; now each of the view's three readers (`instruction-value.js`, `harness.js`, `tool-outputs.js`) calls `onSession` per session and `scan-worker.js:progressOf` counts a new session as read once all `READERS` have passed it, posted at most every 200 ms with no view, and `scans.js` bumps no revision for it, so the stamp moves and no table is fetched.
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
