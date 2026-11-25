// Recorded workspace changes, never repository names inferred from conversation text.
import fs from 'node:fs';
import path from 'node:path';
import { diskCache, cacheKey, cachedByFiles } from './disk-cache.js';

const CACHE = diskCache('session-workspaces', 2);
const canonical = p => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
export function workspaceMatches(cwd, repos) {
  if (!repos?.length) return true;
  if (!cwd) return false;
  cwd = canonical(cwd);
  // A nested repository belongs to itself, not also to its parent repository.
  let root = cwd;
  while (!fs.existsSync(path.join(root, '.git')) && path.dirname(root) !== root) root = path.dirname(root);
  return repos.some(repo => {
    repo = canonical(repo);
    return fs.existsSync(path.join(root, '.git')) ? root === repo : cwd === repo || cwd.startsWith(repo + path.sep);
  });
}

// Only literal execution directories on tool calls qualify. Never evaluate generated code.
function executionDirectory(p, cwd) {
  let input = p.arguments ?? p.input ?? p.action;
  if (typeof input === 'string') { try { input = JSON.parse(input); } catch {} }
  if (typeof input === 'object' && input) {
    const dir = input.workdir || input.cwd || input.working_directory;
    if (typeof dir === 'string') return path.resolve(cwd || '/', dir);
  }
  // Codex's functions.exec wrapper carries calls as JavaScript. Recognize only a
  // literal workdir on an exec_command call, not paths mentioned in command output.
  if (typeof input === 'string' && /(?:^|\.)exec$/.test(p.name || '')) {
    const tokens = input.match(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\/\*[\s\S]*?\*\/|\/\/[^\n]*|[A-Za-z_$][\w$]*|[^\s]/g)?.filter(t => !t.startsWith('//') && !t.startsWith('/*')) || [];
    const dirs = [];
    for (let i = 0; i < tokens.length; i++) {
      if (tokens.slice(i, i + 5).join(' ') !== 'tools . exec_command ( {') continue;
      let depth = 1;
      for (let k = i + 5; k < tokens.length && depth; k++) {
        const t = tokens[k];
        if (t === '{' || t === '[' || t === '(') depth++;
        if (t === '}' || t === ']' || t === ')') depth--;
        if (depth !== 1 || !['workdir', '"workdir"', "'workdir'"].includes(t) || !['{', ','].includes(tokens[k - 1]) || tokens[k + 1] !== ':') continue;
        const value = tokens[k + 2];
        if (!value || !['"', "'"].includes(value[0]) || ![',', '}'].includes(tokens[k + 3])) continue;
        try { dirs.push(value[0] === '"' ? JSON.parse(value) : value.slice(1, -1).replace(/\\'/g, "'")); } catch {}
      }
    }
    if (dirs.length && new Set(dirs).size === 1) return path.resolve(cwd || '/', dirs[0]);
  }
  return null;
}

export function codexWorkspaces(rows) {
  let cwd = null, turn = null;
  const turns = new Map();
  return rows.map(j => {
    const p = j?.payload || {};
    if ((j?.type === 'session_meta' || j?.type === 'turn_context') && typeof p.cwd === 'string' && path.isAbsolute(p.cwd)) cwd = p.cwd;
    if (j?.type === 'turn_context') { turn = p.turn_id; if (turn) turns.set(turn, cwd); }
    if (j?.type === 'response_item' && ['function_call', 'custom_tool_call', 'local_shell_call'].includes(p.type)) {
      const dir = executionDirectory(p, cwd);
      if (dir) { cwd = dir; if (turn) turns.set(turn, cwd); }
    }
    // Usage can arrive after a different turn's context under concurrency.
    return j?.type === 'token_usage_record' && turns.has(p.turn_id) ? turns.get(p.turn_id) : cwd;
  });
}

export function sessionWorkspaces(file) {
  return cachedByFiles(CACHE, cacheKey(file), [file], () => {
    const rows = fs.readFileSync(file, 'utf8').split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } });
    const workspaces = codexWorkspaces(rows), timeline = [];
    rows.forEach((j, i) => {
      if (!j || !workspaces[i]) return;
      if (i === 0 || workspaces[i] !== workspaces[i - 1]) {
        const t = Date.parse(j.timestamp);
        if (Number.isFinite(t)) timeline.push({ t, cwd: workspaces[i] });
      }
    });
    return { paths: [...new Set(workspaces.filter(Boolean))], timeline: timeline.sort((a, b) => a.t - b.t) };
  });
}

export function workspaceAt(timeline, at) {
  const t = typeof at === 'number' ? at : Date.parse(at);
  let cwd = null;
  for (const entry of timeline || []) { if (entry.t > t) break; cwd = entry.cwd; }
  return cwd;
}
