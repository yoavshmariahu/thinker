# Plugins

One plugin per host, each a pointer to the thinker installed on this machine (`~/.thinker/app`): the
plugin's hooks run the installed copy's `thinker hook`, so the notes, the learning and the updates are the
installed copy's. Nothing of thinker runs from a plugin. The hooks are for the cache and nothing else: on a
machine without thinker they do nothing. Installing is the plugin's command, run by the person:
`/thinker:install` in Claude Code (`commands/install.md`), the `thinker-install` skill in Codex, the
`install` command in Cursor. Each runs `npx -y @zerotimedev/thinker --clients <host> --no-modify-path --no-ui
--yes`: that host alone is wired, no other agent is touched, no shell file is edited. The installer writes the
host's own settings hooks, and where those run thinker's hooks the plugin yields (`--plugin`): one copy, never
a note twice, and the installed copy does the work from the next session on.

| host | plugin | marketplace file | install |
|---|---|---|---|
| Claude Code | `claude-code/` (`.claude-plugin/plugin.json` and `icon.png`, `hooks/hooks.json`) | `.claude-plugin/marketplace.json` | `claude plugin marketplace add yoavshmariahu/thinker` then `claude plugin install thinker@thinker` |
| Codex | `codex/` (`plugin.json`, `hooks/hooks.json`) | `.agents/plugins/marketplace.json` | `codex plugin marketplace add yoavshmariahu/thinker` then `codex plugin add thinker@thinker` |
| Cursor | `cursor/` (`.cursor-plugin/plugin.json`, `hooks/hooks.json`, the scripts under `bin/`) | `.cursor-plugin/marketplace.json` | from Cursor's Customize panel once listed; the CLI loads no plugins |

Codex runs a plugin's lifecycle hooks for plugins installed by hand in the desktop app and asks for the
same trust review as its own hooks; its public directory takes no plugin with hooks. Both are in its
documentation, as is the Cursor CLI's limit; none of the three has been run live from this repository yet.
