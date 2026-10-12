import path from 'node:path';
import readline from 'node:readline/promises';
import { PROJECT_FILE, projectFromFlags, writeProject } from '../project.js';
import { activityAreas, saveAreas } from '../areas.js';
import { selectMenu } from './ui.js';

// What a build reads: by default the user's focus areas, the directories their own commits touch
// (areas.js), so the cache is warm where they work; or the whole repository (the generic build);
// or directories they name. The choice is kept in .thinker/config.json as `areas`, which
// maintenance reads to keep warming the same places. --directories, --full-repo and --project
// answer without asking; so does --yes, which takes the areas when there are any.
export async function chooseProject({ repo, store = null, flags = {}, out = console.log, interactive = !!process.stdin.isTTY,
  selectFn = selectMenu, readlineFn = () => readline.createInterface({ input: process.stdin, output: process.stdout }), areasFn = activityAreas }) {
  let project = projectFromFlags(repo, flags, { save: true });
  const explicit = flags.project || flags.directories || flags['full-repo'];
  const found = explicit ? null : areasFn(repo);
  const areas = found?.directories?.length ? found.directories : null;
  let source = explicit ? (project ? 'manual' : 'all') : null;
  if (!explicit && (!interactive || flags.yes)) {
    if (areas) { project = { version: 1, name: path.basename(repo), directories: areas }; source = 'activity'; }
    else source = project ? 'manual' : 'all';
  } else if (!explicit) {
    const items = [];
    if (areas) items.push({ label: `Your areas: ${areas.join(', ')} (from your ${found.source === 'prs' ? 'merged pull requests' : 'commits'})`, value: 'areas' });
    items.push({ label: areas ? 'Whole repository (generic build)' : 'Full repo', value: 'full' }, { label: 'Specify project directories', value: 'project' });
    const choice = await selectFn({ header: '  What should Thinker build a cache for?', items, defaultIndex: areas ? 0 : (project && !project.directories.includes('.') ? 1 : 0), out });
    if (!choice) throw new Error('Project selection cancelled; no cache build started.');
    if (choice.value === 'areas') { project = { version: 1, name: path.basename(repo), directories: areas }; source = 'activity'; }
    else if (choice.value === 'full') {
      // Persist a changed preference, so the next build does not silently reuse the old scope.
      if (project) writeProject(repo, { ...project, directories: ['.'] }, PROJECT_FILE, { overwrite: true });
      project = null; source = 'all';
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
      source = 'manual';
    }
  }
  if (store) saveAreas(store, { directories: project?.directories?.filter(d => d !== '.') || [], source: source || (project ? 'manual' : 'all') });
  out(project ? `  Cache build: ${source === 'activity' ? 'your areas' : project.name} (${project.directories.join(', ')})${source === 'activity' ? '; --full-repo for the whole repository' : ''}` : '  Cache build: Full repo');
  return project;
}
