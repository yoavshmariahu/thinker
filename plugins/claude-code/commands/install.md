---
description: Install thinker on this machine for Claude Code only (the plugin's hooks then run it)
allowed-tools: Bash(npx -y thinkersh:*), Bash(test -f ~/.thinker/app/src/cli.js)
---

Install thinker on this machine for Claude Code only, then tell the person what happened. Run exactly:

```
npx -y thinkersh --clients claude --no-modify-path --no-ui --yes
```

This downloads the latest thinker release into `~/.thinker`, verifies it, installs its dependencies and wires
Claude Code's own settings (its hooks). No other agent is touched and no shell startup file is edited. It takes about a
minute and needs Node 20+, git, curl and tar.

When it finishes, report in two or three lines: whether it succeeded, that the profile and the clearing start with the next
session (the plugin's hooks yield to the installed copy from then on), and, if it failed, the last lines of the
output and that `npx thinkersh` can be run by hand. If `~/.thinker/app/src/cli.js` already exists,
say thinker is installed already and run nothing.
