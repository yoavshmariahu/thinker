import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

from guardrails import HERE, MODELS, GuardError, assert_ready, checked_ready, digest, guarded_env, supervised, validate_execution, source_hashes, ROOT


class Guards(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='.guard-test-', dir=HERE)
        self.out = Path(self.temp.name)
        self.tasks = [{'id': 'task'}]
        self.raw = self.out / 'raw'; self.raw.mkdir()
        for arm in ['base', 'gold']:
            g = {'returncode': 1 if arm == 'base' else 0, 'tests': 1, 'passed': 0 if arm == 'base' else 1,
                 'failures': 1 if arm == 'base' else 0, 'errors': 0, 'skipped': 0}
            self.save(f'task-verify-{arm}-validation.json', {'module': g, 'acceptance': g})
        for model in MODELS:
            name = f'task-{model}'
            self.save(name + '-learn.json', {'valid': True, 'model': MODELS[model], 'effort': 'high'})
            self.save(name + '-learn-build.json', {'valid': True, 'cacheBuildPath': 'distillFile', 'setupError': None})
            note = {'id': 'note', 'body': 'supported fact', 'deps': [{'path': 'src/file.py'}], 'status': 'fresh'}
            source = self.raw / (name + '-learn-notes') / 'note.json'; source.parent.mkdir(); source.write_text(json.dumps(note))
            target = self.out / 'state' / (name + '-thinker') / '.thinker/notes/note.json'; target.parent.mkdir(parents=True); target.write_bytes(source.read_bytes())
            self.save(name + '-learn-note-hashes.json', {'note.json': digest(source)})
            self.save(name + '-thinker-retrieval.json', {'noteCount': 1, 'text': 'supported fact', 'included': ['note']})

    def tearDown(self):
        self.temp.cleanup()

    def save(self, file, obj):
        (self.raw / file).write_text(json.dumps(obj))

    def test_inherited_global_cache_and_hooks_cannot_leak(self):
        env=guarded_env(self.out,self.out/'policy.json',base={'THINKER_NOTES_DIR':'/other/cache','THINKER_REPO':'/other','THINKER_HOOKS':'on','THINKER_TEST':'0','MAX_THINKING_TOKENS':'0'})
        self.assertNotIn('THINKER_NOTES_DIR',env); self.assertNotIn('THINKER_REPO',env); self.assertNotIn('MAX_THINKING_TOKENS',env)
        self.assertEqual(env['THINKER_TEST'],'1'); self.assertEqual(env['THINKER_HOOKS'],'off')

    def test_complete_cache_gate(self):
        assert_ready(self.out, self.tasks)

    def test_one_failed_cohort_blocks_all_coding(self):
        self.save('task-gemini-learn-build.json', {'valid': False, 'setupError': 'missing tags'})
        with self.assertRaises(GuardError): checked_ready(self.out, self.tasks)
        self.assertTrue((self.out / 'STOPPED.json').exists())

    def test_gate_rejects_empty_unserved_missing_and_mutated_cache(self):
        for file, bad in [
            ('task-sol-learn-note-hashes.json', {}),
            ('task-sol-thinker-retrieval.json', {'noteCount': 1, 'text': '', 'included': []}),
            ('task-sol-thinker-retrieval.json', {'noteCount': 1, 'text': 'x', 'included': ['missing']}),
            ('task-sol-learn.json', {'valid': True, 'model': 'wrong', 'effort': 'high'}),
            ('task-sol-learn-build.json', {'valid': True, 'cacheBuildPath': 'prototype'}),
        ]:
            with self.subTest(file=file, bad=bad):
                original = (self.raw / file).read_text(); self.save(file, bad)
                with self.assertRaises(GuardError): assert_ready(self.out, self.tasks)
                (self.raw / file).write_text(original)
        target = self.out / 'state/task-sol-thinker/.thinker/notes/note.json'
        target.write_text('{}')
        with self.assertRaisesRegex(GuardError, 'hash mismatch'): assert_ready(self.out, self.tasks)

    def test_baseline_cache_contamination_rejected(self):
        (self.out / 'state/task-opus-baseline/.thinker').mkdir(parents=True)
        with self.assertRaisesRegex(GuardError, 'baseline contaminated'): assert_ready(self.out, self.tasks)

    def test_collection_error_is_not_base_failure(self):
        self.save('task-verify-base-validation.json', {'acceptance': {'returncode': 2, 'passed': 0, 'failures': 0, 'errors': 1}})
        with self.assertRaises(GuardError): assert_ready(self.out, self.tasks)

    def execute(self, code, seconds=3, **kwargs):
        return supervised([sys.executable, '-u', '-c', code], cwd=self.out, env=os.environ,
                          prefix=self.out / 'fixture', seconds=seconds, batch=self.out, heartbeat=.05, **kwargs)

    def test_live_output_and_heartbeat_before_exit(self):
        # The child independently observes disk logs while its parent is still running.
        code = "import pathlib,time; print('live',flush=True); time.sleep(.2); assert 'live' in pathlib.Path('fixture.events.jsonl').read_text(); assert 'running' in pathlib.Path('fixture.process.json').read_text()"
        r = self.execute(code)
        self.assertIsNone(r['reason']); self.assertIn('live', r['stdout'])

    def test_timeout_kills_grandchild_and_preserves_partial_output(self):
        code = "import subprocess,sys,time; subprocess.Popen([sys.executable,'-c',\"import time,pathlib; time.sleep(1); pathlib.Path('escaped').write_text('bad')\"]); print('partial',flush=True); time.sleep(30)"
        r = self.execute(code, .3)
        self.assertEqual(r['reason'], 'timeout'); self.assertIn('partial', r['stdout'])
        time.sleep(1.1); self.assertFalse((self.out / 'escaped').exists())
        self.assertTrue((self.out / 'STOPPED.json').exists())

    def test_normal_exit_cleans_orphans(self):
        code = "import subprocess,sys; subprocess.Popen([sys.executable,'-c',\"import time,pathlib; time.sleep(.8); pathlib.Path('orphan').write_text('bad')\"]); print('done',flush=True)"
        self.assertIsNone(self.execute(code)['reason'])
        time.sleep(1); self.assertFalse((self.out / 'orphan').exists())

    def test_child_policy_violation_is_writable_and_stops_batch(self):
        code="import os,pathlib,time; p=pathlib.Path(os.environ['THINKER_BENCH_VIOLATION']); assert p.parent==pathlib.Path.cwd(); p.write_text('{}'); time.sleep(30)"
        self.assertEqual(self.execute(code)['reason'],'test-policy-violation')
        self.assertTrue((self.out/'fixture.violation.json').exists())
        self.assertTrue((self.out/'STOPPED.json').exists())

    def test_shared_stop_terminates_an_active_process(self):
        r = self.execute("import pathlib,time; pathlib.Path('STOPPED.json').write_text('{}'); print('saved',flush=True); time.sleep(30)")
        self.assertEqual(r['reason'], 'batch-stopped')

    def test_interrupt_terminates_children_and_records_reason(self):
        code = "import os,signal,time; os.kill(os.getppid(),signal.SIGTERM); time.sleep(30)"
        self.assertEqual(self.execute(code)['reason'], 'interrupted')

    def test_failing_process_stops_and_cannot_reuse_logs(self):
        self.assertEqual(self.execute("raise SystemExit(2)")['reason'], 'process-failed')
        with self.assertRaises(GuardError): self.execute("print('must not run')")

    def test_native_transcript_is_mirrored_before_exit(self):
        brain = self.out / 'brain'; brain.mkdir()
        code = "import pathlib,time; p=pathlib.Path('brain/new/.system_generated/logs/transcript.jsonl'); p.parent.mkdir(parents=True); p.write_text(str(pathlib.Path.cwd())); time.sleep(.3); assert pathlib.Path('fixture.transcript.jsonl').read_text()==str(pathlib.Path.cwd())"
        self.assertIsNone(self.execute(code, native_root=brain)['reason'])

    def test_protocol_rejects_changed_source_and_model(self):
        (self.out / '.git').write_text('gitdir: fixture')
        (self.out / 'tasks.json').write_text('[]')
        config = {'guardrailsVersion':1,'models':MODELS,'effort':'high','fallback':False,
                  'tasksSha256':digest(self.out / 'tasks.json'),'thinkerCommit':'head',
                  'sourceHashes':{'file':'hash'},'agentSeconds':600}
        with patch('guardrails.ROOT',self.out), patch('guardrails.source_hashes',return_value={'file':'hash'}), patch('guardrails.subprocess.check_output',return_value='head'):
            (self.out / 'execution.json').write_text(json.dumps(config))
            validate_execution(self.out)
            for key, bad in [('effort','medium'),('thinkerCommit','other'),('sourceHashes',{}),('tasksSha256','changed'),('agentSeconds',99999)]:
                value = config[key]; config[key] = bad
                (self.out / 'execution.json').write_text(json.dumps(config))
                with self.assertRaises(GuardError): validate_execution(self.out)
                config[key] = value

    @unittest.skipUnless(importlib.util.find_spec('pytest'), 'pytest integration needs the benchmark Python environment')
    def test_real_pytest_cannot_enable_stress_by_clearing_addopts(self):
        (self.out / 'pytest.ini').write_text('[pytest]\naddopts = -m "not stress"\nmarkers = stress: expensive\n')
        (self.out / 'test_fixture.py').write_text("import pytest\ndef test_ok(): pass\n@pytest.mark.stress\ndef test_expensive():\n open('stress-ran','w').write('bad')\n")
        for args, expected in [([], 0), (['-o', 'addopts='], 4)]:
            r = subprocess.run([sys.executable, '-m', 'pytest', '-q', *args], cwd=self.out,
                               env=guarded_env(self.out, self.out / 'policy.json'), capture_output=True, text=True, timeout=10)
            self.assertEqual(r.returncode, expected, r.stdout + r.stderr)
        self.assertFalse((self.out / 'stress-ran').exists())
        self.assertTrue((self.out / 'policy.json').exists())

    @unittest.skipUnless(importlib.util.find_spec('pytest'), 'pytest integration needs the benchmark Python environment')
    def test_real_pytest_blocks_oversized_suite_and_watchdog(self):
        (self.out / 'test_many.py').write_text("import pytest\n@pytest.mark.parametrize('n',range(2001))\ndef test_many(n): pass\n")
        env = guarded_env(self.out, self.out / 'policy.json')
        r = subprocess.run([sys.executable, '-m', 'pytest', '-q'], cwd=self.out, env=env, capture_output=True, timeout=10)
        self.assertEqual(r.returncode, 4)
        # Exercise the actual expiry handler without spending 120 seconds.
        r = subprocess.run([sys.executable, '-c', 'import thinker_bench_pytest as g; g.expired(None,None)'], cwd=self.out, env=env, timeout=5)
        self.assertEqual(r.returncode, 124)


if __name__ == '__main__':
    unittest.main()
