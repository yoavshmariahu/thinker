#!/usr/bin/env bash
set -euo pipefail

# Test fixtures and model responses never send telemetry or start background learning.
export THINKER_TEST=1 THINKER_TELEMETRY=off THINKER_HOOKS=on THINKER_CE=off
export THINKER_LOG=local
# This runner owns /workspace/trivial-repo and the container's agent settings.
[ -f /.dockerenv ] || { echo "Run this suite inside its Docker image." >&2; exit 1; }

BOLD='\033[1m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
NC='\033[0m'

pass() { echo -e "${GREEN}✔ PASS:${NC} $1"; }
info() { echo -e "${BLUE}ℹ INFO:${NC} $1"; }
warn() { echo -e "${YELLOW}⚠ WARN:${NC} $1"; }
fail() { echo -e "${RED}✖ FAIL:${NC} $1"; exit 1; }

echo -e "\n${BOLD}================================================================${NC}"
echo -e "${BOLD}     THINKER ONBOARDING & BASIC FEATURES E2E TEST SUITE      ${NC}"
echo -e "${BOLD}================================================================${NC}\n"

# -------------------------------------------------------------
# STEP 1: Verify installed CLIs
# -------------------------------------------------------------
info "Step 1: Checking installed agent CLIs..."

which claude >/dev/null && pass "Claude Code CLI installed: $(claude --version 2>&1 | head -n 1)" || fail "Claude CLI missing"
which codex >/dev/null && pass "OpenAI Codex CLI installed: $(codex --version 2>&1 | head -n 1)" || fail "Codex CLI missing"
which agent >/dev/null && pass "Cursor Agent CLI installed: $(agent --version 2>&1 | head -n 1)" || fail "Cursor Agent CLI missing"
which gemini >/dev/null && pass "Google Gemini CLI installed: $(gemini --version 2>&1 | head -n 1)" || fail "Gemini CLI missing"

# -------------------------------------------------------------
# STEP 2: Initialize a trivial repository
# -------------------------------------------------------------
info "Step 2: Initializing trivial repository..."
REPO_DIR="/workspace/trivial-repo"
rm -rf "$REPO_DIR"
mkdir -p "$REPO_DIR"
cd "$REPO_DIR"

git init -q
git config user.name "Test Agent"
git config user.email "agent@example.com"

cat << 'EOF' > math.js
export function add(a, b) {
  return a + b;
}

export function multiply(a, b) {
  return a * b;
}

export function factorial(n) {
  if (n <= 1) return 1;
  return n * factorial(n - 1);
}
EOF

cat << 'EOF' > server.js
import { add, multiply } from './math.js';

export function startServer(port = 8080) {
  console.log(`Server listening on port ${port}`);
  return { port, status: 'running' };
}
EOF

cat << 'EOF' > package.json
{
  "name": "trivial-repo",
  "version": "1.0.0",
  "type": "module"
}
EOF

git add .
git commit -qm "feat: initial commit with math and server modules"
pass "Trivial repo created with 2 code files and committed to git."

# -------------------------------------------------------------
# STEP 3: Onboard with Thinker (thinker setup)
# -------------------------------------------------------------
info "Step 3: Running thinker setup..."
CLI_JS="/thinker/src/cli.js"

INIT_OUT=$(node "$CLI_JS" setup --no-build --yes --clients claude,codex,cursor,gemini 2>&1)
echo "$INIT_OUT"

for file in "$HOME/.claude.json" "$HOME/.claude/settings.json" "$HOME/.codex/hooks.json" "$HOME/.codex/config.toml" "$HOME/.cursor/hooks.json" "$HOME/.cursor/mcp.json" "$HOME/.gemini/settings.json"; do
  [ -f "$file" ] && pass "Found $file" || fail "$file missing"
done

# -------------------------------------------------------------
# STEP 4: Seed a simple cache note & test cache hits
# -------------------------------------------------------------
info "Step 4: Seeding cache with a simple note about math.js..."
mkdir -p .thinker/local/notes

cat << 'EOF' > .thinker/local/notes/calc-multiply.json
{
  "id": "calc-multiply",
  "kind": "location",
  "title": "Multiplication and factorials in math.js",
  "answers": [
    "how do I multiply numbers",
    "where is multiplication implemented",
    "how to calculate factorials",
    "multiplication logic"
  ],
  "body": "math.js:multiply handles two-factor multiplication. math.js:factorial computes recursive factorials.",
  "deps": [
    { "path": "math.js", "symbol": "multiply" },
    { "path": "math.js", "symbol": "factorial" }
  ],
  "tags": ["math", "multiply", "factorial"],
  "confidence": 0.9,
  "status": "fresh",
  "source": "human"
}
EOF

# Refresh deps & content hashes
node "$CLI_JS" check
# The hook threshold normally waits for three notes. This fixture deliberately has one.
node --input-type=module <<'JS'
import fs from 'node:fs';
import { Store } from '/thinker/src/store.js';
import { createNote } from '/thinker/src/ops.js';
const store = new Store(process.cwd());
const file = '.thinker/local/notes/calc-multiply.json';
const input = JSON.parse(fs.readFileSync(file, 'utf8'));
createNote(store, input, { source: { type: 'human' }, reuseId: 'calc-multiply' });
fs.writeFileSync('.thinker/config.json', JSON.stringify({ ...store.config(), minNotes: 1, holdout: 0 }));
JS
pass "Cache fixture created with dependency hashes."

# Test orient CLI
info "Testing thinker orient CLI for query: 'where is multiplication implemented?'"
ORIENT_RES=$(node "$CLI_JS" orient "where is multiplication implemented?")
if echo "$ORIENT_RES" | grep -q "calc-multiply"; then
  pass "thinker orient got a cache HIT on calc-multiply"
else
  fail "thinker orient missed calc-multiply: $ORIENT_RES"
fi

# Test hook prompt for Claude
info "Testing Claude Code hook prompt..."
CLAUDE_HOOK_OUT=$(echo '{"prompt": "where is multiplication implemented?", "session_id": "claude-hit"}' | node "$CLI_JS" hook prompt --user --client claude)
if echo "$CLAUDE_HOOK_OUT" | grep -q "<thinker-cache>" && echo "$CLAUDE_HOOK_OUT" | grep -q "math.js:multiply"; then
  pass "Claude Code prompt hook returned <thinker-cache> bundle"
else
  fail "Claude hook prompt failed: $CLAUDE_HOOK_OUT"
fi

# Test hook prompt for Codex
info "Testing Codex hook prompt..."
CODEX_HOOK_OUT=$(echo '{"prompt": "where is multiplication implemented?", "session_id": "codex-hit"}' | node "$CLI_JS" hook prompt --user --client codex)
if echo "$CODEX_HOOK_OUT" | grep -q "<thinker-cache>" && echo "$CODEX_HOOK_OUT" | grep -q "math.js:multiply"; then
  pass "Codex prompt hook returned <thinker-cache> bundle"
else
  fail "Codex hook prompt failed: $CODEX_HOOK_OUT"
fi

# Test hook prompt for Gemini / Agy
info "Testing Gemini/Agy hook prompt..."
GEMINI_HOOK_OUT=$(echo '{"prompt": "where is multiplication implemented?", "session_id": "gemini-hit"}' | node "$CLI_JS" hook prompt --user --client gemini)
if echo "$GEMINI_HOOK_OUT" | grep -q "BeforeAgent" && echo "$GEMINI_HOOK_OUT" | grep -q "math.js:multiply"; then
  pass "Gemini/Agy prompt hook returned JSON BeforeAgent hook output with cache bundle"
else
  fail "Gemini hook prompt failed: $GEMINI_HOOK_OUT"
fi

# Cursor receives the context directly on beforeSubmitPrompt.
info "Testing Cursor prompt hook..."
CURSOR_PROMPT_OUT=$(echo '{"prompt": "where is multiplication implemented?", "session_id": "curs-sess-1"}' | node "$CLI_JS" hook prompt --user --client cursor)
if echo "$CURSOR_PROMPT_OUT" | grep -q "additional_context" && echo "$CURSOR_PROMPT_OUT" | grep -q "math.js:multiply"; then
  pass "Cursor delivered cache bundle with the prompt"
else
  fail "Cursor prompt hook failed: $CURSOR_PROMPT_OUT"
fi

# -------------------------------------------------------------
# STEP 5: Add to cache via hooks & distillation (learning loop)
# -------------------------------------------------------------
info "Step 5: Simulating agent session and recording via hooks..."
SESS="sess-learn-001"

# 1. Prompt hook records user prompt
echo "{\"prompt\": \"How does the server start and on what port?\", \"session_id\": \"$SESS\"}" | \
  node "$CLI_JS" hook prompt --user --client gemini --record >/dev/null

# 2. Tool hook records file read
echo "{\"tool_name\": \"read_file\", \"tool_input\": {\"file_path\": \"server.js\"}, \"tool_response\": \"export function startServer(port = 8080) { return { port, status: 'running' }; }\", \"session_id\": \"$SESS\"}" | \
  node "$CLI_JS" hook tool --user --client gemini --record >/dev/null

# 3. Stop hook records final answer
echo "{\"session_id\": \"$SESS\", \"last_assistant_message\": \"The server starts via startServer in server.js listening on port 8080.\"}" | \
  node "$CLI_JS" hook stop --user --client gemini --record --no-distill >/dev/null

TRACE_FILE=".thinker/state/trace-$SESS.jsonl"
if [ -f "$TRACE_FILE" ]; then
  pass "Session trace captured in $TRACE_FILE (events: $(wc -l < "$TRACE_FILE"))"
else
  fail "Trace file $TRACE_FILE was not created"
fi

info "Distilling captured trace into new cache notes..."
export THINKER_LLM=command
export THINKER_LLM_CMD="node /thinker/.agents/skills/e2e-testing-onboarding/scripts/mock_distill_llm.js"

node "$CLI_JS" distill "$TRACE_FILE" --repo "$REPO_DIR" --session "$SESS"

NEW_NOTE_COUNT=$(ls -1 .thinker/local/notes/*.json | wc -l)
info "Total notes in cache now: $NEW_NOTE_COUNT"
if [ "$NEW_NOTE_COUNT" -ge 2 ]; then
  pass "Successfully distilled new note from session trace into cache!"
else
  fail "Distillation did not create a new note."
fi

# -------------------------------------------------------------
# STEP 6: Cache re-use and invalidation
# -------------------------------------------------------------
info "Step 6: Testing retrieval of newly learned note..."
SERVER_QUERY="how does the server start and what port does it use?"
SERVER_ORIENT=$(node "$CLI_JS" orient "$SERVER_QUERY")
echo "$SERVER_ORIENT"

if echo "$SERVER_ORIENT" | grep -q "server.js:startServer"; then
  pass "Cache HIT on newly learned note for '$SERVER_QUERY'"
else
  fail "Newly learned note was not served by orient: $SERVER_ORIENT"
fi

info "Testing dependency-keyed cache invalidation..."
# Edit server.js startServer symbol
sed -i 's/8080/9090/g' server.js

STALE_ORIENT=$(node "$CLI_JS" orient "$SERVER_QUERY")
echo "$STALE_ORIENT"

if echo "$STALE_ORIENT" | grep -q "Pending verification"; then
  pass "Dependency edit leaves the note usable and labelled pending verification"
else
  fail "Edited note was not labelled pending verification: $STALE_ORIENT"
fi

info "Testing that a missing dependency is withheld..."
rm server.js
MISSING_ORIENT=$(node "$CLI_JS" orient "$SERVER_QUERY")
if echo "$MISSING_ORIENT" | grep -q "server.js:startServer"; then
  fail "Note with a missing dependency was served: $MISSING_ORIENT"
fi
pass "Note with a missing dependency is withheld"

info "Testing desktop queue, proxy transport, and removed test hooks..."
cd /thinker
unset THINKER_LLM THINKER_LLM_CMD
THINKER_CODEX_PROXY_SMOKE=1 THINKER_CLAUDE_GATEWAY_SMOKE=1 npm test -- test/install.test.js test/machine-tool-actions.test.js test/settings-preservation.test.js test/claude-gateway.test.js test/pending-verification.test.js test/session-work.test.js test/proxy-network.test.js test/proxy-service.test.js test/proxy-codex.test.js test/test-command-removed.test.js

echo -e "\n${BOLD}================================================================${NC}"
echo -e "${GREEN}${BOLD}       ALL TESTS COMPLETED SUCCESSFULLY IN DOCKER!        ${NC}"
echo -e "${BOLD}================================================================${NC}\n"
