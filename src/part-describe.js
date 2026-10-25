// What a part of the context is, in a label and one line, for the rows of Recent activity and `thinker context
// --history` (2026-10-24, the owner's ask): a built-in tool is told apart from a custom one (a skill, an MCP server, a
// plugin), and the thing changed gets a line saying what it does ("Grep output": text search over files). The line comes
// from a table for Claude Code's own tools and the common shell commands, whose definitions change and whose names say
// little; for everything else from the first sentence of the part's own text (a tool's definition, a skill's description, a
// section's first line).
const TOOL_ABOUT = {
  Read: 'reads a file', Edit: 'edits a file in place', MultiEdit: 'several edits to one file', Write: 'writes a file', Bash: 'runs a shell command',
  BashOutput: 'the output of a background shell', KillShell: 'stops a background shell', Grep: 'text search over files', Glob: 'finds files by name pattern', LS: 'lists a directory',
  Task: 'starts a subagent', Agent: 'starts a subagent', WebFetch: 'fetches a web page', WebSearch: 'searches the web', TodoWrite: "the agent's task list",
  NotebookEdit: 'edits a Jupyter notebook', Skill: 'invokes a skill', AskUserQuestion: 'asks the person a question', ToolSearch: "loads a deferred tool's definition",
  Workflow: 'orchestrates subagents by a script', ScheduleWakeup: 'self-paced wakeups for a loop', ReportFindings: 'reports code-review findings', Artifact: 'drafts a document or page',
  SendFeedback: 'drafts feedback about Claude Code', EnterPlanMode: 'enters plan mode', ExitPlanMode: 'leaves plan mode with the plan', EnterWorktree: 'a git worktree for the session', ExitWorktree: 'leaves the session worktree',
  Monitor: "watches a command's output", CronCreate: 'schedules a recurring prompt', CronDelete: 'removes a scheduled prompt', CronList: 'lists the scheduled prompts',
  SendMessage: 'messages another agent', ListAgents: 'lists the agents to message', TaskStop: 'stops a background task', PushNotification: 'sends a notification',
  RemoteTrigger: 'starts a remote session', EndConversation: 'ends the conversation', LSP: 'language server queries over the code', TaskOutput: "a background task's output",
};
const COMMAND_ABOUT = {
  grep: 'text search over files', rg: 'text search over files', ag: 'text search over files', sed: 'edits or prints lines of a file', awk: 'text processing by field', cat: 'prints a file', head: 'the first lines of a file', tail: 'the last lines of a file',
  ls: 'lists a directory', find: 'finds files', tree: 'a directory as a tree', wc: 'counts lines and words', sort: 'sorts lines', uniq: 'drops repeated lines', cut: 'cuts fields from lines', tr: 'replaces characters', xargs: 'runs a command over its input', diff: 'compares files',
  echo: 'prints text', printf: 'prints text', mkdir: 'makes a directory', rm: 'removes files', cp: 'copies files', mv: 'moves files', touch: 'creates an empty file', chmod: 'changes file permissions', ln: 'links files', cd: 'changes directory', pwd: 'the current directory', tee: 'writes output to a file as well',
  git: 'version control', gh: 'GitHub from the command line', npm: 'package manager and scripts', npx: 'runs a package', pnpm: 'package manager and scripts', yarn: 'package manager and scripts', node: 'runs JavaScript', tsc: 'the TypeScript compiler', eslint: 'lints the code', prettier: 'formats the code',
  python: 'runs Python', python3: 'runs Python', pip: 'Python packages', pip3: 'Python packages', uv: 'Python packages and runs', pytest: 'runs the Python tests', ruff: 'lints Python', black: 'formats Python', mypy: 'type-checks Python', poetry: 'Python packages',
  jest: 'runs the JavaScript tests', vitest: 'runs the JavaScript tests', mocha: 'runs the JavaScript tests', go: 'builds, tests and runs Go', cargo: 'builds, tests and runs Rust', rustc: 'the Rust compiler', make: 'runs the build', cmake: 'configures the build', gradle: 'builds Java', mvn: 'builds Java', dotnet: '.NET build and test', ruby: 'runs Ruby', bundle: 'Ruby gems', rake: 'Ruby tasks', java: 'runs Java', javac: 'the Java compiler', swift: 'builds and runs Swift', xcodebuild: 'builds an Xcode project',
  docker: 'containers', 'docker-compose': 'containers together', kubectl: 'Kubernetes', terraform: 'infrastructure as code', aws: 'the AWS command line', gcloud: 'the Google Cloud command line', az: 'the Azure command line', ssh: 'a shell on another machine', scp: 'copies files to another machine', rsync: 'syncs files',
  curl: 'HTTP requests', wget: 'downloads a URL', jq: 'JSON processing', yq: 'YAML processing', ps: 'the running processes', kill: 'stops a process', pkill: 'stops processes by name', lsof: 'open files and ports', top: 'the running processes', du: 'disk use of files', df: 'free disk space', env: 'the environment variables', printenv: 'the environment variables', export: 'sets an environment variable', which: 'where a command is', type: 'what a command is',
  tar: 'archives', zip: 'archives', unzip: 'extracts an archive', gzip: 'compresses a file', open: 'opens a file or URL', sleep: 'waits', date: 'the date and time', time: 'times a command', true: 'does nothing', test: 'tests a condition', brew: 'Homebrew packages', apt: 'Debian packages', 'apt-get': 'Debian packages', sqlite3: 'a SQLite database', psql: 'a Postgres database', redis_cli: 'a Redis server', 'redis-cli': 'a Redis server', mysql: 'a MySQL database', thinker: 'the thinker command', claude: 'Claude Code', codex: 'the Codex CLI', cursor: 'Cursor', agent: 'the Cursor agent CLI', gemini: 'the Gemini CLI',
};
// a shell command's name: the first word of its line, less a path, an env prefix, sudo or time
const commandName = s => { const ws = String(s || '').trim().split(/\s+/).filter(w => !/^[A-Z_][A-Z0-9_]*=/.test(w) && !['sudo', 'time', 'nohup', 'command'].includes(w)); return (ws[0] || '').replace(/^.*\//, ''); };
// the first sentence of a text, skipping a heading, a list dash, a markdown front matter, and HTML or code marks; at most 120 characters
const firstSentence = (text, max = 120) => {
  let t = String(text || '').replace(/^---\n[\s\S]*?\n---\n?/, '').replace(/^\s*#+ .*\n+/, '').trim();
  t = t.replace(/^- /, '').replace(/<[^>]*>/g, '').replace(/[`*_\r]+/g, '').replace(/\n+/g, ' ');
  const s = t.split(/(?<=\.)\s/)[0].trim();
  return s.length > max ? `${s.slice(0, max - 1).replace(/\s+\S*$/, '')}…` : s;
};
// a skill's `description:` from its SKILL.md front matter, if the text holds one
const skillDescription = text => { const m = String(text || '').match(/^---\n[\s\S]*?^description:\s*(["']?)([^\n]*?)\1\s*$[\s\S]*?\n---/m); return m ? m[2].trim() : ''; };

const CUSTOM = { mcp: 'Custom tool · MCP server', connector: 'Custom tool · connector', plugin: 'Custom tool · plugin', desktop: 'Desktop app tool' };
// What a change's part is (`what`) and does (`about`), from the change as context-suggest.js:partChanges makes it, or from a
// history entry written before these were kept (kind and key alone, `fromEntry`): `toolKind` is the harness source's kind
// (tool for a built-in, mcp, plugin, connector, desktop), `name` the tool's or output's name, `text` the part's own text.
export function describePart({ kind, key = '', name = '', builtin = false, toolKind = null, text = '' } = {}) {
  if (kind === 'section') return { what: 'Instruction section', about: firstSentence(text) };
  if (kind === 'setting') return { what: 'Claude Code setting', about: 'the context size at which Claude Code compacts the conversation into a summary' };
  if (kind === 'skill') return { what: 'Custom tool · skill', about: skillDescription(text) || firstSentence(text) };
  if (kind === 'tool') {
    const tk = toolKind || (builtin || /:(builtin|tool):/.test(`:${key}`) ? 'tool' : /:mcp:/.test(`:${key}`) ? 'mcp' : /:plugin:/.test(`:${key}`) ? 'plugin' : /:desktop:/.test(`:${key}`) ? 'desktop' : null);
    const n = name || key.replace(/^.*:/, '');
    return tk === 'tool' || builtin ? { what: 'Built-in tool', about: TOOL_ABOUT[n] || firstSentence(text) } : { what: CUSTOM[tk] || 'Custom tool', about: firstSentence(text) };
  }
  if (kind === 'output') {
    const n = name || key.replace(/^output:/, '').replace(/@.*$/, '');
    if (n.startsWith('Bash:')) { const c = commandName(n.slice(5)); return { what: 'Shell command output', about: COMMAND_ABOUT[c] || (text ? firstSentence(text) : '') }; }
    if (n.startsWith('mcp:')) return { what: 'Custom tool output · MCP server', about: firstSentence(text) };
    return { what: 'Built-in tool output', about: TOOL_ABOUT[n] || firstSentence(text) };
  }
  return { what: '', about: '' };
}
// the same for a history entry (context-suggest.js:changeHistory): an entry written before `what` and `about` were kept
export const describeEntry = e => e.what ? { what: e.what, about: e.about || '' } : describePart({ kind: e.kind, key: e.key, name: e.name || '' });

// What a part is, for telemetry: the group it belongs to, and its name only where the name is the agent's own
// (a built-in tool of Claude Code, a shell command), never a section title, file name, skill name or MCP server
// name. The one gate every name passes through before it leaves the machine (telemetry.js:spendMetrics); the
// tables above are the allow list, so a tool nobody here has heard of is counted without its name.
export function partIdentity({ kind, key = '', name = '', what = '' } = {}) {
  if (kind === 'section') return { group: 'section', name: null };
  if (kind === 'skill') return { group: 'skill', name: null };
  if (kind === 'tool') {
    const n = name || key.replace(/^.*:/, '');
    const group = what === 'Built-in tool' || /:(builtin|tool):/.test(`:${key}`) ? 'builtin-tool'
      : /:mcp:/.test(`:${key}`) || what.endsWith('MCP server') ? 'mcp-server'
        : /:plugin:/.test(`:${key}`) || what.endsWith('plugin') ? 'plugin'
          : /:desktop:/.test(`:${key}`) || what === CUSTOM.desktop ? 'desktop-tool' : 'other-tool';
    return { group, name: group === 'builtin-tool' && TOOL_ABOUT[n] ? n : null };
  }
  if (kind === 'output') {
    const n = name || key.replace(/^output:/, '').replace(/@.*$/, '');
    if (n.startsWith('Bash:')) { const c = commandName(n.slice(5)); return { group: 'shell-output', name: COMMAND_ABOUT[c] ? `Bash:${c}` : null }; }
    if (n.startsWith('mcp:')) return { group: 'mcp-output', name: null };
    return { group: 'builtin-output', name: TOOL_ABOUT[n] ? n : null };
  }
  return { group: 'other', name: null };
}
// A tool's name as the compression records it (diet.js logs `tool`), under the same gate: a built-in tool or a
// known shell command by name, anything else counted without one.
export const publicToolName = tool => {
  const n = String(tool || '');
  if (n.startsWith('Bash:')) { const c = commandName(n.slice(5)); return COMMAND_ABOUT[c] ? `Bash:${c}` : null; }
  return TOOL_ABOUT[n] ? n : null;
};
