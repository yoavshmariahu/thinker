# @zerotimedev/thinker

[Thinker](https://zerotime.dev) helps your coding agent use fewer tokens.
Find wasted context, review what to cut, and reuse what your agent learns about your code.

```bash
npx @zerotimedev/thinker
```

The installer connects your coding agents and shows suggested savings from your recent sessions.
Review them in your browser or terminal, then keep coding as usual.

Requires bash, git, curl, tar and Node 20+. [Setup and privacy](https://zerotime.dev/docs#install).

## Installer details

The package downloads the latest GitHub release, verifies its SHA-256 and installs it under
`~/.thinker`. Thinker keeps itself updated; npm is not needed again.
Installer options pass through, for example `npx @zerotimedev/thinker --uninstall`.

## As a pi package

The same package is a [pi](https://pi.dev) package: `pi install npm:@zerotimedev/thinker` adds an extension that
runs the installed thinker in every pi session (notes with each prompt and as files are opened, sessions
distilled into notes). It is a pointer: install thinker first with the command above. Where `thinker connect`
has already wired pi (`~/.pi/agent/extensions/thinker.js`), the package stays quiet, so nothing is served twice.
