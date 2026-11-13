# Usage, savings and learning

What thinker costs, what it saves, and how it learns from your sessions. Where the agents'
context goes, and what to cut, is the [Find Savings page](context.md). Back to the [README](../README.md).

## Usage and savings

`thinker usage` summarizes the machine's log: the requests the hooks saw, the sessions, which agents made them, and
what learning spent in reported model tokens, for one repository or every repository on the machine (clones and
worktrees sharing an origin count as one). What thinker saves is the context clearing's, and it is measured: the
Report page (`thinker ui`, `thinker report`) shows it week by week beside what a session costs, and `thinker savings`
says the figure the status line and the cards carry, today and over the whole log, at list prices.

The profile has a measurement of its own. 15% of sessions see no profile (chosen by a hash of the session id;
`holdout` in `.thinker/config.json` or `THINKER_HOLDOUT` changes the share or turns it off), and every observation
read from a session carries which side it was on, so `thinker profile holdout` compares the two: corrections and
redirects per session, observations per session, and from the log the prompts and tokens a session cost. Fewer than
twenty sessions a side is too few to read. The estimated reading the knowledge notes avoided, and the per-prompt
holdout that measured them, went with the notes on 2026-11-08.

## Pull requests, and what was saved on each

`thinker prs` answers one question: of the work you actually shipped, how much of it did thinker
pay for.

```
$ thinker prs --days 7
Pull requests · github.com/you/repo · last 7 days

Merged with work recorded here: 22 of 90 merged in the repository
Still open: 3

Saved on those 22 merged pull requests
  cleared         197M tokens the clearing left out of their prompts (measured) · 9.0M on the average one

What they cost
  agent tokens    865.4M over 29 linked sessions: every prompt and every answer added up,
                  the same way the saving is
  average merged  39.3M tokens · 0.7h from opened to merged · 22/22 with complete counters
```

`--detail` adds a block per pull request, with its sessions; `--pr <n>` takes one; `--json` is the
data behind both.

**The saving is measured.** The context proxy replaces the older tool results of a conversation in the requests it
forwards, counts what it left out of each prompt, and those are added up over the pull request's sessions.

**Matching a session to a pull request** needs nothing from you. A session is matched by a commit it
was sitting on, or failing that by its branch. Where that is wrong or a session split across two pull
requests, say so:

```
thinker prs link --session <id> --pr 42
thinker prs link --session <id> --split 42:0.4,43:0.6
```

**Reading the pull requests** uses your own `gh` login, read-only. Maintenance
does it once a day in the background, so the report is current without you running anything; `maintain:
{ prSync: false }` in `.thinker/config.json` turns that off and leaves `thinker prs sync` to you.

**Posting savings after merge** is an explicit local command, with no model calls:

```sh
thinker prs comment --pr 42 --dry
thinker prs comment --pr 42
```

It refreshes GitHub metadata, checks the PR is merged, and posts the same measured clearing and
estimated reading savings as the report. Rerunning updates this machine's existing comment under your
`gh` account; an identical comment makes no write. `--dry` refreshes local metadata and prints the comment
without writing to GitHub. `--json` returns the action, body and comment URL. The default window is
30 days, as for `thinker prs`; use `--days 90` for older work. Missing sessions or zero recorded savings
stop the post. Session totals are attributed to a PR, not divided into per-commit measurements.

The comment includes a **net dollar figure** in USD, using the last recorded model for each linked
session and Thinker's shared price table (including repository `prices` overrides). Cleared tokens use
the cache-read price; avoided reading uses the input price; and from that total Thinker **deducts what
the calls after a clear paid to write the prompt prefix into the cache again**, at the one-hour write
rate. Those three rates differ twentyfold, which is why the figure was misleading while it was gross.
Manual PR allocation shares apply throughout. Unknown models are explicitly unpriced, with partial
totals labelled. Learning spend is not deducted, and these are list prices, not a measured change to a
subscription bill.

The deduction counts only the prefix rewrites of calls from a session's **first clear onward**: a
rewrite before any clear cannot be the clearing's doing. It is deliberately conservative, since a
held-out session rewrites on a few percent of its long calls anyway and those are charged here too. If
the net comes out negative, Thinker says so rather than reporting a zero, and the automatic pass holds
that PR back — a clear that costs more than it saves is a bug to chase, not news for someone's PR.

**Automatic comments** run as part of the existing four-hour update job, including when no update is
available or the update check fails. Both the OS schedule (`thinker update --quiet`) and the detached
check started by normal Thinker use run the same pass. No extra daemon or model calls are needed.
The first pass records a start date without backfilling old PRs. Subsequent passes post once per PR
merged after that date, with positive recorded savings, after the merge and linked sessions have been
quiet for 20 minutes. Receipts prevent repeat comments; manual `prs comment` still updates a comment.
At most ten comments are attempted per pass, with failures retried on a later pass.

It needs the local usage and delivery records plus a `gh` login with permission to comment. Run
`thinker prs auto --dry --json` to inspect eligible locally recorded PRs without contacting GitHub,
or `thinker prs auto` to run the pass now (the four-hour per-repository throttle still applies).
Set `"prComments": false` in `~/.thinker/config.json` to disable automatic comments for the machine,
or in a repository's `.thinker/config.json` to disable them there. Disabled repositories are skipped.
Status/check/scheduling commands never post, and ordinary sync and maintenance remain read-only on
GitHub. A GitHub Actions runner alone has none of this machine's records.
Only the summary is published, with its window and machine scope; no session IDs, paths or profile text.
Each machine keeps its own comment, so figures from another machine are not overwritten. Avoid
summing comments from machines with copied or overlapping session records.

Other than an explicitly posted comment, the evidence stays local. The counts and token totals reach the telemetry if telemetry is on
(`telemetry: false` in `.thinker/config.json`, or `THINKER_TELEMETRY=off`); a pull request's number,
title, URL, branch and author, the repository, and the session ids never do.

## Labels: naming the machine a figure came from

Everything thinker reports is pseudonymous: an install id, a device id, counts and sums, never a path, a
repository, a prompt or a symbol. On one person's machine that is the whole story. A company running
thinker inside its own coding agent needs one thing more — which customer, harness build or job a session
belonged to — and nothing in a payload can say it, because the only identity there is the machine's own.

Labels are that, and they are set rather than inferred:

```json
{ "labels": { "tenant": "acme", "harness": "orbit-1" } }
```

in `~/.thinker/config.json` (bake it into an image), or

```
THINKER_LABELS='{"tenant":"acme","job":"17"}'     # or: THINKER_LABELS=tenant=acme,job=17
```

per container, merged over the config a key at a time. They appear in the telemetry payload as `labels`
and on each session's row in the usage log, so an export can group sessions by them. Eight labels at most,
keys of up to 40 characters from `[A-Za-z0-9_.-]`, values of up to 64; anything longer or structured is
dropped rather than cut short, and a malformed value is simply no label.

Nothing is read from the environment for you — not a hostname, a cloud instance id or a git remote. A
label exists because somebody wrote one, which makes it the one place in a payload where identifying data
can appear: whether a customer's name leaves a machine is yours to decide, not a default of ours. With
telemetry off (`THINKER_TELEMETRY=off`) nothing is sent at all and the labels stay on the session rows,
where `thinker telemetry --json` will show them to you before anything leaves.

## Exporting sessions

thinker can hand each session to a sink of your own as it ends: one JSON object per session,
newline-delimited, carrying what that session cost, what the clearing saved on it, the labels above, and
what thinker decided and why.

```
THINKER_EVENTS=off                                  # the default: nothing leaves
THINKER_EVENTS=stdout                               # one line a session, for a container's logs
THINKER_EVENTS=/var/log/thinker/sessions.jsonl      # appended, for a log agent to tail
THINKER_EVENTS=http://collector.internal/v1/sessions
```

or `events` in `~/.thinker/config.json`. The figures are the ones `thinker prs` and the Report already
computed, so an exported dollar can never disagree with a printed one.

Two things a consumer must know. A session is shipped when it ends and **may be shipped again** -- the
clearing's figure settles a few turns after the cut -- so events are upserts keyed on the install and the
session id, newest wins, and adding two events for one session double-counts it. And a sink that is down
costs a session nothing: the line waits in `~/.thinker/state/events-spool.jsonl` and rides out with the
next session.

Each event carries `decisions`: how many cuts fired and under which policy, the reasons thinker cut nothing
(the cut policy's own branches, so "why was nothing cut here" has a recorded answer), and which tools'
results left the prompt. Counts, reasons and tool names -- never a tool's arguments or its output.

`demo/collector/` is a working sink and a page over it: one row a machine with its own figures, a roll-up by
label, and the decisions behind the saving.

## The context diet

Off until an experiment shows it helps. With

```json
{ "diet": { "enabled": true } }
```

in `.thinker/config.json` (or `THINKER_DIET=on`), thinker's post-tool hook in Claude Code replaces a
tool's result before the model reads it, so less enters the context and less is re-read on every
later turn:

- a whole file read with `cat`, `nl`, `sed -n '1,$p'` or the Read tool becomes the lines around what
  the session searched for and the identifiers of the request, with each omitted range naming the
  definitions it holds, and a last line saying how to read any range;
- a test run becomes the counts and each distinct failure cause once, the whole log kept under
  `.thinker/state/tests/`;
- a search with a large output becomes its hits grouped per file, a few per file.

A short file, a file with nothing to centre on, or one where the kept lines would be most of it
passes whole. `minLines` (120), `window` (40 lines each side of a hit), `cap` (0.6), `testChars`
(2000), `searchChars` (8000), `perFile` (3) and `maxFiles` (40) in the same object adjust it; `tests:
false` leaves test runs alone. Other agents get their results untouched.

## Models from other providers, and subagents on them

A subscription login (Claude, ChatGPT) is only valid at its own vendor, so the main conversation stays
there. What can run elsewhere is the side traffic: a subagent sent off with a bounded task. `thinker
models` is how a model outside the login is brought in, and the profile of how it did.

```sh
thinker models add openrouter https://openrouter.ai/api/v1 --key-env OPENROUTER_API_KEY
thinker models route explore openrouter/openai/gpt-6-sol      # thinker/explore now means that model
thinker models assign Scout thinker/explore                   # a read-only subagent on it
thinker models assign Explore thinker/explore                 # Claude Code's own Explore too (agents.explore)
thinker models profile                                        # how each model did, and what that recommends
```

- **A provider is what it was found to speak.** `add` and `probe` call `GET /v1/models`, then send one
  token as Anthropic Messages and as OpenAI Chat Completions, and record which answered in its own shape.
  A gateway that speaks Messages (LiteLLM's Anthropic route, OpenRouter, Vercel, Bifrost) gets the request as
  Claude Code sent it, model swapped; one that speaks Chat alone gets a translation (`src/wire-chat.js`):
  system prompt, turns, tools, calls and results, images and a JSON schema carry over; thinking, cache
  markers and Claude's server tools do not, and the log row names what was dropped. Prices the provider
  reports go to the Report and the profile through `prices.js`; `thinker models price` sets one it did not.
- **The key never sits in a settings file.** `--key-env` names a variable of the proxy's environment,
  `--key-file` a private file, `--key` writes one under `~/.thinker/keys`. The proxy reads it per
  request and adds it as it forwards; the agent's own login never goes to another host, and the
  registry (`~/.thinker/providers.json`) names where the key is, never the key.
- **A route is an alias**, `thinker/<alias>`, or a direct `thinker/<provider>/<model>`. A subagent file
  names the alias, so `thinker models route` moves every subagent on it with no file rewritten. Claude Code
  sends an id it does not recognise upstream unchanged; the proxy routes it, and a route nobody registered is
  refused with a 400 on the subagent's first call rather than forwarded to Anthropic.
- **A subagent is a file** under `~/.claude/agents`, written by `assign` with a marker so only thinker's
  own file is ever rewritten or removed; a `reader` cannot write, a `worker` can. The Agent tool's
  `subagent_type` names it. `connect` and `rewire` write what the registry names; `uninstall --user`
  removes them.
- **The profile** (`~/.thinker/state/model-profile.json`, `thinker models profile`) reads the subagent
  transcripts beside their parents: per model and subagent type, the runs, the cost a run, the calls and the
  time, failed calls, and what the parent did in the exchange after the subagent returned (the share of the
  subagent's files it read again, whether it edited, whether the person corrected the exchange), plus each
  route's calls, failures and median first byte from the proxy log. The recommendation is a rule over those
  figures, printed with them: past five runs, a model that costs less a run and is no worse by ten points on
  re-reads, corrections and failures is named; it is applied by hand with `thinker models route`, never by
  the profile itself.

## Your own model endpoint

Where model traffic must go through a gateway (a corporate proxy with its own base URL and
token, a local server), point thinker at any OpenAI-compatible `/chat/completions` endpoint
instead of an agent's login:

```sh
export THINKER_LLM_BASE_URL=https://gateway.example.com/v1
export THINKER_LLM_API_KEY_ENV=GATEWAY_TOKEN     # the variable that holds the token
export THINKER_LLM_MODEL=gpt-4.1-mini            # the gateway's name for the model
```

With the base URL set, this endpoint is used before any installed agent (`THINKER_LLM=openai`
pins it, and skips the fallback to the agents). The token is read from the variable named in
`THINKER_LLM_API_KEY_ENV`, else from `THINKER_LLM_API_KEY`, else `OPENAI_API_KEY`. The model
must be named: either `THINKER_LLM_MODEL` for every call, or `distillModel` and `verifyModel` in
`.thinker/config.json` to use a cheaper model for verification than for distillation. A schema
travels in the prompt, not in `response_format`, so gateways that only pass text through work too.
A failed call reports the status and the endpoint's answer (a 401 names the token variables).

The agents keep their own login in thinker's calls, with the agent's tools, hooks, extensions,
plugins and project files switched off:

- `claude -p` runs without hooks, permissions, plugins or skills and gets the
  connection settings back: from the `env` blocks of `~/.claude/settings.json` and the repository's
  `.claude/settings.json` and `.claude/settings.local.json` (local overrides shared, shared overrides user), the
  entries that say where the model is and how to authenticate (a gateway's `ANTHROPIC_BASE_URL`
  and `ANTHROPIC_AUTH_TOKEN`, the Bedrock, Vertex and Foundry switches and their cloud
  credentials, proxies and certificates), with `apiKeyHelper` and the AWS credential helpers.
  The `ANTHROPIC_DEFAULT_SONNET_MODEL`, `ANTHROPIC_DEFAULT_HAIKU_MODEL`,
  `ANTHROPIC_DEFAULT_OPUS_MODEL` and `ANTHROPIC_DEFAULT_FABLE_MODEL` mappings are preserved,
  including mappings exported in the shell. Explicit model IDs and `THINKER_LLM_MODEL` still win.
  Telemetry exporters and per-call output limits from those settings stay out.
- `codex exec` keeps `~/.codex/config.toml`, so a `model_providers` entry there (a gateway
  base URL and key variable) applies; MCP servers, plugins, hooks and project instructions are off.
- `gemini` keeps its settings and environment (`GEMINI_API_KEY`, a base URL); extensions and
  MCP servers are off. Cursor's `agent` runs in ask mode with its own login.

`thinker doctor` names the provider that answers thinker's calls and makes one short call to it, so a
gateway that answers 401 shows up there, with the endpoint's answer, before any session is distilled.

The context proxy honors `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY` and their lowercase
forms when connecting to model endpoints. Retries follow the same route. Its background service
retains these settings and certificate paths from the launch environment or Claude's user settings;
the service files are readable only by their owner because a transport proxy URL may contain credentials.
Model API credentials are not copied into the service configuration. To clear a retained transport
setting, export it as an empty string and run `thinker proxy on` again.

## Your own model command

For a backend no provider speaks (another API shape, a company SDK, a local model), `THINKER_LLM_CMD`
names any command and thinker runs it for each model call. The contract:

- **stdin**: the whole prompt (system text, the request, and when a JSON answer is expected, the
  schema with "Reply with one JSON object ... It must match this JSON Schema: ...").
- **stdout**: only the reply. A JSON answer may be fenced or surrounded by prose; thinker finds the object.
- **exit code**: non-zero on failure, with the reason on stderr; thinker then falls back to the next
  provider (`THINKER_LLM=command` pins the command, with no fallback).
- **environment**: `THINKER_TIER` (`haiku`, `sonnet` or `opus`: what the call is worth, a
  verification being cheap and a distillation costly; unset when a full model name was asked for),
  `THINKER_MODEL` (the name resolved for the call: the tier, a name from the repository's config, or
  `THINKER_LLM_MODEL`), and `THINKER_SCHEMA` (the JSON Schema on its own, when one is expected), so a
  shim can pick its backend's model per tier and use the backend's structured output.

A reference shim for a gateway with the `/chat/completions` shape (the `openai` provider above
does this without a shim):

```js
#!/usr/bin/env node
// THINKER_LLM_CMD="node ~/thinker-llm.mjs"
import fs from 'node:fs';
const MODELS = { haiku: 'small-model', sonnet: 'medium-model', opus: 'large-model' };
const prompt = fs.readFileSync(0, 'utf8');
const body = { model: MODELS[process.env.THINKER_TIER] || process.env.THINKER_MODEL, messages: [{ role: 'user', content: prompt }] };
if (process.env.THINKER_SCHEMA) body.response_format = { type: 'json_schema', json_schema: { name: 'reply', schema: JSON.parse(process.env.THINKER_SCHEMA) } };
const res = await fetch(`${process.env.GATEWAY_URL}/chat/completions`, {
  method: 'POST', body: JSON.stringify(body),
  headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.GATEWAY_TOKEN}` },
});
if (!res.ok) { console.error(`gateway answered ${res.status}: ${await res.text()}`); process.exit(1); }
const reply = await res.json();
process.stdout.write(reply.choices[0].message.content);
```

## Delegation: big reads and suite runs on a Sonnet subagent

In Claude Code and OpenCode 2, a read of about a thousand lines or more, or a whole test-suite run, is handed to a subagent on
Claude Sonnet 5.5 and the main model gets its report instead of the output. The report names what the request needs
as `path:line`; the main model still reads the lines it edits itself. It is off by default; when on, half the
sessions are held out so the saving can be measured, and the log's `delegate` rows carry each run's cost.

- On: `"delegate": { "enabled": true }` in `~/.thinker/config.json` (or `THINKER_DELEGATE=on`), then `thinker rewire`;
  OpenCode reads it when it starts. Off again: `"delegate": false` and `thinker rewire`.
- Another model: `THINKER_DELEGATE=claude-haiku-5-5`, or `"delegate": { "model": "..." }`.
- The threshold (tokens of reads in one turn before the rest is delegated, 35000): `"delegate": { "threshold": 20000 }`.
