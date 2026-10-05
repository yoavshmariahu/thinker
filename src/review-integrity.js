// Conservative, explainable gate-integrity signals. These are observations to inspect,
// not a claim that every deleted assertion was the only coverage of a behavior.
import crypto from 'node:crypto';

const testFile = p => /(^|\/)(tests?|__tests__)\/|[._](test|spec)\.[^/]+$/.test(p);
const gateFile = p => /^\.github\/workflows\/|(^|\/)(package\.json|pyproject\.toml|tox\.ini|setup\.cfg|[^/]*(?:eslint|pytest|jest|vitest|tsconfig|coverage)[^/]*)$/.test(p) || p === '.thinker/verification.json';
const assertion = /\b(?:assert(?:\.\w+)?\s*\(|assert\s+\S|expect\s*\()/;
const rules = [
  ['failure-ignored', /continue-on-error\s*:\s*true|\|\|\s*(?:true|exit\s+0)\b|\ballow_failure\s*:\s*true/, 'A failure-suppression marker was added; check whether required failures can now pass.'],
  ['test-skipped', /\b(?:test|it|describe)\.(?:skip|todo|only)\s*\(|\b(?:skip|xfail)\s*[:=(]|@(?:pytest\.mark\.)?(?:skip|xfail)/, 'A skip, expected-failure, or test-selection marker was added; check executed coverage.'],
  ['lint-disabled', /eslint-disable|noqa\b|@ts-(?:ignore|nocheck)|["'][\w/@-]+["']\s*:\s*(?:["']off["']|0)\b/, 'A potential lint or type-check suppression was added.'],
  ['conditional-gate', /^\s*(?:if|paths-ignore|paths|branches-ignore)\s*:/, 'A workflow condition or filter changed; verify required checks still run.'],
];

export function gateIntegrity(change, reader) {
  const findings = [];
  const add = (file, line, rule, message, before, after, certainty = 'needs-assessment') => {
    const id = crypto.createHash('sha256').update(`${file}\0${rule}\0${before}\0${after}`).digest('hex').slice(0, 20);
    findings.push({ id: `gate-${id}`, file, line, rule, severity: 'warning', certainty, evidenceType: 'text-change', message, before, after, resolution: 'needs-review' });
  };
  for (const f of change.files) {
    const before = reader.before(f.oldPath || f.path) || '', after = reader.after(f.path) || '';
    const tests = testFile(f.path), gate = gateFile(f.path);
    if (tests && !after && before) add(f.path, 0, 'test-removed', 'A test file was removed. Confirm replacement coverage.', before.slice(0, 500), '', 'needs-assessment');
    if (gate && before !== after) add(f.path, 0, 'gate-definition-changed', 'Verification configuration changed. Required execution uses the base contract.', before.slice(0, 500), after.slice(0, 500), 'needs-assessment');
    if (!tests && !gate && !/\.[cm]?[jt]sx?$|\.py$/.test(f.path)) continue;
    const oldLines = new Set(before.split('\n').map(l => l.trim()));
    for (const [i, line] of after.split('\n').entries()) {
      if (oldLines.has(line.trim()) || !f.touched.has(i + 1)) continue;
      for (const [rule, pattern, message] of rules) {
        if (rule === 'conditional-gate' && !f.path.startsWith('.github/workflows/')) continue;
        if (pattern.test(line)) add(f.path, i + 1, rule, message, '', line.trim().slice(0, 500));
      }
    }
    if (tests && after) {
      const newLines = new Set(after.split('\n').map(l => l.trim()));
      const removed = before.split('\n').filter(l => assertion.test(l) && !newLines.has(l.trim()));
      if (removed.length) add(f.path, 0, 'assertion-changed', 'Assertions were removed or rewritten; equivalent replacement coverage has not been established.', removed.join('\n').slice(0, 1000), '', 'needs-assessment');
    }
  }
  return { status: findings.length ? 'needs-review' : 'no-signals', findings, limitation: 'Pattern-based signals do not establish equivalent coverage or detect every weakened gate.' };
}
