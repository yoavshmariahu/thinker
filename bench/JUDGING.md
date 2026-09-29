# Acceptance Criteria Judging Protocol & Standard

Standard operating procedure and decision rules for LLM-based and human evaluation of benchmark tasks in `thinker`.

---

## 1. Core Objective

Benchmark tasks evaluate whether an agent's patch satisfies the **observable runtime behaviour** required by an issue or pull request, as specified in calibrated acceptance criteria.

- Acceptance criteria describe **what** the software does, never **how** it is implemented (no requirement for specific files, function names, layers, or variable structures).
- Any design or architecture that produces the required observable behavior is valid and must be marked `met`.

---

## 2. Verdict Definitions

For each criterion, the judge outputs one of three verdicts along with quoted code evidence:

| Verdict | Meaning | When to Use | Impact on Scoring |
|---|---|---|---|
| `met` | The patch guarantees the specified behavior. | The logic, control flow, error handling, or helper delegation satisfies the requirement. | Counts toward essential/all scores; needed for strict pass. |
| `not_met` | The patch fails to provide the specified behavior. | The logic explicitly omits a requirement, returns incorrect types/values, swallows errors, or violates constraints. | 0 points on that criterion; fails strict pass. |
| `unclear` | Truly indeterminate from code structure alone. | **STRICT LAST RESORT**: Used *only* when behavior is fundamentally non-deterministic at runtime (e.g. unconstrained reflection, external network dependency without mock). | Fails strict pass; must not be used as a proxy for context truncation. |

---

## 3. Standard Decision Rules for Edge Cases

### Rule 1: Established Repository Contracts & Helper Delegation
*Why this exists: On Grafana PR132983, both cache and no-cache arms generated identical deletion code calling `resolveName`. The cache arm was marked `unclear` because `resolveName` was defined ~250 lines earlier outside the diff padding.*

- When a patch calls a pre-existing helper, interface method, or constructor (e.g. `l.resolveName(...)`, `store.GetAuthInfo(...)`, `resourceInfo.NewNotFound(...)`, `errors.Is(...)`):
  - **The judge must assume the existing repository helper satisfies its established contract**, unless the patch alters that helper or contradictory code is visible in the context.
  - The judge **must NOT mark a criterion `unclear`** simply because an existing repository function's implementation was not included in the diff context window.
  - If the patch correctly passes the required parameters, checks the returned error, and maps the result, the criterion is **`met`**.

### Rule 2: Unchanged Surrounding Code
- When an acceptance criterion requires that existing functionality continues to work (e.g. "bulk delete remains unsupported" or "other auth associations remain unaffected"):
  - If the surrounding unchanged code already implements this behavior and the patch does not break or alter it, the criterion is **`met`**.

### Rule 3: Error Propagation and Mapping
- When a criterion requires returning a specific error condition (such as "typed not-found error"):
  - It is satisfied if the code checks for that error (or relies on a helper that returns it) and returns or propagates the typed error or corresponding HTTP/gRPC status code.
  - If a function checks `errors.Is(err, user.ErrUserNotFound)` and returns `resourceInfo.NewNotFound(name)`, this fulfills the requirement.

### Rule 4: Code Evidence Over Author Claims
- The agent's final conversational response or summary is an author claim, **not evidence**.
- **A correct patch must not be penalized** because the author omitted mentioning a detail in their final summary.
- Conversely, **claims in the summary cannot override missing or flawed code**. Evidence quoted by the judge must come from the patch or surrounding post-patch code.

### Rule 5: Standard Library & Framework Semantics
- Standard library functions (Go `errors.Is`, Python `isinstance`, JS `Array.prototype.find`) and standard framework mechanisms (Kubernetes client error helpers, React lifecycle, Django ORM) must be evaluated according to their documented runtime behavior.

---

## 4. Evaluation Harness Guidelines

To prevent artificial false negatives:

1. **Context Window Padding**:
   - `contextFrom` provides at least **80 lines of padding** before and after each changed hunk (up from 45).
   - For files with **300 lines or fewer**, the **entire file** is provided after the patch so that all intra-file helpers, structs, and receivers are in context.
2. **Context Cap**:
   - Context limits should be sized comfortably for modern model context windows (at least 80,000 characters / ~20,000 tokens).
3. **Escalation Protocol for `unclear`**:
   - If an essential criterion receives an initial verdict of `unclear` citing missing definition of a function or method, the harness or reviewer must inspect whether the function exists in the repository worktree and re-evaluate with that symbol's definition.

---

## 5. Canonical Judge System Prompt

All benchmark runners (`bench/criteria.js`, `bench/codex-run.js`, `bench/gemini-run.js`, `bench/rejudge-fable.js`) share the canonical prompt exported from [`bench/judge-protocol.js`](judge-protocol.js):

```text
You evaluate code patches against acceptance criteria. For each criterion, determine whether the code after the patch exhibits the required observable behaviour: 'met', 'not_met', or 'unclear'.

DECISION RULES & PROTOCOL:
1. ANY VALID DESIGN COUNTS: Do not require a particular file, layer, variable name, or implementation strategy. Any code structure that delivers the observable behaviour is valid.
2. REPOSITORY CONTRACTS & DELEGATION: If the patch delegates to an existing helper, repository method, or standard library function (e.g. resolveName, getByID, IsNotFound) whose definition is not fully shown in the context, assume the existing helper satisfies its established contract unless visible code contradicts it. Do NOT return 'unclear' merely because a referenced pre-existing function's body is outside the diff window.
3. UNCHANGED SURROUNDING CODE COUNTS: Behaviour provided by unchanged surrounding code counts as 'met' when a criterion asks that existing functionality continues to work.
4. 'UNCLEAR' IS A STRICT LAST RESORT: Reserve 'unclear' ONLY for cases where the logical execution path is fundamentally unknowable from code structure alone (e.g. unconstrained dynamic reflection or missing new functions created by the patch). Never use 'unclear' as a substitute for checking standard error propagation or helper delegation.
5. CODE EVIDENCE OVER AUTHOR CLAIMS: The author's conversational summary is an unverified claim. A correct patch must not be penalized because the author omitted mentioning it in their summary; conversely, claims in the summary cannot override missing or flawed code.
6. QUOTE DECISIVE CODE: For each verdict, quote the specific lines of code that demonstrate your conclusion.
```
