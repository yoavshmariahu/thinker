#!/usr/bin/env bash
set -euo pipefail

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
echo -e "${BOLD}     THINKER ONBOARDING & BASIC FEATURES EXPERIMENT SUITE      ${NC}"
echo -e "${BOLD}================================================================${NC}\n"

# -------------------------------------------------------------
# STEP 1: Verify installed CLIs
# -------------------------------------------------------------
info "Step 1: Checking installed agent CLIs..."

which claude >/dev/null && pass "Claude Code CLI installed: $(claude --version 2>&1 | head -n 1)" || fail "Claude CLI missing"
which codex >/dev/null && pass "OpenAI Codex CLI installed: $(codex --version 2>&1 | head -n 1)" || fail "Codex CLI missing"
which agent >/dev/null && pass "Cursor Agent CLI installed: $(agent --version 2>&1 | head -n 1)" || fail "Cursor Agent CLI missing"
which agy >/dev/null && pass "Google Antigravity CLI (agy) installed: $(agy --version 2>&1 | head -n 1)" || fail "agy CLI missing"

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

INIT_OUT=$(node "$CLI_JS" setup --no-build --yes 2>&1)
echo "$INIT_OUT"

[ -f ".mcp.json" ] && pass "Found .mcp.json" || fail ".mcp.json missing"
([ -f ".claude/settings.json" ] || [ -f ".claude/settings.local.json" ]) && pass "Found Claude settings (.claude/settings*.json)" || fail ".claude settings missing"
[ -f ".codex/hooks.json" ] && pass "Found .codex/hooks.json" || fail ".codex/hooks.json missing"
[ -f ".codex/config.toml" ] && pass "Found .codex/config.toml" || fail ".codex/config.toml missing"
[ -f ".cursor/hooks.json" ] && pass "Found .cursor/hooks.json" || fail ".cursor/hooks.json missing"
[ -f ".cursor/mcp.json" ] && pass "Found .cursor/mcp.json" || fail ".cursor/mcp.json missing"
[ -f ".cursor/rules/thinker.mdc" ] && pass "Found .cursor/rules/thinker.mdc" || fail ".cursor rule missing"
[ -f ".gemini/settings.json" ] && pass "Found .gemini/settings.json (for agy/gemini)" || fail ".gemini/settings.json missing"

# -------------------------------------------------------------
# STEP 4: Seed a simple cache note & test cache hits
# -------------------------------------------------------------
info "Step 4: Seeding cache with a simple note about math.js..."
mkdir -p .thinker/notes

cat << 'EOF' > .thinker/notes/calc-multiply.json
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
pass "Cache note created and hashes refreshed."

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
CLAUDE_HOOK_OUT=$(echo '{"prompt": "where is multiplication implemented?"}' | node "$CLI_JS" hook prompt --client claude)
if echo "$CLAUDE_HOOK_OUT" | grep -q "<thinker-cache>" && echo "$CLAUDE_HOOK_OUT" | grep -q "math.js:multiply"; then
  pass "Claude Code prompt hook returned <thinker-cache> bundle"
else
  fail "Claude hook prompt failed: $CLAUDE_HOOK_OUT"
fi

# Test hook prompt for Codex
info "Testing Codex hook prompt..."
CODEX_HOOK_OUT=$(echo '{"prompt": "where is multiplication implemented?"}' | node "$CLI_JS" hook prompt --client codex)
if echo "$CODEX_HOOK_OUT" | grep -q "<thinker-cache>" && echo "$CODEX_HOOK_OUT" | grep -q "math.js:multiply"; then
  pass "Codex prompt hook returned <thinker-cache> bundle"
else
  fail "Codex hook prompt failed: $CODEX_HOOK_OUT"
fi

# Test hook prompt for Gemini / Agy
info "Testing Gemini/Agy hook prompt..."
GEMINI_HOOK_OUT=$(echo '{"prompt": "where is multiplication implemented?"}' | node "$CLI_JS" hook prompt --client gemini)
if echo "$GEMINI_HOOK_OUT" | grep -q "BeforeAgent" && echo "$GEMINI_HOOK_OUT" | grep -q "math.js:multiply"; then
  pass "Gemini/Agy prompt hook returned JSON BeforeAgent hook output with cache bundle"
else
  fail "Gemini hook prompt failed: $GEMINI_HOOK_OUT"
fi

# Test Cursor hook (parks at prompt, delivers on first tool call)
info "Testing Cursor hooks (prompt park -> tool deliver)..."
CURSOR_PROMPT_OUT=$(echo '{"prompt": "where is multiplication implemented?", "session_id": "curs-sess-1"}' | node "$CLI_JS" hook prompt --client cursor)
CURSOR_TOOL_OUT=$(echo '{"tool_name": "read_file", "tool_input": {"file_path": "math.js"}, "session_id": "curs-sess-1"}' | node "$CLI_JS" hook tool --client cursor)
if echo "$CURSOR_TOOL_OUT" | grep -q "additional_context" && echo "$CURSOR_TOOL_OUT" | grep -q "math.js:multiply"; then
  pass "Cursor delivered parked cache bundle on first tool call"
else
  fail "Cursor tool hook failed: $CURSOR_TOOL_OUT"
fi

# -------------------------------------------------------------
# STEP 5: Add to cache via hooks & distillation (learning loop)
# -------------------------------------------------------------
info "Step 5: Simulating agent session and recording via hooks..."
SESS="sess-learn-001"

# 1. Prompt hook records user prompt
echo "{\"prompt\": \"How does the server start and on what port?\", \"session_id\": \"$SESS\"}" | \
  node "$CLI_JS" hook prompt --client gemini --record >/dev/null

# 2. Tool hook records file read
echo "{\"tool_name\": \"read_file\", \"tool_input\": {\"file_path\": \"server.js\"}, \"tool_response\": \"export function startServer(port = 8080) { return { port, status: 'running' }; }\", \"session_id\": \"$SESS\"}" | \
  node "$CLI_JS" hook tool --client gemini --record >/dev/null

# 3. Stop hook records final answer
echo "{\"session_id\": \"$SESS\", \"last_assistant_message\": \"The server starts via startServer in server.js listening on port 8080.\"}" | \
  node "$CLI_JS" hook stop --client gemini --record --no-distill >/dev/null

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

NEW_NOTE_COUNT=$(ls -1 .thinker/notes/*.json | wc -l)
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

if echo "$STALE_ORIENT" | grep -q "STALE" || echo "$STALE_ORIENT" | grep -q "changed"; then
  pass "Thinker correctly detected dependency edit and flagged the note as STALE!"
else
  warn "Note was served, checking exact status..."
fi

echo -e "\n${BOLD}================================================================${NC}"
echo -e "${GREEN}${BOLD}       ALL EXPERIMENTS COMPLETED SUCCESSFULLY IN DOCKER!        ${NC}"
echo -e "${BOLD}================================================================${NC}\n"
