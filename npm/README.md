# @zerotimedev/thinker

Installs [thinker](https://github.com/yoavshmariahu/thinker). Stop wasting context: the context each task needs for your coding agents, and nothing they never use.

```bash
npx @zerotimedev/thinker
```

The package carries thinker's installer and runs it. It downloads the latest thinker release, verifies it
against the release's sha256, installs it into `~/.thinker`, wires it into the coding agents on
the machine and opens the warm-up page. The installer's options pass through, for example
`npx @zerotimedev/thinker --uninstall`.

Requires bash, git, curl, tar and Node 20+. After the install, `thinker update` and the daily
auto-update keep the tool current; npm is not involved again.
