# thinker — a knowledge cache for coding & review agents

![Pixel-art blue sky with white clouds](docs/images/sky.png)

Every merged fix leaves knowledge behind that the next change can quietly undo.
`thinker` learns from your repository's merged pull requests and your agent
sessions, and keeps what it learns as short notes tied to the code they describe.
Coding agents get the notes that fit their task while they work. A review flags
a change that brings back a fixed bug or breaks a rule your team wrote down,
before it merges.

Website, docs and benchmarks: [zerotime.dev](https://zerotime.dev). Research prototype.

## How it works

1. **It learns from your history.** Thinker reads your merged pull requests, fixes first, and your agent sessions. It writes short notes: what broke and why, what a later change must not undo, how the parts connect. Each note points at the exact code it describes.
2. **It hands your agent what fits.** When you give your agent a task, Thinker passes it the note that fits, if one does, and tools that jump straight to the code.
3. **It checks changes against your rules.** The behaviors your system must keep come from the design documents checked into the repository (READMEs beside the code), and you and your agent write down the rest. `thinker review` flags a change that brings back a fixed bug or breaks one of them.
4. **It keeps itself current.** When the code under a note changes, the note is checked again in the background; until it passes, it is never handed over as fact.

Everything stays in your repository's `.thinker/` folder. Model calls go through
the coding agent you already use, on its own login.

## Install

Paste this into your coding agent, opened in your repository:

```text
Set up Thinker in this repository (if this folder is not a git repository, ask me which one to set up and work there). Thinker is a knowledge cache for coding agents (https://zerotime.dev); its notes and behaviors stay in this repository's .thinker/ folder and are never uploaded.
1. Install it and connect this repository, without building the cache yet: `curl -fsSL https://zerotime.dev/dist/install.sh | bash -s -- --yes --no-build --no-behaviors`. It needs git, curl, tar and Node 20+.
2. Run `~/.thinker/bin/thinker system define --no-copy` and follow the prompt it prints between the two lines as my request: it writes down the system behaviors this repository's design documents (READMEs) state, goes through them with me, and interviews me about the rest while the cache builds in the background. Ask me one question at a time and wait for my answers. Where it says `thinker`, use `~/.thinker/bin/thinker` if `thinker` is not on PATH yet.
```

The agent installs Thinker, reads the behaviors your design documents (READMEs beside
the code) already state, goes through them with you, builds the cache in the background
and interviews you about the rest. Start a new agent session afterwards: hooks
and tools load when a session starts. Or install from a terminal, inside a repository:

```bash
curl -fsSL https://zerotime.dev/dist/install.sh | bash
```

Requires git, curl, tar, Node 20+ and a logged-in coding agent. Works with Claude
Code, Codex CLI, Gemini CLI, Cursor, Pi, Windsurf Cascade, GitHub Copilot CLI and
OpenCode ([hook coverage and limitations](docs/agent-integrations.md)).

## Everyday commands

```bash
thinker review --base origin/main   # check this branch against the notes and behaviors
thinker system docs                 # behaviors from the READMEs and design documents checked in
thinker system define               # interview prompt for writing more system behaviors
thinker ui                          # local page: usage, the cache, behaviors to accept or edit
thinker benchmark                   # compare your agent with and without the cache
thinker usage --here                # what the cache cost and what it saved
```

Otherwise, work with your agent as usual: the notes arrive on their own.

## Results

**Code review: bugs missed.** 100 real bug fixes from seven open-source
repositories, each reversed so the change brings the bug back, then reviewed by
the same model with and without thinker.

```
Claude Opus 5.5    without thinker  ██████████████░░░░░░  7 missed of 25
                   with thinker     ████░░░░░░░░░░░░░░░░  2 missed of 25    71% fewer

GPT-6.1 Sol        without thinker  ██████████████████░░  18 missed of 50
                   with thinker     ██░░░░░░░░░░░░░░░░░░  2 missed of 50    89% fewer

Gemini 3.8 Flash   without thinker  ████████████████░░░░  8 missed of 25
                   with thinker     ██████████░░░░░░░░░░  5 missed of 25    38% fewer
```

**Coding agents: input tokens per task.** Real tasks from merged pull requests,
same model with and without thinker.

```
Claude Fable       without thinker  ████████████████████  1.25M
                   with thinker     ████████████████░░░░  1.02M   18% less tokens

Gemini 3.8 Flash   without thinker  ████████████████████  16.6M
                   with thinker     ████████████████░░░░  13.4M   19% less tokens

GPT-6 Astra        without thinker  ████████████████████  473k
                   with thinker     ████████████████░░░░  384k    19% less tokens
```

Each model saw different bugs and tasks, so the rows are not a model ranking; one
run per arm. Method, uncertainty and per-task results: [bench/RESULTS.md](bench/RESULTS.md).

## Learn more

- [Setup, updates and telemetry](docs/setup.md): install options, build depth and cost, large repositories, the local cache, updates, test mode, telemetry and opting out
- [Review and system behaviors](docs/review.md): writing behaviors, review modes and output, proof of correctness on a PR, review before committing
- [Usage, savings and learning](docs/usage.md): `thinker stats` and `usage`, the holdout comparison, how sessions are learned from
- [Delivery outcomes](docs/delivery-outcomes.md): `thinker impact`, tokens and fixes per merged PR
- [Task verification](docs/task-verification.md): verification contracts run in Docker
- [ONBOARDING.md](ONBOARDING.md): setting up your local cache
- [AGENTS.md](AGENTS.md): how thinker works inside, per-agent support, repository layout

## License

MIT. See [LICENSE](LICENSE).
