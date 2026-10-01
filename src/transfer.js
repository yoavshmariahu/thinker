// Portable archives contain whole notes from both tiers. Import never writes shared files.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { gitHead } from './store.js';
import { tarPackArgs, tarListArgs, tarExtractArgs } from './update.js';

const META = ['cochange.json', 'prs.json', 'config.json'];
const tar = args => execFileSync('tar', args, { encoding: 'utf8', env: { ...process.env, COPYFILE_DISABLE: '1', COPY_EXTENDED_ATTRIBUTES_DISABLE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
export function exportCache(store, file) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-export-'));
  try {
    fs.mkdirSync(path.join(temp, 'notes'));
    const notes = store.list();
    for (const note of notes) fs.writeFileSync(path.join(temp, 'notes', `${note.id}.json`), JSON.stringify(note, null, 2) + '\n');
    const items = ['notes'];
    for (const name of META) if (fs.existsSync(path.join(store.dir, name))) { fs.copyFileSync(path.join(store.dir, name), path.join(temp, name)); items.push(name); }
    fs.writeFileSync(path.join(temp, 'cache-manifest.json'), JSON.stringify({ repo: path.basename(store.repo), commit: gitHead(store.repo), notes: notes.length, exportedAt: new Date().toISOString() }));
    tar([...tarPackArgs(), path.resolve(file), '-C', temp, ...items, 'cache-manifest.json']);
    return { notes: notes.length };
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
export function importCache(store, source) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-import-'));
  try {
    let file = path.resolve(source);
    if (/^https?:\/\//.test(source)) {
      file = path.join(temp, 'download.tgz');
      execFileSync('curl', ['-fsSL', '-o', file, source], { stdio: ['ignore', 'pipe', 'pipe'] });
    }
    const names = tar([...tarListArgs(), file]).split('\n').filter(Boolean);
    if (names.some(n => n.startsWith('/') || n.split('/').includes('..') || !/^(?:\.\/)?(?:notes\/?|notes\/[a-z0-9][a-z0-9-]*\.json|cochange\.json|prs\.json|config\.json|cache-manifest\.json)$/.test(n))) throw new Error('refusing to unpack: archive contains unsafe paths');
    // Reject symlinks, hardlinks and special files before extraction, including link chains.
    if (tar(['-tvzf', file]).split('\n').filter(Boolean).some(line => !/^[-d]/.test(line))) throw new Error('refusing to unpack: archive contains links or special files');
    const unpack = path.join(temp, 'unpack'); fs.mkdirSync(unpack);
    tar([...tarExtractArgs(), file, '-C', unpack]);
    const noteDir = path.join(unpack, 'notes');
    const notes = fs.existsSync(noteDir) ? fs.readdirSync(noteDir).map(f => JSON.parse(fs.readFileSync(path.join(noteDir, f), 'utf8'))) : [];
    if (notes.some(n => !n || typeof n.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(n.id))) throw new Error('invalid note id in archive');
    store.init();
    for (const note of notes) store.put(note);
    // Keep the receiving checkout's configuration and existing mining history.
    for (const name of META) if (!fs.existsSync(path.join(store.dir, name)) && fs.existsSync(path.join(unpack, name))) fs.copyFileSync(path.join(unpack, name), path.join(store.dir, name));
    return { notes: notes.length };
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
