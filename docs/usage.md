# Usage, savings and learning

What the cache costs, what it saves, and how it learns from your sessions. Where the agents'
context goes, and what to cut, is the [Find Savings page](context.md). Back to the [README](../README.md).

## Cache usage and savings

The Report's estimated input savings now include observed re-reads and subtract
carried note context. Coverage is shown beside the total; sessions without lifetime
evidence use a one-read fallback. See [how cache savings are calculated](cache-savings.md)
for the assumptions, clearing behavior, and compatibility of older JSON fields.

View Report on the page (`thinker ui`) shows the cache's numbers under the tables: its saving at list price,
tokens saved, cache hits and the share of servings the sessions acted on. Behind them: notes served and how, what the
sessions did with them, what learning and maintenance cost in reported model tokens, and an estimate of the
reading avoided, for one repository or every repository on the machine (clones and worktrees sharing an origin
count as one).

One number in it is measured rather than estimated. The hooks serve nothing in
15% of prompts (chosen by a hash of the session id and the turn's number, so
every hook of a turn agrees; `holdout` in `.thinker/config.json` or
`THINKER_HOLDOUT` changes the share or turns it off), and the stop hook records
after every turn what the session has cost so far by its own transcript: tool
calls, model turns, input tokens. A turn's cost is what that grew by. The holdout
comparison compares the prompts that got notes with
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
have no such channel, so there it lives on the page.
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

Session learning is the background distillation of each session. The distillation selects at most 12,000 characters of source evidence from the transcript:
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

Compact discovery requests at most 3,000 output tokens, assessment alone 1,500, and full distillation
6,000. These bounds reduce input and output, not guarantee a measured saving or identical note quality.
`distillModel` in `.thinker/config.json` chooses the model for session learning; `THINKER_LLM_MODEL`
takes precedence.

## Pull requests, and what was saved on each

`thinker prs` answers one question: of the work you actually shipped, how much of it did thinker
pay for.

```
$ thinker prs --days 7
Pull requests · github.com/you/repo · last 7 days

Merged with work recorded here: 22 of 90 merged in the repository
Still open: 3

Saved on those 22 merged pull requests
  cleared         197M tokens the API left out of their prompts (measured)
  reading avoided 177k tokens of files the notes meant nobody read (estimate)
  together        197.2M tokens · 25k on the median one

What they cost
  agent tokens    865.4M over 29 linked sessions: every prompt and every answer added up,
                  the same way the saving is
  median merged   23.5M tokens · 0.7h from opened to merged · 22/22 with complete counters
```

`--detail` adds a block per pull request, with its sessions; `--pr <n>` takes one; `--json` is the
data behind both.

**Two savings, never blended silently.** *Cleared* is measured: the context proxy asks the API to drop
the older tool results of a conversation, the API answers with the tokens it left out of that prompt,
and those are added up over the pull request's sessions. *Reading avoided* is an estimate: one read per
file behind each note a session was seen to act on. Both lines are always labelled.

**Matching a session to a pull request** needs nothing from you. A session is matched by a commit it
was sitting on, or failing that by its branch. Where that is wrong or a session split across two pull
requests, say so:

```
thinker prs link --session <id> --pr 42
thinker prs link --session <id> --split 42:0.4,43:0.6
```

**Reading the pull requests** uses your own `gh` login, read-only; nothing is ever posted. Maintenance
does it once a day in the background, so the report is current without you running anything; `maintain:
{ prSync: false }` in `.thinker/config.json` turns that off and leaves `thinker prs sync` to you.

Everything is local. The counts and token totals reach the telemetry if telemetry is on
(`telemetry: false` in `.thinker/config.json`, or `THINKER_TELEMETRY=off`); a pull request's number,
title, URL, branch and author, the repository, and the session ids never do.

## What the hooks serve, and the symbol table behind it

Besides the notes, the post-tool hook can hand the agent two things about the
code it is looking at. Both are new serving strategies, so both are **off until
an experiment shows they help**, and both are turned on per repository in
`.thinker/config.json`.

```json
{
  "symbolTable":    { "enabled": true },
  "onSight":        { "enabled": true, "perFile": 2, "perSession": 8 },
  "onSightOutline": { "enabled": true, "perSession": 8, "maxLines": 40 }
}
```

`onSight` serves understanding notes the first time a file comes into the
agent's view. `onSightOutline` serves that file's own outline instead: what is
defined in it and on which lines, functions and classes only, never imports or
plain constants, at most `maxLines` lines and `perSession` files in a session,
each file once. A file named in a search result with the line the search hit is
outlined around that line — the enclosing definition is always included — rather
than from the top, so a 600-definition file still answers the question that was
asked. A bare listing (`rg --files`, `ls -R`) names dozens of files at once, so
hits with lines take the session's budget first. When the tool searched for a
single identifier and the checkout defines it in exactly one place, the block
ends with where that is. Servings are written to the usage log as `late`
servings with `"on": "outline"`, so a replay can count them apart from the notes.

`symbolTable` is what makes that cheap. With it on, the checkout keeps a
definition index under `.thinker/state/symbols/` (already outside git, like the
rest of `state/`), and thinker's definition lookups — the anchoring guard, the
on-sight outline — read it instead of running `git grep`
over the tree and re-parsing what they hit. On PostHog (53,503 tracked files,
43,427 of them code, 641,442 definitions) a definition lookup goes from about
2.9 s for the first and 0.6–0.9 s for each one after, to 108 ms for the first in
a process and 1–2 ms after; one file's outline costs 2 ms. The index is 62 MB
there, and the whole-repository build that produces it takes about 95 s (11 s
when the parser's own disk cache is already warm).

The table is kept current without ever blocking a hook. One `git ls-files -s`
(26 ms on PostHog) catches everything that moved in git's index; the files that
changed are outlined again on the spot, up to `refreshFiles` (200) of them and
`refreshMs` (2 s), and any file the caller names is hashed and outlined there
and then, so a per-file answer is always exact. Unstaged edits elsewhere in the
tree need a sweep that stats every file, which costs over a second on a
checkout that size: it runs inline only once a measurement puts it under
`sweepMs` (120 ms), and otherwise moves into the background. When more has
changed than the table's delta holds (`maxDelta`, 400 files), or there is no
table yet, a background build is started and the caller falls
back to `git grep` meanwhile. A missing or half-built table is never an error.

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

## Test runs an agent can afford to read

A failing test run is often the most expensive thing in a session: whole suites of output read
back into the context on every iteration, a third of it colour escapes, and seventy failures that
are really a handful of causes. Off until an experiment shows it helps. With

```json
{ "tests": { "nudge": true } }
```

in `.thinker/config.json`, a shell command that is a test run is answered before it runs: Claude
Code and Codex have the command rewritten to go through thinker's test wrapper, and Cursor is told what
to run instead. Each command is answered once per session. The wrapper runs the command as given, with
colour off, keeps the whole log in `.thinker/state/tests/<timestamp>-<runner>.log` (ignored by git; the
last twenty are kept) and gives the agent only what a reader needs:

```
pytest: 9 failed, 0 passed — exit 1
2 distinct causes in 9 failing tests:
8× ConnectionError: could not reach the rows database at 127.0.0.1:5432
    tests/test_rows.py::test_fetch_rows[1], tests/test_rows.py::test_fetch_rows[2], … +6 more
    tests/test_rows.py:8 in test_fetch_rows
    app/rows.py:6 in fetch
    app/rows.py:2 in connect
1× ModuleNotFoundError: No module named 'app.gone'
    tests/test_rows.py::test_import_missing
    tests/test_rows.py:17 in test_import_missing
full log (81 lines): .thinker/state/tests/2026-10-18T05-37-29-595-pytest.log
```

The exit code is the test command's. pytest, jest, vitest, `go test`, `cargo test` and `node --test`
are parsed; any other runner is reported by the last lines of its log. The same `tests` object sets
`color`, `causes`, `examples`, `traceback`, `tail` and `keepLogs`.

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

