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
- The gateways door (`src/proxy-chat.js`, 2026-11-10) adapts OpenAI Chat Completions (OpenRouter, LiteLLM; routed by path prefix on the service, `proxy: { gateways }` in the machine config) to the same `decideCut`, with its own cut store (`state/clearing/chat/`) and its own conversation key (the first user message; a gateway sends no session header). A new gateway is a config entry, not a new door. Its cleared-token figure is always the cut's own estimate (`cutting.js:clearedOf` reads `protocol: 'chat'` rows so).
- **The decision's rates are dynamic** (`src/gateway-rates.js`, 2026-11-10): config (`proxy: { rates }`) beats the fit of the gateway's own per-call cost answers (`rateTracker`, in memory, solved once per new observation) beats the Anthropic constants. `priceCut`/`decideCut` take `rates`; a clear and a payback refusal carry theirs on the row, and the record's `saved` is read at the rates its clear was priced with (`cutResponse`). A provider that never reports cache-write tokens gets the rewrite priced at 1.0 (implicit caching charges full input price for it), named `assumed` -- a fit that cannot see a coefficient is never read as one that measured it at zero.
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
- Run `npm ci` in a new worktree before the suite, and treat a first run with those failures as nothing. What installed them is not confirmed; if it turns out to be a prompt hook, it is an install nobody asked for (the rule that hooks do no side work went on 2026-11-11, the installer-from-a-hook ban did not), and is worth chasing.

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

**Serving and policy switches: the state, and why each is where it is.**
The rule that stood here from 2026-10-16 to 2026-11-08 -- that a change to cache sources, note serving or (in its
2026-11-08 rewording with the notes' removal) what a session is shown or the clearing's policy ships off behind a
switch, and goes default-on only after an experiment or a holdout measurement cited in its own PR -- is **removed, at
the owner's instruction (2026-11-08)**. What it was for: a run of serving strategies that looked good offline and cost
more in live sessions (the Jev reranker, serve-on-sight, the LLM reranker), so the rule made the experiment the price
of a default. What it cost: the session profile is the clearest case -- the one honest measure of it needs weeks on
one machine, so the rule would have held a feature off by default for a quarter to buy a number nobody can act on.
Judgement replaces it. The records below are kept because they say what is on and what measured it; they are no
longer exceptions to anything.
- Offline replays are still not evidence of a live gain, and a figure from one should say so.
- On by default, no experiment (2026-11-08): the session profile, measured by its per-session holdout (`thinker profile holdout`); Artemis task benchmarks do not fit a per-person profile.
- On by default, no experiment (2026-11-01, `devin-compaction.js`): Devin's own compaction threshold is written into its user config (`agent.compaction_threshold_tokens`) at `DEVIN_COMPACT_AT`, the proxy's trigger (140k), **on by default** with no experiment. Devin has no model endpoint, so its compactor is the only context reduction it can have; `devin: { compactAt: 0 }` (`THINKER_DEVIN_COMPACT_AT=off`) turns it off and restores what was there. Proven live at 140k: six turns of heavy reads peaked at 143k and fell to ~100k at each applied compaction, where the same workload without the key climbed to 297k (`docs/agent-integrations.md`). Savings claims still need an experiment: judge by summary calls and cache rewrites, not tokens removed.
- On by default, no experiment (2026-10-25): Codex proxy tool-output clearing is on by default via install/connect/setup/update. `proxy-codex.js` wires a managed provider without reading credentials. `/codex` routes ChatGPT-account requests to the ChatGPT backend, API-key requests to OpenAI. Custom providers stay as configured. `thinker proxy off` restores prior selection. Savings claims still need an Artemis experiment.

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
- **The figure's rate is a result's, not the prompt's** (2026-11-08; `proxy.js:RESULT_TOKENS_PER_CHAR`, 0.445,
  mirrored by the clear mod for its breakdown). `TOKENS_PER_CHAR` (0.36) is the Report's whole-prompt calibration;
  measured on 265 real tool results from transcript usage deltas, results run 0.433 median, 0.445 weighted, so the
  reported saving was a fifth short (the one clean live cut: 16,966 claimed, 30,718 dropped by the API). The
  decision's own arithmetic keeps 0.36: a cut and its tail scale together, and widening the size floor's reach is
  a policy change. Still an estimate (`clearedEstimated`); the honest next step is the API's own usage deltas per
  result, recorded in the cut record as the result first enters, which the proxy and the mod both see.
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
  the service's holdout; `test/claude-clear.test.js` holds them together), read from the same `proxy` block of the
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
- **A refusal says which branch refused it** (2026-11-08; `cutting.js:decideCut` returns `reason`, both doors
  print it). `decideCut` refuses on six branches and none of them was distinguishable from the object it
  returned: `mid-turn`, `one-cut` and `below-trigger` all answer `{cut, clear: false}`, and a payback refusal is
  a size refusal with a `held` beside it. So the Messages door derived the reason from `candidate` alone -- one
  line, `d.candidate ? 'below-clear-minimum' : 'nothing-to-cut'` -- and of this machine's 125 rows carrying a
  candidate, **29 carried one above the floor and 11 were payback refusals, all labelled as the floor**. That is
  the one question the log exists to answer, the floor being the lever the policy turns on, and the 60k floor was
  chosen against a log that mislabelled a quarter of its refusals. The Responses door derived it correctly from
  `held` and the trigger but saw neither of the first two branches, and deriving it twice is the rederiving the
  shared-policy rule forbids. Now the function that decides says why.
  - **`nothing-to-cut` wins over every branch.** Mid-turn is most of the traffic, so a mid-turn request with
    nothing cuttable in it logged as `mid-turn` would drown the refusals the log is read for; a request with no
    candidate says so whichever branch it took, and `mid-turn` means a boundary genuinely held back.
  - **`nothing-to-cut` is checked before the trigger**, so `below-trigger` means what it says: there was
    something to cut and the prompt was too small to spend it. Those rows are the trigger's to answer for.
  - **A refusal that was not the candidate's fault carries the candidate too**, so the same log answers what a
    lower trigger would have taken -- the question `AGENTS.md` last answered by rebuilding bodies from
    transcripts.
  - Pinned by `test/cutting.test.js` (all six branches, the precedence, and that no refusal moves the set).
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
- **The holdout is half the sessions, from 15%** (2026-11-09, the owner's call; `proxy-service.js:SERVICE_HOLDOUT`,
  mirrored by the mod's `HOLDOUT`, pinned together by `test/claude-clear.test.js`). The 15% was inherited from the
  notes' per-turn holdout, where the held-out side was a regression check on something already shipped. The clearing's
  question is still open -- the 28-turn pairing above, the cut arm's unexplained extra writes, and the Factory's split
  on the day it was built (19 cleared sessions against 42 held out, marked thin) -- and at 85/15 the small side carries
  most of the noise, so every figure waited on the held-out sessions alone. Half is the profile's reasoning applied
  here (`PROFILE.holdoutRate`): an even split is for a question, an unbalanced one for a guard, and this goes back to
  85/15 once the clearing's net is known. The side is still per session by hash (`proxy.js:heldOut`), so a session
  keeps its side across the change; `proxy: { holdout }` in the machine config still wins; the service restarts idle
  on the next prompt hook after the update, since its flags moved (`replaceReason`). Cost: half the sessions past
  140k go uncleared for the window, which at this machine's rate is the saving the clearing would have made on them.

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

**What changed in thinker, said once (2026-11-10, the owner's ask; `src/update-note.js`):**
- thinker ships every few days and said nothing about it. The agents it wires itself into never name a
  version or a release, so the knowledge notes became a memory profile on a person's machine overnight
  with no word anywhere in the product. One note, four lines at most, said once.
- **One copy, in `src/update-note.js`**: `UPDATE_NOTE` is `{id, title, lines, more}`, and
  `updateNoteText` is how an agent that draws no card says it. The Claude Code mod carries its own copy
  of those words (`src/integrations/claude-card`, `UPDATE_NOTE`), held to this one by
  `test/claude-card.test.js`, as every other word the mod says is.
- **Keyed on the note's own id, never on a version** (`updateNoteDue`, `updateNoteShown`, kept in
  `<THINKER_HOME>/state/update-note.json` beside the notice cadence, since a person sees one stream of
  messages however many checkouts they work in). So a note can be written without cutting a release, and
  a release that changes nothing a person can see says nothing. Change the id to say something new.
- **Two doors, one voice**: where the card mod runs it is a card under the answer, drawn at the end of
  the first turn, and the Stop hook says nothing (`carded`, the rule the money already follows); every
  other agent gets it at the top of the next end-of-turn summary, inside the cadence, so it is still one
  thinker message. Notices off silences it like everything else.
- It does not wait for the summary cadence in the card door: a release note is a one-off, and a person
  who learns a week late what their agent has been doing has learnt it too late. It does not spend the
  summary either, so the next one still comes when it is due.

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
- **And the version, which nothing else in a session says** (the owner's ask, 2026-11-10): `thinker
  v0.3.0: saved today ~ · lifetime ~`. An agent never names the thinker it is running, so a person whose
  knowledge notes became a profile overnight had no way to tell which copy did it or whether their own
  is current. The status row is the one surface on screen the whole session, so it carries it and no
  other line does. The figure's own version: `computeSavings` stamps the ledger with `appVersion()` and
  every door reads it from there, so the row names the copy that counted the dollars beside it (the mod
  reads one small file and cannot read a `package.json` of thinker's). A ledger from before this, or a
  checkout with no version to read, says `thinker:` as it did. The desktop line drops the name alone
  (`desktopStatus`, `/^thinker:? ?/`), since the app heads a pinned line with the plugin's name.
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
- **The row follows the file, not the turn** (2026-11-08; `register.tsx:LEDGER_POLL_MS`, `ledgerMoved`). The
  Stop hook's refresh is a detached process of about a second, and the mod read the ledger at the end of the
  same turn, before the write landed: every session showed the ledger as of its previous turn, and open
  sessions disagreed until each had another turn. The mod now stats the ledger file every 5 s while the
  session is open and reads it only when its modification time moved, cancelled at `session.end`; the runtime
  has no file watcher. `test/claude-card.test.js` pins it.
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

- **OpenCode 2's terminal part is one more door** (2026-11-10; `src/integrations/opencode-tui.js`,
  `src/integrations/opencode-v2.js`; `clients.js:opencodeMajor`). OpenCode 2 does not run v1 plugins at
  all, so `connect`/`rewire` writes a plugin **directory** (`plugins/thinker/`, `index.ts` server part +
  `tui.tsx` terminal part) where the binary's major is 2, and the v1 single file where it is not; the
  wrapper stays two lines that import this checkout's modules by file:// URL, as the v1 file did, so the
  words stay in one place. The footer rides the built-in footer row (`prompt.footer.status`, the one
  slot both the launcher and a session view draw -- registering the launcher's `home.footer.status` as
  well showed the figure twice; checked live), after the host's health indicators and before its
  version -- the same "a row of thinker's own does not earn one" rule the status tail follows -- reads
  the kept ledger every 5 s like the mod (`LEDGER_POLL_MS`, held to the same figure by
  `test/cli-ui-sync.test.js`), and the words are `savingsStatus`, the status row's own.
  The end-of-turn summary is a toast: v2 gives a server plugin no client (v1's `client.tui.showToast` is
  gone), so the Stop hook writes what it said to `THINKER_HOME/state/notice-last.json`
  (notice-cadence.js:writeNoticeLast) and the terminal part toasts it once (`noticed` dedupes by `at`); a
  headless `opencode run` has no terminal part and the summary is dropped there, as in v1. Everything the
  shapes rest on was checked against a real opencode 2.2.7 on 2026-11-10: prompt hook edits become the
  canonical prompt, `tool.execute.after` mutates `result.content`, the turn's end is
  `session.execution.succeeded` with the session in `data.sessionID` (v1's `session.idle` and
  `properties` are gone), and `context.storage.memory` is a Solid ProxyObject read as `state.line`.
  One divergence from the v1 door, same day: v1 serves the block as a `synthetic: true` part the
  host never renders; v2's admission hook has no synthetic part, so the block rides the prompt text
  and is visible. `ctx.session.synthetic` from inside the hook answers without error and never
  reaches the same execution -- the faithful port needs an opencode-side surface that does not exist
  yet (checked against 2.2.7).

**Exploration subagents on Sonnet, off by default (2026-11-08; `src/explore-agent.js`):**
- **Off until the owner decides to ship it** (the same day, after #712 landed on by default: "not 100% sure I want to ship
  it"). `exploreModel` returns null unless `THINKER_EXPLORE_MODEL=on|<model>` or `agents: { explore: true | "<model>" }`
  opts the machine in; a file written while it was on is removed at the next connect or rewire, and connect says so. The
  delegation nudge that would make it worth having is a todo; the measurement doors (#716, #717) are in place.
- Claude Code's built-in Explore subagent runs on the main conversation's model, so on an Opus or Fable session a
  delegated exploration is billed at that model's rates. A user or project subagent named `Explore` overrides the
  built-in one and keeps its own `model` (code.claude.com/docs/en/sub-agents), so `thinker connect` and `rewire` write
  `<claude config dir>/agents/Explore.md` at user scope with `model: claude-sonnet-5-5` (the full id: the `sonnet` alias
  resolved to Sonnet 5 on Claude Code 2.1.319, checked live), read-only (`disallowedTools`), starting
  without CLAUDE.md as the built-in does, with a `<!-- thinker-explore -->` marker. Only a file carrying the marker is
  ever rewritten or removed; a person's own Explore.md is left alone and named once in connect's output; a project's
  `.claude/agents/Explore.md` wins in Claude Code's own order and is never touched. `thinker uninstall --user` removes
  it. On, or another model: `THINKER_EXPLORE_MODEL=on|haiku|<id>`, or `agents: { explore: true | "<model>" }` in
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

**Models from other providers, and subagents on them (2026-11-10, the owner's ask; `src/providers.js`,
`src/wire-chat.js`, `src/proxy-routing.js`, `src/model-agents.js`, `src/model-profile.js`, `thinker models`):**
- The ask: an auto-routing strategy that is easy to onboard from a subscription or an API behind a gateway, a
  model-behaviour profile curated from the person's own sessions, and the performance figures kept beside it so a
  routing decision can say why. This is the integration layer and the ledger; the routing itself is still a hand
  move (`thinker models route`) on a printed recommendation, until the figures have been read on real runs.
- **There is no standard gateway interface; the wire formats are the standard.** Chat Completions is spoken by every
  gateway, Messages by some and by Claude Code alone, Responses by Codex; `GET /v1/models` is the one near-standard
  beside them, pricing has none (OpenRouter and Vercel put it in the list, LiteLLM in `/model/info`). So a provider
  is a base URL, a credential reference and the formats it was *found* to speak: `probeProvider` lists the models and
  sends one token in each format, and only a 200 in the format's own shape counts (a gateway answering every path
  with its own JSON is not speaking it). The registry is the machine's (`<THINKER_HOME>/providers.json`, mode 600),
  the key is never in it (`auth: { env | file }`, the file mode-checked as the Bedrock token is), and
  `registryPrices` is read by `prices.js:listPrice` after the repository config and before the built-in table, so
  dollars still have one door.
- **A route is what a request names** (`thinker/<alias>`, `thinker/<provider>/<model>`; `resolveRoute`). Claude Code
  sends an unrecognised model id upstream unchanged (checked live 2026-11-10 against a fake API: `--model
  thinker/gateway/gpt-6-sol` arrived as sent, with the adaptive thinking block and twelve tools, logged
  `unrecognized_model` on its side), so a subagent file whose `model:` is a route reaches the proxy. The proxy
  (`routeOf`, decided after the body is read since the route is in it; the upstream, `lib` and the agent pool moved
  inside `end` for it) forwards to the provider with the provider's credential and without the agent's
  (`routedHeaders` drops `authorization`, `x-api-key` and `anthropic-beta`), the cut applied first as for any
  request, then the model swapped and the Claude-only fields dropped (`routedBody`: `context_management` always;
  `thinking`, `metadata` unless the provider's model is itself a Claude model), then translated to Chat where that is
  the provider's format and the answer translated back as the API's own events (`wire-chat.js`; `usageTap` reads
  it unchanged; a whole answer and an error come back at their status in the API's shape). A route the registry
  cannot answer, or a key that is not there, is a 400 or 401 to the agent (`proxy-route-refused` in the log), never a
  forward of a made-up model to Anthropic with the person's login. The row carries `route`, `provider`,
  `routedModel`, `format`, `firstByteMs` and `dropped`. `authWatch` never judges a routed request (its upstream is
  not Anthropic's). Codex's Responses path is untouched.
- **A subagent on a model is a user-scope file** (`model-agents.js`; `<claude config dir>/agents/<Name>.md`, marked
  `thinker-agent`, a `reader` template that cannot write and a `worker` that can). That is the whole mechanism of
  "safely trigger a subtask on a specific model": the main conversation never moves, the key never enters Claude
  Code's settings, a wrong route fails on the subagent's first call with the reason, and every call carries the route
  on its log row. `Explore` is never written here -- it has its own writer (`explore-agent.js`) and `thinker models
  assign Explore <model>` sets `agents.explore` instead, since two writers of one file is how the other removes it.
  `connect` and `rewire` write what the registry names, `uninstall --user` removes them, a person's own file of the
  same name is left alone and named once.
- **The model profile** (`model-profile.js`; `<THINKER_HOME>/state/model-profile.json`, per repository, merged on
  show) is read from what is already recorded, no model call: each subagent transcript beside its parent (its
  `.meta.json` carries `toolUseId`, the parent's Agent call), priced at its own model, with the parent's follow-up in
  the exchange that launched it -- the share of the subagent's files the parent read again, edits after it, a
  correction or an interruption on that exchange (the ledger's verdicts, as the Factory reads them) -- and each route's
  calls, failures and median first byte from the proxy log. `recommend` is a rule with the figures beside it: per
  subagent type the model with the most runs is the baseline, and past `MIN_RUNS` (5) a model cheaper a run and no
  worse by `WORSE_BY` (10 points) on re-reads, corrections and failures is named. First cut, no evidence behind the
  constants yet: the re-read share is the one figure a price list cannot give and is the one to watch first. What it
  cannot see: a subagent whose parent is on another machine, Codex and Cursor subagents (none recorded), and whether
  the parent *should* have re-read (a read-only run that found the file is followed by the parent reading it to edit,
  which counts as a re-read; the edit column stands beside it for that reason).
- **First read of this machine's 60 days (2026-11-10, 94 subagent runs, 79 linked to the parent's Agent call), which
  moved the rules twice (`RULES_VERSION` 3).** The Read tool's paths alone saw 76 files across every run and no
  re-read at all: subagents here explore through Bash (grep, sed -n, cat), so a path named in a command counts
  (`pathsOf`, relative to the checkout with a worktree's prefix dropped), and the same run reads 20 files a run. And a
  background subagent returns in an exchange a task notification opened, so 11 runs showed no follow-up until an
  exchange became the person's (`isHarnessEvent`, the Factory's rule). With both: **after an Explore run the parent
  read again 51% of the explorer's files in the same exchange and 63% eventually** (4 runs, all on Opus 5, 39 files a
  run, 29.5 parent calls after), against 3-7% in the exchange and 7-27% ever after a general-purpose run. Split by what
  the run did rather than its type: general-purpose runs that edited (45, $4.37 a run) were re-read 4% in the exchange
  and 13% ever and followed by an edit of the parent's in 78% of cases -- the work is mostly trusted, then touched up;
  read-only general-purpose runs (20, $1.53) read almost no code at all (0.2 files a run: web research, docs). So the
  one exploration sample says half of what an explorer reads comes back into the parent's context anyway, which is
  the figure the delegation nudge and any cheaper Explore model must be judged against, and 4 runs is not a judgement.
  Per call: Fable $0.42, Opus 5 $0.10, Opus 5.5 $0.056, Haiku 4.5 $0.02 -- the gap a routed model has to beat, before
  its re-reads. OpenRouter's public list parsed as-is (465 models, 457 priced, cache read and both write TTLs
  reported, `supported_parameters` naming tools and structured outputs); its Messages endpoint was not probed, since no
  key is on this machine, so the live gateway smoke is still owed.
- Not done: routing by the profile itself, a holdout on the route (an alias that resolves to the session's own model
  for a share of sessions, so the comparison is paired), the delegation nudge that would make the runs happen, and a
  live run against a real gateway -- the translation is tested against fakes shaped like OpenAI's stream and the probe
  against fakes shaped like OpenRouter's and LiteLLM's lists. `docs/usage.md` has the person's side.

**A hook may hand a tool call to a subagent (2026-11-11, the owner's call; two rules removed):**
- Two rules stood here and are gone at the owner's instruction: *hooks never run or rewrite test commands*
  (2026-10-30, after the test wrapper and its automatic command interception were removed) and *hooks are only for
  the cache, no installs or side work from a hook* (2026-10-22, after PR #434 made a prompt hook start the installer).
  What they were for: a hook runs in every turn of a person's session, so an action it takes is one nobody asked for
  in that turn, and the interception of test commands had bought nothing. What they cost: the delegation trigger. The
  stage-delegation bench of 2026-11-10/11 (43 paired runs, Opus inline against an Opus lead with Sonnet subagents;
  the owner's memory notes `delegation-trigger-rules` and `stage-delegation-bench-2026-11-10`) measured that handing
  a turn's exploration to a Sonnet explorer once its reads pass ~35k tokens saves 11-50% on such sessions, projects
  to ~4.6% of this machine's spend over 30 days, and that a nudge the model may ignore is not a trigger. The only
  deterministic door Claude Code has is a PreToolUse hook that denies the read or the suite run, runs the subagent
  itself, and returns its report as the denial. That is side work from a hook, and it intercepts test commands, so
  both rules had to go for it.
- What stays: the installer is still a command, a skill or the page, never a hook branch, since downloading software
  from a hook is what directory reviews reject. Legacy `hook pre` calls still do nothing and the wiring refresh still
  removes them. A hook that spends the person's tokens does so under a switch the person can turn off, logs every
  interception with its cost, and is judged live against a per-session holdout, as the clearing is.

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
| `src/delivery-telemetry.js` | what leaves the machine about savings: the `prs` block (counts, tokens, cost, the clear on each) and the `sessions` block (the same saving per session), both grouped by the cut policy that made it |
| `src/factory.js`, `src/commands/factory.js` | the Factory: every model call at one of seven stages by the tool it called, the loops detected in the sessions by code, the first-pass yield; kept with the Report, read by the page's Factory tab and `thinker factory` |
| `src/explore-agent.js` | the user-scope Explore subagent on Sonnet: written by connect/rewire, removed by uninstall --user, never a person's own file |
| `src/providers.js`, `src/wire-chat.js`, `src/proxy-routing.js` | models from other providers: the registry and probe, Messages to Chat and back, the proxy forwarding a `thinker/…` model to its provider |
| `src/model-agents.js`, `src/model-profile.js`, `src/commands/models.js` | subagents on a chosen model, and the profile of how each model did as one; `thinker models` |
| `src/proxy*.js`, `src/commands/proxy.js` | context proxy; `thinker proxy on\|off\|status`; `proxy-route.js` leaves a routed harness alone; clearing results, call text and earlier thinking all on by default (2026-10-28), `--no-clear-inputs`, `--no-clear-thinking` off |
| `src/cutting.js` | the clearing: the cut set, the ratchet, the priced decision at a turn boundary, the session record |
| `src/proxy-retry.js` | a request that never reached the upstream: the retryable codes, the ladder a dead resolver gets, the address a host last answered on |
| `src/compression.js` | what the clearing saved, per session, shown as a cache hit is (`TURNS_AFTER`, `compressionHeader`); and what it cost, as the cache writes of the calls after a clear (`clearingCostBySession`) |
| `src/devin-compaction.js` | Devin has no model endpoint for the proxy: its own compaction threshold, written by policy (`devin.compactAt`, off by default), and what each compaction took out, read from Devin's session database |
| `src/notice-cadence.js` | how often thinker says anything at the end of a turn: one summary every 20 prompts and at most one a day |
| `src/update-note.js` | what changed in thinker, in four lines at most, said once per machine: a card where the mod runs, the top of the next summary everywhere else |
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
- **Telemetry** (`delivery-telemetry.js`): counts, tokens, dollars, and the policy behind each saving. See the section below.

## What a user's savings are, measured (2026-11-11, the owner's ask)

The question was what thinker saves **per session** on other people's machines, what a pull request **costs**, and
**whether a pull request got a context clear and how much was cleared**. The pieces were nearly all on the machines
already (`delivery.js` prices every session and every pull request at list rates, `compression.js` measures what the
clearing took out by either door) and nearly none of it was leaving them. What the dashboard could be asked on the
day of the ask, read from production: 262 installs in 30 days, 11 of them active, `prs.netUsd / prs.linkedSessions`
the only per-session figure there was -- and three reasons it could not be read.

- **The denominators disagreed.** `activity.sessions` is the report's own period (one hour for an hourly send) and
  the proxy's `sessions` is 30 days of `x-claude-code-session-id`, subagents and title calls included: one install
  reported 2 sessions and 2,563 on the same snapshot. Neither is a person's session, so cleared over sessions meant
  nothing. The figure is now built from the sessions themselves (`sessionsOf`, the usage log's `op: session` rows,
  one row per session), each with its own cleared tokens, its own cost and its own prompt count.
- **The window pooled dead policies.** The two biggest installs read -$980 and -$225 over 30 days that span the
  API-side clearing and the pre-#693 cut, both measured as losses. Now every saving names the policy that made it
  (below), so a reader never adds two.
- **Desktop clears were invisible and a pull request's cost never left the machine.** One install with 101 merged
  pull requests sent no proxy block at all. The per-session block reads `clearingFor`, which takes the proxy's log
  first and the clearing mod's own record where the log has no rows, so a desktop session counts; `prs.spendUsd`
  and `prs.spendPrs` carry what those pull requests cost.

**Every saving names the cut policy that made it; no date in the code** (`cutting.js:policyId`, `POLICY_REV`).
`r1-t140k-f60k-p25-deep`: the revision of what no setting can change (the cold-boundary rule, the payback pricing,
the ratchet), then the settings that were in force -- trigger, size floor, payback, one cut a session or many.
`proxy.js` puts it on the row it logs, on a clear and on a refusal alike (a refusal's policy says which floor
refused); `compression.js:noteCompression` keeps it on the session's record, and marks `policyChanged` where a
session spans an update; the desktop mod writes the same string from its own mirrored constants, held to the
proxy's by `test/claude-clear.test.js`, because one policy may not have two names. A saving made before this
shipped reads `unstamped` and is never folded into today's.
- **Why not a date.** `factory.js:CLEARING_SINCE` dates the current policy from the merge of #693, which is true
  for this machine and wrong for everybody else: a person still on an older copy is running the older policy
  today, so a date would count their old sessions as current, and a person who updated a week late would have good
  sessions thrown away. Nothing on one machine can know when another updated, and with the stamp it does not have
  to. The Factory's own date stays as it is -- it reads this machine's transcripts, where the update time is known.

**`sessions` in the payload** (`delivery-telemetry.js:deliveryMetrics` returns `{ prs, sessions }` from one walk of
the repositories): groups of **sums**, never per-session averages, so every rate a dashboard shows is a ratio of
sums -- the mean of per-session ratios read $13.93 against the true $5.97 on this machine's own ledger. `all`,
`cleared` and `uncleared` (a session grouped by **what happened to it**, not the arm it was assigned to: 230 of
249 sessions on one machine's clearing arm had never had a clear), `byPolicy`, `byClient`, and `netBuckets` for the
spread, since five pull requests were most of a fortnight's saving here. `prompts` -- the session's own model calls
-- rides beside the dollars, because a cleared session is a long session and cost per session cannot tell the two
apart; cost per prompt can.

**`prs` is schema 3**: `spendUsd` and `spendPrs` (what they cost, over the pull requests whose **every** session
could be priced -- one unpriced session leaves a pull request out of both figures rather than counting it at zero),
`clearedPrs` (how many got a clear), `byPolicy`, and `rows`, the newest 50 merged pull requests as numbers alone.
Nothing names a pull request, a repository or a session, as before.

**A payload that does not fit loses its lists, not its figures** (`telemetry.js:fitPayload`, `PAYLOAD_BUDGET` 56 KB
against the API's 64 KB). The rows are what can grow without bound, and a 413 loses the **whole** report with
nothing on the machine saying why: the longest list goes first, only as far as the budget needs, the block says
`rowsDropped` and the payload says what it dropped. This machine's payload is 37 KB with every list in it.

**Where to read it**: the **Savings per session** dashboard (`scripts/savings-dashboard.mjs`, ten cards) and four
new cards on **Pull requests delivered** (`scripts/delivery-dashboard.mjs`, whose `valid` now accepts schema 2 or
3 so the old cards keep reading older snapshots). No database change and no Lambda deploy: both blocks are read out
of `reports.raw_json`, which the ingest already stores whole.

**What it still cannot say.** A cleared session is not a comparable session, and nothing here is a controlled
comparison -- the holdout is, and it is per machine (`thinker profile holdout`, `thinker factory --diff
compression`). The policy stamp starts empty: every clear on this machine today reads `unstamped`, and the current
policy's per-session figure only begins once installs carry this build. A session whose agent reports no usage
(Cursor) counts as a session and in no dollar figure.

## Usage history

- Runs append to `~/.thinker/log.jsonl` (under `THINKER_HOME`). Repo key: origin in `.git/config`; no origin: path.
- `THINKER_LOG`: path, `local` (`.thinker/log.jsonl`), or `off`. Harnesses installing real hooks MUST set `THINKER_LOG=local`.
- Log keeps first 200 chars of each request (`op: request`; `orient` rows from before 2026-11-08 count as requests too).
- `thinker usage [--here] [--days n] [--json]`: requests, sessions, agents, what learning spent. The savings are the clearing's (`thinker savings`, the Report).
- MUST NOT show dollar costs or estimate cost from tokens outside `prices.js`'s doors. Provider-reported cost is data only.

## The session profile (2026-11-07, `src/profile.js`; on by default since 2026-11-08)

- **Two stages, one ledger.** Sessions end by pairing each prompt with answers until the next prompt, asking the model for observations: request, approach, outcome (`accepted`, `corrected`, `redirected`, `unknown`), quoted reaction, lesson where supported. Written to `.thinker/local/profile/ledger.jsonl`, 60-day window. Rows carry `at` (session clock) and `seen` (ledger read time).
- **Compile is a daily patch** (`compileHours` 24, `compileBatch` 200). Due when a session enters the ledger and last compile is 24h old. Model shown profile with id on each entry, new observations, and related rows (max 40, `relatedCited`). Returns keep / update / drop / add. Entry with no citations leaves by code. Updates apply floors and window; full compile via `thinker profile compile --full` or changed prompt; backlog longer than 200 patches in steps, oldest first.
- **Citations hold entries to observation window** (`settle`): dropped if window does not hold; entry with none leaves. Counts and dates from cited observations. `howWeWork` line needs two sessions or one stating/correcting preference or interrupted. Workstream leaves if not seen in 21 days. Stated preferences and corrections worth most; repeated rules get marked "in AGENTS.md; still missed".
- **Model: Opus only** (`PROFILE_MODELS`, `completeProfile`). Calls get 10 minutes. Another model set via `learn.profileModel`.
- **Skills** (`exchanges` carries `skills`, `observationSkills`; `/skill` or agent `Skill` call). Extractor sees `SKILLS:` line per exchange. Compile shown tally per skill (sessions, observations, person/agent typed, outcomes) and related observations (max 40, newest). Line per skill: use and person's reaction. Kept only when cited observation ran or named skill; two sessions or person naming it. Rendered `/name: text`. Backfill via `thinker profile backfill [--dry]`.
- **Rendered block** (~1500 tokens, `renderChars`; `renderProfile`, `profileBlock`). Headed with one sentence and session count. **Served text only** (no counts, dates, outcome tallies; use `show --why`). Oldest workstreams first (to 3), least-used skills (to 3), weakest ways of working (to 4), longest last (`TRIM`).
- **Served by prompt hook, held out by session** (deterministic share via `profileHoldoutRate` 0.5, `learn: { profileHoldout }`, env `THINKER_PROFILE_HOLDOUT|THINKER_HOLDOUT`). Block goes first in session; state file holds arm, count, compactions seen (`st.profile`). `profile-served` row logged per injection and once per held-out session.
- **Measure: cost per exchange and recurrence.** Cost is ratio of sums (tokens over exchanges), stratified by model, bootstrapped interval. Recurrence: how often person restates prior preference (`repeats` on observation; extractor shown profile lines and 200 prior distinct prefs/lessons, newest first). Judged `profile` (line held it) or `ledger` (compile failed). `servedRate` is holdout's question; `unlearnedRate` checks extractor. Rows before `repeats` extraction not measured (`measured` field).
- **Line verdicts** (`LINE_VERDICTS`, `shownLines`, `profileTurn` keeps ids in `st.profile.shown`; `thinker profile lines [--why]`). Per-line per-session: `applied`, `ignored` (evidence of violation or silence where line covered work; person restating in prompt is `ignored`), `na` (no bearing). `followRate` over sessions line applied to; `null` where none. Default `na`. Verdict on unseen id or second verdict on same line dropped.
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
