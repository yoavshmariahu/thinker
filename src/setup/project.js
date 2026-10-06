import path from 'node:path';
import readline from 'node:readline/promises';
import { PROJECT_FILE, projectFromFlags, writeProject } from '../project.js';
import { selectMenu } from './ui.js';

export async function chooseProject({ repo, flags = {}, out = console.log, interactive = !!process.stdin.isTTY,
  selectFn = selectMenu, readlineFn = () => readline.createInterface({ input: process.stdin, output: process.stdout }) }) {
  let project = projectFromFlags(repo, flags, { save: true });
  const explicit = flags.project || flags.directories || flags['full-repo'];
  if (interactive && !flags.yes && !explicit) {
    const choice = await selectFn({ header: '  What should Thinker build a cache for?', items: [
      { label: 'Full repo', value: 'full' },
      { label: 'Specify project directories', value: 'project' },
    ], defaultIndex: project && !project.directories.includes('.') ? 1 : 0, out });
    if (!choice) throw new Error('Project selection cancelled; no cache build started.');
    if (choice.value === 'full') {
      // Persist a changed preference, so the next build does not silently reuse the old scope.
      if (project) writeProject(repo, { ...project, directories: ['.'] }, PROJECT_FILE, { overwrite: true });
      project = null;
    } else {
      out('  Enter directories relative to the repository root, separated by commas.');
      out('  Example: apps/web, packages/ui. Retrieval remains available across the repo.');
      const rl = readlineFn();
      try {
        while (true) {
          const name = (await rl.question(`  Project name [${project?.name || path.basename(repo)}]: `)).trim() || project?.name || path.basename(repo);
          const answer = await rl.question(`  Directories${project ? ` [${project.directories.join(', ')}]` : ''}: `);
          try {
            project = writeProject(repo, { version: 1, name, directories: answer.trim() ? answer.split(',') : project?.directories || [] }, PROJECT_FILE, { overwrite: true });
            out(`  Saved ${PROJECT_FILE}.`);
            break;
          } catch (e) { out(`  ${e.message}`); }
        }
      } finally { rl.close(); }
    }
  }
  out(project ? `  Cache build: ${project.name} (${project.directories.join(', ')})` : '  Cache build: Full repo');
  return project;
}
