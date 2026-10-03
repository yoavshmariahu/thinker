// Bearer tokens. The admin token comes from the environment (THINKER_SERVER_ADMIN_TOKEN) and can do
// everything; the tokens it mints are kept hashed in <data>/tokens.json, each with the repositories
// it may touch ('*' for all) and its scopes: read (pull notes), write (push notes, stream sessions,
// send pull requests), admin (repositories and tokens).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const SCOPES = ['read', 'write', 'admin'];
const hash = t => crypto.createHash('sha256').update(String(t)).digest('hex');
const safeEqual = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

export class Tokens {
  constructor(root, { adminToken = process.env.THINKER_SERVER_ADMIN_TOKEN } = {}) {
    this.file = path.join(root, 'tokens.json');
    this.adminHash = adminToken ? hash(adminToken) : null;
  }
  #read() { try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { return { tokens: [] }; } }
  #write(data) { fs.mkdirSync(path.dirname(this.file), { recursive: true }); const tmp = `${this.file}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 }); fs.renameSync(tmp, this.file); }

  create({ name, repos = ['*'], scopes = ['read', 'write'] }) {
    if (!/^[\w.@-]{1,64}$/.test(String(name || ''))) throw new Error('token name: letters, digits, . _ @ -');
    if (!Array.isArray(scopes) || !scopes.length || scopes.some(s => !SCOPES.includes(s))) throw new Error(`scopes: ${SCOPES.join(', ')}`);
    if (!Array.isArray(repos) || !repos.length) throw new Error('repos: a list of repository ids, or ["*"]');
    const data = this.#read();
    if (data.tokens.some(t => t.name === name)) throw new Error(`a token named ${name} exists; revoke it first`);
    const token = 'tk_' + crypto.randomBytes(24).toString('hex');
    data.tokens.push({ name, hash: hash(token), repos: repos.map(r => String(r).toLowerCase()), scopes, created: new Date().toISOString() });
    this.#write(data);
    return { name, token, repos, scopes };
  }
  revoke(name) {
    const data = this.#read();
    const n = data.tokens.length;
    data.tokens = data.tokens.filter(t => t.name !== name);
    this.#write(data);
    return data.tokens.length < n;
  }
  list() { return this.#read().tokens.map(({ hash: _, ...t }) => t); }

  // Who presents this token; null for none or an unknown one.
  identify(token) {
    if (!token) return null;
    const h = hash(token);
    if (this.adminHash && safeEqual(h, this.adminHash)) return { name: 'admin', repos: ['*'], scopes: [...SCOPES], admin: true };
    const t = this.#read().tokens.find(t => safeEqual(t.hash, h));
    if (!t) return null;
    if (!t.lastUsed || Date.now() - Date.parse(t.lastUsed) > 3600_000) { try { const data = this.#read(); const row = data.tokens.find(r => r.hash === h); if (row) { row.lastUsed = new Date().toISOString(); this.#write(data); } } catch {} }
    return { name: t.name, repos: t.repos, scopes: t.scopes, admin: t.scopes.includes('admin') };
  }
}

export function allows(who, scope, repoId) {
  if (!who) return false;
  if (who.admin) return true;
  if (!who.scopes.includes(scope)) return false;
  if (repoId === undefined) return true;
  return who.repos.includes('*') || who.repos.includes(String(repoId).toLowerCase());
}

export function bearer(req) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer\s+(\S+)$/i);
  return m ? m[1] : null;
}
