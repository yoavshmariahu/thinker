// What kind of container, if any, this process is running in. One definition, in a module of its own with
// no imports, because two callers now ask the question and neither may pull the other in: the telemetry, so
// a count of zero sessions can be told from a blind spot (`telemetry.js:machineFacts`), and the proxy, so an
// agent in a container is never left routed at a port nothing answers on (`proxy-service.js:ensureProxy`).
// `telemetry.js` imports `proxy-service.js`, so the shared definition cannot live in either.
import fs from 'node:fs';

// 'docker' | 'podman' | 'kubernetes' | 'containerd' | null, from the marks a runtime leaves on the process
// it runs. Never a container id or an image name: a kind is all of this that ever leaves the machine.
// `/.dockerenv` and `/run/.containerenv` are the runtimes' own files; the cgroup line is the fallback where
// neither is mounted.
export function containerKind({ env = process.env, readFile = fs.readFileSync, exists = fs.existsSync } = {}) {
  if (env.KUBERNETES_SERVICE_HOST) return 'kubernetes';
  try { if (exists('/.dockerenv')) return 'docker'; } catch {}
  try { if (exists('/run/.containerenv')) return 'podman'; } catch {}
  try {
    const cgroup = String(readFile('/proc/self/cgroup', 'utf8'));
    if (/kubepods/.test(cgroup)) return 'kubernetes';
    if (/docker/.test(cgroup)) return 'docker';
    if (/containerd|libpod|lxc/.test(cgroup)) return 'containerd';
  } catch {}
  return null;
}

export const inContainer = opts => containerKind(opts) !== null;
