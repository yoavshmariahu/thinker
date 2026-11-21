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
- That file is for the **pair**: an assertion names both doors (page and CLI, page and the terminal's own
  renderer). One file's internals pinned by a regex over its source belongs in that file's own test, not here --
  26 such assertions were taken out on 2026-11-15, and they were most of why the file was edited twice a day.

**The proxy and desktop clearing hold one policy (MANDATORY):**
- `src/proxy.js` and the desktop door implement the same clearing policy, never two.
- The clearing mod (`src/integrations/claude-clear`) holds NO policy (2026-11-18): an open session keeps the mod it loaded, so a copy there is frozen at the release the session was opened under. It asks the installed CLI at each decision (`thinker hook clear`, `src/clear-door.js`: `start`, `decide`, `apply`) and puts the answer in place. A constant or rule back in the mod fails `test/claude-clear.test.js`.
- Every `PROXY_DEFAULTS` key honored by `clear-door.js:desktopPolicy` or exempted with reason in `DESKTOP_POLICY` (`test/claude-clear.test.js`).
- `cut` is honoured there, not exempt (2026-11-19): with the cutting off the desktop door clears nothing either. It is where most of this machine's clearing happened, so a switch one door kept would have left the measurement as unreadable as it was.
- Policy change is judged live on cache writes against 15% holdout, not replays.
- A change to `register.tsx` is only tested by `claude plugin test src/integrations/claude-clear` (its
  `hooks/clear.test.tsx` is a bun test and `npm test` never reaches it). Run it. `npm test` holds the cheap
  half: `test/claude-clear.test.js` transpiles the file and fails where it would not load at all -- what the
  other assertions there, each extracting one function from the source as text, cannot see (#888).

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

**Cutting is OFF, and the proxy stays (2026-11-19, the owner's call; `proxy.js:PROXY_DEFAULTS.cut`, held by
`test/cut-off.test.js`):** nothing below this is in force on an unconfigured machine. Read this before tuning a
guard: the guards are not what is being reconsidered.
- **Why.** The cutting was worth $7.01 and $4.03 in the weeks to 2026-11-15 and 2026-11-22 against $1,164 and
  $393 of spend (the Report's weekly savings table), under 1%, where delegation was $16.60 and $13.52. The two
  weeks before read $239 and $298, so the series disagrees with itself by fifty times, and the holdout cannot
  say which is true: 2 sessions cleared against 18 held out past the trigger, a ±54% band around a difference
  of a percent or two (`thinker factory --diff compression`). A policy whose own ledger cannot be read is not a
  policy that can be tuned. The strategy is being rethought from the measurement up.
- **One switch, read in one place.** `cfg.cut === false` is the first branch of `cutting.js:decide`, so all three
  doors and the desktop door refuse together (`reason: 'off'`), no breakpoint is seeded and no set is remembered.
  Off is not held out: a held-out session is one the policy still decides about.
- **Still measured.** A row carries the `candidate` the request would have given up, so the log goes on saying
  what a cut was worth while none is made -- the only free evidence the next strategy can be built on.
- **What the proxy is for now:** carrying and logging every request (`op: proxy`, the cache reads and writes
  every dollar figure on this machine is built from), `proxy-retry.js`, routing and pricing other providers'
  models, the gateways and Bedrock, and the delegation's savings read off the calls it sees.
- **The policy stamp says which.** `policyId` is `v<version>-off` while cutting is off, so a saving made under
  the one policy is never pooled with the other (`cutting.js`).
- **Back on:** `proxy: { cut: true }` in `<THINKER_HOME>/config.json` (the way to ship it, through a PR),
  `--cut`, or `THINKER_PROXY_CUT=on`. Every guard below is untouched and comes back exactly as it was.
- A test that exercises the cutting asks for `cut: true` in its own config; `test/cut-off.test.js` is the only
  file that says what the default does.

**The clearing: how thinker cuts results when it is asked to (MANDATORY, 2026-11-04; OFF by default since
2026-11-19, above):**
- Cut and keep newest turn + 3 results. Trigger 140k, floor 8k, payback 25 calls. A session resumed past the cache's hour is cut by the same trigger and floor (2026-11-17); the pause only makes the cut free.
- `decideCut` returns `reason` (seven branches: `off` wins, then `nothing-to-cut`, then `below-trigger`, then `below-clear-minimum`, `mid-turn`, `one-cut`, `payback`). Both doors use it.
- Ratchet per conversation (keyed on first user message); write merges, never replaces; turn rises, set advances.
- A long call whose result is short (a heredoc, a Write, an Edit that answered in a line) is a candidate on the call's own text (2026-11-17, `r6`); the short result stays. Only with `cutInputs`.
- `cutThinking` (2026-11-17, on by default since 2026-11-18; `--no-cut-thinking` is the way back; `--cut-thinking`, `THINKER_PROXY_CUT_THINKING=on`, `proxy: { cutThinking: true }`): a cut also leaves out the earlier turns' thinking blocks after its own oldest replaced result and before the turn it was made in, whole blocks only, never the turn in progress. Ranges kept on the record (`rec.think`, one `[result id, turn]` a cut) and only ever grow. Priced in the ladder (`thinking` on the rung and the row). Policy name ends `+th`. Messages door only; the mod is exempt.
- `thinkingKeepTurns` (2026-11-17, 2 by default since 2026-11-18; `--thinking-keep-turns n`, `THINKER_PROXY_THINKING_KEEP_TURNS`, `proxy: { thinkingKeepTurns }`): with `cutThinking`, the last n turns before the one in progress keep their thinking, so a cut's range stops n turns back. A cut never reaches above its own oldest replaced result for thinking that has aged since an earlier cut (2026-11-18): that moved the breakpoint to the top of the conversation (a PostHog turn-6 cut wrote 65k for 15.5k of thinking where the same cut without it wrote 19k). Aged thinking goes only when a later cut's own span holds it. Policy name ends `+th<n>`.
- `cutBreakpoint` (2026-11-17, on by default, not yet confirmed live; off with `--no-cut-breakpoint`, `THINKER_PROXY_CUT_BREAKPOINT=off`, `proxy: { cutBreakpoint: false }`): a boundary that finds a cut seeds it (one `cache_control` on the last block before the first changed one, nothing replaced, `reason: seed`), and the next request after that one's answer makes the cut at the same breakpoint, priced at `tail`. Policy name ends `+bp`. Rows carry `bp` (breakpoints the request came with), `mark`, `planned`. Messages door only; the mod is exempt. Claude Code already sends four breakpoints (two on the system prompt, one on each of the last two messages), so on the seed and cut requests the proxy's takes the place of the older message one.
- The tail is priced from where the breakpoint lands (2026-11-17, `proxy.js:markBlock`, `POLICY_REV` 7): the walk back from the first changed message steps over a message that can carry none (a plain string, thinking alone), and what it steps over is written again. Priced from the first changed message, a PostHog session's first cut was predicted at 41,465 and wrote 57,346, the difference being Claude Code's environment message.
- **A cut takes a finished call's screenshot too, and leaves its path (2026-11-15, the owner's call; `cutImages`,
  `proxy.js:saveCutImages`, `cutting.js:imagePlaceholder`).** A result was eligible by its text alone, so a browser
  session's screenshots were never cut. Now a base64 image in a result that is going is saved under the clearing's
  `images/` directory (kept 2 days) and the placeholder names the file, so the model reads it again if it needs to;
  an image that cannot be saved stays in the prompt. An image is counted at its tokens, never its base64
  (`wireChars`): read as text one screenshot put the prompt past the trigger by itself and made every rewrite look
  hundreds of times dearer. The policy id says `+img`. Proxy only: the host hands the mod a result as text
  (`DESKTOP_POLICY` exempts it), and the Responses and Chat doors are unchanged. `proxy: { cutImages: false }` or
  `--no-cut-images` turns it off; there is no variable.
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

**The two guards scale with what the route charges for a rewrite (2026-11-13, `cutting.js:cutScale`, `scaledPolicy`):**
- Trigger and `clearAtLeast` × `clamp((write/read) / 20, 0.1, 1)`. 20 is Anthropic's 1h ratio, the harshest any provider charges, and the reason a cut needs a tail ≤1.25× what it removes.
- Only a route with rates of its own scales (`gateway-rates.js`, four sources). Nothing reads model or TTL: the 5m write would price Anthropic at 12.5 and move its guards on the TTL alone, and the desktop door (`clear-door.js`) is Anthropic's by construction and reads no rate. Anthropic unmoved, keeps its policy id.
- GLM: write 1.0, read 0.5 stated (implicit cache, no write or storage line), so a 14k trigger; the floor stays 8k, since #783 left only the trigger scaling (`cutting.js`: "Only the trigger scales"). Stamp `r3-t14k-f8k-p25-deep`. Never pooled with an Anthropic saving; the scaling itself bumped no `POLICY_REV`, the guards are already in the stamp.
- `PAYBACK` 25 unchanged and does the policing, but it polices less than this said: with the rewrite charged whole, a 7k cut behind a 180k tail priced at 52 and was refused; corrected (below) it prices at 25 and is made. A cheap route still prefers **early and small**, since the tail is what it is paying for, but "late and small is refused" now needs a tail 40x the cut, not 25x.
- A guard pinned by flag or env is never scaled (`cfg.pinned`). `prices.js:statedRates` answers only where cache prices are **stated**, never from `fill`'s invented tenth.
- Open number: GLM's read rate. Z.ai's doc says half, third-party listings a fifth (→ 0.27, 38k/16k). Judged on live cost per exchange, not by replay.

**A cut is charged what it adds to the call, not the whole rewrite (2026-11-13, `cutting.js:priceCut`, `POLICY_REV` 3 (#783 took 2; two pricings may not share one stamp)):**
- `cost = recache x (write - read) - read x removed`. Without the cut this same call reads the whole prompt back from the cache, the tail included, so the rewrite is not charged in full: the read it displaces comes off it, and so does the read of what the cut removes. Identically, payback falls by `tail/cut + 1`.
- On Anthropic a read is a tenth of a write, so it is a ~6% change -- invisible while only Anthropic was priced. Where a read is half the input price it is most of the cost.
- Measured on this machine's 93 priced warm boundaries: Anthropic 1h cuts 13 → 20, Anthropic 5m 49 → 68, GLM read 1/2 93 → 93 (already all passing), GLM read 1/5 89 → 92. **So it lands on Anthropic and the OpenAI/Gemini shape, not on GLM**, where the guards above were the only thing refusing.
- `payback` 0 is reachable and means repaid on the call that makes the cut; it cannot go below (clamped, to keep `Math.ceil`'s `-0` out of the log).
- The desktop door decides in ratios (`clear-door.js:clearPays`): `(writeRatio - 1) x recache <= (PAYBACK + 1) x dropped`, held to `priceCut` over 160 points by `test/claude-clear.test.js`.
**The cut is taken from the tail backwards (2026-11-13, `proxy.js:cutCandidates`, `cutting.js:decideCut`):**
- Taking every eligible result starts the rewrite at the OLDEST one, so it spans nearly the whole conversation while removing only the results in that span -- 26-34% of it on this machine's 93 priced warm boundaries against the 42% Anthropic's hourly rates need, which is why 0 of the 12 boundaries under the current stamp were cut.
- A removed token saves the same wherever it sat; only the cost depends on position. So `cutCandidates` returns `steps`, the nested suffixes from the tail backwards, built in one backward pass (the set only grows backwards, so a message already passed never changes and the running sum is every deeper rung's tail). The deepest rung IS the old whole-set candidate, held to the single stringify's figure by `test/cut-ladder.test.js`.
- `decideCut` takes the largest-saving rung that pays. No new constant: the pricing is the whole of the economics and this chooses among priced options. `depth` and `rungs` ride **inside `clear` and `held`**, which every door already logs (2026-11-14: they were on the decision and on no row, so the first live run could not say whether a boundary had one rung or nine). Chat and Responses build no ladder yet and hand one set, which is picked as before.
- `clearAtLeast` 60k → **8k**, and it no longer scales with the route (#781 scaled it while it was economics). The floor was the economics when a boundary had one candidate; now it only guards against acting on `recache`'s estimation noise, and noise is in tokens, not in what a provider charges. The trigger still scales.
- The mod holds the same policy: `clearLadder`, `chooseDepth`, and `clearOld({ depth })`. The check prices every rung and queues a compaction turn only if one repays; a hand-run clear still takes everything.
- **The shallowest rung is nearly free, which is the mechanism in one line**: with `keepMin` 0 a newest-eligible result took out 10,800 tokens for a 111-token rewrite (payback 2). So a refusal means the eligible results are OLD with protected bulk behind them -- which is what the live boundaries of 2026-11-14 were.
- **First live A/B (2026-11-14, 8-turn read session, two proxies, $12): no difference.** Both arms cut at turns 4 and 6, the same 66,097 and 61,791 tokens, 158,084 cleared, $5.95 against $5.98. The corrected cost priced those cuts at 13 and 11 instead of 15 and 13, and turn 3's refusal moved from the floor to the pricing (payback 65). The ladder only pays in the middle band -- the whole set fails and a shallower rung passes -- and this workload never landed there: either the whole set paid at 13-15, or no rung paid (best 27, 36, 116). The 93 historical boundaries DO land there (tail/cut 1.9-2.9 against a bar of 1.37), so judge it on real traffic, not on a synthetic read session.
- **Unmeasured, and what to watch.** `proxy-replay.js` cannot judge it (it models the API-side edit this replaced) and the holdout is off since 2026-11-12, so the judges are cost per exchange and `rereads.js` -- which is what this puts most at risk, a cut nearer the tail being a cut of results the model used more recently.

**The turn in progress is never cut into (the long-turn rule, removed 2026-11-16, the owner's call):**
- A cut moves only at a turn boundary, and a turn is one prompt of the person's to the next. A one-prompt
  autonomous job is all one turn, so the cut never fires in it however large it grows (container e2e,
  2026-11-13: one prompt, 16 calls, 5k -> 193k tokens, all refused `nothing-to-cut`). That is known and
  accepted.
- The rule that cut into such a turn once its own results passed the trigger (`--long-turn`, `longTurn`,
  `keepTurn` 10, the `-lt10` stamp; 2026-11-14, never on by default) is gone, with its flags, its
  environment variables and the re-read reconstruction it needed.
- Why: its one live run on the shape it was for (`bench/experiments/browser-big.json` on the
  `agent/langchain-hooks` branch, 2026-11-16; one prompt, 200 product pages, Sonnet 5.5). The cut fired 18
  times, held the context at 158k against 326k, and removed eight pages the agent had read and not yet
  tallied. The agent did not notice, read nothing again, and answered 508 where the uncut session answered
  the right 525. That is the failure `rereads.js` cannot see: a model working out of a gap asks for nothing.
  Nothing in a request says which results of a running turn the model has finished with.
- Do not bring a mid-turn cut back without a signal for "finished with" that comes from the model.

**A cut takes the finished call's own text too, by default (2026-11-14, the owner's call; `cutting.js:cutInput`,
`proxy.js:applyCut`, `cutInputs`):**
- #611 removed exactly this on 2026-11-04. One of its two reasons has expired: inputs bought **0.6%** of what
  results buy -- measured on a session whose `tool_use` inputs were 2,800 chars, a file path each. Measured again
  on 2026-11-14 over 8 sessions of this machine: **3.1M chars of inputs, 72% `Bash.command` heredocs and 12%
  `Write.content`, 13.3% of what a cut must rewrite.** The workload changed, so the answer did.
- The other reason stands and shapes the code: blanking a call taught the model **a false history of itself** -- in
  a 28-turn run it read its own emptied calls, reported it had been "making the tool calls without file paths", and
  began doing that. So this is **never a blank**: every key the agent sent stays, every value shorter than
  `MIN_CHARS` stays verbatim (a `description`, a `file_path`, a flag -- what the model reads to know what it did),
  and only a long string body is replaced. A call whose input is all short values is not touched. Thinking is never
  touched -- that was the edit that broke the API in October. The placeholder's words say the call was made in full
  and tell the model not to copy the shape, because on OpenCode 2 the wording of a substitution is the mechanism.
- Only ever beside the result: a call keeps its text while its result is still in the prompt, because the pair is
  what the model reads. The ladder prices both halves (`cand.chars`, `cand.inputChars`) -- counting only the
  results, a step understated its own saving and was refused for a payback it in fact makes.
- On by default; `proxy: { cutInputs: false }`, `--no-cut-inputs`, `THINKER_PROXY_CUT_INPUTS=off`. The stamp carries
  `+in` (`r4-t140k-f8k-p25-deep+in`), so a figure with the calls in it is never pooled with one without. The desktop
  mod mirrors the naming function and keeps the flag off, with the reason recorded: in the desktop app an input
  really is a file path, so the 2026-11-04 measurement still holds there.
- Measured, 8 of this machine's biggest sessions, 4,891 calls, same bodies: the recent policy cut **1** (0.07M),
  today's policy with inputs off **2** (0.07M), **with inputs on 7 (0.14M)**, and with the since-removed long-turn rule as well **9**
  (0.25M). Real, and small in absolute terms: `payback` still refuses ~863 calls either way.
- **Run live, and it was the best arm** (`bench/experiments/cut-inputs-posthog.json`, tag `posthog-cut-inputs`,
  2026-11-15, $28.98): PostHog PR106936, nine turns, Opus 5.5, three arms, graded by Opus against criteria written
  before the run. Bare $9.32 / 24.2M input / 167 calls / 6-of-6 essential; results-only $9.81 / 17.4M / **186** /
  **5 of 6**, a fail; **inputs on $9.00 / 12.3M / 159 / 6 of 6**, a pass. So cutting a call's own text cost no
  essential criterion and was cheapest on every axis, and the arm that lost one was **results-only** -- which is
  not what the hypothesis predicted. **One task, one rep: 5-of-6 against 6-of-6 on a single session is inside
  run-to-run variance and may not be cited as "results-only fails".** What it supports is that input cutting shows
  no harm, three independent signals agreeing. `c9` was missed by every arm, so it is a hard criterion, not a cut.
- **The exposure.** `tool_use_rewritten` is a named break of the preserved-thinking check whose only listed remedy
  is "echo `tool_use.input` exactly as received" -- unlike a result prune, which the same table allows client-side
  "at a declared boundary, as a pure function of the growing history". So on accounts created on or after
  2026-08-31, and on Fable 5.2 / Mythos 5.2 for every account, this can 400 where cutting results alone would not.
  thinker sets no `prefix_mismatch_behavior`, so on an older account the check does not run at all. The server-side
  alternative is `clear_tool_uses_20250919` with `clear_tool_inputs: true`, which is exempt from the check -- and is
  what the pre-2026-11-04 proxy used (`injected: true, inputs: true` on those log rows, no `clientCut`).

**The keep list: file reads no cut takes and no delegation hands away (2026-11-17, `src/keep.js`):**
- From a person's report: an agent that "forgets what worked", whose notes file they had to shout at it to read again. A read of the notes is a tool result like any other, and a model that carries on without it scores zero on the re-read measure.
- The newest copy of a kept file stays (a whole read, a `cat`, a Write); older copies are cut as before. Kept: `*.md`, what the profile learned, a file the person named in a prompt, a file read again after a cut.
- A web address is kept as a file is (a fetch tool's call, an untrimmed `curl`): learned or named, and it covers the pages under it.
- No model at decision time. The profile's reader records `sources` on an observation (files the person pointed at, held to their own words by `sourcePattern`); `profile.js:syncKeep` writes them to `<THINKER_HOME>/state/keep.json`, a list per checkout, read together by every door.
- Every door: `proxy.js:keptOf`, `proxy-responses.js:responsesKept`, `proxy-chat.js:chatKept`, the desktop door (`clear-door.js:keptOf`, which calls keep.js itself; the mod has no copy, `test/keep.test.js`), `delegate.js:delegateTool` (`declined: 'kept'`). Policy `r10`; a boundary's row carries `kept: { results, tokens }`.
- Delegation's "named" reads the newest prompt only.
- Replayed over this machine's 14 days (16 cut sessions, 1.88M tokens taken): `.md` 1.3% of it, the list as a whole 8.3%, most of that files named in a prompt.

**What the clearing saved is shown, three turns on (2026-10-29):**
- `clearedBy` on row; `cleared: 0` if nothing cut. Measured: the cut's own `tokens`, not API's.
- A cut result's tokens are counted from its text (2026-11-17, `proxy.js:resultTokens`, which the desktop door calls too): letters 0.34, digits 0.78, symbols 1.05, newlines 1.6, other 0.7, spaces nothing. Fitted to the API's own counts on 1,082 results (median error 4.0% against 10.6% for a flat 0.445). `POLICY_REV` 8. Images and a call's own text keep `RESULT_TOKENS_PER_CHAR` (0.445), as do delegation and the re-read figures.
- Session record: `state/compression/<session>.json`; `compressionHeader` on four doors.
- Desktop clears measure cost from API's `cache_creation_input_tokens` and `cache_read_input_tokens`.

**Proxy never takes over another's route (MANDATORY, 2026-10-28):**
- `routeEvidence` reads every place a route comes from; non-thinker routes left as-is with reason.
- `api.anthropic.com` is not a route (desktops set it; any exact match is dropped on next rewire).
- **Thinker's own proxy is never another's route** (2026-11-14): every port a proxy of this thinker bound is in `served` (`recordProxyListening`, `SERVED_KEEP` 20) and `isOwnUrl` reads it, so an ad-hoc `proxy serve --port n` beside the service is known as thinker's.
- **A hook's environment is the session's, not the machine's** (2026-11-14): `routeAppeared` judges from the files alone (`claudeBlocker({ ambient: false })`); the process env counts only where the person typed the command (`proxy on`, the wiring). One session's variable stood the machine down on 2026-11-01 and again on 2026-11-14, killing live sessions' route.
- Stands down with reason if credentials fail or API refuses `AUTH_REFUSALS` times.
- That evidence is a session's own (`proxy.js:authWatch`, 2026-11-18): counted per session, and held (`proxy-auth-held` row) where the API answered that session before or another session of the same agent inside `AUTH_QUIET_MS` (10 min). One terminal's key or an expired login never decides for the machine.
- Sits in front of a gateway only on `thinker proxy on --gateway` + user yes; kept in service state, or `proxy: { upstream }` wins.
- On 400 to context-management edit with non-Anthropic upstream: if refusal names field/beta, drop edit rest of proxy's life (`editRejected`, `proxy-edit-rejected` row, `edit-unsupported` read); any other 400 passed once, edit still added next request.

**The API refusing a conversation thinker rewrote (2026-11-15, the owner's ask):**
- Two refusals, two scopes. `refusesEdit` is an upstream that cannot take the server-side field at all: stops editing
  for the proxy's life. **`refusesHistory` is the API rejecting the rewritten history: stops cutting for that session
  alone** (`rejectedSessions`), because the bound thinking is one conversation's and the proxy serves every agent on
  the machine. A stood-down session never cuts again; the request goes again as the agent wrote it, so the agent
  always gets its answer and never sees the 400.
- **Explicit only.** The body must name the thing checked AND what was wrong with it (`tool_use_rewritten`,
  `tool_results_rewritten`, `prefix_mismatch` are each enough alone; `thinking block` needs a verdict beside it). A
  model name, a rate limit, a malformed body may never stop the cutting -- the October lesson (LiteLLM, a 400 over a
  model name taken for a refusal) is why. `refusesEdit`'s vocabulary could not see a prefix-check refusal at all,
  so before this it reached the agent as its own 400 and nothing stood down.
- **Why it exists now:** a pruned tool *result* has a sanctioned client-side form; a rewritten tool_use *input* has
  none ("echo `tool_use.input` exactly as received"), so cutting a call's own text is the half of a cut the check
  names. Enforced for accounts created on or after 2026-08-31 and on Fable 5.2 / Mythos 5.2 for every account.
- **A metric, on the Token spend dashboard** (`telemetry.js:proxyMetrics` → `rejected: {total, history, edit,
  sessions, messages, responses}`; two cards in `thinker-internal: scripts/spend-dashboard.mjs`). Counts only: what the API said quotes
  the machine's own request back and stays in its log. The scalar is the number that must stay at zero. Split by
  door, because only the Messages path rewrites a call's own text and only it binds thinking to the conversation's
  bytes -- the Responses (Codex) door replaces results alone, so a refusal there means something else, and a machine
  that uses only that door may not read as a blank (`test/metrics-dashboard.test.js` holds every card to both).
- Measured before it shipped: 22 days, 30,341 proxied requests, 12,537 with a thinker edit, **2** 400s -- both
  2026-10-24, both the API-side clearing era, none since the cut moved client-side. The valve has never fired.
- Fixed on the way: the `proxy-cut-rejected` row carried no `session`, so `proxyReport`'s `sessionsRejected` keyed
  on it and could only ever read 1.

**OpenCode on OpenRouter goes through the proxy by default (2026-11-15, the owner's call):**
- The service runs `--gateway-openrouter` and `connect` points OpenCode's `provider.openrouter` at `<proxy>/openrouter/v1`, unless `proxy: { gateways: { openrouter: false } }` (`proxy-service.js:openrouterGateway`, the one reader). LiteLLM is the person's own server and stays a setting.
- Opt-in since #743 meant nobody had it: seven GLM sessions on the owner's machine re-read 120M cached tokens uncut.
- The door drops the agent's `/v1` where the upstream has its own (it was `/api/v1/v1/…`, a 404 on every request against OpenRouter itself; the fleet e2e used a fixture).
- A Chat conversation is keyed on the agent's session id (`x-opencode-session-id` and its three siblings, else `prompt_cache_key`) plus the first user message (`proxy-chat.js:chatSession`). The first message alone is thinker's own profile block on OpenCode, so every session in a checkout shared one record and the set moved inside a turn.
- Checked live through OpenRouter on GLM 5.3, Gemini 3.6 Flash, Claude Haiku 5.5 and GPT-5.4 mini (trigger lowered to 30k): the cut fired at the boundary, the same set on every call of a turn, 75-82% read from cache on the cut's own call and 92-100% on the next (GLM stayed at 67-82%).

**A request that never reached the API recovers (2026-11-05, `src/proxy-retry.js`):**
- Address cache (`addressBook`, cached 6 h), ladder (`RETRY_WAITS` 0.25–4s), fresh socket for TLS and the four unreachable/dropped codes (EHOSTUNREACH, ENETUNREACH, EADDRNOTAVAIL, ECONNRESET).
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
- **Delegated reads are a second series, and the footer total adds it** (2026-11-14, the owner's ask; `report-savings.js:delegationSavings`, series `delegation`, the ledger's `delegated` cell). One rule: the lead did not write the read into its cache and did not read it back on any later call. The write is netted against the subagent (its own `cost` on a fallback row; the same tokens at the pinned `model`'s write rate on a handoff row; zero where neither is known), the later calls are the proxy's rows for the session on its lead model, stopping where the turn count falls (a compaction). Not a firing: held out, declined, failed, cached, or a handoff the lead ignored (a later `after: 'handoff'` row naming the same file: `readAnyway`, the one rule, which the day's count uses too -- `delegate.byDay.ignored`, schema 3 since 2026-11-20, the owner's ask, a subset of `delegated` so a day already sent still means what it said, and `delegated - ignored` is what the dollars are drawn from). A delegated read is never in the prompt, so the clearing cannot also count it: same kind of token, never the same token. A ceiling, as the clearing's gross is: the subagent's own overhead on a handoff and the report it sends back are not deducted.

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
  delegate` row -- and the execution is the host's. A ranged Read (`offset`/`limit`, under the 4k `threshold`) is
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
- **Five reads a turn are handed over, each file once, a suite run once** (`handoffsPerTurn` 5 since 2026-11-15,
  the owner's call; 1 until then; `decide`'s `spent`, `noteHandoff`). What makes a handoff impossible to loop is the
  positive guard: a subagent's own call is never delegated (`fromSubagent` -- Claude Code's `agent_type`/`agent_id`,
  OpenCode's `agent` on every event, where anything but a primary agent fails closed). The budget of one stood
  beside it and cost reach: replayed over 30 days of this machine's sessions it turned away 42.5M read tokens, 4.5
  times what the rule delegated (projected 1.9% of spend at one, 4.5% at three). A read the budget or the file's
  own report lets through is allowed and logged `fired: false`, and which one says so is the row's own marker
  (2026-11-19, three where there was one): `after: 'handoff'` is this file's report already in the lead's hands,
  which is the lead reading it anyway and the one free signal of whether the model obeyed; `after: 'budget'` is
  the turn's five spent on other files, which says nothing about the model; `after: 'in-flight'` is a second call
  of one batch for a read still being explored, answered from that report and never the file.
  **Not measured live:** two paired mlflow tasks run at five never had a second big read in a turn, so whether a
  lead working from several reports a turn holds its outcome is still open; `delegated.ignored` on the session
  row (delegated.js) and the judged bench are where it will show.
- **The same read twice in one batch is one handoff** (2026-11-19; `register.tsx:flight`, `flightKey`, and
  `in_flight` on the pretool event). A lead that reads one file in two calls of a parallel batch sends both
  through the hook before it has seen either answer, so the rule's "a file already handed over is never denied
  twice" -- there so a lead can insist -- let the whole file land in the context the handoff had just kept it out
  of. Measured on this machine on 2026-11-19: two hooks 25 ms apart on one session, one handoff, and a
  43k-token read straight through beside it, with no model spent to reproduce it. The mod keys each read it is
  exploring before its first `await`, so the second call waits for the same report and is answered with it; the
  entry is dropped when the report is delivered, which leaves the lead insisting a turn later exactly as it was.
  A ranged read is its own key, since a range is what the denial sends the lead back for and is never delegated.
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
- **What it saved is read out of the transcript when a turn ends (2026-11-15, `src/delegated.js`), as the re-reads
  are.** One rule: a delegated read saves its write once and its read on every later call of the lead, until a cut or
  a compaction would have taken it out anyway, less what the subagent that read it cost. The hook keeps each real
  handoff in the session's state (`delegate.js:noteFiring`); the Stop hook reads them against the transcript
  (`delegatedOf`: later calls of the lead, a file the lead read whole anyway counts nothing, the subagent found by
  type and start and priced at its own model) and puts `delegated` on the `op: session` row, cumulative.
  `report-savings.js:delegationSavings` counts a session from those rows, each adding what it added; a session from
  before the rows carried it falls back to the proxy-log rule of #796. Never overstated: the reads start at the
  second later call, stop at the first cut, and a subagent the lead started unprompted is neither charged nor
  credited. On two bench sessions of 2026-11-14: $0.53 on a $3.15 mlflow session (one 45k read), $0.13 on a $7.12
  PostHog session (three firings, one ignored).
- The rule (`decide`) is one comparison: **a read of `threshold` tokens (4k) or more fires, and no other read
  does** (the owner's call, 2026-11-17: "I just wanted if read >= 8k"). Nothing is added up across a turn; the
  turn, keyed on Claude Code's `prompt_id`, only bounds the handoff budget. Until then the rule was a tally of
  the turn's reads against the threshold (35k until 2026-11-16) with a per-read floor (`minRead` 8k), which is
  what the bench runs of 2026-11-15/16 and the website's delegation pages ran under; `minRead` is gone and a
  config that still names it is ignored. **4k since 2026-11-20** (the owner's call, "for everyone", on the 75%
  the holdout does not hold back): 8k was set while the explorer was Sonnet and never revisited after #787 pinned
  it to Haiku. Priced through `prices.js`, three real Haiku explorations off this machine's session rows (95-167k
  tokens each, 4-6 turns) cost $0.0057, $0.0070 and $0.0099 -- mean $0.0076, against $0.141 for the same work on
  Sonnet -- while a read the lead keeps costs it $0.0125-$0.0185 a thousand tokens (the 1h cache write at $10/M,
  then $0.50/M read back on each of the 5-17 later calls it rides on), so cost break-even is around 400-600
  tokens and the dollars have not set this floor for some time. What does set it is substitution: below some size
  the 25-line report is the worse answer, because the model wanted those lines to edit and reads the file anyway.
  Where that size is has never been measured -- the 40 bench sessions of 2026-11-16 found no correctness loss
  where it fires, and where it fired was 8k and up -- so the holdout is what says, on the share of handoffs the
  lead reads anyway (`after: 'handoff'`, 0 of 30 firings at 8k), on the re-read share and on the wait. The prize:
  over 247 explorations of 2026-11-17/20 the floor at 8k fired on 13% of reads and carried 51% of the read
  tokens, and 4k adds 50 reads and 288k tokens, 48% more handed away. Reads are sized from the file
  on disk at `TOKENS_PER_CHAR` (0.445, the proxy's result rate) plus the Read tool's line-number prefix; a `cat`,
  `sed -n` or large `head` of a file counts, anything piped into grep/head/tail/wc does not (the model trimming for
  itself). A shell line that names a range (`sed -n 10,60p`, `head -n 40`, `sedLines`) is sized by the lines it asks
  for, as a ranged Read is, so it falls under the threshold and is never the thing that fires: a ranged read is the model
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
  so the *projections* are never added (the measured figures are: a delegated read is not there to be cleared, see Savings footer); the write half (~$190 of $291 a month here) is delegation's alone.
- Measured from day one: every firing is a log row (`op: delegate`: kind, files, tokens, `mode`, and for a handoff
  the `agent` and `handoffTool` it named; for the fallback the subagent's usage and `total_cost_usd`, its session
  id, `cached`, `error`). A handoff carries no cost of its own on the row **on purpose** -- the host bills it, and
  the Report reads it as a subagent conversation priced at its own model, so a cost here would be counted twice.
  **A quarter of the sessions are held out** (`holdout` 0.25 since 2026-11-16, 0.5 until then; by hash
  of the session id, `proxy.js:heldOut`, the same rule as the clearing's); a held-out session logs the row with
  `held: true` and reads as it would have. Judge it by cost per exchange, cleared and held-out, over a window, and
  by whether the model re-reads what the explorer summarised (the model-profile's re-read share is the figure).
  The live smoke (2026-11-12): an Opus session told to read core.py (3,681 lines) in full had the Read denied, the
  explorer ran 24 s for $0.21, and Opus answered with the right line numbers from the report, saying so.
- **One decision a tool call, and the row names the door (2026-11-20; `delegate.js:noteDecided`, `via`).** Claude
  Code has two doors on one call -- the mod's `tool.call`, which runs the subagent itself, and the settings hook --
  and the mark below (`state/claude-delegate/<session>`) is a file written at session start, so a session without
  one decided every read twice and wrote two rows nothing could tell apart. Measured on this machine
  2026-11-15..20: marked sessions 1 duplicate in 44 rows, unmarked 54 in 139. The expensive half was never at
  risk -- a handoff is recorded under the session's lock, so the second door reads `spent` and fires nothing, and
  none of the 68 pairs ran two subagents -- so what it cost was the log's meaning (a reader counting rows counts
  each read twice) and a node process a call. `tool_use_id`, which both doors hold for the same call, is now
  recorded under the lock by whichever gets there first, and the other stands down before a row is written; every
  row carries `via: 'mod' | 'settings'`. Claude Code only: it is the one host with two doors, and the one whose id
  is the API's own (Devin's CLI sends `read:0#99f0` for every read of a session). Rows before this read no `via`,
  and duplicates in them pair on session + tool + files + tokens within a few seconds.
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
  (its plugin reads the switch once at setup). `THINKER_DELEGATE=<model>` or `delegate: { model, threshold,
  holdout, timeoutMs, handoff, fallback, handoffsPerTurn }` tune it;
  `THINKER_DELEGATE_THRESHOLD`, `THINKER_DELEGATE_HOLDOUT=off` for an experiment arm, and
  `THINKER_DELEGATE_HANDOFF=off` / `THINKER_DELEGATE_FALLBACK=on` to run the old owned-subagent arm instead.
  Under `THINKER_TEST` the hook does nothing unless `THINKER_HOOKS=on`, as every user-scope hook.
- **Run end to end on Claude Code, and obedience is not what it rests on** (2026-11-19, the owner's ask; four
  `claude -p` sessions on the real binary, 2.1.329 with thinker 0.4.8, against a scratch `THINKER_HOME`, $0.56 of
  lead spend). On a 1,621-line file (43,210 tokens) the hook fired, the mod spawned the host's own `Explore` on
  `claude-haiku-5-5` (`parent_tool_use_id: toolu_plugin_…` in the transcript, so the harness ran it, not the
  lead), the subagent read the file itself -- 62 KB into its own context, which is thrown away -- and the lead's
  Read came back as a 2,394-char report it answered from, having never seen the file. So on Claude Code, as on
  OpenCode, a handoff is not a nudge the lead can refuse; the instructing words are what is left for a run that
  fails. The other three sessions each declined for a reason worth keeping: a file the person named in the prompt
  (`kept: 'named'`), a ranged read under the threshold, and a session that explored with `grep` and never called
  Read at all.
- **What is still unmeasured.** Whether a lead working from several reports a turn does as well as one reading the
  files (quality, not plumbing), and the obedience share on a host where the lead must call the subagent tool
  itself -- the fallback words path, which is what every host but Claude Code and OpenCode gets. The measure for
  the second is the live one this project already uses: over a window of sessions with the trigger on, the share
  of `op: delegate` handoff rows followed in the same turn by a subagent conversation in the host's own transcript
  (Claude Code writes one per subagent; the Report already reads them), against the `after: 'handoff'` rows that
  say the lead read the file itself anyway -- beside cost per exchange on the holdout. Those rows only mean that
  since 2026-11-19: until the markers were split they also counted a batch's second read of one file, which the
  lead had not yet seen an answer for, so a share read off them before that date is contaminated.
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
- **Devin is the third door (2026-11-16; `delegate.js:HOSTS.devin`, `clients.js` writes `PreToolUse` on
  `read|exec|run_subagent`).** Probed live on CLI 3000.11.234 with swe-2-high and swe-2-medium: its PreToolUse hook
  sends Claude Code's payload (`tool_name` `read`/`exec`, `tool_input` `{ file_path, offset, limit }`/`{ command }`,
  `prompt_id`; no `cwd`, no transcript) and takes Claude Code's deny JSON, which the model is shown ("Hook block").
  Both models then called **`run_subagent`** with `profile: "subagent_explore"`, `title` and `task` -- so the
  handoff names those fields (`subagent.fields`) -- and answered right from the report. Through thinker's own hook
  the same day: a 62k-token read denied, one `op: delegate` row (`client: devin`, `mode: handoff`), the right
  answer. **Devin does not mark a subagent's calls**: they carry the lead's session id and prompt id and nothing
  else, and no `SubagentStop` fired. So they are known by the **window** between `run_subagent`'s PreToolUse and
  its PostToolUse, which Devin sends when the subagent has answered (`noteSubagent`, `subagentRunning`; the tool
  hook closes it, so `PostToolUse` is written on `run_subagent` alone where learning and late serving are off);
  inside it nothing is decided, and a subagent that never answers stops holding it after `SUBAGENT_WINDOW_MS`
  (15 min). The brief's request comes from thinker's own trace (`lastPromptOfTrace`). Not checked: a background
  subagent (its PostToolUse may come at launch, closing the window early), a paid lead model, and Devin Desktop.
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

**The explorer is the lead's own family's cheap model on OpenRouter (2026-11-15, the owner's ask):**
- `delegate.js:EXPLORER_FAMILIES`: Anthropic to Haiku 5.5, OpenAI to Luna, Google to Gemini 3.5 Flash-Lite, Z.ai to GLM 5.3 Flash, DeepSeek to v4.1 Flash, Qwen to 3.8 Flash, Mistral to Small. xAI, Moonshot and MiniMax have no pair; a lead already on the cheap tier and any provider that is not a gateway keep the plain agent. `delegate: { families: false }` turns it off.
- OpenCode's plugin asks `session.get({ sessionID })` for the lead's model (neither hook event carries it) and passes it to `hook pretool`; the denial names `thinker-explore-<family>`, one pinned agent file a family (`delegate-agents.js`).
- Each explorer run live as the pinned subagent on one 118 KB file: all right for $0.01-0.02 except Google (Flash-Lite 11-13 of 13 names; 3.8 Flash was right but cost more than the lead's own read). The table carries the figures.
- **On OpenCode the plugin runs the subagent itself, so nothing depends on the lead obeying** (`opencode-v2.js:hostRun`, `delegate.js:hostRunOrder`). A handoff is words in a denied call, and live through OpenRouter Claude Sonnet 5.5 refused them twice and asked the person, GPT 6.1 Terra and GPT-5.4 mini read the file in chunks instead, Haiku followed one time in two. Now the hook hands the plugin an order (agent, model, brief) and the plugin runs a child session on the host's own machinery (`session.create({ parentID, agent, model })`, `prompt`, `wait`, `context`; probed on 2.2.7) and throws the report as the call's result, in `denial()`'s report sentence. `agent` and `model` go on `create` (on `prompt` they are ignored), and a model is always named, since a child given none runs on the host's default, not the session's.
- The brief carries the person's request (`user_prompt`, kept by the plugin's prompt hook): OpenCode gives the hook no transcript, and an explorer not told the question summarised the first chunk it read. A repeat whole read in the turn gets the same report; a failed or late run lets the read through.
- Live after the change, five leads through OpenRouter (GLM 5.3 flashx, Sonnet 5.5, GPT 6.1 Terra, Gemini 4 Hydrogen, Haiku 5.5): the subagent ran every time and every answer was fully right. Sonnet's read cost $0.017 (lead and child together) against $0.38 when it read the file itself.

**A hook may delegate to a subagent (2026-11-11):**
- Two rules removed: hooks never run test commands; hooks are only for cache, no installs.
- PreToolUse hook can deny a read/test, run subagent, return report.
- Logged, costed per session, judged live on holdout.

**One Claude Code session can be turned off, from inside it (2026-11-18, issue #858):**
- `/thinker-disable` and `/thinker-enable` are the clearing mod's (`claude-clear/hooks/register.tsx:sessionOff`, `sessionOn`): the wiring is machine-wide, and a mod is the one thing that runs inside a single session.
- Off is two writes to that process's environment: `ANTHROPIC_BASE_URL` unset (the engine reads it at every send, so the next request goes to Anthropic) and `THINKER_HOOKS=off` (every hook command started afterwards inherits it and returns in `commands/hooks.js`). Checked live on Claude Code 2.1.327.
- What does not work, tried the same day: rewriting the URL in an `http.fetch` hook (the credential stays with the origin the request was raised for: 401); taking thinker's hooks out in a `settings.read` hook (the engine runs them all the same); answering `classic.*` in their place (silences every other tool's settings hooks too).
- Only the service's own plain route is taken (`ownRoute`, against `state/proxy-service.json`): a gateway, the desktop app's URL and the Bedrock path stay. The mark is `state/session-off/<session>.json`, read at session start, so a resumed session stays off.
- A hook that is off still costs a Node start (about 0.25 s, beside other tools' hooks, which run at the same time). A shell guard in the command would cost 7 ms but the command's exact text is what `clients.js` recognises as ours and what Codex's trust hash is taken over.

**On Claude Code the mod runs the delegated subagent, on thinker's rule, on the fly (2026-11-15, the owner's call):**
- `claude-clear/hooks/register.tsx:delegateCall`: a `tool.call` hook on Read and Bash, inside the harness. It asks `hook pretool` with `host_runs` (the size, the holdout, the log row: one copy of the rule, the CLI's), and when it fires spawns the harness's own subagent (`$.agent.spawn`, the order's `Explore`) and answers the call with the report in `denial`'s sentence. What `opencode-v2.js:hostRun` is for OpenCode. Works in the terminal and the desktop app.
- A settings hook cannot do this: it can deny, never spawn, and nothing fires after its denial; a redirect to a stub with an agent hook after the read was called an injection 3 times in 3.
- The mod marks the session (`state/claude-delegate/<session>`) and the settings hook's copy of the call stands down there (`preToolHook`); the settings hook stays for a Claude Code too old for mods, with the handoff's words. A session whose mark never arrived is held by `noteDecided` instead, on the call's own `tool_use_id` (above).
- No model is named to the spawn (the Agent tool refuses a full id); Explore.md's pin picks it. A spawn that fails or passes 240 s lets the call through. The wait is spent in `$` calls, which a hook's time budget does not count.
- Live on 2.1.325, Sonnet lead, three runs: fired every time, the subagent 10 s for $0.005 on Haiku 5.5, a small read untouched (0.7 s for the rule). The lead went straight on in one and checked the report with a grep or a short range first in two; none re-read the file.
- **On by default, a quarter of the sessions held out (2026-11-16, the owner's call; `DELEGATE_DEFAULTS.enabled`, `holdout` 0.25).** `delegate: false` or `THINKER_DELEGATE=off` switches it off; read at the session's start.

**What may go to a cheaper model (MANDATORY, 2026-11-19, the owner's rule):**
- "Critical decisions or thinking does not get routed to a cheaper model. These models should be scoped for simple tasks."
- A cheaper model gets work whose answer is already there to be found or copied, and which the lead checks against the source before acting: where things are in a large file (the lead reads the lines it edits), what a test runner printed. It reports what is there; it is never asked what to do or why.
- Never moved to a cheaper model: a subagent the lead chose to start (research, a survey, a review, a plan, a diagnosis, a page read with a question to answer), a build, a fix. That is the lead's thinking, on the model the person chose.
- In the code: the trigger has two kinds, `explore` and `verify`; the hook is wired on `Read|Bash` and never on the Agent tool; the verifier's prompt asks for what the runner printed, "no cause, no fix, no opinion" (`test/delegate-handoff.test.js` pins all three).
- A new kind needs both halves before it is proposed: the answer can be checked against the source by the lead or by code, and a paired run on real briefs shows the same answers, not only a lower cost.

**A read and a suite run have a model each (2026-11-20, the owner's call: "split please"):**
- `delegate.model` is the suite run's and the default; `delegate.exploreModel` (null by default, config block only, no environment variable) is the read's alone. `delegate.js:modelFor(kind, cfg)` is the one place that answers, and every namer of a model goes through it: the agent files, the denial's sentence, the log row, the agent hook, the fallback subagent.
- Why split: the two jobs are not alike. Copying a runner's summary is not a recall problem, and Haiku was measured identical on it. A read's report is what the lead works from instead of the file, so what matters is whether it names the right files -- and on 13 replayed explorations (2026-11-07) Haiku found 0.65 of the core files against Sonnet 5.5's 0.77, Sonnet tying Opus. Moving one model would have taken the suite run with it, 60 times the cost for nothing.
- Still Haiku on both sides until a paired run on real handoffs says otherwise (21 real handoffs cost $0.009 each on Haiku, $0.128 at Sonnet 5.5 list). `exploreModel` is the switch that makes that run a one-line change rather than a code change.

**The suite run's own agent on Haiku (2026-11-19):**
- Why: `general-purpose` has no model of its own, so a handed-over suite run ran on the lead's with every tool in its prompt: 17 real runs in 30 days at $0.51 each, against about $0.10 for the lead running the suite.
- `thinker-verify` (`delegate-agents.js:installClaudeVerifier`, user scope, marker `thinker-delegate`), pinned by full id to `delegate.model`, tools Bash, Read, Grep, Glob. Written and removed with the trigger, beside Explore.md. Named only while its file is there (`delegate.js:claudeVerifierReady`), else `general-purpose` as before: nothing built in stands behind the name.
- Paired on thinker's own suite (1,171 tests, 2026-11-19): `general-purpose` on Fable 5.2 $0.71, `thinker-verify` on Haiku 5.5 $0.002, the same pass, fail and skip counts. Through the settings hook and through the mod.
- Its description is read by the lead: worded as what the agent does, a Sonnet lead called it unprompted. It says to call it only when thinker asks.

**The lead's own subagents on Sonnet: tried and removed (2026-11-19, #881 for one day):**
- What it was: `delegate: { subagentModel: "sonnet" }`, a PreToolUse answer on the lead's own Agent call (`updatedInput`) naming the model for `general-purpose`, `claude` and `web-fetch`. Off by default; it worked as built (live on 2.1.329).
- Why it went: two real briefs run both ways. A page-reading brief: $0.95 on Fable 5.2, $0.07 on Sonnet 5, and Sonnet answered yes to a question both Fable runs called "not on the page", from passages about another case, having read a quarter of the page. A research brief: $2.76 (an October run's tokens at Fable 5.2 list) against $0.54, the same headline answers, a page unread and an issue thread cited where the original quoted the documentation.
- The replay behind it priced tokens and could not see this: 55 such runs in 30 days billed $156, $39 at Sonnet's list. Cheaper is not the test; the same answer is.
- What stays true of the harness: a settings hook can rewrite an Agent call's input; the Agent tool's `model` takes an alias and refuses a full id; the call's model outranks an agent definition's.
- Also not built, on the same replay: build, fix-loop and commit/PR handoffs (70% of build runs are 1-4 calls, nothing at the first edit predicts a long one); browser runs (a hook sees the call, not what the run is to check).

**The same file, read again: the model is pointed at the copy it already has (2026-11-20, the owner's call after
Headroom Labs; `delegate.js` "the same file, read again", `op: repeat`):**
- The measurement that asked for it, free, off this machine's own transcripts (14 days, 1,035 of them, 10,938
  reads): **36% of every tool result a model was handed was a byte-identical repeat of a result already in that
  same context**, 44% of the read bytes, 87% of it within five calls of the first copy. Under the rule below the
  fortnight would have kept 24M tokens out of the context (39% of what reads put in), a billion cache-read
  tokens, about **$390 at list** -- against the clearing's measured $4-7 a week and the handoff's $13-17. Repeats
  of **shell** output are 6% of shell bytes and JSON and log squeezing (Headroom's own big numbers) are 0.1-0.3%
  of this machine's result bytes, so neither is built: the saving here is reads, and it is repetition.
- **The rule.** A Read, or a shell line that prints a file, whose bytes the model already has is denied, and the
  denial says where its own copy is (`denial({ kind: 'repeat' })`). No model is asked anything, nothing is
  summarised, and nothing is taken away -- the bytes are in the context already. It fires below the handoff's
  threshold, which is the point: reads of 35k tokens and over are 2% of the result mass, 2k-8k is half of it.
- **The guards are the rule.** The earlier copy must have landed in the context (a read the handoff answered
  never did, so the next read of that file is the model's first sight of it); the file must be byte-identical
  now (`contentHash`, so a changed file is always read again and no staleness policy is needed); **the same part
  of it** (`rangeKey`: the Read tool's `offset` and `limit`, and for a shell line its own command text, since
  only `shellRead` can read a range out of a command and two ranges of one length are different lines -- a
  whole-file `cat` keeps the common key, so a `cat` after a `Read` of the same file is still answered);
  a compaction drops the memory (`compactions.js:compactionsSince`, moved there from `profile.js` so neither
  hook pulls the other's module graph); once per file per turn (`pointed`), so a model that insists gets the
  bytes and a deterministic denial can never loop; `repeatMin` 2,000 tokens (98% of the value, a fifth fewer
  firings than a floor of 500); and the keep list's patterns, so the person's own files are never answered for.
  The keep list's other half -- a file named in this turn's prompt -- is not applied: it exists so the model is
  never handed a summary of the file it was told to read, and its own copy is not a summary.
- **Both doors.** The settings hook denies as it does for a handoff. The mod is the door in every session it
  marks, and it read only subagent orders until now: `register.tsx:reasonOf` returns a denial that carries no
  order, which is this pointer (and the fallback subagent's report, dropped there until the same day).
  OpenCode's plugin already threw a denial with no order as the call's result. The pointer rides the handoff's
  hook, so `delegate: false` switches both off and `delegate: { repeats: false }` only this one.
- **One decision a call covers it** (#887): the pointer is decided inside the same `preToolHook` guard, so a
  Claude Code call that one door answered is not pointed at by the other, and the row carries the same `via`.
  A file the lead insisted on and then read whole itself (`decide`'s `handed`) is pointed at the time after.
- **Measured from day one**, like the handoff: a row per firing (`op: repeat`: tool, files, tokens, `held`,
  `fired`, `declined` for `below-floor`, `pointed`, `compacted`), **half the sessions held out** by a hash of
  their own (`repeat#<session>`, so no session is on the quiet side of both triggers), and the session's own
  figure at the end of the turn -- `st.repeated` through `delegated.js:delegatedOf`, the same arithmetic as a
  handoff's saving (the write once, the read on every later call, nothing where the lead read the file whole
  anyway) under `repeated` on the `op: session` row, never added into the handoff's figure.
- **Counted where every other saving is (2026-11-21, the owner's ask):** a third savings series beside the
  clearing's and the handoff's -- `repeat`, "Reads already in context" (`report-savings.js:repeatSavings`, read
  from the sessions' own `repeated` figure, priced at the write the lead never made plus the read of it avoided
  on each later call, **netted against nothing** because nothing ran). It is in `thinker report`, the Report
  page's Savings table (its own dot), the footer and `thinker savings` ("reads already in context"), and leaves
  the machine by day in `repeat` of the telemetry payload (`telemetry.js:repeatMetrics`, schema 1: `pointed`,
  `held`, `again`, `ignored`, `savedTokens`, `savedUsd`, `unpricedTokens`). Never added into the handoff's
  figure: two policies, two series, as the clearing and the handoff are. `again` and `ignored` are the quality
  counts -- a read asked for twice in a turn, and a pointed-at file the lead went on to read whole -- so the
  day's count and the day's dollars are one rule here too (`pointed - ignored` is what the saving is drawn from).
  Sessions only, no row-based fallback: the trigger ships with the figure and has no history to price.
- **Live, on Opus 5 through the settings hook (2026-11-20):** the second whole-file read was denied, the lead
  answered from the first copy ("200 functions, f7 returns x + 7"), said the hook had stopped the read and why,
  and did not route around it. The mod's branch is held by a test that runs the mod's own `reasonOf`; a headless
  `claude -p` session would not activate the mod against a redirected `THINKER_HOME`, cause unknown, so that
  door's live check waits for a real session on a released build.

**Claude Code's agent hook: the harness runs the subagent, no rule fires it yet (2026-11-15, the owner's call):**
- A PreToolUse handler of `type: "agent"` makes Claude Code spawn its own subagent on a matched call; its `ok: false` reason is the denied call's result. The lead has no say and thinker spawns nothing.
- `delegate.js:agentHookEntries`, `agentHookPrompt`; reads only. Rules are `delegate: { agentHooks: [{ matcher, if? }] }`, **empty by default, so nothing is written**. When to fire is a separate decision.
- Live on 2.1.325: whole read of 600 lines answered in 12 s for $0.005 on Haiku, worked from; a ranged read let through by the subagent in 3 s; `if` (`Read(*.js)`) filters.
- The reason must open with `denial`'s report sentence and the subagent must be told it is the one named: a bare report, or one hedging about who read the file, was called an injection and re-read.
- Limits: static match only (no size or holdout), one model call per matched read, no `op: delegate` row. A suite run failed live (shell only where the session's permissions allow it; report distrusted).

**Fleet reporting: a machine with an org API key reports to its org's dashboard (2026-11-17, `src/fleet.js`):**
- Beside the telemetry and separate from it: the telemetry is thinker's own, anonymous, hourly, a 30-day window; this is the person's org, keyed, incremental. Neither reads the other's state.
- **No key, nothing**: no request, no state file, no process. Key is `THINKER_API_KEY`, else `<THINKER_HOME>/fleet-key` (`thinker config set api-key`, 0600, never `config.json`). `THINKER_FLEET=off` is local mode with a key set.
- **From the Stop hook** (`fleetTick`, beside `emitSession`), so every client is covered, desktops included. At most one report every 5 min (`FLEET.everyMs`): due now is sent now (2 s), else one detached `fleet-report --at` waits for the mark. An idle machine sends nothing.
- **A report is increments, applied exactly once**: per moved session, figures now minus figures last acknowledged (`sessionEvent`'s, so the one pricing door). Written to `state/fleet.json` under its own id before sending and re-sent unchanged until acknowledged; nothing new is built meanwhile; one sender at a time (`state/fleet.lock`). The server refuses the last id applied. Do not make a report a total: the server adds.
- **Closed list out**: machine id (the install id, or `THINKER_MACHINE_ID`), hostname, OS, version; per session id, agent, model, repository name (origin's last two parts, never a path or URL), two times, numbers. No prompt, code or path.
- **A session in depth** (`detailOf`, 2026-11-17, for the dashboard's session page): the per-call series, thinker's actions and cost by token type (`events.js:costByType`, `costOf`'s four terms each alone), rebuilt field by field so a delegation's file names and error text stay on the machine. A snapshot, not an increment: sent whole, and only when its stamp changes. A report holds `sessionsMax` (10); a backlog goes as up to `reportsMax` reports back to back.
- **The answer carries the org's settings** (`managed: { at, config }`, the dashboard's Account → Machine settings): `applyManaged` takes them exactly as it takes a sink's, so `MANAGED` is still the whole list, newest `at` wins, and `managed: false` / `THINKER_MANAGED=off` refuses them while the figures still go. The server's list (`thinker-internal: infra/fleet/src/api.mjs`) mirrors `MANAGED`; change both.
- `thinker status` sends a real report (the waiting one, or an empty one), so "reachable" means the key was accepted. The server lives in the private repository; `fleet: { url }` in config points a test at loopback.

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

**The website and the hosted infrastructure are not here (2026-11-17, the owner's call):**
- `site/` (thinker.sh) and `infra/` (the site's deploy, the metrics API, the fleet service) live in the private `thinker-internal` repository. This repository is the tool.
- A change to a payload the metrics API reads is tested here for what the client sends; the server's half is tested there.

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
- **Every saving names its policy:** `cutting.js:policyId`, format `r<rev>-<settings>` (e.g., `r4-t140k-f8k-p25-deep`). `proxy.js` stamps on log rows; `compression.js:noteCompression` on session record. Unstamped savings never fold into current figures. Policy stamp prevents date-based errors across machines.
- **Dashboard reads stamped policies only** (`thinker-internal: scripts/savings-dashboard.mjs:STAMPED`). Pre-stamp clears in separate row. Unstamped clears left out.
- **Two rewrites not charged:** cold cut's own call (`r.clear.cold`) and rewrites from expired cache (no read found). Both doors enforce via `cutting.js:chargedRewrite`, `register.tsx:chargedRewrite`.
- **A saved token is priced by what its request did with the cache** (2026-11-18; `cutting.js:savedAs`, `wroteCold`): a cache read, or a cache write at the request's own TTL mix where the request read nothing back and wrote its whole context (a session resumed past the cache's hour: 20 reads to the written token on Opus 5, 40 on Opus 5.5, 80 on a Fable). The same mark as `chargedRewrite` read the other way, so a rewrite a cut caused (it still reads the system prompt) is never credited. `compression.js:clearedBySession` and `report-savings.js:weeklySavings` price row by row; `cost.cold`, the `sessions` groups' `coldUsd` and `byDay`'s `coldUsd`/`stampedColdUsd` are that part of the saving on its own (part of `savedUsd`, not beside it; absent from a client before it). A desktop clear known from its record has no request to read and is priced as reads; delegation's later calls are too (a session's rows hold its subagents' cold first requests).
- **Goose goes through the proxy** (2026-11-19; `proxy-service.js:gooseFile`): a top-level `ANTHROPIC_HOST` in Goose's `config.yaml` (`GOOSE_PATH_ROOT/config` when that is absolute, else `XDG_CONFIG_HOME` or `~/.config`, `goose/`), the proxy's bare origin, set and taken out as text (`yamlScalar`, `withYamlScalar`) because Goose rewrites the file; a host of the person's own is left and named, and no file is made where there is none. Only its Anthropic provider is carried; on another the key is inert and the line says which provider it is on. Its session is the `agent-session-id` header (`cutting.js:SESSION_HEADERS`). Goose sends four cache breakpoints at the five-minute TTL and `thinking.block_binding: drop_block`, so a cut is neither a fifth breakpoint nor a refused history. Read in Goose's source at 1.60 and run through the real proxy with requests of that shape against a stand-in for the API; not yet run with the Goose binary itself. Devin has no such route: its model calls go to Cognition's backend (`devin-compaction.js`).
- **A seeding request's row carries the cut it was sent with** (2026-11-18): every earlier cut is applied on the request that seeds the next (`proxy.js`, `clientCut` on the `seed` row, `reason` kept); rows written before that said `cleared` 0 and are given the figure of the conversation's request before them at read time (`compression.js:carrySeeded`: same model, the same or the next turn, a context 0.9 to 2 times that row's; marked `carried`).
- **Prices are a model's, not its family's** (2026-11-18, against Anthropic's pricing page; `model-usage.js:RATES`): Fable 5.2 and Mythos 5.2 at $8/$40 with reads at $0.20 (they were priced as 5.1, a quarter high); Fable 5 and Mythos 5 read at a tenth, $1; Sonnet 5.5 reads at $0.10. `cutting.js:readRate` takes the same rows, so the cut decision on Fable 5 and Sonnet 5.5 moved with them (0.025 to 0.1, 0.1 to 0.05). Haiku 5.5 over 100k of prompt is five times its row and is not modelled. **A warm cut is charged whatever its request wrote** (2026-11-18): no 100k context floor and no half-of-context share, which had recorded large cuts as free.
- **Only the rewrite a cut caused is charged** (2026-11-16, the owner's call; `compression.js:clearingCostBySession`, `register.tsx:charge`): the request that made the cut (the row's `clear`; the mod's first request after a clear). A rewrite on any later request was coming without the clearing and is in no cost figure.
- **Factory's two arms:** `telemetry.js:armsMetrics` sends `factory.arms` sums (sessions, exchanges, dollars, rework, cache traffic, merged PRs) per stage/loop, by policy stamp. Schema 1, read by **Diff by feature** dashboard.
- **No saving or clearing cost on or before 2026-11-04** (2026-11-16, the owner's call; `delivery.js:COST_SINCE`): clears, rewrites after one and desktop records before 2026-11-05T00:00Z are in no dollar figure of `thinker prs`, the PR stats or the telemetry; the dashboards' by-day cards hold the same line. Off under `THINKER_TEST` unless a test passes `costSince`. The ledger's lifetime figure is not cut.
- **Thinker by day** (2026-11-16; `thinker-internal: scripts/daily-dashboard.mjs`): saved per day and total since 2026-11-04, devices with a session, cuts (`proxy.byDay.cuts`, and from 2026-11-19 Devin's own compactions beside them: `telemetry.js:compactionMetrics`, `compactions.byDay`, counts alone and in no dollar figure, since the proxy cannot carry Devin and a Devin session has no list price), delegations (`telemetry.js:delegateMetrics`), what delegation saved (the same block's `savedUsd`, the savings ledger's own rows by day, added into the total), known devices. The total and "Saved per day" read one table of days (`savedDays`: the cuts' net plus delegation's saving), so the bars add up to the total; each half has its own card ("Saved by context cuts, per day" with the cut costs beside the gross, "Saved by delegation, per day"). A negative day is a measured loss (a cut that had not repaid its rewrite), never clamped. Every card shows the last 30 UTC days (`WINDOW_DAYS`); the line savings count from is in the queries and in no card's name. The cuts' two cards share a row, delegation's two the next. Clearing dollars count stamped sessions alone (`stampedNetUsd`): a clear with no recorded policy is in no card. A day is read from the newest snapshot carrying it, so days add up. Dollar cards prefer `sessions.byDaySchema` 2 snapshots: a session is dated by its own turns, never by a background read of it (`delivery.js:READ_LATER`).
- **`sessions` payload groups:** sums not averages. `all`, `cleared`, `uncleared`, `byPolicy`, `byClient`, `netBuckets`. Cost per prompt beside cost per session.
- **`prs` schema 3:** `spendUsd`, `spendPrs` (over PRs with all sessions priced), `clearedPrs`, `byPolicy`, `rows` (newest 50). No PR/repo/session names.
- **Labels were removed** (2026-11-14, the owner's call; added 2026-11-12 in #778, `src/labels.js`): up to 8 names an operator set, on the payload and on every `op: session` row, so a fleet could group its figures by customer, harness build or job. Nothing ever read them: the fleet page became one row a machine, and the collector's grouping by label went with it. They were also the single place in a payload where identifying data could appear, which is a standing cost for a feature with no reader. An export that needs to say whose machine a session was can key on the install id it already carries. The code is in git at `0b5797bc4` and before; do not bring it back without a page that shows them.
- **Oversized payload:** `fitPayload`, `PAYLOAD_BUDGET` 56 KB. Drops rows first, sets `rowsDropped`.
- **Session events, the per-session export** (2026-11-13, `src/events.js`): one JSON object a session, newline-delimited, to `off` (default) / `stdout` / a file / an HTTP collector, by `THINKER_EVENTS` or `events` in `THINKER_HOME/config.json`. Figures from `delivery.js:sessionsOf` -- nothing here turns a token into a dollar. The payload cannot be this: a 30-day window sent hourly is for dividing sums, not adding them. **Upsert keyed on (install, session)**, newest wins (the clearing's figure settles turns after the cut), so a sink must never add two events for one session. A sink that is down spools to `state/events-spool.jsonl` (500 lines) and drains oldest-first on the next session; every transport failure is "nothing left", never a lost line. Carries `version` and `decisions` -- the cuts with policy and turn, the refusal reasons (`decideCut`'s branches) and the tools whose results left the prompt, from the proxy log and `state/compression/<session>.json`. Loopback-only under test, the telemetry's rule.
- **The fleet collector** (`demo/collector/`, demo tooling, in no release; Node 22.5+ for `node:sqlite`): `POST /v1/sessions`, one SQLite table, and a page whose critical view is **one row a machine** with its own stats, a roll-up by label beside it, and the decisions behind the saving. Three rules it is built on: an event is an upsert never an addition; a rate is a ratio of sums; no dollar is made there (a session with no list price is a session and in no dollar figure, `null` not $0.00).
- **The fleet e2e, and the four things it found** (2026-11-13, `demo/e2e/`): three containers, each OpenCode 2
  with thinker installed and wired, thinker's proxy in the model path and a **loopback Messages API** in place
  of a provider, so a real agent loop runs with no credentials (`demo/e2e/model.mjs`: the turns are scripted,
  the usage is measured from the body that arrived, nothing invents a figure). `fleet.sh clear|build|up|push|
  reset|round N|policy T|state` drives it against a collector on the host. **Everything below was found by
  running it and none of it by reading the code**, and all four were invisible on this machine because they
  are the paths Claude Code does not take:
  - **OpenCode's route had no `/v1`, so the cut never fired once.** `proxy-service.js:opencodeFile` wrote the
    proxy's bare origin; the Vercel AI SDK posts `${baseURL}/messages`, and `proxy.js:transformRequest` only
    matches `/^\/v1\/messages/`. 16 calls reached 193k tokens of context with nothing cleared, while
    `thinker proxy status` said the route was wired. `isOwnUrl` now strips `/v1`, `/openrouter`, `/bedrock`
    and `/codex` before comparing, or thinker reads its own route as somebody else's and will not remove it.
  - **No request was attributed to a session.** `sessionOf` read `x-claude-code-session-id` and nothing else,
    so every other client's rows logged `session: null` and the cut's record keyed on a body hash. OpenCode
    2.3.0 sends the id in four headers (`x-opencode-session`, `x-opencode-session-id`, `x-session-affinity`,
    `x-session-id`), the same `ses_...` id its plugin gives the Stop hook. `SESSION_HEADERS` reads them.
  - **No session event shipped at all.** The Stop hook's `op: session` branch required the agent's own
    transcript; the clients that keep none are recorded by thinker's own trace (`traceFile`), which the
    distillation beside it already read. A fleet of OpenCode machines reported nothing.
  - **And then the session had no figures.** A trace carries no usage, so the row named a client and not one
    token. `compression.js:usageBySession` sums the proxy's own rows per session (it is in the path of every
    call and taps the usage off the answer), and `sessionsOf` prices from that **only where the session's own
    record has none** -- a transcript always wins, `usageFrom: 'proxy'` and `servedCalls` say where the figure
    came from and how many answers the proxy saw. Nothing new prices anything: `prices.js:costOf` is still the
    door, and the row's `input` (the API's fresh count) is converted to the total it takes.
  - Two things the e2e showed that are **not** bugs. A session of one prompt and forty tool calls has nothing
    the cut may touch, because the newest turn is kept whole (`walkResults`) -- an autonomous one-prompt job
    never gets a cut, which is a policy question and not a fault, and it is why the e2e runs three prompts in
    one session. And `cleared` is cumulative over requests on purpose: a result cut at call 20 is absent from
    every later prompt, so summing the per-request figure is the tokens actually avoided, which is exactly
    what `delivery.js` then prices once at the cache-read rate. 92M cleared on a 244M-token session is that,
    not an over-count.
  - What the run shows end to end: a slider moved on the dashboard reaches three containers on their next
    session (`serviceArgs` translates the merged config into the proxy's `--trigger`), and the refusal reason
    inside them moves from `below-trigger` to `below-clear-minimum`. The plugin's own stop call loses a race
    with `location.shutdown` under `opencode run`, so the wrapper ends the session itself -- which is the
    integration point for a harness that owns the job's lifecycle.
- **`byDay` cumulative per snapshot:** day of session's last request or PR merge. Never add snapshots; explode days, add those.
- **Desktop clears outlive card record:** `compression.js:mirrorClearing` writes to `state/compression/<session>.json` (max 200 files, pruned after `PRUNE_AGE` 2 days) and once to log (`op: 'clearing'`). `delivery.js:sessionsOf` reads; `clearedBySession` sums cumulative. Take newest row, never add.
- **Cold cut pricing:** the ledger (`compression.js:clearingCostBySession`) charges a cut made on a cold request nothing (cache expired, rewrite happens anyway). Warm cuts charged their rewrite. **The decision does not price cold at zero** (2026-11-18, the owner's call): `cutting.js:priceCut` and `clear-door.js:clearPays` price a pause past the cache's hour as a live session, so a resumed session is cut only where a live one would be.
- **Dashboards:** **Savings per session** (`thinker-internal: scripts/savings-dashboard.mjs`), **Pull requests delivered** (`thinker-internal: scripts/delivery-dashboard.mjs`, `valid` accepts schema 2 or 3). Read from `reports.raw_json`.
- **Limits:** Clearing holdout off since 2026-11-12 (was per-machine baseline, now end). Unstamped clears on current machine until next build. Sessions with no usage (Cursor) counted but no cost. Model per-session reread tracked in `src/rereads.js`.

## Usage history

- Runs append to `~/.thinker/log.jsonl` (under `THINKER_HOME`). Repo key: origin in `.git/config`; no origin: path.
- `THINKER_LOG`: path, `local` (`.thinker/log.jsonl`), or `off`. Harnesses installing real hooks MUST set `THINKER_LOG=local`.
- Log keeps first 200 chars of each request (`op: request`; `orient` rows from before 2026-11-08 count as requests too).
- `thinker usage [--here] [--days n] [--json]`: requests, sessions, agents, what learning spent. The savings are the clearing's (`thinker savings`, the Report).
- MUST NOT show dollar costs or estimate cost from tokens outside `prices.js`'s doors. Provider-reported cost is data only.

## The session profile (2026-11-07, `src/profile.js`; on by default since 2026-11-08)

- **Two stages, one ledger.** Sessions end by pairing each prompt with answers until the next prompt, asking the model for observations: request, approach, outcome (`accepted`, `corrected`, `redirected`, `unknown`), quoted reaction, lesson where supported. Written to `.thinker/local/profile/ledger.jsonl`, 60-day window. Rows carry `at` (session clock) and `seen` (ledger read time).
- **The repository's rules ride the same pass** (2026-11-21, the owner's call: "judge sessions not replays; each session gets one pass"). The read is also shown the sections of the instruction files that could bear on the session (`instruction-value.js:passSections`: the ones its tool calls fired, then the ones with no trigger, whole sections up to `VALUE.passChars` 24k) and returns `rules`: followed / violated / applicable for each that came up, with a quote the code checks against the session (`checkedRule`: no quote, kept as applicable). Kept on the session's record (`recordPassVerdicts`, the worst verdict across reads) where the Context report reads `judged`. No call of its own: a second call on a 25% sample did this until 2026-11-08, and from then until this nothing did (its caller went with the knowledge notes). Measured on one real session here: 14k tokens, $0.12, 7 s for the whole read. `instructions: { value: { judge: false } }` turns it off; `share` shows the sections to a share of sessions. `thinker context --judge n` still judges by hand, a call each.
- **Compile is a daily patch** (`compileHours` 24, `compileBatch` 200). Due when a session enters the ledger and last compile is 24h old. Model shown profile with id on each entry, new observations, and related rows (max 40, `relatedCited`). Returns keep / update / drop / add. Entry with no citations leaves by code. Updates apply floors and window; full compile via `thinker profile compile --full` or changed prompt; backlog longer than 200 patches in steps, oldest first.
- **Citations hold entries to observation window** (`settle`): dropped if window does not hold; entry with none leaves. Counts and dates from cited observations. `howWeWork` line needs two sessions or one stated preference (a lone correction or interruption no longer suffices, 2026-11-12: that is where the narrow lines came from). Workstream leaves if not seen in 21 days. Stated preferences and corrections worth most; repeated rules get marked "in AGENTS.md; still missed".
- **Model: Opus only** (`PROFILE_MODELS`, `completeProfile`). Calls get 10 minutes. Another model set via `learn.profileModel`.
- **Skills** (`exchanges` carries `skills`, `observationSkills`; `/skill` or agent `Skill` call). Extractor sees `SKILLS:` line per exchange. Compile shown tally per skill (sessions, observations, person/agent typed, outcomes) and related observations (max 40, newest). Line per skill: use and person's reaction. Kept only when cited observation ran or named skill; two sessions or person naming it. Rendered `/name: text`. Backfill via `thinker profile backfill [--dry]`.
- **Rendered block** (~1500 tokens, `renderChars`; `renderProfile`, `profileBlock`). Headed with one sentence and session count. **Served text only** (no counts, dates, outcome tallies; use `show --why`). Oldest workstreams first (to 3), least-used skills (to 3), weakest ways of working (to 4), longest last (`TRIM`).
- **Served by prompt hook, held out by session** (deterministic share via `profileHoldoutRate` 0.5, `learn: { profileHoldout }`, env `THINKER_PROFILE_HOLDOUT|THINKER_HOLDOUT`). Block goes first in session; state file holds arm, count, compactions seen (`st.profile`). `profile-served` row logged per injection and once per held-out session.
- **Measure: cost per exchange and recurrence.** Cost is ratio of sums (tokens over exchanges), stratified by model, bootstrapped interval. Recurrence: how often person restates prior preference (`repeats` on observation; extractor shown profile lines and 200 prior distinct prefs/lessons, newest first). Judged `profile` (line held it) or `ledger` (compile failed). `servedRate` is holdout's question; `unlearnedRate` checks extractor. Rows before `repeats` extraction not measured (`measured` field).
- **Line verdicts** (`LINE_VERDICTS`, `shownLines`, `profileTurn` keeps ids in `st.profile.shown`; `thinker profile lines [--why]`). Per-line per-session: `applied`, `ignored` (evidence of violation or silence where line covered work; person restating in prompt is `ignored`), `na` (no bearing). `followRate` over sessions line applied to; `null` where none. Default `na`. Verdict on unseen id or second verdict on same line dropped.
- **Corrections weigh most, lines retire by code, ids are stable** (2026-11-12, the owner's call). `settle` ranks `howWeWork` by the corrections cited behind a line (`isCorrection`: corrected, redirected or interrupted, the Factory's rule), then sessions; the cap and the render's trim take from the bottom. The compile sees a batch's corrections first and each live entry's `corrections` and `use` (shown, applied, followed, ignored, contradicted from `lineReport`), with the rule to reword, move or drop a line applied in a fifth or fewer of five-plus sessions: the fix is at the source, the retire rule is the backstop. The prompt bars state from a workstream (no PR number, merged/unmerged, deployed, on/off, "done"). A line judged `na` in `retireShown` (15) sessions is `retired` (`retireDue`, `retire`): out of the served block the day it happens (`profileBlock`), marked on the profile at compile and listed to the model as RETIRED, never re-added; `thinker profile lines` and `show --why` mark it; `lines.retired` on the metric. Entry ids keep across compiles (`ids` counters on the profile, `idCounters` for one from before), so a verdict keyed on an id is about one line; until then `h1` was the rank.
- **A verdict is held to its evidence, and to the wording it judged** (2026-11-15, the owner's go). Of the first 597 verdicts here, "followed" was often a true quote about something else (the worktree line on "must not write into a managed account home", a workstream on the status footer), and the compile steers on those counts.
  - **Clause and quote, checked by code** (`checkedVerdict`): a verdict other than `na` names the `clause` of the line it judged, which must be in the line, and its evidence must be in the session text; one that fails is `na` with `unsupported` (`clause` or `evidence`) and what it `claimed`. `thinker profile lines` counts them.
  - **`TOOLS:` per exchange** (`toolLabels`, `exchanges` carries `tools`): the tools the agent ran, by name, and a shell command's program with its subcommand (`git worktree`, `gh pr`, `npm test`). Never an argument, a path or output. A line about an action is judged on it before the agent's words.
  - **Kinds**: each shown line is marked (way of working), (work in progress) or (skill). The last two are context, not rules: `na` unless the session was on that work or ran that skill.
  - **Per wording** (`rev`): `applyPatch` bumps an entry's `rev` when an update changes its text; `profileTurn` keeps the revs a session was shown (`st.profile.revs`, `shownRevs`), `profileSession` asks only about wording the session saw, the verdict row carries `rev`, and `lineReport` counts the current wording's rows alone. A reworded line starts from nothing.
  - **A full compile never reuses an id** (`idFloor`): its counters start from the profile on disk, since `lines.jsonl` is keyed on the old ids.
  - **One rule per line**: a `howWeWork` line is one rule under `ruleChars` (120), and the compile splits an entry that holds several. The line that packed four was followed in 10 of the 20 sessions it bore on and was 32 of the 51 repeats of something the profile held. Caps: `workingOn` 4 (was 6; each bore on 1-3 of 29 sessions), `howWeWork` 16 (was 12).
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
- **Dollars are netted** (2026-11-04; one rule, one sentence: **cleared at cache-read rate, plus reading avoided at input rate, less cache rewrites after clear at list prices**). `delivery.js`, `thinker prs`, posted comment read one computation. Deduction = `chargedRewrite` over proxy log, on the request that made a cut alone. Netted figure (`net`, `netPerPr`, `meanNet`) in data, `thinker prs`, comment. Gross avoided cache reads before cache rewrite costs (Report).

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
- **Endpoint:** `/errors` on metrics API (server side, not in this repository). Rejects payloads matching `LOOKS_PRIVATE`, `LOOKS_LIKE_URL`, `LOOKS_LIKE_TOKEN`.

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
