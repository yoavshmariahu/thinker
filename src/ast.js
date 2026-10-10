// Symbol location through a real parser: web-tree-sitter with the grammars of tree-sitter-wasms,
// for Python, JavaScript, TypeScript, Go and Rust. Both are dependencies of thinker since 0.1.30
// (they were an optional `thinker ast install` before: about 50 MB beside a 500 MB ranking runtime),
// so the parser is on wherever the dependencies are installed. Until initAst() has loaded a grammar,
// deps.js keeps to its regex heuristics, so every caller stays synchronous and an install without
// npm, or a language without a grammar, works as before.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { diskCache } from './disk-cache.js';

export const GRAMMARS = { py: 'python', pyi: 'python', js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx', go: 'go', rs: 'rust' };
export const GRAMMAR_NAMES = [...new Set(Object.values(GRAMMARS))];
// the versions package.json pins, known to load each other: tree-sitter-wasms 0.1.x grammars are ABI 14, which web-tree-sitter 0.23+ no longer loads
export const AST_PACKAGES = ['web-tree-sitter@0.22.6', 'tree-sitter-wasms@0.1.13'];

export function grammarOf(file) { const ext = String(file || '').split('.').pop().toLowerCase(); return GRAMMARS[ext] || null; }

const state = { ready: false, dir: null, Parser: null, parsers: new Map(), error: null, tried: false };

// Where the packages may be: THINKER_AST_DIR when it names a place, thinker's own node_modules (the
// versions it was tested with), then ~/.thinker/ast, where `thinker ast install` put them before 0.1.30.
export function astDirs() {
  const home = process.env.THINKER_HOME || path.join(os.homedir(), '.thinker');
  return [process.env.THINKER_AST_DIR, path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'), path.join(home, 'ast')].filter(Boolean);
}

function resolver(dir) {
  const req = createRequire(pathToFileURL(path.join(dir, 'package.json')).href);
  try { return { req, main: req.resolve('web-tree-sitter'), wasm: g => req.resolve(`tree-sitter-wasms/out/tree-sitter-${g}.wasm`) }; } catch { return null; }
}

// Loads the parser and the grammars (all of them by default). Idempotent; a missing installation
// leaves astStatus().available false and is not an error.
export async function initAst({ dir, grammars = GRAMMAR_NAMES } = {}) {
  if (process.env.THINKER_AST === 'off') return astStatus();
  if (!state.Parser) {
    state.tried = true;
    for (const d of dir ? [dir] : astDirs()) {
      const r = resolver(d); if (!r) continue;
      try {
        const mod = await import(pathToFileURL(r.main).href);
        const Parser = mod.default?.Parser || mod.Parser || mod.default;
        await Parser.init();
        state.Parser = Parser; state.dir = d; state.resolve = r;
        break;
      } catch (e) { state.error = String(e.message || e); }
    }
    if (!state.Parser) return astStatus();
  }
  for (const g of grammars) {
    if (state.parsers.has(g)) continue;
    try {
      const lang = await state.Parser.Language.load(state.resolve.wasm(g));
      const p = new state.Parser(); p.setLanguage(lang);
      state.parsers.set(g, p);
    } catch (e) { state.error = `${g}: ${String(e.message || e)}`; }
  }
  state.ready = state.parsers.size > 0;
  return astStatus();
}

export function astStatus() { return { available: state.ready, dir: state.dir, grammars: [...state.parsers.keys()], error: state.error, tried: state.tried }; }
export function astReady(file) { const g = grammarOf(file); return !!(g && state.parsers.get(g)); }

// Test hook: forget loaded grammars.
export function resetAst() { state.ready = false; state.parsers = new Map(); state.Parser = null; state.dir = null; state.error = null; state.tried = false; cache.clear(); }

// A definition: name, parent (class / impl / receiver type), kind, [start, end) line indexes.
// Node types per grammar whose `name` field names a definition.
const DEFS = {
  python: { function_definition: 'function', class_definition: 'class' },
  javascript: { function_declaration: 'function', generator_function_declaration: 'function', class_declaration: 'class', method_definition: 'method', variable_declarator: 'const', public_field_definition: 'field', pair: 'property' },
  typescript: { function_declaration: 'function', generator_function_declaration: 'function', class_declaration: 'class', abstract_class_declaration: 'class', method_definition: 'method', method_signature: 'method', abstract_method_signature: 'method', variable_declarator: 'const', public_field_definition: 'field', interface_declaration: 'interface', type_alias_declaration: 'type', enum_declaration: 'enum', internal_module: 'namespace', pair: 'property' },
  go: { function_declaration: 'function', method_declaration: 'method', type_spec: 'type', const_spec: 'const', var_spec: 'var' },
  rust: { function_item: 'function', function_signature_item: 'function', struct_item: 'struct', enum_item: 'enum', trait_item: 'trait', type_item: 'type', const_item: 'const', static_item: 'static', mod_item: 'mod', macro_definition: 'macro', union_item: 'union', impl_item: 'impl' },
};
DEFS.tsx = DEFS.typescript;
const CONTAINERS = new Set(['class_definition', 'class_declaration', 'abstract_class_declaration', 'interface_declaration', 'impl_item', 'trait_item', 'mod_item', 'internal_module', 'enum_declaration']);
const VALUE_DEFS = new Set(['arrow_function', 'function', 'function_expression', 'generator_function', 'class', 'async_function']);

const cache = new Map(); // sha(text) -> definitions
const sha = s => crypto.createHash('sha256').update(s).digest('hex').slice(0, 24);

// The definitions of a file are kept on disk by the hash of its text (disk-cache.js): parsing each
// file the notes point at again in every process cost about 8 ms a file, half a second on a cache of
// 150 notes. The same text gives the same definitions in any checkout. DEFS_VERSION changes when
// what definitions() returns does.
const DEFS_VERSION = 2;
const disk = diskCache('ast', DEFS_VERSION);
const flag = v => (typeof v === 'function' ? undefined : !!v);
// A parse error in or beside a node: the grammars lag the languages (Go's new(expr), TypeScript's
// import('x').T in a type), and the parser recovers by cutting a definition short or folding its
// neighbours into it, without saying so. Such a definition is marked and not trusted (astFindSymbol).
function broken(node) {
  const has = n => n && (flag(n.hasError) ?? n.hasError()), err = n => n && (n.type === 'ERROR' || (flag(n.isMissing) ?? n.isMissing()));
  if (has(node) || err(node.nextSibling) || err(node.previousSibling)) return true;
  for (let p = node.parent; p; p = p.parent) if (p.type === 'ERROR') return true;
  return false;
}

function nameOf(node, grammar) {
  if (node.type === 'impl_item') { let t = node.childForFieldName('type'); while (t && t.type !== 'type_identifier') t = t.namedChildren.find(c => c.type === 'type_identifier' || c.type === 'generic_type') || null; return t?.text || null; }
  if (node.type === 'pair') { const v = node.childForFieldName('value'); if (!v || !VALUE_DEFS.has(v.type)) return null; return node.childForFieldName('key')?.text?.replace(/^['"]|['"]$/g, '') || null; }
  const n = node.childForFieldName('name');
  if (!n) return null;
  if (node.type === 'variable_declarator' && n.type !== 'identifier') return null; // destructuring
  return n.text || null;
}

// Go methods: the receiver's type names the parent.
function goReceiver(node) {
  const r = node.childForFieldName('receiver'); if (!r) return null;
  const stack = [r];
  while (stack.length) { const n = stack.pop(); if (n.type === 'type_identifier') return n.text; stack.push(...n.namedChildren); }
  return null;
}

// The node whose lines are the definition's: the declaration around a single name, the export around that.
function rangeNode(node) {
  // a declaration's lines include its `export`/`const` on the same line
  // one name of a group (Go's `const ( a = 1; b = 2 )`, `const a = 1, b = 2`) is its own lines, not the group's
  let n = node;
  if (n.type === 'variable_declarator' || n.type === 'type_spec' || n.type === 'const_spec' || n.type === 'var_spec') {
    let decl = n.parent;
    if (decl && /_spec_list$/.test(decl.type)) decl = decl.parent; // newer Go grammars wrap a group's specs in a list
    const alone = decl && n.parent === decl && decl.namedChildren.filter(c => c.type === n.type).length === 1;
    if (alone) n = decl;
  }
  if (n.parent?.type === 'export_statement') n = n.parent;
  return n;
}
function lineRange(node) {
  const n = rangeNode(node);
  const start = n.startPosition.row;
  const end = n.endPosition.column === 0 ? n.endPosition.row : n.endPosition.row + 1;
  return { start, end: Math.max(end, start + 1) };
}

// Every definition in the text, in source order.
export function definitions(text, file) {
  const g = grammarOf(file); const parser = g && state.parsers.get(g);
  if (!parser) return null;
  const key = g + ':' + sha(text);
  if (cache.has(key)) return cache.get(key);
  const stored = disk.get(key.replace(':', '-'));
  if (Array.isArray(stored)) { remember(key, stored); return stored; }
  let tree; try { tree = parser.parse(text); } catch { return null; }
  const defs = DEFS[g]; const out = [];
  const stack = [{ node: tree.rootNode, parent: null }];
  while (stack.length) {
    const { node, parent } = stack.pop();
    let here = parent;
    if (defs[node.type]) {
      const name = nameOf(node, g);
      if (name) {
        const { start, end } = lineRange(node);
        const d = { name, kind: defs[node.type], start, end, parent: node.type === 'method_declaration' ? goReceiver(node) : parent };
        if (g === 'python' && node.parent?.type === 'decorated_definition' && node.parent.namedChildren.some(c => c.type === 'decorator' && /\boverload\b/.test(c.text))) d.overload = true;
        if (broken(rangeNode(node))) d.broken = true;
        out.push(d);
        if (CONTAINERS.has(node.type)) here = name;
      }
    }
    const kids = node.namedChildren;
    for (let i = kids.length - 1; i >= 0; i--) stack.push({ node: kids[i], parent: here });
  }
  tree.delete?.();
  out.sort((a, b) => a.start - b.start);
  remember(key, out);
  disk.set(key.replace(':', '-'), out);
  return out;
}
function remember(key, defs) {
  if (cache.size > 300) cache.delete(cache.keys().next().value);
  cache.set(key, defs);
}

// Decorators and comments directly above a definition belong to it (as deps.js:findSymbol has it).
export function extendUp(lines, start) {
  let s = start;
  while (s > 0 && /^\s*(@|#\[|\/\/|\/\*|\*)/.test(lines[s - 1])) s--;
  return s;
}

// {start, end} of the symbol's definition (end exclusive), or null. `Class.method` needs the class
// in this file and the method inside it; a bare name takes the first definition.
export function astFindSymbol(text, symbol, file) {
  const defs = definitions(text, file);
  if (!defs) return null;
  const parts = symbol.split('.'); const name = parts[parts.length - 1];
  let cands = defs.filter(d => d.name === name);
  if (parts.length > 1) {
    const parent = parts[parts.length - 2];
    const containers = defs.filter(d => d.name === parent);
    if (!containers.length) return null;
    const inside = cands.filter(d => d.parent === parent);
    cands = inside.length ? inside : cands.filter(d => containers.some(c => d.start > c.start && d.end <= c.end));
  }
  const impl = cands.filter(d => !d.overload);
  if (impl.length) cands = impl;
  if (!cands.length) return null;
  const d = cands[0];
  if (d.broken) return null; // a parse error in or beside it: its lines are not to be trusted, and the caller's regex takes over
  return { start: extendUp(text.split('\n'), d.start), end: d.end };
}
