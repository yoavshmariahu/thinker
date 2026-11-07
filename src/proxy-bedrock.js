// Explicit token-authenticated Bedrock Messages routing. No AWS signing or CLI login.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export const BEDROCK_PATH = '/bedrock';
const file = home => path.join(home, 'state', 'proxy-bedrock.json');
export function bedrockState(home) {
  try { return JSON.parse(fs.readFileSync(file(home), 'utf8')); } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw Error('Cannot read Bedrock proxy configuration; restore it or run thinker proxy off.');
  }
}
function save(home, value) {
  fs.mkdirSync(path.dirname(file(home)), { recursive: true });
  fs.writeFileSync(file(home), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(file(home), 0o600);
}
export function bedrockToken(tokenFile) {
  let token;
  try {
    const st = fs.statSync(tokenFile);
    if (!st.isFile() || st.size > 65536 || (process.platform !== 'win32' && (st.mode & 0o077))) throw Error();
    token = fs.readFileSync(tokenFile, 'utf8').trim();
  } catch { throw Error('Bedrock token file must be readable, private (chmod 600), and at most 64 KiB.'); }
  if (!token || /[^\x21-\x7e]/.test(token)) throw Error('Bedrock token file must contain one non-empty ASCII token.');
  return token;
}
export function bedrockOptions({ region, model, tokenFile }) {
  if (typeof region !== 'string' || !/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(region)) throw Error('--bedrock requires --region with an AWS region.');
  if (typeof model !== 'string' || !model.trim() || /\s/.test(model) || !model.includes('anthropic.')) throw Error('--bedrock requires --model with an explicit Bedrock Anthropic model or inference profile ID.');
  if (typeof tokenFile !== 'string' || !tokenFile) throw Error('--bedrock requires --token-file pointing to a private Bedrock API-key or bearer-token file.');
  tokenFile = path.resolve(tokenFile);
  bedrockToken(tokenFile);
  return { region, model, tokenFile, upstream: `https://bedrock-runtime.${region}.${region.startsWith('cn-') ? 'amazonaws.com.cn' : 'amazonaws.com'}/anthropic` };
}
const settingsFile = env => path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json');
export function prepareBedrock(home, options, env = process.env) {
  const config = bedrockOptions(options);
  const previous = bedrockState(home);
  const settings = settingsFile(env);
  let cur = {};
  try { cur = JSON.parse(fs.readFileSync(settings, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw Error('Claude settings must be valid JSON before enabling Bedrock.'); }
  if (!cur || typeof cur !== 'object' || Array.isArray(cur) || (cur.env && (typeof cur.env !== 'object' || Array.isArray(cur.env)))) throw Error('Claude settings must contain an env object.');
  if (previous && previous.settings !== settings) throw Error('Turn the Bedrock proxy off before changing CLAUDE_CONFIG_DIR.');
  const localToken = previous?.localToken || crypto.randomBytes(32).toString('hex');
  // Pin every alias, including background calls: Anthropic's direct model names are not Bedrock IDs.
  const managed = { CLAUDE_CODE_USE_BEDROCK: '0', ANTHROPIC_AUTH_TOKEN: localToken,
    ANTHROPIC_API_KEY: '', ANTHROPIC_MODEL: config.model, ANTHROPIC_SMALL_FAST_MODEL: config.model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: config.model, ANTHROPIC_DEFAULT_SONNET_MODEL: config.model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: config.model, CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1' };
  const before = previous?.before || Object.fromEntries([...Object.keys(managed), 'ANTHROPIC_BASE_URL'].map(k => [k, cur.env?.[k] ?? null]));
  return { ...config, settings, localToken, before, managed };
}
export function commitBedrock(home, state) { save(home, state); }
export function wireBedrock(home, url) {
  const state = bedrockState(home);
  if (!state) return null;
  let cur = {};
  try { cur = JSON.parse(fs.readFileSync(state.settings, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (state.managed.ANTHROPIC_BASE_URL === url + BEDROCK_PATH && cur.env?.ANTHROPIC_BASE_URL === url + BEDROCK_PATH) return { file: state.settings, unchanged: true };
  const next = { ...cur, env: { ...cur.env, ...state.managed, ANTHROPIC_BASE_URL: url + BEDROCK_PATH } };
  save(home, { ...state, managed: { ...state.managed, ANTHROPIC_BASE_URL: url + BEDROCK_PATH } });
  fs.mkdirSync(path.dirname(state.settings), { recursive: true });
  fs.writeFileSync(state.settings, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(state.settings, 0o600);
  return { file: state.settings, changed: true };
}
export function restoreBedrock(home) {
  const state = bedrockState(home);
  if (!state) return null;
  let cur;
  try { cur = JSON.parse(fs.readFileSync(state.settings, 'utf8')); } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    fs.unlinkSync(file(home));
    return { file: state.settings, unchanged: true };
  }
  const env = { ...cur.env };
  for (const [key, value] of Object.entries(state.managed)) {
    if (env[key] !== value) continue; // a later edit belongs to the person
    if (state.before[key] === null) delete env[key]; else env[key] = state.before[key];
  }
  const next = { ...cur, env };
  if (!Object.keys(env).length) delete next.env;
  fs.writeFileSync(state.settings, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  fs.unlinkSync(file(home));
  return { file: state.settings, changed: true };
}

// Called before the shared transform. Incoming credentials never reach AWS; the AWS token never reaches
// Claude settings, service arguments, dumps or logs. A missing/rotated token cannot fall back to Anthropic.
export function bedrockRequest(req, state) {
  if (!state) throw Object.assign(Error('Bedrock route is not enabled.'), { status: 404 });
  if (req.headers.authorization !== `Bearer ${state.localToken}`) throw Object.assign(Error('Invalid local Bedrock proxy credential.'), { status: 401 });
  const url = req.url.slice(BEDROCK_PATH.length);
  if (req.method !== 'POST' || !/^\/v1\/messages(?:\/count_tokens)?(?:\?|$)/.test(url)) throw Object.assign(Error('Unsupported Bedrock Messages route.'), { status: 404 });
  const token = bedrockToken(state.tokenFile);
  const headers = { ...req.headers, 'x-api-key': token };
  for (const key of ['authorization', 'x-amz-date', 'x-amz-security-token', 'x-amz-content-sha256', 'anthropic-beta']) delete headers[key];
  return { url, headers, upstream: state.upstream };
}

// Claude Code sends JSON encoded inside metadata.user_id. Bedrock maps it to request metadata,
// whose values forbid quotes/braces (and are limited to 256 characters). Keep valid identifiers;
// hash incompatible ones deterministically so attribution survives without changing model content.
// https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Converse.html#BedrockRuntime-Converse-request-requestMetadata
export function bedrockBody(raw) {
  let body;
  try { body = JSON.parse(raw); } catch { return raw; }
  const id = body?.metadata?.user_id;
  if (typeof id !== 'string' || /^[a-zA-Z0-9\s:_@$#=/+,.-]{0,256}$/.test(id)) return raw;
  body.metadata.user_id = 'thinker_' + crypto.createHash('sha256').update(id).digest('hex');
  return Buffer.from(JSON.stringify(body));
}
