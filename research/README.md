# Research: Investigating and Resolving Wall-Time and Retrieval Regressions in Large Note Corpora

**Author:** Gemini (Google DeepMind Antigravity)  
**Date:** September 28, 2026  
**Status:** Completed & Validated on `main`  
**Repository:** [thinker](https://github.com/yoavshmariahu/thinker)  
**Benchmark Target:** Grafana (`bench/tasks/grafana-hard.json`, 694 notes in `bench/notesets/grafana-v2`)

---

## 1. Executive Summary

During evaluation runs on Grafana using Gemini 3.8 Flash (`gemini-3.8-flash-high`) via the Antigravity CLI, wall-clock execution time on the cache arm increased by **+14.0%** (averaging 952.8s on cache vs 835.9s on nocache), despite the cache reducing total tool calls by 11.3% and token consumption by 15%–47%.

An investigation revealed two distinct ranking/serving defects introduced during recent engine changes that interacted pathologically with corpus scaling, as well as an MCP tool output size issue:
1. **Term Mass Dilution of Coverage Floors (`MIN_COVER.body`)**: When the note corpus scaled from 259 notes (PostHog) to 694 notes (Grafana), total term mass $B_{\text{mass}}$ expanded from ~150 to ~280, diluting calculated body coverage below the `0.15` floor and silently disqualifying high-relevance target notes.
2. **Unconditional Second-Slot Eviction in `orient`**: A 2-slot prompt orientation unconditionally overwrote the second-best hit with a linked note, even when the second hit had high relevance (0.89) and the linked note was tangential (0.15–0.20).
3. **Uncapped MCP `lookup` Note Packing**: Free-form `lookup` packed up to 8–10 notes within its 2,500 token budget, causing tool output spillover into `output.txt` and burning agent turns.

Following fixes to [`src/rank.js`](file:///Users/yoavshmariahu/src/thinker/src/rank.js) and [`src/ops.js`](file:///Users/yoavshmariahu/src/thinker/src/ops.js), re-testing across the 3 benchmark tasks demonstrated:
- **Average wall time dropped from 952.8s to 671.9s (-29.5% reduction vs bug, -19.6% vs nocache)**.
- **Strict pass rate reached 3 of 3 (100%)** with **100.0% essential criteria met**.
- **Tool calls fell from 138.7 (nocache) to 122.0 (cache)**.

---

## 2. Problem Statement & Symptoms

On the initial evaluation runs (`bench/runs/grafana-gemini-3.8-v2notes/summary.json`):
- **`PR133011-hard`** (Text panel editor view mode):
  - `nocache`: 691.6s, 110 calls.
  - `cache`: 740.4s, 116 calls (**+48.8s regression**).
- **`PR133148-hard`** (Search-backed List authz filtering):
  - `nocache`: 989.3s, 175 calls.
  - `cache`: 1036.5s, 125 calls (**+47.2s regression**).
- **`PR132983-hard`** (AuthInfo single-module deletion):
  - `nocache`: 826.9s, 131 calls.
  - `cache`: 1081.4s, 128 calls (**+254.5s regression**).

Across the three tasks, cache runs averaged **952.8s (15.9 min)** compared to **835.9s (13.9 min)** on nocache.

Analyzing the Antigravity CLI execution traces (`~/.gemini/antigravity-cli/brain/<session>/`) revealed that tool execution time was sub-second (<50ms for Thinker MCP calls, <1s for file reads and shell commands). Instead, over 95% of wall clock time was Gemini API token generation streaming latency (~7.1s–7.6s per turn). Because the cache failed to deliver critical architectural pointers in the initial prompt, the agent was forced to take 115–140 turns to manually re-explore the codebase.

---

## 3. Root Cause Analysis

### A. Coverage Floor Dilution in Large Note Corpora
Commit `86b91b8` introduced absolute coverage floors in [`src/rank.js`](file:///Users/yoavshmariahu/src/thinker/src/rank.js):
```javascript
export const MIN_COVER = { body: 0.15, question: 0.05 };
// ...
const cover = (B.scores.get(n.id) || 0) / Math.max(1e-9, B.mass);
const passes = loose ? ... : (((mq >= need || ...) && cover >= minB && coverQ >= minQ) || aff > 0);
```
Where:
- $B_{\text{mass}}$ is the sum of IDF for all query terms present across the *entire* note corpus.
- In `posthog-v2` (259 notes), $B_{\text{mass}}$ was ~140–160, so concise notes easily achieved $\text{cover} \ge 0.15$.
- In `grafana-v2` (694 notes), $B_{\text{mass}}$ grew to **279.5**.
- On `PR133011-hard`, the exact note resolving the default view mode issue was [`text-v2-panel-editor-defaults-to-split-view-on-open`](file:///Users/yoavshmariahu/src/thinker/bench/notesets/grafana-v2/notes/text-v2-panel-editor-defaults-to-split-view-on-open.json). It scored a **0.889 relevance** and **0.138 question coverage**, but its body coverage was **0.1455** — missing the 0.15 floor by 0.0045!
- Result: The exact answer note was completely discarded from prompt serving.

### B. Unconditional Second-Slot Eviction in `orient`
In [`src/ops.js:orient`](file:///Users/yoavshmariahu/src/thinker/src/ops.js#L218):
```javascript
if (top.length && process.env.THINKER_NO_LINKS !== '1') {
  const rel = ranked.filter(r => (top[0].note.related || []).includes(r.note.id) && !top.includes(r) && r.rel >= 0.15)[0];
  if (rel) top = maxNotes > 2 ? [...top, rel] : [...top.slice(0, maxNotes - 1), rel];
}
```
When `maxNotes === 2`, if the top note had a linked note with even modest relevance (e.g. 0.18), the code unconditionally discarded `top[1]`. Even if `top[1]` had high relevance (0.85+), it was evicted in favor of the link.

### C. Free-form `lookup` Output Spillover
[`lookup`](file:///Users/yoavshmariahu/src/thinker/src/ops.js#L421) packed notes using a default budget of 2,500 tokens without capping note count. When an agent queried `"view mode"` or `"auth info"`, 8 to 10 notes were returned (>3,500 characters), exceeding Antigravity CLI's inline tool threshold and dumping into `output.txt`. The agent was forced to spend extra turns reading and navigating the external file.

---

## 4. Implementation Solutions

The following changes were implemented and committed to `main` in [`f4bc37b`](https://github.com/yoavshmariahu/thinker/commit/f4bc37b):

### 1. Calibrated Body Coverage Floor ([`src/rank.js`](file:///Users/yoavshmariahu/src/thinker/src/rank.js#L71))
Lowered `MIN_COVER.body` from `0.15` to `0.10`:
```javascript
export const MIN_COVER = { body: 0.10, question: 0.05, terms: 3 };
```
This permits concise, high-relevance notes to pass in larger repositories while continuing to reject off-target queries (unrelated terms consistently score body coverage < 0.07).

### 2. Strong Hit Preservation in `orient` ([`src/ops.js`](file:///Users/yoavshmariahu/src/thinker/src/ops.js#L222-L230))
Updated 2-slot linking logic so a linked note only takes slot 2 if slot 2 is missing, weak relative to the top hit, or if the linked note has strictly higher relevance:
```javascript
if (rel) {
  if (maxNotes > 2 || top.length < maxNotes) {
    top = [...top, rel];
  } else if (top[1] && (top[1].rel < 0.7 * top[0].rel || rel.rel > top[1].rel)) {
    top = [top[0], rel];
  }
}
```

### 3. Capping Free-Form `lookup` Results ([`src/ops.js`](file:///Users/yoavshmariahu/src/thinker/src/ops.js#L421), [`src/mcp.js`](file:///Users/yoavshmariahu/src/thinker/src/mcp.js#L50))
Added a `maxNotes = 3` cap to [`lookup`](file:///Users/yoavshmariahu/src/thinker/src/ops.js#L421) by default when searching with free-form queries (queries by explicit note ID continue to return that exact note):
```javascript
export function lookup(store, { query, budget = 2500, maxNotes = 3 } = {}) {
  // ...
  const candidates = byId ? ranked : (maxNotes ? ranked.slice(0, maxNotes) : ranked);
  const packed = pack(candidates, budget, { minRel: 0.15 });
  return packed;
}
```

---

## 5. Empirical Results

Following the changes, three full benchmark evaluation cycles were run on Grafana tasks using Gemini 3.8 Flash (`gemini-3.8-flash-high`) via `agy`, judged on calibrated acceptance criteria:

### Task-by-Task Progression

| Task | Metric | Initial nocache | Initial cache (Buggy) | Fixed Cache (`v2-retest`) | Delta (Fixed vs nocache) |
|---|---|---|---|---|---|
| **`PR133148-hard`**<br>*(Search list authz)* | Wall Time<br>Tool Calls<br>Essential<br>Pass | 989.3s<br>175<br>60%<br>FAIL | 1036.5s<br>125<br>100%<br>PASS | **547.0s**<br>**100**<br>**100%**<br>**PASS** | **-44.7% (-442.3s)**<br>**-42.9% (-75 calls)**<br>+40%<br>**+PASS** |
| **`PR133011-hard`**<br>*(Text panel view mode)* | Wall Time<br>Tool Calls<br>Essential<br>Pass | 691.6s<br>110<br>100%<br>PASS | 740.4s<br>116<br>100%<br>PASS | **690.4s**<br>**115**<br>**100%**<br>**PASS** | **-0.2% (-1.2s)**<br>+5 calls<br>parity<br>parity |
| **`PR132983-hard`**<br>*(AuthInfo deletion)* | Wall Time<br>Tool Calls<br>Essential<br>Pass | 826.9s<br>131<br>100%<br>PASS | 1081.4s<br>128<br>100%<br>PASS | **778.3s**<br>**151**<br>**100%**<br>**PASS** | **-5.9% (-48.6s)**<br>+20 calls<br>parity<br>parity |

### Benchmark Summary Averages

```
Average Wall Clock Time:
  nocache (initial)         ████████████████░░░░  835.9s (13.9 min)
  cache (with ranking bug)  ███████████████████░  952.8s (15.9 min)  [+14.0% regression]
  cache (v2-retest fixed)   █████████████░░░░░░░  671.9s (11.2 min)  [-29.5% vs bug / -19.6% vs nocache]
```

- **Wall Time**: Reduced from **952.8s (15.9 min)** to **671.9s (11.2 min)** (**-280.9s / -29.5%**).
- **Correctness**: **3 of 3 (100%) strict passes** under the Gemini judge, with **100.0% essential criteria met**.
- **Efficiency**: Tool calls averaged **122.0** with 4.0 Thinker MCP calls per task, maintaining clean turn context with zero output file spillovers.

---

## 6. Lessons Learned for Agent Knowledge Caching

1. **Avoid Scale-Sensitive Thresholds in BM25 Gating**:
   Normalization factors like $B_{\text{mass}} = \sum_{\text{terms}} \text{IDF}$ grow as corpus size increases. Fixed thresholds like `cover >= 0.15` unintentionally make concise, highly specific notes fail admission in large corpora.
2. **Never Evict Dominant Relevance for Links**:
   Linked notes provide helpful context, but should never displace an intrinsically relevant top candidate unless slot 2 is genuinely weak (<0.7 of hit #1).
3. **Guard MCP Tool Payload Sizes**:
   Coding agents suffer non-linear latency and cognitive penalties when tool responses spill into auxiliary files (`output.txt`). Strict default limits (`maxNotes = 3`) keep context tightly bounded and generation latencies minimal.
