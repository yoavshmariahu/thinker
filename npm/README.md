# @zerotime/thinker

Installs [thinker](https://github.com/yoavshmariahu/thinker), a knowledge cache for coding agents.

```bash
npx @zerotime/thinker
```

This runs the same installer as the `curl ... | bash` command in the thinker README, carried in
the package instead of fetched at run time. It downloads the latest thinker release, verifies it
against the release's sha256, installs it into `~/.thinker`, wires it into the coding agents on
the machine and opens the warm-up page. The installer's options pass through, for example
`npx @zerotime/thinker --uninstall`.

Requires bash, git, curl, tar and Node 20+. After the install, `thinker update` and the daily
auto-update keep the tool current; npm is not involved again.
