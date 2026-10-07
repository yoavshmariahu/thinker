"""Live product wiring for the `thinker` arm: hooks and the MCP server, as the product writes them.

The arm must receive thinker the way a real session does, not a transcription of it, so the wiring
is written by `installClient` through wire.mjs and only validated here. The agent CLIs are launched
with their own settings sources disabled, so each run carries its own config: Claude Code reads it
from --settings/--mcp-config, Codex from the run's CODEX_HOME plus the checkout's trusted hooks.
"""
import json
import os
from pathlib import Path
import subprocess

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
MCP_TOOLS = ['mcp__thinker__orient', 'mcp__thinker__lookup', 'mcp__thinker__find',
             'mcp__thinker__drilldown', 'mcp__thinker__remember', 'mcp__thinker__feedback']


class WiringError(RuntimeError):
    pass


def wire(client, checkout, receipt, env):
    """Write the arm's wiring through the product and return the receipt it records."""
    checkout, receipt = Path(checkout).resolve(), Path(receipt)
    if receipt.exists():
        return validate(client, checkout, receipt)
    result = subprocess.run(['node', str(HERE / 'wire.mjs'), client, str(checkout), str(receipt)],
                            cwd=ROOT, env={**env, 'THINKER_TEST': '1'}, capture_output=True, text=True)
    if result.returncode != 0 or not receipt.exists():
        raise WiringError(f'wiring failed for {client}: {result.stderr.strip()[:400]}')
    return validate(client, checkout, receipt)


def validate(client, checkout, receipt):
    """Fail closed unless the wiring runs this frozen copy against this checkout's cache."""
    r = json.loads(Path(receipt).read_text())
    checkout = Path(checkout).resolve()
    if r.get('client') != client or Path(r.get('repo', '')).resolve() != checkout:
        raise WiringError('Receipt names another client or checkout')
    if r.get('cli') != str(ROOT / 'src/cli.js') or r['mcpEntry']['args'] != [str(ROOT / 'src/mcp.js')]:
        raise WiringError('Wiring does not run the frozen copy of thinker')
    if r['mcpEntry'].get('env', {}).get('THINKER_REPO') != str(checkout):
        raise WiringError('MCP entry is not pinned to this checkout')
    # The guidance is composed by the frozen source, so the arm cannot receive edited text.
    expected = subprocess.run(['node', '-e', (
        "import('./src/cache-guidance.js').then(m=>process.stdout.write("
        "m.cacheInstructions({repo:process.argv[1]})))")
        , str(checkout)], cwd=ROOT, capture_output=True, text=True,
        env={**os.environ, 'THINKER_TEST': '1'})
    if expected.returncode != 0 or expected.stdout != r.get('instructions'):
        raise WiringError('Recorded instructions differ from the frozen cache-guidance output')
    if not r.get('instructions', '').strip() or len(r['instructions']) > 2048:
        raise WiringError('Instructions missing or above the host cap')
    required = {'claude': ['repo.local', 'repo.mcp'], 'codex': ['repo.hooks', 'user.toml']}[client]
    for key in required:
        entry = r.get('written', {}).get(key)
        if not entry or not Path(entry['path']).exists():
            raise WiringError(f'Wiring file {key} missing')
    hooks = hook_commands(r)
    if not any(' hook prompt' in c for c in hooks):
        raise WiringError('No prompt hook in the wiring')
    if any(' --user' in c for c in hooks):
        raise WiringError('Hooks must be repo-scope: test mode silences user-scope hooks')
    return r


def hook_commands(receipt):
    """Every hook command the written wiring holds, for either client's file shape."""
    found = []
    for key in ['repo.local', 'repo.hooks']:
        entry = receipt.get('written', {}).get(key)
        if not entry:
            continue
        config = json.loads(Path(entry['path']).read_text())
        for groups in (config.get('hooks') or {}).values():
            for group in groups if isinstance(groups, list) else []:
                found += [h.get('command', '') for h in group.get('hooks', [])]
    return found


def agent_argv(client, checkout, receipt):
    """CLI flags that make each host read this run's wiring, and nothing of the machine's."""
    written = receipt['written']
    if client == 'claude':
        return ['--settings', written['repo.local']['path'],
                '--mcp-config', written['repo.mcp']['path'], '--strict-mcp-config']
    # Codex reads MCP servers and hook trust from CODEX_HOME, which is this run's own directory.
    return []


def tools_for(client, arm, base):
    """The thinker arm may call the cache's tools; the baseline is offered none."""
    return base + (MCP_TOOLS if arm == 'thinker' and client == 'claude' else [])
