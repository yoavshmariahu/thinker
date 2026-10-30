---
name: e2e-testing-onboarding
description: >-
  Run end-to-end containerized onboarding and feature verification for thinker across coding agent CLIs
  (Claude, Codex, Cursor, Gemini), validating cache hits, hook recording, trace distillation,
  dependency-keyed verification, and proxy transport.
---

# Thinker E2E Testing & Onboarding

Run this workflow in an isolated worktree. This is a deterministic integration suite,
not a benchmark or a claim about agent quality. No provider credentials are needed.
The model response for distillation is a fixture; the four clients' hook payloads are
simulated. The Codex proxy smoke test runs the installed Codex CLI against a loopback
model server, including a resumed session. Desktop learning is exercised through the
session queue tests, without opening GUI applications.

## Run

```bash
docker build -t thinker-test -f .agents/skills/e2e-testing-onboarding/scripts/Dockerfile .
docker run --rm --network none --security-opt seccomp=unconfined thinker-test
```

The image installs Claude Code, Codex, Cursor Agent, and Gemini CLI, then installs
thinker's locked dependencies with `npm ci`. Installed CLI versions are printed at
startup. The image sets `THINKER_TEST=1` and `THINKER_TELEMETRY=off` before installs;
the runner and all its children retain them. Runtime networking is loopback only.
The seccomp option allows Codex's own sandbox to create namespaces inside Docker;
without it the fixture shell command fails with a `bwrap` namespace error. Mount
no personal settings or credentials into this disposable container.
Setup may report that it cannot fetch the ranker; these lifecycle tests use lexical
ranking (`THINKER_CE=off`). Ranking itself has separate tests in the full suite.

The runner owns `/workspace/trivial-repo` and the container's home. Do not run it on
the host: setup writes agent settings, and the fixture repository is reset each run.

## Lifecycle and assertions

1. Verify all four installed CLIs can report their versions.
2. Create and commit a small repository with `math.js` and `server.js`.
3. Run `thinker setup --no-build --yes --clients claude,codex,cursor,gemini`.
   Assert machine-wide wiring in `~/.claude.json`, `~/.claude/settings.json`,
   `~/.codex/{hooks.json,config.toml}`, `~/.cursor/{hooks.json,mcp.json}`, and
   `~/.gemini/settings.json`. Setup no longer creates a Cursor repository rule.
4. Create a deterministic note fixture with dependency hashes. Set `minNotes: 1`
   and `holdout: 0` for this deterministic fixture (the shipped hook threshold is
   three, with a 15% holdout). Assert CLI
   retrieval and user-scope prompt hook delivery for every client. Cursor delivers
   `additional_context` on the prompt; Gemini wraps `BeforeAgent` context in JSON.
5. Record prompt, tool, and final-answer events through hooks. Distill that trace
   with `THINKER_LLM=command` and `mock_distill_llm.js`; assert a new note in
   `.thinker/local/notes/` and retrieve it through the CLI.
6. Edit a dependency: the note remains served with `Pending verification`. Remove
   the dependency: the note is withheld. Both are hard assertions, not warnings.
7. Run the installer, machine tool switch, pending-verification, desktop
   session-work, proxy network/service, real Codex transport, and
   removed-test-command integration tests.

Fixtures here are test data only. Never use them as benchmark caches. Evals and
benchmark caches use Artemis and the repository's experiment approval workflow.

## Files

- `scripts/Dockerfile`: isolated Linux image and CLI provisioning.
- `scripts/run_suite.sh`: lifecycle assertions and integration test selection.
- `scripts/mock_distill_llm.js`: deterministic distillation model response.
