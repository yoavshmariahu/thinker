import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.env.HOME + '/.artemis/artemis.db', { readOnly: true });
const src = JSON.parse(db.prepare('SELECT data FROM tasksets WHERE name=?').get('mlflow-b2-hard').data);
const audit = JSON.parse(fs.readFileSync('/Users/yoavshmariahu/.claude/jobs/8ea0abd0/tmp/audit/mlflow-audit.json', 'utf8'));
// What each unfair task's tests check that its request did not say (task-audit-2026-10), stated in the request.
const ADD = {
  'PR26270-hard': `For Gemini, number tool calls separately for each candidate (each streamed choice): within one candidate, its tool calls get 0, 1, 2, and so on across the whole stream. Each streamed chunk's choice index is the candidate's own \`index\` field from the Gemini response when it has one, and its position in the candidates list otherwise.`,
  'PR26307-hard': `Deep-copying a live (still active) span raises \`TypeError\` with the message "'LiveSpan' cannot be deepcopied while active. Call \`span.to_immutable_span()\`"; pickling one raises \`TypeError\` with "'LiveSpan' cannot be pickled while active. Call \`span.to_immutable_span()\`".`,
  'PR26311-hard': `The same fallback also covers ragged nested arrays whose elements are not dictionaries (for example rows [[1, 2], [3]]): they hash without an error, and data that differs only in how elements are split across rows ([[1, 2], [3]] against [[1], [2, 3]]) hashes differently. Rows that are missing (None or NaN), at any position including the first row, are handled by it too: the array hashes without an error, and the same data always hashes the same.`,
  'PR26442-hard': `In the provider catalog, TypeSafe's API-key auth mode lists exactly one optional config field: name \`api_base\`, type \`string\`, description "TypeSafe API Base URL (defaults to https://api.typesafe.ai/v1)", not required.`,
  'PR26267-hard': `Serve the server-info endpoint from a new FastAPI router named \`server_info_router\`, importable from \`mlflow.server.fastapi_app\` beside the other native routers, with its response built by a new function \`build_server_info_payload()\` (no arguments) in a new module \`mlflow.server.server_info_api\`; tests replace that function to simulate errors. When it raises an \`MlflowException\`, respond with the exception's \`get_http_status_code()\` and its \`serialize_as_json()\` body, as the Flask handler does. The health check (\`/health\` and \`/mlflow/health\`, answering "OK") must also keep responding while the shared worker pool is exhausted, through the same dedicated capacity. With basic auth on, the server-info paths are public, as \`/health\` is: \`mlflow.server.auth.is_unprotected_route(path)\` returns true for them, with and without the static prefix.`,
};
const REAUDIT = { 'PR26270-hard': 'clean', 'PR26307-hard': 'inferable', 'PR26442-hard': 'inferable', 'PR26267-hard': 'clean', 'PR26311-hard': 'clean' };
const REAUDIT_NOTE = {
  'PR26270-hard': 'Re-audited clean: per-candidate numbering and the candidate index are stated.',
  'PR26307-hard': 'Re-audited inferable: the LazySpan shallow-copy and stays-unloaded checks follow from LazySpan being lazy.',
  'PR26442-hard': 'Re-audited inferable: the typesafe_api_base config key follows the openai_api_base / anthropic_api_base precedent.',
  'PR26267-hard': 'Re-audited inferable on is_unprotected_route, which the request now states: clean.',
  'PR26311-hard': 'Re-audited hidden on missing first rows, which the request now states: clean.',
};
const EXCLUDED = { 'PR26225-hard': 'Making it fair means dictating four private helpers, an environment variable and six messages: left out.', 'PR26369-hard': 'Its performance half is graded by exact SQL text and statement counts: left out.' };
const by = Object.fromEntries(audit.map(a => [a.task.endsWith('-hard') ? a.task : a.task + '-hard', a]));
const tasks = src.tasks.map(t => {
  const a = by[t.id], out = { ...t };
  if (ADD[t.id]) {
    out.prompt = `${t.prompt}\n\nDetails the tests check:\n${ADD[t.id]}`;
    out.fairness = { class: REAUDIT[t.id], audited: '2026-10-16', was: a.class, rewritten: true, note: REAUDIT_NOTE[t.id] };
    if (out.preflight) out.preflight = { ...out.preflight, testNeedsGoldSymbols: false, goldSymbolsNamedInRequest: true };
  }
  else if (EXCLUDED[t.id]) out.fairness = { class: a.class, audited: '2026-10-16', note: EXCLUDED[t.id] };
  else out.fairness = { class: a.class, audited: '2026-10-16', note: a.notes };
  return out;
});
const spec = { repo: src.repo, base: src.base, description: 'mlflow harder set with fair requests: the five tasks whose tests checked unstated details state them (research/task-audit-2026-10); PR26225 and PR26369 are marked unfair', tasks };
fs.writeFileSync('/Users/yoavshmariahu/src/thinker-probe2/research/task-audit-2026-10/mlflow-b2-fair.json', JSON.stringify(spec, null, 1));
console.log(tasks.map(t => `${t.id} ${t.fairness.class}${t.fairness.rewritten ? ' (rewritten)' : ''}`).join('\n'));
