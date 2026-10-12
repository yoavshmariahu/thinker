# Usage, savings and learning

What the cache costs, what it saves, and how it learns from your sessions. Back to the [README](../README.md).

## Cache usage and savings

Run `thinker stats` for a machine-wide dashboard of activity, agent usage,
learning, estimated reading avoided, and reported model tokens, with a breakdown
by repository and the current checkout's cache details. `--here` limits activity
to this repository, `--days 7` shows the last week, and `--json` includes the full
data (the original `repo`, `notes`, `status`, `kinds`, and `uses` fields still
describe the current checkout). Repositories are discovered from the configured
usage log; clones and worktrees sharing an origin are grouped together. Cache
counts are current, even when activity is filtered by date.

Run `thinker usage --here` to compare this repository's cache spending with its
estimated savings, or `thinker usage` for every repository on the machine.
`--days 7` limits the period; `--json` includes spending by operation, provider/model,
and repository.

One number in it is measured rather than estimated. The hooks serve nothing in
15% of prompts (chosen by a hash of the session id and the turn's number, so
every hook of a turn agrees; `holdout` in `.thinker/config.json` or
`THINKER_HOLDOUT` changes the share or turns it off), and the stop hook records
after every turn what the session has cost so far by its own transcript: tool
calls, model turns, input tokens. A turn's cost is what that grew by. The
"Holdout" section of `thinker usage` compares the prompts that got notes with
the ones that had notes withheld, as cost per prompt (the side's summed cost
over its measured prompts) overall and per model, once twenty prompts stand on
each side; and how often each side's prompt was followed by a correction. The
unit is the prompt rather than the session because a session is as long as you
keep it. Notes served on an earlier turn stay in the agent's context, so a
held-out turn after a served one is partly treated: the difference is
understated, never inflated. Prompts where nothing would have been served are
on neither side. Telemetry, unless you opted out, sends the totals behind this
comparison (prompt counts and summed tool calls, turns and tokens per side and
per model, over 30 days), nothing about the prompts themselves. This is what
the notes do for your own work, on your own repository, by your own agent, and
it is the number to hold the cache's spending against.

Once a week, at the first turn of the week, the agent shows you that number for
the last 30 days across every repository on the machine, as one line: about how
many fewer input tokens the prompts with notes cost than they would have at the
held-out cost per prompt, with the two costs and the counts behind it. Nothing is
shown until twenty prompts stand on each side. Claude Code, Codex and Gemini show
the line as a message to you, outside the model's context; Cursor and Copilot
have no such channel, so there it lives in `thinker usage` and the UI.
`THINKER_NOTICE=off` or `"notice": false` in the config turns it off with the
other end-of-turn notices.

The report separates cache initialization (PR mining and phrasings; exploration in logs
from before it was removed), ongoing session distillation, and maintenance. It records reported
input/output tokens, provider prompt-cache reads/writes, and missing usage. Model calls that produce no notes, dry-run distillations, and
failed attempts count too. Tokens reported before an invalid model answer are retained;
failures without counters remain unknown. Nothing is given in dollars: the agents run on
subscriptions as often as on metered keys, so a price from an API list would mislead.

The token balance subtracts both injected notes and reported build/maintenance tokens
from estimated file-reading tokens avoided. Savings still require a session assessment
that the note was used. This is a token comparison: tokens of different models and of
cached input are counted alike. Older logs omitted tokens and setup exploration,
so historical totals cannot establish full payback. A limited date range also excludes
setup spending outside that period.

Session learning uses the working agent's `remember` and `feedback` tools first:
save a reusable finding while its evidence is already in context. Background
learning selects at most 12,000 characters of source evidence from the transcript:
the first request, the last answer, failures and corrections with what followed
them, and the most recent tool calls. Routine exploration and cache hits alone do not
trigger discovery. Notes are assessed only when discussed explicitly or when a
failure/correction touches their dependencies; omitted evidence stays unknown,
not “unused.” Only returned assessments are checkpointed as assessed.

`learn.auditRate` in `.thinker/config.json` selects a stable sample of sessions
(default 0.05) for the fuller, 70,000-character trace path. Set it to 0 to disable
sampling, or 1 to audit every eligible session. Small, uneventful sessions still
skip learning; `learn.quietExplore: 0` retains an explicit opt-in to processing
every eligible session. The log records `learningMode` (`evidence`, `assessment`,
`audit`, or `full`) and trace size so quality and spending can be compared.

`thinker distill <transcript> --dry --evidence` previews the compact path;
without `--evidence` or `--incremental`, an explicit distill retains the fuller
trace as its fallback when semantic selection is disabled or unavailable. Both dry runs call a model but save no notes. Compact discovery
requests at most 3,000 output tokens, assessment alone 1,500, and full distillation
6,000. Claude CLI receives these per-request output limits, disables optional
thinking, and limits structured-output attempts; provider retries can still add
usage. These bounds reduce input and output, not guarantee a measured saving or
identical note quality.

To evaluate a cheaper distillation model, compare the same transcripts with
`thinker distill <transcript> --dry --model <model>`, then inspect usage and note quality.
`--dry` still calls a model and records its usage, but does not save notes. The existing
`distillModel` setting in `.thinker/config.json` chooses the default distiller for session
learning and PR mining; an explicit `--model` or `THINKER_LLM_MODEL` takes precedence.
The report's no-new-note/no-merge counts help identify low-yield runs, though those runs
may still assess existing notes. Keep quality and downstream task correctness in the
comparison, not just note count.

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

- `claude -p` runs without settings (no hooks, permissions, plugins or skills) and gets the
  login side of your user settings back: from the `env` block of `~/.claude/settings.json`, the
  entries that say where the model is and how to authenticate (a gateway's `ANTHROPIC_BASE_URL`
  and `ANTHROPIC_AUTH_TOKEN`, the Bedrock, Vertex and Foundry switches and their cloud
  credentials, proxies and certificates), with `apiKeyHelper` and the AWS credential helpers.
  Telemetry exporters and model aliases from the settings stay out; `THINKER_LLM_MODEL` names
  the model when the gateway does not know Anthropic's model IDs.
- `codex exec` keeps `~/.codex/config.toml`, so a `model_providers` entry there (a gateway
  base URL and key variable) applies; MCP servers, plugins, hooks and project instructions are off.
- `gemini` keeps its settings and environment (`GEMINI_API_KEY`, a base URL); extensions and
  MCP servers are off. Cursor's `agent` runs in ask mode with its own login.

`thinker doctor` names the provider that answers thinker's calls and makes one short call to it, so a
gateway that answers 401 shows up there, with the endpoint's answer, before any session is distilled.

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

