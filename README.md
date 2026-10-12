# thinker — a knowledge cache for coding agents

![Pixel-art blue sky with white clouds](docs/images/sky.png)

Every merged fix leaves knowledge behind that the next change can quietly undo.
`thinker` learns from your repository's merged pull requests and your agent
sessions, and keeps what it learns as short notes tied to the code they describe.
Coding agents get the notes that fit their task while they work, and the notes
that rest on the code a change touches when they review one.

<table align="center">
  <tr>
    <td align="center" width="280"><h2>18%</h2>fewer tokens per task</td>
    <td align="center" width="280"><h2>10%</h2>less wall time per task</td>
  </tr>
</table>
<p align="center">on real coding tasks from open-source repositories, same model with and without the cache</p>

Website, docs and benchmarks: [zerotime.dev](https://zerotime.dev).

## Install

Run this in a terminal, inside your repository:

```bash
curl -fsSL https://raw.githubusercontent.com/yoavshmariahu/thinker/main/install.sh | bash
```

Or, with npm, the same installer carried in a package instead of fetched at run time:

```bash
npx @zerotime/thinker
```

Requires git, curl, tar, Node 20+ and a logged-in coding agent. Works with Claude
Code, Codex CLI, Gemini CLI, Cursor, Pi, Windsurf Cascade, GitHub Copilot CLI and
OpenCode ([hook coverage and limitations](docs/agent-integrations.md)).

The installer fetches the [latest release](https://github.com/yoavshmariahu/thinker/releases)
(a tag `vX.Y.Z` with the archive, its `version.json` manifest and the installer attached)
and checks the archive against the manifest's SHA-256. `thinker update` does the same
daily in the background; `thinker update v0.1.34` pins a release.

## Uninstall

```bash
thinker uninstall --user --purge   # inside a repository: its hooks, MCP registration and notes, and the machine-wide wiring
rm -rf ~/.thinker                  # the app, the ranking model and the usage log
```

Then drop the `PATH` line the installer added to your shell startup file. To keep
thinker but switch it off for one repository with sensitive content, run `thinker disable` there.

## How it works

1. **It learns from your history.** Thinker reads your merged pull requests, fixes first, and your agent sessions. It writes short notes: what broke and why, what a later change must not undo, how the parts connect. Each note points at the exact code it describes.
2. **It hands your agent what fits.** When you give your agent a task, Thinker passes it the note that fits, if one does, and tools that jump straight to the code.
3. **It knows your rules.** The behaviors your system must keep come from the design documents checked into the repository (READMEs beside the code), and you can add, change or remove one by asking your agent. When a change touches the code a rule governs, the agent reviewing it is handed that rule.
4. **It keeps itself current.** When the code under a note changes, the note is checked again in the background; until it passes, it is never handed over as fact.
5. **It audits your skills.** Each skill file (`SKILL.md`) checked into the repository gets a card that is served like a note and checked against the code it talks about. A skill the code contradicts is listed with its issues and not handed over until it is fixed or reviewed; among skills that do the same thing, the one the sessions confirm is the one served.

Everything stays in your repository's `.thinker/` folder. Model calls go through
the coding agent you already use, on its own login.

## Everyday commands

```bash
thinker system docs                 # behaviors from the READMEs and design documents checked in
thinker skills                      # the skill files as the cache sees them: out of date, duplicates, evidence
thinker ui                          # local page: usage, the cache, behaviors to accept or edit
thinker benchmark                   # compare your agent with and without the cache
thinker usage --here                # what the cache cost and what it saved
```

Otherwise, work with your agent as usual: the notes arrive on their own.

## Results

**Coding agents: input tokens and wall time per task.** Real tasks from merged pull requests,
same model with and without thinker.

```
Claude Fable       without thinker  ████████████████████  1.25M
                   with thinker     ████████████████░░░░  1.02M   18% less tokens

Gemini 3.8 Flash   without thinker  ████████████████████  16.6M
                   with thinker     ████████████████░░░░  13.4M   19% less tokens

GPT-6 Astra        without thinker  ████████████████████  473k
                   with thinker     ████████████████░░░░  384k    19% less tokens
```

```
Claude Fable       without thinker  ████████████████████  2.7 min
                   with thinker     █████████████████░░░  2.3 min  14% less time

Gemini 3.8 Flash   without thinker  ████████████████████  13.1 min
                   with thinker     ██████████████████░░  11.9 min 8.5% less time

GPT-6 Astra        without thinker  ████████████████████  152 s
                   with thinker     ███████████████████░  141 s    7% less time
```

Each model saw different tasks, so the rows are not a model ranking; one run per
arm. Bug detection is not claimed: on held-out bugs the cache did not change what a
reviewer caught (research/regression-heldout on the `agent/heldout-regression` branch). Method, uncertainty and per-task results: [bench/RESULTS.md](bench/RESULTS.md).

## Learn more

- [Setup, updates and telemetry](docs/setup.md): install options, build depth and cost, large repositories, the local cache, updates, test mode, telemetry and opting out
- [Usage, savings and learning](docs/usage.md): `thinker stats` and `usage`, the holdout comparison, how sessions are learned from
- [Skills](docs/skills.md): skill cards, the audit, what sessions say about a skill, duplicates
- [Delivery outcomes](docs/delivery-outcomes.md): `thinker impact`, tokens and fixes per merged PR
- [Task verification](docs/task-verification.md): verification contracts run in Docker
- [ONBOARDING.md](ONBOARDING.md): setting up your local cache
- [AGENTS.md](AGENTS.md): how thinker works inside, per-agent support, repository layout

## License

MIT. See [LICENSE](LICENSE).
