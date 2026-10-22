# Plugins

One plugin per host, each a pointer to the thinker installed on this machine (`npx @zerotimedev/thinker`
puts it in `~/.thinker/app`): the plugin's hooks run the installed copy's `thinker hook`, so the notes,
the learning and the updates are the installed copy's. Nothing of thinker runs from a plugin, and a plugin
on a machine without thinker does nothing. Where the host's own settings already run thinker's hooks
(`thinker connect`, which the installer runs), the plugin yields (`--plugin`): one copy, never a note twice.

| host | plugin | marketplace file | install |
|---|---|---|---|
| Claude Code | `claude-code/` (`.claude-plugin/plugin.json` and `icon.png`, `hooks/hooks.json`) | `.claude-plugin/marketplace.json` | `claude plugin marketplace add yoavshmariahu/thinker` then `claude plugin install thinker@thinker` |
| Codex | `codex/` (`plugin.json`, `hooks/hooks.json`) | `.agents/plugins/marketplace.json` | `codex plugin marketplace add yoavshmariahu/thinker` then `codex plugin add thinker@thinker` |
| Cursor | `cursor/` (`.cursor-plugin/plugin.json`, `hooks/hooks.json`, the scripts under `bin/`) | `.cursor-plugin/marketplace.json` | from Cursor's Customize panel once listed; the CLI loads no plugins |

Codex runs a plugin's lifecycle hooks for plugins installed by hand in the desktop app and asks for the
same trust review as its own hooks; its public directory takes no plugin with hooks. Both are in its
documentation, as is the Cursor CLI's limit; none of the three has been run live from this repository yet.
