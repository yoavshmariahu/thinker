# Where a session's input tokens go (2026-10-22)

Measured on this repository's own Claude Code sessions, for the Report page (`src/report.js`). The
Report's tables show the four parts the Save page measures and controls; everything else a session
reads is computed too (`thinker report --json`, `breakdown`) and written up here, for the work on
cutting it. The owner's decision of 2026-10-22.

## Method

Two readings, both from the transcripts under `~/.claude/projects/<repo>/`.

1. **The requests as sent.** Claude Code 2.1.308 writes every API request into the transcript:
   `api-request-shape` (the system prompt and the tool definitions, by hash), `api-request-blob`
   (each message, by hash) and `api-request` (the request as `base` + `keep` + `tail` of hashes).
   Rebuilding them gives the exact composition of each call's context, at four characters a token.
   Script: the session's scratchpad `requests.mjs`; the per-kind shares below are from the 30
   longest sessions of the 35 days before 2026-10-22 (3,669 calls, 895M input tokens reported).
2. **The product's readers**, joined by session id (`report.js:reportView`): the Save page's four
   estimates (instruction-value.js, harness.js, tool-outputs.js) and, since this day, what the
   conversation itself costs (`transcripts.js:parseClaude`, `carried`): each kind's running size
   since the last compaction, added once per model call that reports usage.

## The breakdown

Share of the input tokens the model reported, by what the context held, on the 30 longest sessions:

| kind | share | what it is |
|---|---|---|
| tool results | 27% | every result stays in the conversation and every later call reads it again |
| instruction files | 14% | AGENTS.md (33k tokens here) with the person's global CLAUDE.md and memory file: about 40k a call |
| the agent's tool calls | 12% | the input of every `tool_use`: the edits (`old_string`, `new_string`) and commands it wrote, read again by every call after |
| user text | 11% | prompts, the reminders and hook context in user messages, skill files loaded as meta messages |
| thinking kept | 11% | Claude Code sends `clear_thinking keep: all`, so every turn's thinking stays in the context; by the end of a long session each call re-reads about 45k tokens of it (counted by `usage.output_tokens_details.thinking_tokens`; the signature is about 4.3 characters a token) |
| Claude Code's own messages | 5% | mid-conversation system messages: "Only you see that command's output", environment updates, the total-tokens reminders; about 19k by the end of a 114-call session |
| tool definitions | 4% | 8–27k a call: the built-in tools, more when a session loads deferred ones through ToolSearch |
| system prompt | 2% | 4.5k a call (the prompt snapshot) |
| system reminders, agent text | under 1% | |

The Report's six-week averages per session on 2026-10-22, in the Report's own units (chars/4): tool
outputs 5.6M, instruction files 3.1M, thinking kept 2.4M, the agent's tool calls 2.3M, built-in tools
2.2M, Claude Code's notes 1.6M, prompts and replies 0.9M, custom tools 0.7M, system prompt 0.35M,
output 72k; the whole session 28.2M.

## The residual, and the unit

At four characters a token the parts cover 74% of the input the long Claude Code sessions reported
(median session 79%; 185 sessions, 6.1B tokens, 98% of all input), and the residual is a counting
error, not a missing part: on the 79 sessions whose first request is fully recorded, with nothing in
it but the system prompt, the tools, the instruction payload and the first prompt, the model reports
**1.44 tokens for every four characters** (range 1.41–1.46; 2.78 characters a token). Applying that
factor takes the parts to 107–114% of the reported input. Codex sessions (1.6% of the input) have no
conversation parts from their transcript and are covered 40%.

So every row of the Report is undercounted by about the same factor; the shares and the trends hold.
Choices not made yet: count the Report's parts at the calibrated 2.78 characters a token (one constant,
the Report alone), calibrate the whole product (the Save page's estimators too), or leave the unit and
the note. A real tokenizer is not available locally; `count_tokens` would need an API key.

## What could be cut, beyond the four parts the Save page controls

- **Thinking kept (11%).** Claude Code keeps every turn's thinking; the API's `clear_thinking`
  edit with a smaller `keep` would drop old turns' thinking from the context. Whether the harness
  exposes that is Claude Code's setting, not thinker's; the proxy (`thinker proxy`) could rewrite the
  request's `context_management`, as it does for old tool results, off until an experiment.
- **The agent's tool calls (12%).** The text of every edit and command, read again after its use.
  The same shape as tool results: the proxy's `clear_tool_uses` edit has `clear_tool_inputs: true`,
  which clears the inputs with the results. Off until an experiment.
- **Claude Code's own messages (5%).** Reminders repeated on every turn (total tokens left, "only you
  see this output") accumulate; nothing in thinker touches them today.
- **Tool results (27%)** are the Save page's Tool outputs row: compression, and the proxy's clearing of
  results from earlier turns (research/output-lifetime-2026-10-22).
- **Instruction files (14%)** are the Save page's sections; the memory file and the global CLAUDE.md
  ride with them in the same payload and are not listed there.

## The choice, 2026-10-25

The Report counts the estimated parts at the calibrated rate, per provider (`report.js:CALIBRATION`: Anthropic 1.44, the
others one for one until measured, the config on top), and shows the conversation kinds as rows under the four parts; the
Save page keeps chars/4, its unit for choosing what to cut. The thresholds were scaled with the unit. What is left over is
"Unattributed input". The cache-write side of the bill, which this breakdown did not look at, is in
research/cost-levers-2026-10-25.md.
