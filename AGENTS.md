# thinker: internals and working context

Reference for agents and contributors working on this repository. The
user-facing summary is in `README.md`; benchmark results are in
`research/bench-history/RESULTS.md`.

```
agent session ──► distill ──► .thinker/local/notes/*.json ──► orient / lookup (MCP)
                                   │
                          deps + content hashes
                                   │
             commit / edit ──► stale ──► verify (small model) ──► fresh | updated | retired
```

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

**Cache and serving changes need an experiment (MANDATORY):**
- Changes to cache sources (source, code or history selection, note kind) or note serving (ranking, cross-encoder, floors, slots, budgets, serving pool) ship off by default behind a config switch.
- Enable by default only after an Artemis experiment: plan, owner approval, run. Compare with shipped strategy on same tasks. Report numbers and caveats.
- Offline replays are not evidence. Measure outcomes in agent sessions.
- Default-on switch = its own PR citing the experiment.
- Owner-approved freshness policy (2026-10-30): an ordinary dependency edit queues verification while
  the note remains usable (`status: pending`, `recheck`). Preserve its last verified dependency hashes,
  timestamp and commit until verification succeeds; do not silently rebaseline. Missing files/symbols
  and explicit contradictions stay withheld. `refresh` migrates legacy hash-only stale notes to pending,
  and maintenance plus `thinker verify` handle both states, including the desktop session queue.
  This is the owner's explicit policy choice after cancelling the serving experiment; dense fallback,
  CE rescue and serve-stale switches remain off. A changed hash alone is not evidence of a wrong claim.
- Owner-approved exception (2026-11-01, `devin-compaction.js`): Devin's own compaction threshold is written into its user config (`agent.compaction_threshold_tokens`) at `DEVIN_COMPACT_AT`, the proxy's trigger (140k), **on by default** with no experiment. Devin has no model endpoint, so its compactor is the only context reduction it can have; `devin: { compactAt: 0 }` (`THINKER_DEVIN_COMPACT_AT=off`) turns it off and restores what was there. Proven live at 140k: six turns of heavy reads peaked at 143k and fell to ~100k at each applied compaction, where the same workload without the key climbed to 297k (`docs/agent-integrations.md`). What each compaction took out is measured from Devin's session database either way, per later call as the proxy's clears are. Savings claims still need an experiment: judge by summary calls and cache rewrites, not tokens removed.
- Off behind switches, awaiting an experiment (2026-10-28, `ops.js:servingConfig`, `serving` in `.thinker/config.json`): `denseFallback` (`THINKER_SERVE_DENSE_FALLBACK`) scores the notes with the local embedding model when no note shares a word with the request, serving the best above `denseFloor` (0.35, `pack`'s own `minRel`); `ceRescue` (`THINKER_SERVE_CE_RESCUE`) serves the best candidate the cross-encoder vetoed rather than nothing; `serveStale` (`THINKER_SERVE_STALE`) serves a stale match with its ⚠ banner instead of holding it back, which revises the mutable behavior "the prompt hooks serve no stale note". Environment wins over config. Each answers one measured miss reason; none is on until an Artemis experiment measures it in agent sessions.
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
  door into: the Claude Code status row (terminal and the desktop app), the Codex desktop card, the
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

**Hooks never run or rewrite test commands (MANDATORY, 2026-10-30):**
- Thinker is the cache and context reduction harness. The test wrapper and its automatic command interception have been removed.
- Legacy `hook pre` calls do nothing; wiring refresh removes those hooks while preserving other hooks.

**Telemetry and tests (MANDATORY):**
- Set `THINKER_TEST=1` for tests, benchmarks, eval harnesses, scratch experiments, and their setup/install steps (`npm test` sets it).
- It blocks production telemetry and automatic background work, keeps usage logs local, silences machine-wide hooks, and suppresses coverage offers (hooks, `orient` over MCP).
- `THINKER_OFFERS=on`: restore offers, offer tests only.
- `THINKER_TELEMETRY=off`: extra telemetry-only control.
- Every child process must inherit these settings.
- Never send these runs to the production telemetry endpoint or count them as usage.
- Telemetry tests use mocked requests or isolated loopback only. Never contact production.

**Benchmark caches (MANDATORY):**
- Build only through product paths: `mine-prs` (GitHub or `--git`), or `understand` (`src/understand.js`).
- Forbidden: `seed`, synthetic agent sessions, distilling a benchmark's own eval traces, hand-written notes.
- Nothing from the task's future may be reachable:
  - Build at an anchor commit at or before the earliest task base in that repo.
  - Each task gets a copy, topped up only with changes merged before its own base.
  - Verify the fix commit is absent from the cache's build checkout.
- Record anchor commit, what was mined or read, source hashes, and model and effort of every building call. The cache builder may differ from the coding model (owner-approved, 2026-11-05); record both separately.
- Missing, failed or empty cache stops the run before coding. No fallback.
- Historical session-learning experiments are not valid caches.
- `research/performance-canary/guardrails.py` enforces this (`cacheSource: recent-merged-prs`). `research/efficiency-simple/run.py` mines only.

**Matched models (MANDATORY):**
- Compare arms only with the same exact model and reasoning effort within each compared phase: exploration, coding, judging. Cache building is a separate phase and may use a different model and effort from coding; a Sonnet-built cache may be evaluated with Opus. Keep the cache fixed unless cache selection is the declared intervention.
- Keep agent config fixed except the declared intervention.
- Record every phase's model before running. Disable silent provider/model fallback. A model or effort mismatch between the coding arms invalidates their comparison; a different, explicitly recorded cache-builder model does not.
- Prefer executable tests for correctness. Report correctness, tokens, latency separately.
- Different models or reasoning settings go in separate cohorts, never one ranking.

**Evals only through Artemis (MANDATORY):**
- Run, follow, read benchmarks only via Artemis (`~/src/artemis`; start with `bin/artemis-up`; web app and MCP server).
- Follow `.agents/skills/run-evals/SKILL.md`: `create_pr_set` (freeze PRs); `plan_cache` / `build_cache`; `plan_experiment`; user approves each plan; `start_experiment`; read with `get_experiment`, `get_session`.
- Never start the task runner (`~/src/task-runner`) or run `mine-prs` by hand.
- Never report numbers computed by hand from run files.
- Artemis and task runner use thinker only via CLI: `thinker mcp`, `hook`, `guide`, `served`, `spent`, `export --dir`, `version` (`src/commands/external.js`). Changing their output or input is an interface change: stay compatible or change Artemis in step.
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
| `src/ops.js` | serve, merge, assess, link |
| `src/deps.js` | dependencies, symbol hashing |
| `src/ast.js` | tree-sitter boundaries (default); regex fallback in `deps.js` |
| `src/disk-cache.js` | machine-wide results cache (`~/.thinker/cache`) |
| `src/codegraph.js` | call graph: `fanout`, callers, callees, `findSymbols` |
| `src/rank.js` | BM25, relevance gate, budget packing |
| `src/distill.js` | transcript to notes and assessments |
| `src/maintain.js` | background maintenance, daily cap |
| `src/skills.js`, `src/commands/skills.js` | SKILL.md cards; `thinker skills` (`docs/skills.md`) |
| `src/instruction-value.js`, `src/context-view.js`, `src/commands/context.js` | `thinker context`, Context tab |
| `src/guard.js` | anchoring guard |
| `src/update.js` | self and background updates |
| `src/usage.js` | usage log summary |
| `src/delivery.js`, `src/delivery-journal.js`, `src/commands/prs.js` | `thinker prs`: the pull requests the sessions here produced, what each cost and what was saved on it, in tokens and in netted dollars |
| `src/delivery-telemetry.js` | the same as counts and tokens, for the telemetry payload's `prs` block |
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

The installer (`install.sh`) installs the tool wherever it is run and wires
it into the agents on this machine (`thinker connect`, below). Every git
repository on the machine has a cache from then on:
the first hook, MCP server or cache command in a checkout starts one, empty
(`store.js:init`, kept out of `git status` through `.git/info/exclude`), and it
grows from the sessions there. Nothing is built, and nothing is opt-in. **Background
learning was cut to the sessions on 2026-10-21 (the owner's decision: the cache's
background spend was not paying for itself, and few people were running it;
`d84af6795`):** the warm-up that read a repository's merged pull requests into the cache
went entirely (the command, the page's tab and its build queue, the offer the hooks and
the MCP server made, the installer's and setup's `--build`, which are accepted and
ignored), and maintenance mines no pull requests or commits, walks no area history,
reads no design documents or skill files and merges no duplicates unless the
repository's `maintain` config turns each on (`maintain.js:DEFAULTS`). What is left on
by default: the once-per-session distillation, and a maintenance run that re-verifies
at most 3 stale notes and phrases the new ones. `mine-prs` and `understand` stay,
unlisted in the help, for Artemis's benchmark caches alone. What the installer does
show at once is where the agents' context goes, read from their transcripts
(`context-machine.js`; the Context view below): on a terminal it asks whether to see what to cut first in the browser or there, where the suggestions are a multi-select of the actions the page's rows would take, applied through the same `approveChanges` (`setup/context-ask.js`, `thinker context --machine --ask`, 2026-10-22); in the browser the page opens on All with the same suggestions checked and their actions picked, once, for the person to review and Apply (`context-machine.js:suggestedPicks`, sent with `/api/context` as `suggested`; `page.html:preselectRows`; 2026-10-24), and since 2026-10-29 the terminal's multi-select comes checked the same way. The paragraphs on the build below are
history: how it ran until then, kept because the mining code is still what Artemis
builds caches with. Outside a git repository there is nowhere to keep a cache: the CLI's cache
commands stop with that message (`cli.js:CACHE_COMMANDS`), the MCP server
offers no tools and says so in its instructions, and the hooks are quiet. A
prompt an empty cache has nothing for is logged as a request all the same
(`commands/hooks.js`), so `thinker usage` and the telemetry count the machine
as active; before 2026-10-12 it was not, and a machine in daily use read as
idle until its cache had learned something.

The wiring lives in the agents' own settings, once per machine, since
2026-10-04 (`clients.js:wiringFiles`, scope `user`): `~/.claude/settings.json`
and `~/.claude.json`, `~/.codex/hooks.json` and `~/.codex/config.toml`,
`~/.gemini/settings.json`, `~/.cursor/hooks.json` and `~/.cursor/mcp.json`.
`thinker connect [--clients …]` writes it and needs no repository; `setup`
runs it as its first step, and so does the installer. A hook there names no
`--repo` and reads the checkout from the agent's input (`cwd`, Cursor's
`workspace_roots`; `commands/hooks.js`); the MCP entry pins no `THINKER_REPO`
and the server takes the repository from the directory the client starts it
in, asking a client that declares MCP roots for its workspace when that
directory is not a repository (`mcp.js`). Before that, `setup` wrote the
hooks and the MCP entry into each checkout's own files, which the Codex
desktop app does not read (openai/codex#13025: it loads MCP servers from the
user's `config.toml` alone), and a fresh worktree had none of them. The
checkout's machine-local wiring of this copy is taken out by `setup` and by
the first hook at user scope that runs there (`clients.js:stripRepoWiring`),
named once at the end of the turn; committed wiring (`--shared`, `.mcp.json`)
stays, and a hook at user scope yields to a checkout whose own files run this
copy's hooks (`clients.js:repoWiredByCopy`), so nothing fires twice.
`thinker uninstall --user` removes the machine-wide wiring; the installer's
`--uninstall` does that outside a repository. A machine set up before this
needs no step: the `rewire` that `thinker update` runs wires the user's
settings for every agent the known checkouts wire to this copy, with the
options they were set up with (`clients.js:connectFromCheckouts`).

`thinker setup` connects the agents (above), adds the repository's own pieces
(git hooks, Cursor's always-applied rule, Codex's trust in the project,
`.thinker/`), and then asks whether to build
the cache from the merged pull requests, since that is the only
step that spends anything (`setup.js:confirmCacheBuild`). The question defaults
to no; `--build` answers yes without asking (so does `--yes`, or naming
`--prs`/`--pr`), `--no-build` answers no and leaves a repository that
is set up and learns from sessions. Outside a terminal the answer is no.
Declining, or having no authenticated agent, no longer stops setup: step 1 has
already run and the footer says how to build later.

The build itself (`thinker setup --build`, or the installer with `--build`; history, see above):

1. distills up to 60 merged pull requests of the GitHub `origin` into fix
   records, invariants and conventions (`--prs n`; needs `gh`);
2. links the notes and writes search phrasings (eight notes per call,
   `ops.js:phraseBatches`); it also drafted behaviors, until that step and
   `thinker system propose` went on 2026-10-30 (below). Batched because
   `claude -p` exits 1 when an answer reaches its output cap, and a failed batch
   costs its own notes only; the retry is `thinker phrase`, never a second build;
3. last and optional (`--no-docs`), reads the checked-in design documents into
   system behaviors (`behavior-docs.js`), at most eight a build
   (`setup/steps.js:DOCS_LIMIT`; maintenance reads the rest), then the skill
   files. Last since 2026-10-12 because it is the least exercised path of a
   build, so a problem there costs nothing that came before.

On a terminal the build shows one progress bar on its last line
(`setup/ui.js:progressBar`, fed by `progress.js:buildProgress`): the share
done, the time left, and the stage's counts (pull requests mined, documents
read) with the item in hand; the stage headlines and results print above it.
The page's bar reads the same model from the mining batch's file
(`ui/server.js:jobProgress`). The agents (`--clients claude,codex,cursor,gemini`, `all`,
   or `auto`, the default) were connected in step 1.

A build does not explore the code, and no command does: exploration sessions
(`thinker seed`, `setup --areas n`) were removed in 0.1.22. They cost about 400k
tokens per area against 14k per pull request and gave few notes back, and a
"skipped" exploration line read as a failed step to the agents running setup.
The build says once that its notes come from pull requests; `--areas` and
`--no-seed` from old scripts are ignored.

Both steps run through an installed agent with its own login (`--agent`
picks one). Measured on this machine's log: about 14k tokens per
pull request (`setup/estimate.js:TOKENS_PER_PR`). The estimate is printed
in tokens and minutes before anything runs, never in dollars: decided 2026-10-04,
since most agents run on subscriptions and a figure from API list prices told
people they would spend money they would not. In a terminal `setup`
asks before spending (`--yes` skips the question). The hooks and MCP entry live in the agents' own settings. Team wiring with
`--shared` is no longer supported.

To mine more pull requests later (for a benchmark cache: unlisted since 2026-10-21), run `thinker mine-prs` (`thinker learn
--prs` is gone). With no arguments it takes the
GitHub `origin`, mines what was merged since the last run and then goes
further back in history, 20 at a time (`--limit n`). Without GitHub, or
with `--git`, it mines commits from git history; `--fixes` keeps only those
whose message says they fix something (`prs.js:FIX_LIKE`), the records a
reviewing agent draws on most; a repository whose work lands by direct commits has
few pull requests, and this one had 8 to mine against 17 fix commits. With GitHub, mining
read merged pull requests alone, so a change pushed
straight to the default branch is never mined there (188 of this repository's 551
first-parent commits since 2026-09-19 name no pull request). So those commits are listed
beside the pull requests, unless `mining: { commits: false }` in `.thinker/config.json`
(or `THINKER_MINE_COMMITS=off`; the variable overrides the config) says otherwise (`prs.js:listMergedChanges`, `commitsOn`):
a pull request keeps GitHub's description and review comments, a commit is mined from
its message and diff as with `--git`. On by default without an experiment, at the
owner's decision (2026-10-19), an exception to the rule below.
A cache warmed before that read the pull requests alone, and in a repository developed
mostly by direct commits it stayed small. Maintenance finds such caches without a model
call (`commits-offer.js:scheduleCommitsOffer`, at most weekly, on a GitHub repository whose
cache has read some history): when 20 of the last 500 first-parent commits are direct,
unmined and not chores, the next prompt asks the person once ("thinker found N unmined
commits", `<thinker-unmined-commits>`) to mine them, no or never; a yes runs `thinker
mine-prs --direct` (only commits naming no pull request) in the background through their
agent's login, or the session in a desktop app (`answerCommits`, the MCP `commits` tool,
`thinker commits --answer`). No waits a month; never stops it on the machine
(`THINKER_HOME/state/commits-never`); `maintain: { commitsOffer: false }` turns the check
off. `thinker commits` prints the count. Every
pull request it
has looked at is recorded in `.thinker/prs.json`, which is committed with the
notes, so none is distilled twice, by you or by a teammate. Pull requests merged
after thinker was set up are distilled by background maintenance (see [The
learning loop](#the-learning-loop)); `mine-prs` is for history before that.

## Project cache builds

History: the project file narrows the mining commands, which left the product on 2026-10-21; nothing a person runs
reads it now. `thinker.project.json` at the repository root stores `{version: 1, name,
directories: [repo-relative paths]}`. `src/project.js` validates paths and reads
it for cache-building commands only. `thinker project init <dirs...> --name ...`
creates it without initializing a cache. Interactive setup (`src/setup/project.js`)
offers Full repo or Specify project directories before the usage estimate; `--yes`
reuses the file. `--project file` chooses another file; `--full-repo` overrides it
for one run. Choosing Full repo in the menu updates an existing default file to
`directories: ["."]`.

`planAreas` / `discoverAreas` use literal git pathspecs before clustering and
cannot widen a selected deep directory into its parent. No command calls them now
(the behavior interview that listed the main areas is removed, with `thinker system define`). Groups use
128 KiB of source (roughly 32k tokens) and 80 files as per-session working-set
heuristics, not a repository coverage limit. Small sibling groups share a session;
oversized directories split recursively, including flat directories split into
explicit file batches. A single oversized file stays intact. Every eligible
source file belongs to one group; tests are used only if no production source is
available. Size and git churn determine execution order, and an explicit cap
selects from that order. These sizing heuristics are not empirically calibrated.
Setup passes the same directories to estimates and PR mining. Scoped PR scans keep a directory-keyed
cursor; only successfully processed changes enter the global mined record, so
unrelated PRs remain available to other builds. Git history uses directory
pathspecs; GitHub uses the listed changed paths with bounded scans. All projects
share the repository's notes. Retrieval and automatic maintenance do not
load the project file; existing dependency paths provide retrieval relevance.

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
- `THINKER_LOG`: path, `local` (`.thinker/log.jsonl`), or `off`.
- `THINKER_NOTES_DIR` runs log locally by default. Harnesses installing real hooks MUST set `THINKER_LOG=local`.
- Log keeps first 200 chars of each request.
- Use `attemptedHitRate`; `hitRate` is legacy.
- `late` servings (edit hook) are logged only when they serve (`ops.js:lateLocked`).
- `thinker usage [--here] [--days n] [--json]`.
- Savings count only `confirmed` servings. Estimate, not measurement.
- Not counted as reading (`usage.js:countsAsReading`): `.claude/`, `.codex/`, `.cursor/`, `.gemini/`, `.mcp.json`, git internals, `.thinker/`, build/run output.
- Anchors MUST be existing files (`ops.js:createNote`).
- Build/run output is refused as anchor (`deps.js:TRANSIENT`): `node_modules/`, `dist/`, `coverage/`, `.next/`, `__pycache__/`, `bench/runs/`, `.thinker/`, `*.log`, `*.tmp`.
- Agent configuration is a valid anchor. A note with no other anchor is refused.
- MUST NOT show dollar costs or estimate cost from tokens. Provider-reported cost is data only.

## Staleness is a claim about the code, not about the note

A dep's hash moving means the code the note rests on changed. It is not evidence that the note is
wrong, and it was being used as if it were. Measured 2026-10-28: of the notes marked stale the
verifier answered `still_valid` on 53% across production (664 of 1,246) and 51% on this machine over
all history (321 of 627), with 6 of 664 of those passes later doubted — so the verdict is reliable and
about half of all staleness was never a real change.

The hash itself is right. Checked the same day: of 543 changed deps behind this repository's stale
notes, only 10 (under 2%) differed by comments or whitespace alone, so a hash that ignored cosmetic
edits would clear almost nothing. What changed is real code; what does not change is what the note
claims about it.

What followed from the mark was the problem:

- The hooks withhold every stale note (`freshOnly`). Still true. Serving it with its ⚠ banner instead
  is the `serveStale` lever, off until an experiment.
- A withheld note could never be verified. `maintain.js:pickStale` re-verifies the stale notes *served*
  recently, and a withheld note is never served: withheld → never served → never eligible → stale for
  good. On this repository that was 318 stale notes with **1** eligible. Being held back is now
  recorded (`ops.js:orient` sets `heldAt`, a `LOCAL_FIELDS` entry) and counts as the demand it is, so
  the same 318 fill the batch and clear in about three weeks.
- A withheld note was then deleted for not being served. `deleteUnused` now keeps a note wanted within
  the window, and the window is 30 days rather than 14.
- The backlog those three had already built up (318 of 440 notes here, 1,236 of 2,683 across
  production) was cleared in one step on upgrade, rather than left to drain through the verifier over
  weeks: the reset below.
- A note whose files are all **gone** was treated as stale, and stale is the one thing it is not
  (2026-10-30): `file removed` is not a change a verifier can judge, there being no code left to read,
  so the note went round that same loop for ever — withheld, never served, never eligible — and the
  reset puts it straight back, since re-hashing a gone file gives `missing` again. Thinker refuses such
  a note at creation already (`ops.js:createNote`: an anchor must be an existing file), so `refresh`
  now applies the same rule to one whose files went away afterwards: `status: 'invalid'`,
  `invalidReason: 'anchors removed: …'`, logged `retire-gone`, no model call
  (`ops.js:anchorsGone`). Nothing that was being served stops being served. A desired behavior, a
  skill card and a note a person wrote are left alone — those are a person's to decide on, and they
  stay stale with their banner. Found in a user's cache: 13 of 68 notes pointed at deleted files, nine
  of them at a `docs/design/` directory that no longer existed.

### The one-time staleness reset

`stale-reset.js`, run once per repository by `thinker rewire` after an update, beside
`retire-background.js`. Every note marked stale is re-baselined: its deps re-hashed against the
working tree and the `stale` block dropped, which is exactly what a `still_valid` verdict does to the
record (`ops.js:verifyNote`). Setting the status alone would change nothing, since the next `refresh`
re-derives staleness from the stored hashes.

Statuses are brought up to date first (`refresh`, as `thinker check` does), because staleness is
worked out when a note is checked, not when the code changes: a cache holds notes that are stale and
not yet marked, and clearing only the marked ones would leave those to go stale on the next prompt.
On this repository 324 notes were marked stale on disk and 325 would clear.

It does not touch `confidence` and does not set `verified`: no model looked at these notes, and a
reset is not a verification. It records `rebaselined` (a `LOCAL_FIELDS` entry) so the notes it waved
through stay identifiable. `invalid` notes, a `violated` behavior and a `broken` skill card are left
alone; only `stale` is cleared. `RESET_VERSION` guards it per repository, and the marker file keeps the
prior record of every note it touched, so `undoStaleReset` can put them back.

**What it costs.** About half of the cleared notes were going to come back `update` or `invalid`
(53% `still_valid` across production, 51% here), and they are now served without the ⚠ STALE banner
that warned the agent. The trade: a withheld note helps nobody, and a wrong one is caught again the
next time its code changes. Owner's decision, 2026-10-28.

## What a note is

A note answers a recurring question, not "what this file does":

| kind       | answers                                                                 |
|------------|-------------------------------------------------------------------------|
| `map`      | where a recurring concern is handled, how control or data flows across files, the shape of a module area |
| `howto`    | how to build / test / run / lint, with the non-obvious flags            |
| `rule`     | what a change must respect: an invariant, a convention, a trap, a fix not to undo, a reason, what changes together and through which mechanism |
| `behavior` | a desired behavior of the system a person wrote; the code must uphold it (see [Desired behaviors](#desired-behaviors)) |

Until October 2026 there were eleven kinds (`location`, `callpath`, `overview`,
`invariant`, `convention`, `gotcha`, `rationale`, `fix`, `cochange`, `howto`,
`behavior`): nobody applied them consistently, the distiller included, and the
serving code had a branch for several. The old names are read as the new ones
wherever a note is read (`store.js:KIND_ALIAS`, `kindOf`), so committed notes,
benchmark notesets and a config written with them keep working; a file is
rewritten with the new kind when the note is next written. The measurements
quoted below with the old names are about those subkinds.

Each note stores: `title`, `answers` (question phrasings, for retrieval),
`body` (3–12 lines with `file:Symbol` pointers), `deps` (files/symbols it
rests on, each with a content hash), `source` (agent / human / pr / doc),
`verified`, `verifiedCommit`, `confidence`, `status` (fresh / stale / invalid).

## Dependency-keyed invalidation

- A dep is `{path, symbol?}`. With symbol, thinker hashes that definition's block; without, the whole file.
- Block found by tree-sitter (grammars: Python, JavaScript, TypeScript, Go, Rust) or regex (`deps.js:findSymbol`). Parser on by default since 0.1.30: `web-tree-sitter` and `tree-sitter-wasms` pinned/installed via `npm ci`. Optional `thinker ast install` into `~/.thinker/ast`; also read from `THINKER_AST_DIR`; disabled via `THINKER_AST=off`. Parser hashes carry `engine: "ast"`; mismatch with regex hash: if regex unchanged, not stale; parser record replaces it (`upgraded`).
- Parser fallback: grammars lag languages. Broken definitions marked (`ast.js:broken`); `astFindSymbol` returns nothing, `locateSymbol` falls back to regex.
- Hashing cached to `~/.thinker/cache`: file definitions, symbol/file hash, dep hash at commit (`disk-cache.js`, `deps.js`). Keys include text/commit and hasher source; entries never wrong, only absent.
- Pointers in body (`core.py:Command.main`, `Foo.bar`) auto-extracted as deps.
- Every `orient`/`lookup` re-hashes deps against working tree. Whole-file deps shadowed by symbol deps dropped (`ops.js:dropShadowedFileDeps`). Code file whole-file deps with named definitions become symbol deps at creation (`deps.js:narrowAtCreation`); `thinker check` narrows further (`narrowFileDep`, `checkNote` with `narrow`): if body names definitions, dep becomes symbol deps; if no definitions named and no changed line holds note's terms, keep file dep with new hash.
- Stale notes ranked lower, served with `⚠ STALE` banner listing changed deps. `verify` log records changed deps.
- `thinker check` persists statuses; `thinker verify` sends stale note, git diff since `verifiedCommit`, current text of every dep to Haiku (default) for verdict: `still_valid`, `update`, or `invalid`. One sentence per verdict, body only for `update`, capped 1,500 tokens (`ops.js:VERIFY_SCHEMA`, `VERIFY_MAX_TOKENS`).

## Capture

1. **Automatic**: `thinker distill <transcript.jsonl>` condenses a session
   (prompts, tool calls with truncated results, the agent's final answer)
   and asks a model for 0–3 notes with deps (`distill.js:MAX_NOTES`; the
   prompt expects 0 or 1, and rules out news of what changed, the state of
   one machine, and what the repository's own docs say). The hooks run this
   in the background once per session (on by default; see below). The
   distiller is shown the notes already resting on the files the session
   touched, and up to four on the topic of its requests by BM25
   (`distill.js:relatedNotes`), and may return one with `extends: <id>` and
   the merged body instead of a new note. Near-duplicate notes (same kind,
   ≥0.5 Jaccard on title+answers) are merged, keeping history. The distiller
   is told that a rule about things changing together must name the
   mechanism (a generator, registry, schema, mirror or test), not list the
   files one session touched, since git history holds that already.
2. **Human**: `thinker add note.json`, or asking the agent in a session to
   remember something, which the distiller then keeps. The `remember` MCP tool,
   for an agent to save a note itself, was removed on 2026-10-21: no guidance
   asked for it after 2026-10-08, and the 16 notes it saved here were confirmed
   5 times in all, 11 of them stale or invalid, against what the distillation
   of the same session writes anyway.

## The learning loop

Each session both consumes and improves the cache:

1. `UserPromptSubmit` hook injects the orientation bundle and records which
   note ids were served in this session.
2. Once per session, the distiller sees the trace **and the injected notes**, and
   returns new notes plus one assessment per injected note:
   `confirmed` (the agent acted on the pointer, nothing contradicted it:
   confidence +0.05), `contradicted` (the trace shows a claim is wrong:
   confidence −0.25, body replaced by the correction, history kept, retired
   below 0.3) or `unused` (after five unconfirmed servings, confidence decays
   towards 0.4). No judge or gold answer is involved; the signal comes from
   the transcript.
3. New notes are linked to existing ones that share a symbol-level dep (or
   several files); `orient` pulls one linked note in beside the best hit
   when it has relevance of its own.
4. Co-change is gone (2026-10-04). Co-change notes were acted on 0 of 5
   times they were served and were archived; the git-mined index that
   replaced them (edit-hook partner hints, the end-of-session nudge, the
   `thinker cochange`, the refresh in maintenance,
   `.thinker/cochange.json`) was never shown to be followed either, and was
   removed with the module. An older cache's `cochange.json` is ignored, and
   its `cochange` notes are read as rules (`store.js:KIND_ALIAS`).

5. Archiving (`ops.js:archiveNotes`, `thinker archive`): a note that the
   sessions showed is not worth serving leaves orientation, the edit hook,
   background verification and phrasing, and stays for `drilldown`, `find`
   and `lookup` by id; `rank.js` scores it like an
   invalid note. Two rules, both free: the kinds named in the config (none
   by default since the collapse to four kinds; before it, location, fix,
   cochange and convention, which in a week on this repository were acted on
   0 of 6, 0 of 12, 0 of 5 and 0 of 3 times when served), and a note nobody
   was served in 30 days since it was made. `archived: {at, reason}` is this checkout's
   state (`store.js:LOCAL_FIELDS`), never shared or pushed; a shared note's
   committed file is untouched. Maintenance applies the rules on every run
   and names the count once; `archive` in `.thinker/config.json` sets
   `kinds` and `unservedDays` or is `false`. `thinker archive [--dry]`
   runs the rules by hand, `--list` shows the archive, `--restore [ids]`
   takes notes back, and ids archive any note by request.
5b. Duplicates by meaning (`dedupe.js`, 2026-10-19; on by default from then until 2026-10-21,
   off since with the rest of the background spend: `maintain: { dedupe: true }` or
   `THINKER_DEDUPE=on` turns it on for a repository): `saveNotes`
   merges only notes whose title and answers share half their words, so the same fact
   mined from a pull request and saved from a session in other words stayed two notes
   (0.30 by that measure) that took both serving slots. Where it is on, maintenance finds candidates for free:
   each note embedded locally from its title and search text (`dense.js:embed`,
   all-MiniLM-L6-v2, vectors kept in `.thinker/state/dedupe.json` by text), a pair being
   two notes on a file in common at a cosine of at least `dedupeThreshold` (0.75). On this
   repository's 337 notes that took 4 to 6 seconds and gave 21 pairs, 17 of them the same
   claim or two disagreeing claims about one thing (by hand labels of the top 40; recall
   below 0.75 is not measured). Up to `dedupePerRun` (3) are judged, one call each through
   the verify model (`dedupe.js:judgePair`, through the session in a desktop app), shown
   both notes and the current code of the file they share: `same` and `conflict` are
   merged into the older note (its id, servings and assessments; both notes' answers and
   deps; the old body in `history`) with the judge's title and body, a conflict keeping
   only what the code bears out, and the other is archived as `duplicate of <id>`
   (`thinker archive --restore` takes it back); `distinct` is remembered and not asked
   again until either note's text changes. Logged as `op: "dedupe"`; the end-of-turn
   notice says how many were merged. Checked before it was turned on: on mlflow's mined
   cache 14 pairs, of whose notes past sessions on its 11 tasks were shown 2, so a paired
   run there could not have told the two apart; no agent-session experiment was run.
6. Since 2026-10-21 background upkeep is small: verification is one batch every three days
   (`verifyEveryDays`), of the stale notes served in the last three days (`verifyServedDays`), at most
   50 (`verifyPerRun`); a note a session contradicted is verified at the next run. A note nobody was
   served in 30 days (14 until 2026-10-28), made longer ago than that, is deleted (`maintain.js:deleteUnused`,
   `deleteUnusedDays`; behaviors, skill cards and notes a person wrote stay, and a note committed to the
   repository is archived instead). After an update, `thinker rewire` stops what an older version left
   running that the new defaults no longer do: a mining batch, the unmined-commits question, queued jobs
   other than distillation, catch-up and maintenance (`retire-background.js`), unless the repository's
   config turns mining on. What follows describes the run as it was before.
   Maintenance runs by itself (`maintain.js:maintain`): the catch-up run that
   the prompt hooks start at most every ten minutes ends with one maintenance
   run, and so do the git `post-commit` and `post-merge` hooks that `setup` and the
   installer put in place (`--no-git-hook` leaves it out). A batch runs at most
   once every four hours, on the next repository activity after
   it is due (including explicit `maintain`; `--dry` previews without waiting).
   Retrieval never spawns verification. By default (since 2026-10-21) a run re-verifies up
   to 3 stale notes (10 before) and writes
   phrasings for up to 8 notes that lack them, and that is all it spends on. The
   steps below run only where the repository's config turns them on: with
   `maintain: { prs: true }` a run distills up to 3 pull
   requests merged since maintenance first ran in the repository (older ones
   are `thinker mine-prs`) and schedules the unmined-commits question
   (`commits-offer.js`). It walks no focus areas: the walk went with the warm-up on
   2026-10-21, and the list it walked went on 2026-10-30 (below). Fixes come first (`prs.js:pickPrs`): a pull
   request whose title says it fixes something qualifies without a body and
   takes up to two thirds of a run's slots when other changes wait; a
   candidate the limit passes over is not recorded as mined and is offered
   again next run (`learn.js:minePrs`, `deferred`). The record of a fix is
   what a review draws on most: on 23 real PostHog regressions every bug the
   cache caught and the diff alone missed rested on a note mined from the fix
   (`research/bench-history/RESULTS.md`, "Real bugs on PostHog"). Re-verification ahead of time is for notes served in
   the last 14 days (`verifyServedDays`; 0: all), or held back from a request that recently wanted
   them (`heldAt`), the most served first; a
   stale note nobody is reading waits until a later batch after it is served.
   Dependency hashes and git diffs since each note was verified identify the
   affected notes; unchanged dependencies cause no verification call. A note
   re-verified 3 times in a week (`verifyChurn`; 0: never) rests on code under
   active change: it is left stale, with its ⚠ banner, and named to the user
   once (`maintain.js:pickStale`), to narrow its pointers or retire it. In the
   week this was added, 28 of 80 notes maintenance verified had not been served
   at all, and one note was rewritten 8 times. The tokens the model calls of
   learning and maintenance reported are summed from the machine's log and a run stops
   at `dailyTokens` (default 1M tokens a day with Sonnet, about 40 distillations, and 10M
   with a cheap model; 2M and 50M until 2026-10-21; until 2026-10-04
   the cap was `dailyCap` in dollars, a key now ignored except that 0 still means no
   cap). `maintain` in `.thinker/config.json`
   overrides `enabled`, `dailyTokens`, `verifyPerRun`, `verifyServedDays`,
   `verifyChurn`, `phrasePerRun`, `prs`, `prsPerRun`, `docs`, `docsPerRun`, `skills`, `skillsPerRun`,
   `dedupe` (with `docs: true` a run also reads up to
   three new or changed design documents into behaviors and reconciles the ones a changed
   document produced: `behavior-docs.js:deriveDocBehaviors`; with `skills: true` it cards up to three
   new or changed skill files, `skills.js:scanSkills`). What a run did is shown once at the end of the next turn
   (`maintain.js:maintenanceNotice`), through the same channel as the
   cache-hit notice. `thinker maintain [--dry]` is one run by hand;
   `THINKER_NO_LEARN=1` switches it off with the rest of learning.

Learning is on by default in `setup` and the installer. Evals keep
the cache fixed with `--no-learn` at install time, or `THINKER_NO_LEARN=1` in
the environment, which also silences hooks that are already installed.
`learn: {"sessions": false}` in `.thinker/config.json` switches off learning
from sessions alone (the session distill and the catch-up `learn`), while
learning from code changes goes on: pull requests and re-verification in
maintenance, `thinker distill <file>` by
hand. Each session distilled is a model call, about 10¢ with Sonnet, and in a
week on this repository 30% of them produced no note; without them there are
also no assessments, so `thinker usage` counts no servings as acted on. The
hooks skip a quiet session (`distill.js:quietSession`): nothing served in it
to assess, no edit, no failed tool call, no correcting prompt, and under eight
exploration calls; logged as `distill-skipped` with `reason: quiet`.
`learn.quietExplore` in the config moves the line (0: distill every session);
`thinker distill <file>` by hand distills regardless. The distiller is asked
only for the kinds worth a note here (`ops.js:distillKinds`): the kinds this
checkout serves, plus the kinds review reads from the archive (`REVIEW_KINDS`:
rule, behavior; behavior is never distilled). A note of a left-out kind that
comes back anyway is skipped by `saveNotes`.

Controls for experiments: `THINKER_NOTES_DIR` (a flat note store for a
benchmark arm), `THINKER_HOOKS=off` (the user's machine-wide
hooks do nothing; a checkout's own hooks are unaffected) and `THINKER_MCP=off` (the MCP server offers no
tools; the control arm of `thinker benchmark`), `THINKER_HOLDOUT`. The
switches of settled experiments were removed in October 2026 (early modes,
the router, forced or naive serving, links and co-change off, the guard off,
cover floors, pointer and snippet limits, the fanout tag, a per-model guide
above `orient`); what they measured is in `research/bench-history/RESULTS.md`, and what won is
the only behavior. A harness that needs the order alone passes `cover: {body:
0, question: 0}` to `rank` and `refreshFirst: false` to `orient`.

## Report

**Tabs and entry**
- Tabs: Find Savings (`--tab save`), View Report (`--tab report`). Old `tab=context|changes|cache` open replacement view.
- CLI only: `thinker list`, `show`, `archive`, `system`. Removed: `/api/usage`, `/api/cache`, `/api/behaviors`.
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
- View Report keeps four PR summary cards under the cache cards: merged with work here, tokens saved,
  share of their cost, and the average one. Both sets of cards show labels and values, without descriptions.
  The PR list lives in Recent activity under **PR savings**, beside the default **Action savings** tab.
  The report leads with **Pull request stats**, followed by **Cost by context** and **Cache/compression effectiveness**; **By model** and **By token type** are collapsed under **See more metrics**. The page defaults to Total and displays savings as a weekly table without a graph. Weekly savings (`report-savings.js`) follow request dates and the report toggles: cache estimates subtract note context; compression dollars are gross avoided cache reads at the model's price, before cache rewrite costs. A request belongs to the last repository its session hooks named, so All repositories counts it once.
  It reads the same `/api/report` data and lists merged PRs newest first: number, title, sessions, cost,
  cleared, reading avoided, saved, share. `thinker report` still prints both summaries and the list.
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
- Cache metrics (`report.js:cacheMetrics`, `usage.js:summarize`): dollars saved first, then tokens saved, cache hits, share acted on.
- All repos = `mergeReports`.
- Output compression: `report.js:outputComparison`; tool row vs prior row (`tool-outputs.js:aggregateOutputs`). Saving green first, cost red. Same two lines under action in `thinker report`.

**Performance and kept report**
- Page never recomputes on visit.
- Kept report: `.thinker/state/report.json`, all windows under `views`. One per repo, shared by worktrees.
- `thinker report` and `--refresh` write it. Page starts `thinker report --refresh --all` in background when older than `REFRESH_MS` (10 min) or made by other code; shows "measured n min ago, updating…".
- Decisions under tables read live (`report.js:reportActions`).
- Save page: outgrown kept report shown at once, remade behind (`context-snapshot.js:lastSnapshot`). Transcripts read on visit only if no kept report or action dropped it.
- Background refreshes run one at a time (`ui/server.js:serialSpawner`).
- Note counting: `store.js:count`, no file reads. `store.js:assertSafeNotesPath` rechecked only when `.thinker` or `.thinker/local` mtime changes.
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

## Internal server

`src/server/` and `infra/sync/` remain internal infrastructure: the team's note
store, excluded from public release archives. It posted pull request reviews
until 2026-10-11 (`action/review/`, removed with `thinker review`). Client
sharing, sync, and staged-note repair were removed; old client sync settings do
nothing. Do not reintroduce team collaboration as part of the product. Personal
backup/restore remain supported.

## Skills

A skill file (SKILL.md under `.claude/skills`, `.agents/skills`, `.codex/skills`, `.cursor/skills`,
`.github/skills`, `skills/`) gets a note of kind `skill` (`skills.js:scanSkills`, one model call per
file, by a build, by `thinker skills scan`, and by maintenance where `maintain: { skills: true }` is set;
off there by default since 2026-10-21): a card that is served like a note and tells the agent to
invoke the skill, with the file and the code the skill names as deps. Staleness is `ops.js:refresh`
as for any note; the verification is `skills.js:auditSkill` (through `ops.js:verifyNote`), which
reads the skill file against the current code and answers holds or broken with the issues. A
broken skill has status `broken` (a LOCAL_FIELDS entry): not ranked (`rank.js`), not listed by
`lookup` by kind, left alone by `refresh` and `pickStale`, until its file changes (the scan rewrites
the card and clears it) or a person reviews it (`skills.js:reviewSkill`; `thinker skills review`,
the button in the UI). A card whose own file changed is left to the scan, not audited
(`maintain.js:pickStale`). Sessions grade skills: `transcripts.js` keeps the skill directory on the
Skill tool call, `skills.js:skillsInvoked` and `skillNotesFor` add the invoked skills to the notes a
distillation assesses (always assessed, `learning-evidence.js`), a contradiction is accepted at once
(`learning-pending.js`) and marks the skill broken (`ops.js:attest`), and a session older than the
skill's present text is not counted (`skillFileTime`). Duplicates: `skills.js:dedupeSkills`, with
`skills.prefer` in the config as the pin. Skill cards are never distilled (`distillSpec`,
`distillKinds`, `saveNotes`) or written by an agent. See docs/skills.md.

**Removed session interventions (owner's decision, 2026-10-30):**
- `thinker test` and automatic test rewriting are removed; legacy `hook pre` calls do nothing.
- Stop hooks never block completion to demand more edits or checks.
- Per-file skill recommendations, their evidence collector/seed/preview commands, and their model-backed outcome judge are removed.
- `thinker prs`, note learning/refresh, instruction-file analysis/judging, questions, and other product behavior retain their existing implementations.

**Built-in tools in the harness advice (off until an experiment, 2026-10-20).** With `harness: { builtinTools: true }`
in `.thinker/config.json` (or `THINKER_HARNESS_BUILTIN_TOOLS=on`; `=off` wins over the config), the harness counts
Claude Code's own tools as sources beside plugins, skills and MCP servers: their definitions from the transcript's
`prompt_snapshot` attachment, a call by name as a use (`harness.js:sessionHarness`, `builtinKey`). One called in under
a tenth of the sessions is advised like any source (`thinker harness`, the Context tab's Built-in tools, where a row
shows the tool's own description) and goes off as a bare name in `permissions.deny` of
`.claude/settings.local.json`; `--undo` takes it out. It was never an option of the harness's own in-prompt question
(2026-10-22, the owner's call: a picker's line has no room for what denying a tool costs, no subagents or no
`/loop`, and the question offered eight tools by their token counts alone), and since that question was merged
away (below) it is a Find Savings row like any other, bold and behind a confirmation. Checked with `claude -p` 2.1.304 (2026-10-20): `permissions.deny`
and `--disallowedTools` both take the definition out of the prompt, Workflow, ScheduleWakeup and ReportFindings
together ~4k tokens a call. Never offered (`CORE_TOOLS`): the file and shell tools, Skill, AskUserQuestion (the question goes through it), and
ToolSearch, whose absence puts every deferred definition inline (+29k tokens a call); an allow-list (`--tools`) does the same, so the switch
is a deny list. Why: on this machine's sessions (Artemis Tokens page, waste view) Artifact (15k tokens) was called in
1 of 65 sessions that carried it, Workflow in 0 of 535. Not known: whether the desktop app's own tools (Artifact,
SendFeedback, absent from `-p`) obey the deny list.

**The funnel, end to end (2026-10-26).** Every decision records the door it came through (`context-suggest.js:VIA`,
on the log line and the history entry): `session` (the weekly suggestion answered in the conversation it was passed on
in — the command the offer text tells the agent to run carries `--via session`), `page` (Find Savings), `setup` (the
install's multi-select), `command` (typed; also every decision from a client before 0.2.11). Telemetry counts
`offeredChanges` (what a summary actually put in a prompt, the denominator of the share accepted — a ranked row nobody
saw is not an offer), `offeredPerPrompt`, and `approvedBy` / `dismissedBy` by door (`spendMetrics`); `suggestedTokens` and `offeredTokens`
from before this carry the old `total`, so they are not comparable across the release; the dashboard reads
them in "Suggested, offered and decided", "Where a change was accepted" and "Changes dismissed, by door"
(`scripts/spend-dashboard.mjs`). Those cards count changes, so one machine deciding many times reads as uptake:
the band opens with three cards that count machines at the same stages instead ("Devices shown a suggestion,
and devices that took one", by day, and by device), the per-day one taking the newest report per installation
so a device identifier that changed between uploads is still one machine. What is still not measured: whether the agent passed the summary on at all — the
message asks it to relay in its own words and nothing records that it did, so an offered change may never have reached
the person.

**One suggestion, not three (2026-10-25, the owner's call).** What thinker puts to the person in their session is
the weekly context suggestion alone (`context-suggest.js:contextSuggestOffer`, `maintain.contextSuggest`, at most
every `SUGGEST.everyDays` = 7 days once the repository has 10 sessions to read): a short message, one line per
change with what it costs and the suggested action, and a link to Find Savings, where every part of the context is
a row. It already ranked instruction sections, skills, MCP servers, plugins, built-in tools and tool outputs
against each other by tokens saved, which is why the other two prompt questions went:
- the harness question (`harness.js:scheduleHarnessSuggestion`, `harnessOffer`, `answerHarness`, the MCP `harness`
  tool, `thinker harness --suggest/--answer/--recurring/--suggestions`, the machine's `harness-never`, the
  `/api/harness/suggest` endpoint, the small-skill bundle) was removed on 2026-10-25: a second suggestion of a
  subset of the same sources, through each agent's picker, which could not explain a section diff and never
  carried built-in tools. What stays is the advice behind the rows (`harnessAdvice`), switching off
  (`switchOffNow`, which now applies the chosen labels itself), `undoHarness`, the recall line and the report;
- the coverage question (`coverage.js`) stays off by default (`maintain.coverage`, false since it shipped) and was
  held there the same day: it was not effective enough to put to people. It is the only question the hooks can
  still emit, and only where a repository turns it on.
A new thing worth suggesting is a row and a line of the weekly message, not a question of its own.

**And it only interrupts when it is worth it, and says what it is worth (2026-11-04, the owner's ask).**
- **A thin list is not a question** (`SUGGEST.minAsk` = 2 changes, `SUGGEST.askSaving` = 1,000 input tokens a prompt
  together, both in `contextSuggestOffer` as `thin`). Below either floor the block is the lines and the page's
  address with no question at all, said in one line of the agent's own answer. A single change is never a question:
  "1 -- compress repeated tool output, or none?" is what one desktop session was asked in the middle of its own
  work. `minSaving` (15 a prompt) is what makes a line worth printing; these are what make it worth stopping for.
- **Every figure is also money, where this repository can price one.** `report.js:inputRate` is the dollars an input
  token cost here -- the input side of the Report's token-type table, its cost over its tokens, so cache reads count
  at their own rate and not at the input rate -- read off the kept report by `report-snapshot.js:inputRateHere` (a
  file read, no measurement made) and kept with the summary as `pending.rate`. The lead, each line, and the question
  itself carry it (`thinker context`'s Top changes too, the same rate). No kept report, or a model in the window
  with no list price, means no dollar figure anywhere in the message rather than a guessed one.
- Why: a suggestion nobody can value is one nobody acts on, and "34M tokens over 7 days" is not a figure a person
  can place. It is the only place outside the Report and PR comments where thinker says dollars; `prices.js` is
  still where they come from, and the message says they are list prices and that a subscription bills none of it.

**The one exception (2026-10-28, owner-approved): the offer to turn the context proxy back on** (`proxy-offer.js`).
A one-off repair of a fault thinker caused, not a recurring suggestion: the machines whose harness the proxy broke
turned it off, `off` is durable by design, and the hint a stand-down prints is said once to someone whose session is
already failing, so those machines were the ones getting no clearing at all. Asked once per machine, first in the
hook's one-question chain (`proxyOffer || errorOffer || coverageOffer || contextSuggestOffer`), through the agent's own question
tool, answered through thinker's `proxy` MCP tool (`mcp-server.js`) or `thinker proxy --answer yes|no|never`. The
cohort is a machine whose proxy is off and was once on, either before `FIXED_AT` (2026-10-28, so the fault was live
when they turned it off) or by a stand-down, which only the fixed code does; a cloud route is never asked, since the
proxy cannot speak those formats and there would be nothing to say yes to. Where the machine routes Claude Code
through a model server of its own, yes means `--gateway` (`enableProxyService`), the only thing that puts the proxy
in front of one. Any answer closes it for good -- asking twice is pestering someone thinker already broke once --
and the counts reach the telemetry as `proxy.offer` (`asked`, `yes`, `no`, `never`). No model call anywhere in it,
so it works in a desktop app with no CLI signed in.

It is a question the agent must put to the person, through its own question tool (2026-10-27, the owner's ask;
`QUESTION_TOOLS` by client, in chat where there is none and for Codex, as `coverage.js` does), **and it says it is
thinker asking** (2026-10-29, the owner's ask): the person sees their own agent's picker, so a question that reads as
the agent's own idea leaves them deciding what to cut out of their context without knowing who asked or what will act
on the answer -- and of the four questions thinker has an agent ask, the one that cuts waste was the only one whose
text never named it ("Cut what loads into every session here?", header "Context"). Every offer now builds its
instruction from one clause (`repo-onboard.js:askThrough`, `askInChat`, `QUESTION_HEADER` = `thinker`), which carries
the name in the question and in the header and tells the agent to reword neither; the chat fallback opens the line
with `SIGNATURE`, there being no header to carry it. A fifth question goes through the same helper, and
`test/cli-ui-sync.test.js` holds that for all four modules. Until then it was prose
the agent was asked to relay, and the three devices shown one decided nothing at all: a relayed message can be skipped
by the agent, skimmed by the person, and leaves no answer either way, so nothing told "not interested" from "never
reached them". The answer comes back through thinker's own MCP tool, `context` (`answerContextSuggestion`, registered while
`contextSuggestAwaiting`, as the harness question's tool was until 2026-10-25 and the coverage tool still is): the
agent hands in the numbers the person chose and thinker resolves them against the list it showed and makes the
changes, so nothing depends on the agent composing a command line, and a desktop app answers the same way. The
command (`--via session --approve|--dismiss all`) is the fallback where the client speaks no MCP, and the typed door.
Both answers are recorded: numbers approve, none leaves them alone until the next weekly summary
(`SUGGEST.dismissedDays` = 6 days, one under the cadence so a dismissed change never skips a week; a month until
2026-11-04, the owner's call), and `context-answer` keeps whether they
answered through their agent's question tool or in chat (`actions.answers` in telemetry), so the funnel has a
denominator, a no, and evidence the question was put as one. Built-in tools are named with the page link and never offered as options
(the rule of 2026-10-22, PR #441: a picker's line has no room for what denying one costs), and with nothing else to
ask about the block is the page link alone. The accept path is that answer (`thinker context --days 7 --via session
--approve 1,3`) or a row on Find Savings. A reply's numbers are the lines the summary showed, kept as `offered` in
`<cache>/state/context-suggest.json` for `SUGGEST.answerDays` and read by `offeredChanges`; `--via session` is what
says so. Resolved against a list recomputed at reply time, as until 2026-10-27, "1" applied whatever ranked first
then — every session of the window moves each part's cost a prompt, and three sections within 3k tokens reordered on
one more session, so approving the first line compressed the third. Without `--via session` the numbers are the five
the command has just printed, which is what someone typing it is looking at; a key names a change either way
(`pickChanges`). The page sends keys, never numbers.

**The question carries the page, and the page opens on what was asked (2026-10-29, the owner's ask).** A line of the
summary is a title, two figures and a share; the section's text, the skill's description and the diff a compression
would make are not in it, so the question itself names the page address (`contextSuggestOffer`'s `question`, and the
chat fallback's clause) rather than leaving it to a line of the block the person never sees. That link says which door
sent them (`suggestionsUrl(url, repoId, { from: 'suggestion' })`), and the page opens with **those** changes checked and
each row's dropdown on the action the question suggested (`offeredPicks` → `/api/context` `offered` →
`page.html:preselectRows` on `from=suggestion`), so reviewing is the same decision with the detail in front of them and
Apply is the answer. Not the page's own ranking (`suggestedPicks`, which `from=setup` uses): it is recomputed on arrival
and carries no tool output, so it would check rows the question never showed. A link followed after `SUGGEST.answerDays`
brings no list, as the numbers no longer stand either, and the suggestions stand in for it. The installer's terminal
multi-select comes checked too, as the browser answer's page always did: unchecking what should be kept is the work,
`n` clears them all and Esc applies nothing (`setup/context-ask.js`).

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

## Desired behaviors

Every other kind of note is a claim about the code, and when code and note
disagree the note yields: verification rewrites or retires it. A `behavior` note (`behavior.js`) is the other way round: a
person writes down what the system must do and where that is upheld, and from
then on a change must conform, or be called out for not conforming. The
rule since 2026-10-04: **before a merge the behavior is the truth, after it
the code is.** A pull request that stops upholding a behavior is told so, in
full and first (a fixed behavior loudly, see Review below); once the change is
merged on the default branch the behavior is revised to match the code, with
the old text in its history. Behaviors are never evaluated against a gold set;
the review's callout and the person's decision to merge are the check. `thinker system` is the view of them; the MCP
`lookup` with `kind: "behavior"` returns them to an agent (all of them with no
query); `thinker system md` writes them as `.thinker/SYSTEM.md` for people who
read the repository without the tool. Legacy committed behaviors remain
readable; new behaviors stay local.

- **Fields.** A behavior is an ordinary note (title, body with `file:Symbol`
  pointers, answers, deps) plus `mutability`: `fixed` (a review treats a
  change that stops upholding it as an error and requests changes, with the
  behavior quoted in full) or `mutable` (the default; a warning, and a pull
  request may revise it by editing the note itself). Both follow the code
  once a change is merged. `mutability` and `revised` ({at, commit, reason},
  set when the merged code rewrote it) are shared content; `violated` is this
  checkout's state (`store.js:LOCAL_FIELDS`).
- **Who writes one.** A person: `thinker system add file.json [--fixed]`, or
  `thinker system promote <id> [--fixed]` for a note that already states a
  rule (`thinker list` shows the notes and their kinds). Behaviors agents saved
  with the `remember` tool before it was removed are listed as *proposed* until
  `thinker system accept <id>`. Distillation and PR mining are not offered the kind
  (`distill.js:distillSpec`, `prs.js`), archiving never takes one
  (`ops.js:archiveReason`).
- **Build proposals, and `thinker system propose`, are gone (2026-10-30, the owner's call).** The last
  step of a cache build drafted up to twelve high-signal rule notes into desired behavior candidates in
  `.thinker/local/behavior-proposals.json` (`behavior-proposals.js`), and `thinker system propose` was
  the only place a draft was ever shown: no notice, no page row, no prompt line. The build went on
  2026-10-21, so no draft has been written since, and a user's drafts from the day they installed were
  still sitting unreviewed eleven days later, in a cache whose state they were reading by hand. The
  module, the subcommand, its `--refresh`, the drafts in the workbench (`behavior-workbench.js`), the
  `proposal-` ids in `accept` and `behavior.js:proposeBehaviors` are all removed; `thinker system
  propose` says so and points at `thinker list`. `thinker rewire` drops the leftover drafts file
  (`retire-background.js`). `promote`, `accept` for an agent-saved behavior, `add`, `edit`, `rm`,
  `docs` and `md` are untouched.
- **Verification** (`ops.js:verifyBehavior`, through `verifyNote`): when a dep
  changes the question is whether the code still upholds the behavior.
  `holds` re-baselines; `moved` re-points the deps at where the behavior is
  upheld now (history kept). `broken` depends on where the code is
  (`ops.js:onDefaultBranch`: the deps' files committed, and `HEAD` reached by
  origin's default branch, or a local `main`/`master` without a remote). Not
  merged (a working tree, a branch, unpushed commits): `status: violated`
  with the commit and the reason, deps re-hashed so the note reads as
  violated rather than stale until the code changes again, text untouched,
  named at the end of the next turn (`ops.js:noteUnreported`,
  `maintain.js:maintenanceNotice`) and served with a `⚠ VIOLATED` banner.
  Merged: the model is asked for the behavior as the code upholds it now, the
  body is replaced (pointers of the new text join the deps), `revised` records
  the commit and reason, the old body goes to `history`, the verdict is
  `revised`, the notice says so and `.thinker/SYSTEM.md` is rewritten. A
  behavior is never retired by verification, and never rewritten for code
  that is not merged. On the server the clone sits at the default branch, so
  the behaviors there follow every merge and sync out.
- **Review** (`review.js:assessBehavior`, and the holistic prompt): the
  verdicts are `violation`, `consistent`, `unrelated` and `revised`; `revised`
  only for a mutable behavior whose note file the change edits
  (`review.js:noteFileChanged`, in the scope under review), otherwise it is a
  violation. A violation without a placed finding gets one at the first
  definition the change touched. A finding on a fixed behavior is an error,
  on a mutable one at least a warning, so `--strict` exits 2 in CI. The
  posted pull request review (`review-post.js:buildReview`) opens with a
  violated fixed behavior before anything else: its title, its full text
  under "What it requires", what the change does instead (the model's
  reason), and what merging means (the code becomes the truth and the
  behavior is revised to match; restore the enforcement if that is not
  meant). A violated mutable behavior gets the same block under a quieter
  heading. `renderReview` says the same in one line for the CLI. The
  holistic call may not list a behavior under `outdated`: one it does is turned
  into a finding. The report carries `behaviors`, one line per behavior in
  play (`upheld`, `violated`, `revised`, `unrelated`, or `consulted` on a dry
  run) with whether it was already violated before the change, rendered under
  "Desired behaviors" and in `--json`.
- **This repository's own** (`thinker system`, `.thinker/SYSTEM.md`), written
  2026-10-03: a review never writes to the cache; verification never rewrites
  or retires a behavior; serving and assessment never rewrite a shared note's
  committed file; `THINKER_TELEMETRY=off` and test runs send no telemetry (all
  fixed); the prompt hooks serve no stale note (mutable).
- **Serving.** A behavior is served like an invariant: at orientation with a
  small kind prior, by the edit hook when a file it rests on is edited
  (`ops.js:lateNotes`, first among the rules), and in `thinker review`'s
  consulted set with the highest kind weight.

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

| agent | request notes | edited-file notes | MCP | user files |
|---|---|---|---|---|
| Claude Code (incl. desktop) | each prompt | yes | yes | `~/.claude/settings.json`, `~/.claude.json` |
| Codex CLI (incl. desktop) | each prompt | yes | yes | `~/.codex/hooks.json`, `~/.codex/config.toml` |
| Gemini CLI | each prompt | yes | yes | `~/.gemini/settings.json` |
| Cursor | each prompt (`additional_context`); first-tool fallback for `agent -p` | yes | yes (needs approval) | `~/.cursor/hooks.json`, `~/.cursor/mcp.json`, `.cursor/rules/thinker.mdc` |
| Devin CLI and Devin Desktop's local agent | each prompt | yes | yes (`learn_next` allowed in `permissions.allow`) | `~/.config/devin/config.json`, `~/.config/devin/mcp_config.json` |
| Pi, Windsurf, Copilot CLI, OpenCode, Factory Droid, Qwen Code, Kiro CLI, Cline, Kilo Code, Auggie, Goose | see `docs/agent-integrations.md` | | | agent's own files |

- Edited-file notes are on by default; `--no-late` omits them.
- Plugins under `plugins/` run `thinker hook … --plugin` and yield to host hooks (`clients.js:pluginYields`).
- Pi: `npm/pi/thinker.js`. `thinker proxy --notes` (`proxy-notes.js`) serves agents without prompt hooks (Goose, Aider); off by default.
- One copy per checkout (`clients.js:pruneInstalls`). `setup` removes other copies' hooks and repoints MCP. Claude Code `--local` empties the shared settings file.
- Prompt hook prunes gone or older copies (`olderOnly`), logs `op: "prune"`. Never delete old copy's files.
- Wiring follows installed version (`clients.js:refreshWiring`, `inferWiring`, `installClient`). Rewrite only this copy's entries; leave hand-tuned commands. Skip temp-dir checkouts.
- `thinker update` runs `thinker rewire`. Manual: `thinker rewire [--here] [--dry]`.
- Cursor: `beforeSubmitPrompt` returns `additional_context`. Headless `agent -p` uses `postToolUse`; agent must call `orient`.
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

Learning works with all four agents, and with others through the generic
path below. Nothing in it is tied to one vendor:

- **Sessions.** `thinker distill` reads Claude Code, Codex, Cursor and Gemini
  CLI transcripts (and the streamed output of their headless modes) and maps
  them to one event form: prompt, tool call with result, agent message. Tool
  names are mapped to one vocabulary, so `read_file`, `Read` and a shell `cat`
  are all seen as reading.
- **When.** Once per session, not per turn: each call carries the prompt,
  schema and related notes whatever the size of the trace, and on 2026-10-03
  one session was distilled 13 times. At the end of a turn (`Stop`,
  `AfterAgent`, `stop`) the hook distills only a backlog near the trace limit
  (`distill --batch`, `distill.js:batchDue`, 45,000 condensed chars); the end
  of the session (Claude Code's `SessionEnd`, Cursor's `sessionEnd`) distills
  the rest. Catch-up covers agents that fire no end: `thinker learn` finds
  every session any of these agents ran in the repository and distills what
  is new in those quiet for 20 minutes (`cli.js:LEARN_IDLE_MIN`). Hooks start
  it in the background at most every ten minutes.
- **What the agent's record leaves out.** Where an agent gives no transcript,
  the hooks record the session themselves (`.thinker/state/trace-*.jsonl`).
  Cursor records tool calls without their output; reads and searches are
  repeated against the working tree when distilling.
- **Model.** Distilling, verifying and PR mining run through whichever agent is installed, with the login it already
  has: `claude -p`, `codex exec`, `agent -p` (Cursor) or `gemini -p`. A
  session is distilled by the agent that ran it when possible. `THINKER_LLM`
  picks one (`claude`, `codex`, `cursor`, `gemini`, `anthropic`, `openai`);
  `THINKER_LLM_MODEL` names a model for the non-Claude ones;
  `THINKER_LLM_BASE_URL` is any OpenAI-compatible `/chat/completions`
  endpoint (token from the variable `THINKER_LLM_API_KEY_ENV` names), used
  before the agents; `THINKER_LLM_CMD` is any command that reads a prompt on
  stdin and prints the answer, told the tier, model and schema in
  `THINKER_TIER`, `THINKER_MODEL` and `THINKER_SCHEMA` (docs/usage.md).
- **Any other agent.** Pipe events to `thinker record <session>` as JSON lines
  (`{"t":"prompt","text":…}`, `{"t":"tool","name":…,"input":…,"result":…}`,
  `{"t":"say","text":…}`), then run `thinker learn`. Agents that speak MCP can
  also correct notes with the `feedback` tool.

### What was run live, on 2026-09-27

| | Claude Code | Codex CLI 0.157 | Cursor agent CLI | Gemini CLI |
|---|---|---|---|---|
| notes served in a session | yes | yes | yes | not installed here |
| session turned into notes | yes | yes (hooks, trace and distilling through Codex ran; the short test session produced no notes) | yes (4 notes from 2 sessions, distilled through Cursor) | not installed here |

Gemini support follows its documentation and is covered by unit tests on
constructed input only. Seen in the live runs:

- Codex did not run hooks from a project's `.codex/hooks.json` in
  `codex exec` with only the project marked trusted, but ran the same hooks
  from the user-level `hooks.json`. With the hooks marked as reviewed too
  (what `setup` now writes), `codex exec` 0.157.1 loaded the
  project's MCP server, called `orient` without asking and ran the project's
  hooks.
- Cursor's CLI (`agent -p`) fires `sessionStart`, `postToolUse`,
  `afterShellExecution` and `sessionEnd`, but not `beforeSubmitPrompt` or
  `stop`, and `postToolUse` carries a summary of the tool's output, not the
  output. So thinker installs both the editor's and the CLI's events, takes
  shell output from `afterShellExecution`, re-reads files when distilling,
  and `setup` approves the MCP server (`agent mcp enable thinker`) so the
  agent can call `orient` at the start. In the
  test session it did both unprompted.

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
