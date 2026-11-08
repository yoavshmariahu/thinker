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

