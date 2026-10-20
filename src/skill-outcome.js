// The outcome of a session for the skills it could have read: which rules of the repository's skills its
// change broke, and whether the agent had read the skill. A broken rule of a skill nobody read in the session
// is the evidence that suggesting it would have helped (a miss, skill-suggest.js:creditOutcome); one broken
// although the skill was read, a negative. Without this the ranking only sees which skills agents open.
//
// Why a call of its own: the end-of-session distillation was asked for the broken rules in the same call
// (PR #393) and matched the conventions grader on 0 of 30 graded PostHog sessions (3 with the diff appended,
// none on the right rule): it saw neither the change nor the rules. This check is modelled on that grader
// (Artemis/kronus conventions.js and judge-protocol.js:judgeConventions): it is shown the session's change, the
// full text of the skills that bear on the changed files, the rule files whose globs match them and the
// AGENTS.md text that applies, and answers with violations that quote the rule and name where it is written.
//
//   the change  `git diff` of the files the session edited, from the commit HEAD was on when the session
//               started (the newest commit older than its start) to the working tree, plus files it created.
//               Not the transcript's edits: Claude Code's old/new strings carry no line context and a Codex
//               patch or a shell edit (sed, a script, a generator) changes code the edit events never show,
//               while the working tree at the end of the session is what a reviewer sees. Limited to the files
//               the session edited, so another session's changes elsewhere stay out; a later commit that
//               reached HEAD from elsewhere during the session can still show in those files.
//   the skills  the best `outcomeSkills` candidates of the evidence for the changed files (skill-suggest.js:
//               candidates), and up to `outcomeRuleSkills` that a matching .claude/rules file names
//               (`/name` or `name` in backquotes), the repository saying itself that the skill applies.
//   when        once a session, from the end-of-session distill (commands/learn.js:distillFile), on a share
//               of sessions (`harness.skillOutcomeShare`, by a hash of the session id), only when the session
//               edited files with skills to check, within the daily token cap, never in test mode unless
//               forced (THINKER_HARNESS_SKILL_OUTCOME=on). Model calls go through llm.js:complete, so a desktop
//               app's session answers them like a distillation (session-llm.js). Logged as op "skill-outcome".
//
// Its own switch, off by default: `harness: { skillOutcome: true }` (with skillSuggest on), or the env above.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { complete, DEFAULT_DISTILL_MODEL } from './llm.js';
import { tokensOf } from './model-usage.js';
import { isTestMode } from './test-mode.js';
import { withinDailyCap } from './maintain.js';
import {
  SKILL_SUGGEST, skillSuggestOn, skillSuggestConfig, loadEvidence, saveEvidence, emptyEvidence, skillRegistry, candidates,
  creditOutcome, sessionSkillEvidence, sessionSuggestions, suggestable, areaKeys,
} from './skill-suggest.js';

export function skillOutcomeOn(store, env = process.env) {
  if (!skillSuggestOn(store, env)) return false;
  const v = env.THINKER_HARNESS_SKILL_OUTCOME || '';
  if (/^(0|off|false)$/i.test(v)) return false;
  if (/^(1|on|true)$/i.test(v)) return true;
  if (isTestMode(env)) return false;
  try { return store.config().harness?.skillOutcome === true; } catch { return false; }
}

// a session is checked or not by its id alone, so a second end-of-session run agrees with the first
export function outcomeSampled(id, share) {
  if (!(share > 0)) return false;
  if (share >= 1) return true;
  return parseInt(createHash('sha1').update(String(id)).digest('hex').slice(0, 8), 16) / 2 ** 32 < share;
}

// --- the change --------------------------------------------------------------------------------------------
export function sessionDiff(repo, files, { start } = {}) {
  const fs_ = [...new Set(files)].filter(suggestable);
  if (!fs_.length) return '';
  const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', maxBuffer: 1 << 27, stdio: ['ignore', 'pipe', 'ignore'] });
  let base = 'HEAD';
  if (start) { try { const b = git('rev-list', '-1', `--before=${start}`, 'HEAD').trim(); if (b) base = b; } catch {} }
  let diff = '';
  try { diff = git('diff', '--no-color', '--no-ext-diff', base, '--', ...fs_); } catch {}
  let untracked = [];
  try { untracked = git('ls-files', '--others', '--exclude-standard', '--', ...fs_).split('\n').filter(Boolean); } catch {}
  for (const f of untracked) {
    const r = spawnSync('git', ['-C', repo, 'diff', '--no-color', '--no-index', '--', '/dev/null', f], { encoding: 'utf8', maxBuffer: 1 << 26 });
    if (r.stdout) diff += (diff && !diff.endsWith('\n') ? '\n' : '') + r.stdout;
  }
  return diff;
}
export function changedPaths(diff) {
  const out = new Set();
  for (const m of String(diff || '').matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gm)) out.add(m[2] === '/dev/null' ? m[1] : m[2]);
  return [...out];
}

// --- the guidance ------------------------------------------------------------------------------------------
// the path globs of a rule file's front matter (paths: or globs:, a list or a bracketed line)
export function ruleGlobs(text) {
  const m = String(text || '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return [];
  const lines = m[1].split(/\r?\n/), out = [];
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^(paths|globs):\s*(.*)$/);
    if (!kv) continue;
    const rest = kv[2].trim(), unq = s => s.trim().replace(/^(['"])(.*)\1$/, '$2');
    if (/^\[.*\]$/.test(rest)) out.push(...rest.slice(1, -1).split(',').map(unq).filter(Boolean));
    else if (rest) out.push(...rest.split(',').map(unq).filter(Boolean));
    while (i + 1 < lines.length && /^\s+-\s/.test(lines[i + 1])) out.push(unq(lines[++i].replace(/^\s+-\s/, '')));
  }
  return out;
}
// a gitignore-style glob over a repository path: ** any directories, * no slash, ? one character, {a,b}
export function globRegex(glob) {
  const g = String(glob).trim().replace(/^\.\//, '');
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') { i++; if (g[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*'; }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '{') { const end = g.indexOf('}', i); if (end < 0) { re += '\\{'; continue; } re += '(?:' + g.slice(i + 1, end).split(',').map(s => s.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')).join('|') + ')'; i = end; }
    else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}${g.endsWith('/') ? '.*' : '(?:/.*)?'}$`);
}
// .claude/rules files whose globs match a changed path, and those with no globs (always on)
export function matchingRules(repo, paths) {
  const dir = path.join(repo, '.claude', 'rules'), out = [];
  let names = []; try { names = fs.readdirSync(dir).filter(n => /\.mdc?$/.test(n)).sort(); } catch { return out; }
  for (const n of names) {
    let text; try { text = fs.readFileSync(path.join(dir, n), 'utf8'); } catch { continue; }
    const globs = ruleGlobs(text), res = globs.map(globRegex);
    const hit = globs.length ? paths.filter(p => res.some(r => r.test(p))) : paths;
    if (hit.length) out.push({ path: `.claude/rules/${n}`, text, matched: hit });
  }
  return out;
}
// skills a text tells the agent to use: `/name` or `name` in backquotes
export function skillsNamedIn(text, names) {
  const found = [];
  for (const n of names) {
    const e = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(^|[\\s(\`'"])/${e}(?![\\w-])|\`${e}\``).test(text)) found.push(n);
  }
  return found;
}
// The AGENTS.md text that applies: the root file less its sections about process (commits, pull requests,
// pushing, CI, commands to run), which a diff cannot show, and the AGENTS.md (or CLAUDE.md) of each directory
// on a changed path.
const PROCESS = /commit|pull request|\bPRs?\b|push|merg|\bCI\b|github actions|^commands|release|deploy|automation/i;
export function agentsSections(repo, paths) {
  const read = p => { try { return fs.readFileSync(path.join(repo, p), 'utf8'); } catch { return null; } };
  const out = [], root = read('AGENTS.md') ?? read('CLAUDE.md');
  if (root && !/^@?AGENTS\.md\s*$/.test(root.trim())) {
    const parts = root.split(/^(?=## )/m), kept = parts.filter((p, i) => i === 0 || !PROCESS.test(p.split('\n')[0]));
    out.push({ label: 'AGENTS.md', text: kept.join('') });
  }
  const dirs = new Set();
  for (const p of paths) { const parts = p.split('/'); for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/')); }
  for (const d of [...dirs].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))) {
    for (const n of ['AGENTS.md', 'CLAUDE.md']) {
      const text = read(`${d}/${n}`);
      if (text == null || !text.trim() || /^@?AGENTS\.md\s*$/.test(text.trim())) continue;
      out.push({ label: `${d}/${n}`, text }); break;
    }
  }
  return out;
}
// What the check is shown for a set of changed files: the skills (evidence first, then those a rule names),
// the matching rules and the AGENTS.md text, within a budget in characters. Skills come before AGENTS.md text
// in the budget, since only a skill's breaks are credited.
export function outcomeGuidance(repo, ev, files, { cfg = SKILL_SUGGEST, now = Date.now() } = {}) {
  const paths = [...new Set(files)].filter(suggestable);
  const best = new Map();
  for (const f of paths) for (const [skill, posts] of candidates(ev, f, { now, cfg })) best.set(skill, Math.max(best.get(skill) || 0, ...posts.map(p => p.alpha / (p.alpha + p.beta))));
  const fromEvidence = [...best].sort((a, b) => b[1] - a[1]).map(([s]) => s).filter(s => ev.skills?.[s]).slice(0, cfg.outcomeSkills);
  const rules = matchingRules(repo, paths);
  const names = Object.keys(ev.skills || {}), alias = new Map(names.flatMap(n => [[n, n], ...(ev.skills[n].alias ? [[ev.skills[n].alias, n]] : [])]));
  const byRule = [...new Set(rules.flatMap(r => skillsNamedIn(r.text, [...alias.keys()]).map(n => alias.get(n))))].filter(n => !fromEvidence.includes(n)).slice(0, cfg.outcomeRuleSkills);
  const chosen = [...fromEvidence.map(name => ({ name, by: 'evidence' })), ...byRule.map(name => ({ name, by: 'rule' }))];
  const sections = rules.map(r => ({ kind: 'rule', label: r.path, text: r.text }));
  let used = sections.reduce((a, s) => a + s.text.length, 0);
  const skills = [], dropped = [];
  for (const c of chosen) {
    const s = ev.skills[c.name];
    let text; try { text = fs.readFileSync(path.join(repo, s.file), 'utf8'); } catch { continue; }
    if (used + text.length > cfg.outcomeGuidanceChars) { dropped.push(c.name); continue; }
    used += text.length; skills.push({ ...c, file: s.file });
    sections.push({ kind: 'skill', label: `skill ${c.name} (${s.file})`, text });
  }
  for (const a of agentsSections(repo, paths)) {
    const room = cfg.outcomeGuidanceChars - used;
    if (room < 2000) { dropped.push(a.label); continue; }
    const text = a.text.length > room ? a.text.slice(0, room) + '\n[cut]' : a.text;
    used += text.length; sections.push({ kind: 'agents', label: a.label, text });
  }
  return { sections, skills, rules: rules.map(r => r.path), dropped, chars: used };
}

// --- the judge ---------------------------------------------------------------------------------------------
export const OUTCOME_SCHEMA = {
  type: 'object',
  properties: {
    violations: {
      type: 'array', maxItems: 12,
      items: {
        type: 'object',
        properties: {
          rule: { type: 'string', description: 'the rule, quoted from the guidance (shortened with … if long)' },
          source: { type: 'string', description: 'where the rule is written: the label of its section exactly as given (skill <name> (<path>), a rules file path, an AGENTS.md path)' },
          file: { type: 'string', description: 'the file of the diff that breaks it' },
          evidence: { type: 'string', description: 'the added or changed diff line(s) that break the rule, quoted, and why in one sentence' },
        },
        required: ['rule', 'source', 'file', 'evidence'],
      },
    },
  },
  required: ['violations'],
};
export const OUTCOME_SYSTEM = `You review a code change against the repository's own written guidance, given below in sections: skill files, rule files and AGENTS.md text. You do not judge whether the change does what was asked, and you do not apply your own taste or general best practice: only what this guidance says.

RULES:
1. CITE THE GUIDANCE: every violation breaks a rule written in the guidance. Quote the rule and give as source the label of the section it is written in, exactly as shown after =====. When the same rule is written in several sections, name a skill section if one of them is a skill. No rule in the text, no violation.
2. ONLY WHAT THE DIFF ADDS OR CHANGES: judge the '+' lines (and a removal only when removing breaks a rule). Never flag code the diff leaves as it was.
3. ONLY WHAT THE DIFF SHOWS: skip rules about process the diff cannot show (running tests, linters or type checks, invoking a skill, commit messages, pull requests, asking a person).
4. OMISSIONS ONLY WHEN UNMISTAKABLE: a missing accompanying change counts only when the guidance explicitly requires it for exactly the kind of change the diff makes, and the diff plainly lacks it.
5. QUOTE THE EVIDENCE: quote the offending diff line(s) and say in one sentence how they break the rule. The file is a path from the diff.
6. ONE ENTRY PER RULE PER FILE.
7. EVERY KIND OF RULE: style, wording, naming, punctuation and comment rules count as much as the others; a small break of a written rule is still a break. Go through each skill section's rules and check every added line against them, comments and strings included.
8. WHEN IN DOUBT ABOUT WHETHER THE DIFF BREAKS A RULE, LEAVE IT OUT. An empty list is the right answer for a change that follows the guidance.`;
export function outcomePrompt(diff, guidance, { maxDiff = 40_000 } = {}) {
  const d = String(diff || '');
  return `GUIDANCE:\n${guidance.sections.map(s => `===== ${s.label} =====\n${s.text.trim()}\n`).join('\n')}\nDIFF${d.length > maxDiff ? ` (cut at ${maxDiff} of ${d.length} characters)` : ''}:\n${d.slice(0, maxDiff)}`;
}
// the skill a violation's source names, among the skills the check was shown (by name or by file)
export function violationSkill(source, skills) {
  const s = String(source || '');
  for (const k of skills) {
    const e = k.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (s.includes(k.file) || new RegExp(`(^|[^\\w-])${e}(?![\\w-])`).test(s)) return k.name;
  }
  return null;
}

// One check of a change: the guidance, one model call, the violations each with the skill it is credited to.
export async function judgeSkillOutcome(store, { diff, files, ev, cfg = skillSuggestConfig(store), model, completeFn = complete, accounting, now = Date.now() } = {}) {
  ev = ev || loadEvidence(store) || emptyEvidence();
  if (!Object.keys(ev.skills || {}).length) ev.skills = skillRegistry(store.repo);
  const paths = files?.length ? files : changedPaths(diff);
  const guidance = outcomeGuidance(store.repo, ev, paths, { cfg, now });
  if (!guidance.skills.length || !String(diff || '').trim()) return { skipped: !guidance.skills.length ? 'no-skills' : 'no-diff', guidance, violations: [] };
  const res = await completeFn({ system: OUTCOME_SYSTEM, prompt: outcomePrompt(diff, guidance, { maxDiff: cfg.outcomeDiffChars }), model: model || store.config().harness?.skillOutcomeModel || store.config().distillModel || DEFAULT_DISTILL_MODEL, schema: OUTCOME_SCHEMA, maxTokens: 3000, thinkingTokens: 0, structuredRetries: 1, accounting });
  const raw = Array.isArray(res.json?.violations) ? res.json.violations : [];
  const violations = raw.filter(v => v && String(v.rule || '').trim() && String(v.source || '').trim()).slice(0, 12)
    .map(v => ({ rule: String(v.rule).slice(0, 400), source: String(v.source).slice(0, 200), file: String(v.file || '').replace(/^\.\//, ''), evidence: String(v.evidence || '').slice(0, 400), skill: violationSkill(v.source, guidance.skills) }));
  return { guidance, violations, cost: res.cost ?? null, tokens: tokensOf(res), model: res.model || null };
}

// The end-of-session path (commands/learn.js:distillFile): sampled, once a session, credited and logged.
export async function skillOutcomeCheck(store, file, { session, phase, h, completeFn = complete, now = Date.now(), env = process.env } = {}) {
  if (!skillOutcomeOn(store, env)) return null;
  const cfg = skillSuggestConfig(store);
  h = h || sessionSkillEvidence(file);
  const id = session || h.id;
  if (h.parent || !outcomeSampled(id, cfg.outcomeShare)) return null;
  const ev = loadEvidence(store) || emptyEvidence();
  if (!Object.keys(ev.skills).length) ev.skills = skillRegistry(store.repo);
  const rec = (ev.sessions[id] ||= { at: new Date(now).toISOString(), areas: [], pairs: [], suggested: [], followed: [] });
  if (rec.outcome) return null;
  const files = (h.edited || []).filter(suggestable);
  if (!files.length) return null;
  if (!files.some(f => candidates(ev, f, { now, cfg }).size)) return null;
  if (phase !== 'init' && !withinDailyCap(store).ok) { store.log({ op: 'skill-outcome', session: id, skipped: 'daily-cap' }); return null; }
  const diff = sessionDiff(store.repo, files, { start: h.start });
  rec.outcome = new Date(now).toISOString();
  const r = await judgeSkillOutcome(store, { diff, files, ev, cfg, completeFn, now, accounting: { store, phase, session: id, purpose: 'skill-outcome' } });
  if (r.skipped) { saveEvidence(store, ev); store.log({ op: 'skill-outcome', session: id, skipped: r.skipped }); return r; }
  const read = new Set((h.opened || []).map(o => o.skill)), shown = new Set(sessionSuggestions(store, id).filter(s => !s.withheld).map(s => s.skill));
  const aliasOf = n => Object.entries(ev.skills).find(([, s]) => s.alias === n)?.[0] || n;
  const isRead = n => read.has(n) || read.has(ev.skills[n]?.alias) || [...read].some(x => aliasOf(x) === n);
  const broken = r.violations.filter(v => v.skill).map(v => ({ skill: v.skill, file: v.file, read: isRead(v.skill), shown: shown.has(v.skill) }));
  const credited = creditOutcome(ev, broken, { areas: [...new Set(files.flatMap(areaKeys))], session: id, now, halfLifeDays: cfg.halfLifeDays });
  saveEvidence(store, ev);
  store.log({ op: 'skill-outcome', session: id, skills: r.guidance.skills.map(s => s.name), read: r.guidance.skills.map(s => s.name).filter(isRead), rules: r.guidance.rules, diffChars: diff.length, violations: r.violations.map(v => ({ source: v.source.slice(0, 120), skill: v.skill || undefined, file: v.file || undefined, rule: v.rule.slice(0, 160) })), credited: credited.map(c => ({ skill: c.skill, verdict: c.verdict, ...(c.shown ? { shown: true } : {}) })), cost: r.cost ?? undefined, tokens: r.tokens ?? undefined, metered: true, phase });
  return { ...r, credited };
}
