import path from 'node:path';
import { PROJECT_FILE, readProject, writeProject } from '../project.js';

async function projectCommand({ repo, pos, flags, out }) {
  if (flags.project !== undefined && typeof flags.project !== 'string') throw new Error('--project needs a file path.');
  const file = flags.project || PROJECT_FILE;
  if (pos[0] === 'init') {
    const directories = pos.slice(1);
    if (!directories.length) throw new Error('Usage: thinker project init <directory> [directory…] [--name name]');
    const project = writeProject(repo, { version: 1, name: flags.name || path.basename(repo), directories }, file);
    out(`Saved ${file}: ${project.name} (${project.directories.join(', ')}).\nBuild: thinker setup --build --project ${file}`);
    return;
  }
  if (pos.length && pos[0] !== 'show') throw new Error('Usage: thinker project [show | init <directory> [directory…]]');
  const project = readProject(repo, file, { optional: !flags.project });
  out(project ? JSON.stringify(project, null, 2) : 'Full repo (no thinker.project.json). Use thinker setup to choose project directories.');
}

export const commands = { project: projectCommand };
