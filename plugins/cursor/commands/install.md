---
description: Install thinker on this machine for Cursor only (the plugin's hooks then serve its notes)
---

Install thinker on this machine for Cursor only, then tell the person what happened. Run exactly:

```
npx -y @zerotimedev/thinker --clients cursor --no-modify-path --no-ui --yes
```

This downloads the latest thinker release into `~/.thinker`, verifies it, installs its dependencies and wires
Cursor's own settings (its hooks). No other agent is touched and no shell startup file is edited. It takes about a
minute and needs Node 20+, git, curl and tar.

When it finishes, report in two or three lines: whether it succeeded, that the notes start with the next
session (the plugin's hooks yield to the installed copy from then on), and, if it failed, the last lines of the
output and that `npx @zerotimedev/thinker` can be run by hand. If `~/.thinker/app/src/cli.js` already exists,
say thinker is installed already and run nothing.
