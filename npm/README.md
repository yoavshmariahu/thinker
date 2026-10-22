# @zerotimedev/thinker

Installs [thinker](https://github.com/yoavshmariahu/thinker). Think ahead. Save context: a knowledge cache that gives your coding agents the context each task needs.

```bash
npx @zerotimedev/thinker
```

The package carries thinker's installer and runs it. It downloads the latest thinker release, verifies it
against the release's sha256, installs it into `~/.thinker`, wires it into the coding agents on
the machine, prints where your agents' context goes and what to cut first, and opens the local page on that report. The installer's options pass through, for example
`npx @zerotimedev/thinker --uninstall`.

Requires bash, git, curl, tar and Node 20+. After the install, `thinker update` and the daily
auto-update keep the tool current; npm is not involved again.

## As a pi package

The same package is a [pi](https://pi.dev) package: `pi install npm:@zerotimedev/thinker` adds an extension that
runs the installed thinker in every pi session (notes with each prompt and as files are opened, sessions
distilled into notes). It is a pointer: install thinker first with the command above. Where `thinker connect`
has already wired pi (`~/.pi/agent/extensions/thinker.js`), the package stays quiet, so nothing is served twice.
