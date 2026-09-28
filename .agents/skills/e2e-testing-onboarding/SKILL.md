---
name: e2e-testing-onboarding
description: >-
  Run end-to-end containerized onboarding and feature verification for thinker across coding agent CLIs
  (Claude, Codex, Cursor, Gemini/agy), validating cache hits, hook recording, trace distillation,
  and dependency-keyed invalidation.
---

# Thinker E2E Testing & Onboarding Skill

This skill provides the comprehensive guide, automated container harness, and execution scripts for validating **thinker** onboarding and lifecycle operations across all supported coding agent CLIs:
- **Claude Code** (`claude`)
- **OpenAI Codex** (`codex`)
- **Cursor Agent** (`agent` / `cursor-agent`)
- **Google Antigravity** (`agy` / `gemini`)

---

## 1. The 6-Stage E2E Verification Lifecycle

```
[Stage 1: Multi-CLI Provisioning] ──► [Stage 2: Repo Baseline] ──► [Stage 3: Thinker Init]
                                                                          │
[Stage 6: Re-Use & Invalidation]  ◄── [Stage 5: Learn & Distill] ◄── [Stage 4: Cache Hits]
```

### Stage 1: Environment & CLI Provisioning
Verify all target agent CLIs are present, executable, and on PATH.
- `claude --version`: Anthropic Claude Code CLI
- `codex --version`: OpenAI Codex CLI
- `agent --version` or `cursor-agent --version`: Cursor Agent CLI
- `agy --version`: Google Antigravity CLI

### Stage 2: Repository Setup
Initialize a clean git repository representing a realistic codebase:
- Create domain logic files (e.g. `math.js`) and orchestration files (e.g. `server.js`).
- Commit all code to git to establish initial content hashes.

### Stage 3: Thinker Onboarding (`thinker init`)
Run `thinker init --yes` in the repository root.
- **Client Auto-Detection**: Checks PATH for all installed agents (`claude`, `codex`, `cursor`, `gemini`/`agy`).
- **Configuration & Hooks**:
  - **Claude Code**: Registers MCP in `.mcp.json` and prompt hooks in `.claude/settings.json` (or `.claude/settings.local.json`).
  - **Codex CLI**: Registers MCP in `.codex/config.toml`, hooks in `.codex/hooks.json`, and records project trust in `~/.codex/config.toml`.
  - **Cursor Agent**: Registers MCP in `.cursor/mcp.json`, rules in `.cursor/rules/thinker.mdc`, hooks in `.cursor/hooks.json`, and approves MCP workspace access.
  - **Gemini / Antigravity (`agy`)**: Registers MCP and hooks in `.gemini/settings.json`.
- **Git Co-change Mining**: Mines historical commits to populate `.thinker/cochange.json`.

### Stage 4: Cache Seeding & Multi-Client Cache Hits
Seed a deterministic note into `.thinker/notes/<id>.json` resting on code symbols (`math.js:multiply`).
1. Re-hash content deps with `thinker check`.
2. Test CLI retrieval with `thinker orient "<query>"`.
3. Test prompt hook output across each client adapter:
   - **Claude**: Injects `<thinker-cache>` bundle to stdout.
   - **Codex**: Injects `<thinker-cache>` bundle to stdout.
   - **Gemini / Agy**: Returns JSON output:
     `{"hookSpecificOutput":{"hookEventName":"BeforeAgent","additionalContext":"<thinker-cache>..."}}`
   - **Cursor**: Parks prompt-time bundle and delivers via `additional_context` JSON on the agent's first tool call.

### Stage 5: Learning Loop (Hook Recording & Distillation)
Simulate an agent session with `--record`:
1. `hook prompt`: captures prompt into `.thinker/state/trace-<session>.jsonl`.
2. `hook tool`: captures tool inputs and file reads into the trace.
3. `hook stop`: records `{ t: 'say', text: last_assistant_message }`.
4. Run `thinker distill <trace_file> --repo <repo> --session <session>`.
5. Verify new note is minted into `.thinker/notes/` with symbol dependencies and content hashes.

### Stage 6: Cache Re-use & Invalidation
1. **Re-use**: Query `thinker orient` for the learned topic and confirm immediate cache hit.
2. **Invalidation**: Modify a dependency symbol in the working tree.
3. Query `thinker orient` again and verify thinker detects the content hash mismatch and flags the note:
   `> ⚠ STALE: <file>:<symbol> (symbol body changed)`

---

## 2. Running the Automated Container Suite

The scripts bundled with this skill automate all 6 stages inside an isolated Linux container:

```bash
# Build the test image
docker build -t thinker-test -f .agents/skills/e2e-testing-onboarding/scripts/Dockerfile .

# Run the full test suite
docker run --rm thinker-test
```

### Script Inventory
* [`scripts/Dockerfile`](file:///.agents/skills/e2e-testing-onboarding/scripts/Dockerfile): Multi-CLI Linux container definition (`node:20-bookworm`) installing git, python3, Claude, Codex, Cursor Agent, and Antigravity.
* [`scripts/run_suite.sh`](file:///.agents/skills/e2e-testing-onboarding/scripts/run_suite.sh): Executable test runner executing all assertions with colorized output.
* [`scripts/mock_distill_llm.js`](file:///.agents/skills/e2e-testing-onboarding/scripts/mock_distill_llm.js): Deterministic mock LLM command for distillation (`THINKER_LLM_CMD`).

---

## 3. Key Behavioral Invariants

1. **Auto Client Detection**:
   `detectClients()` in `src/clients.js` detects `gemini` if either `gemini` or `agy` is on PATH or `~/.gemini` exists; it detects `cursor` if `cursor`, `cursor-agent`, or `agent` is on PATH or `~/.cursor` exists.
2. **Offline & Headless Distillation**:
   Setting `THINKER_LLM=command` and pointing `THINKER_LLM_CMD="node /path/to/mock_llm.js"` enables complete offline testing of the learning loop without requiring external API credentials or paid tokens.
3. **Trace Completeness**:
   `hook stop` records the assistant's final response before evaluating `--no-distill`, ensuring traces are complete even when background distillation is deferred.
