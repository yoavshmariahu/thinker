"""Archive this experiment's outputs, excluding auth and model reasoning."""
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import tarfile

if os.environ.get('THINKER_TEST') != '1':
    raise SystemExit('THINKER_TEST=1 required')
root = Path(__file__).resolve().parents[2]
out = Path(__file__).resolve().parent
blocked_types = {'thinking', 'redacted_thinking', 'reasoning', 'reasoning_content', 'reasoning_summary'}
blocked_keys = {'thinking', 'reasoning', 'reasoning_content', 'signature', 'encrypted_content'}

def clean(x):
    if isinstance(x, dict):
        if x.get('type') in blocked_types:
            return None
        return {k: clean(v) for k, v in x.items() if k not in blocked_keys}
    if isinstance(x, list):
        return [v for item in x if (v := clean(item)) is not None]
    return x

paths = list((root/'bench/runs').glob('jev-opus-*-20261006'))
paths += [root/'bench/runs/jev-sol-review-20261006', root/'bench/runs/excluded-jev-opus-test-guard-20261006']
secret_file = Path.home()/'.thinker/jev-key'
secret = secret_file.read_bytes().strip() if secret_file.exists() else b''
manifest = []
with (out/'evidence.tar.gz').open('wb') as raw:
    with gzip.GzipFile(filename='', fileobj=raw, mode='wb', mtime=0) as gz:
        with tarfile.open(fileobj=gz, mode='w') as tar:
            for directory in sorted(paths):
                for p in sorted(directory.iterdir()):
                    if not p.is_file() or p.name == 'summary.json':
                        continue
                    data = p.read_bytes()
                    if p.suffix == '.json':
                        data = (json.dumps(clean(json.loads(data)), indent=2)+'\n').encode()
                    elif p.suffix == '.jsonl':
                        rows = [clean(json.loads(line)) for line in data.splitlines() if line.strip()]
                        data = ''.join(json.dumps(r)+'\n' for r in rows if r is not None).encode()
                    if secret and secret in data:
                        raise RuntimeError('Credential in artifact; refusing to archive')
                    name = str(p.relative_to(root))
                    entry = tarfile.TarInfo(name)
                    entry.size = len(data)
                    entry.mode = 0o644
                    tar.addfile(entry, io.BytesIO(data))
                    manifest.append(dict(path=name, bytes=len(data), sha256=hashlib.sha256(data).hexdigest()))
(out/'evidence-manifest.json').write_text(json.dumps(dict(archiveSha256=hashlib.sha256((out/'evidence.tar.gz').read_bytes()).hexdigest(),files=manifest),indent=2)+'\n')
print(f'Archived {len(manifest)} files, {(out/"evidence.tar.gz").stat().st_size} bytes')
