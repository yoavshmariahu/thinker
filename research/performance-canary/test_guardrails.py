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

from pr_cache import validate_pr_manifest
from frozen_gh import replay
from collect_prs import collect
from guardrails import HERE, MODELS, GuardError, assert_ready, checked_ready, digest, guarded_env, supervised, validate_execution, source_hashes, ROOT


class Guards(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='.guard-test-', dir=HERE)
        self.out = Path(self.temp.name)
        self.tasks = [{'id': 'task', 'base': 'a'*40, 'fixed': 'b'*40, 'upstream': 'https://github.com/pallets/click/pull/2'}]
        self.corpus = {'version':1, 'cacheSource':'recent-merged-prs', 'tasks': {'task': {
            'repository':'pallets/click', 'base':'a'*40, 'before':'2026-01-02T00:00:00Z',
            'selection':'recent-merged-before-base', 'limit':20, 'prs':[{'number':1, 'title':'Fix fixture',
            'mergedAt':'2026-01-01T00:00:00Z', 'updatedAt':'2026-01-01T00:00:00Z',
            'mergeCommit':{'oid':'c'*40}, 'diff':'+ public source', 'comments':[], 'files':[{'path':'src/file.py'}], 'additions':3}]}}}
        (self.out / 'prs.json').write_text(json.dumps(self.corpus))
        self.raw = self.out / 'raw'; self.raw.mkdir()
        for arm in ['base', 'gold']:
            g = {'returncode': 1 if arm == 'base' else 0, 'tests': 1, 'passed': 0 if arm == 'base' else 1,
                 'failures': 1 if arm == 'base' else 0, 'errors': 0, 'skipped': 0}
            self.save(f'task-verify-{arm}-validation.json', {'module': g, 'acceptance': g})
        for model in MODELS:
            name = f'task-{model}'
            self.save(name + '-pr-build.json', {'valid': True, 'cacheSource':'recent-merged-prs', 'cacheBuildPath':'minePrs', 'model':MODELS[model], 'effort':'high', 'prsSha256':digest(self.out/'prs.json'), 'processedPrs':['pallets/click#1'], 'setupError': None})
            note = {'id': 'note', 'kind': 'rule', 'title': 'supported fact', 'body': 'supported fact', 'deps': [{'path': 'src/file.py'}], 'status': 'fresh', 'source': {'type':'pr', 'ref':'pallets/click#1'}}
            source = self.raw / (name + '-pr-notes') / 'note.json'; source.parent.mkdir(); source.write_text(json.dumps(note))
            target = self.out / 'state' / (name + '-thinker') / '.thinker/local/notes/note.json'; target.parent.mkdir(parents=True); target.write_bytes(source.read_bytes())
            self.save(name + '-pr-note-hashes.json', {'note.json': digest(source)})
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
        self.save('task-gemini-pr-build.json', {'valid': False, 'setupError': 'missing tags'})
        with self.assertRaises(GuardError): checked_ready(self.out, self.tasks)
        self.assertTrue((self.out / 'STOPPED.json').exists())

    def test_gate_rejects_empty_unserved_missing_and_mutated_cache(self):
        for file, bad in [
            ('task-sol-pr-note-hashes.json', {}),
            ('task-sol-thinker-retrieval.json', {'noteCount': 1, 'text': '', 'included': []}),
            ('task-sol-thinker-retrieval.json', {'noteCount': 1, 'text': 'x', 'included': ['missing']}),
            ('task-sol-pr-build.json', {'valid': True, 'model': 'wrong', 'effort': 'high'}),
            ('task-sol-pr-build.json', {'valid': True, 'cacheBuildPath': 'prototype'}),
        ]:
            with self.subTest(file=file, bad=bad):
                original = (self.raw / file).read_text(); self.save(file, bad)
                with self.assertRaises(GuardError): assert_ready(self.out, self.tasks)
                (self.raw / file).write_text(original)
        target = self.out / 'state/task-sol-thinker/.thinker/local/notes/note.json'
        target.write_text('{}')
        with self.assertRaisesRegex(GuardError, 'content mismatch'): assert_ready(self.out, self.tasks)

    def test_product_orientation_mutates_usage_without_changing_frozen_content(self):
        repo = self.out / 'state/task-sol-thinker'
        script = """
            import {Store} from './src/store.js';
            import {orient} from './src/ops.js';
            const store = new Store(process.argv[1]).init();
            const config = store.config.bind(store);
            store.config = () => ({...config(), jev:{enabled:false}, rerank:false});
            const result = await orient(store, {task:'supported fact', refreshFirst:false, session:'fixture'});
            if (!result.text || store.get('note').uses !== 1) throw Error('orientation did not serve');
        """
        result = subprocess.run(['node', '--input-type=module', '-e', script, str(repo)], cwd=ROOT,
                       env=guarded_env(repo, repo/'policy.json'), capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        assert_ready(self.out, self.tasks)
        target = repo / '.thinker/local/notes/note.json'
        note = json.loads(target.read_text())
        for key, value in [('body','tampered'), ('deps',[]), ('confidence',0.1),
                           ('source',{'type':'agent'}), ('answers',['invented'])]:
            with self.subTest(key=key):
                target.write_text(json.dumps({**note, key:value}))
                with self.assertRaisesRegex(GuardError, 'content mismatch'):
                    assert_ready(self.out, self.tasks)
        target.write_text(json.dumps(note))

    def test_extra_notes_and_overlays_are_rejected(self):
        cache = self.out / 'state/task-sol-thinker/.thinker'
        for directory in ['local/notes', 'notes', 'local/shared']:
            target = cache / directory / 'extra.json'
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text('{}')
            with self.assertRaisesRegex(GuardError, 'inventory'):
                assert_ready(self.out, self.tasks)
            target.unlink()

    def test_baseline_cache_contamination_rejected(self):
        (self.out / 'state/task-opus-baseline/.thinker').mkdir(parents=True)
        with self.assertRaisesRegex(GuardError, 'baseline contaminated'): assert_ready(self.out, self.tasks)

    def test_collection_error_is_not_base_failure(self):
        self.save('task-verify-base-validation.json', {'acceptance': {'returncode': 2, 'passed': 0, 'failures': 0, 'errors': 1}})
        with self.assertRaises(GuardError): assert_ready(self.out, self.tasks)

    def test_session_notes_cannot_pass_even_with_valid_hashes(self):
        source = self.raw / 'task-sol-pr-notes/note.json'
        target = self.out / 'state/task-sol-thinker/.thinker/local/notes/note.json'
        for provenance in [{'type':'agent','ref':'session'}, {'type':'pr','ref':'pallets/click#999'}]:
            note = json.loads(source.read_text()); note['source'] = provenance
            source.write_text(json.dumps(note)); target.write_bytes(source.read_bytes())
            self.save('task-sol-pr-note-hashes.json', {'note.json':digest(source)})
            with self.assertRaisesRegex(GuardError, 'frozen PR corpus'):
                assert_ready(self.out, self.tasks)

    def test_pr_receipt_cannot_be_empty_or_outside_corpus(self):
        path = self.raw / 'task-sol-pr-build.json'
        build = json.loads(path.read_text())
        for processed in [[], ['pallets/click#999']]:
            build['processedPrs'] = processed; path.write_text(json.dumps(build))
            with self.assertRaisesRegex(GuardError, 'mining receipt'):
                assert_ready(self.out, self.tasks)

    def test_future_target_and_session_pr_inputs_rejected(self):
        validate_pr_manifest(self.corpus, self.tasks)
        pr = self.corpus['tasks']['task']['prs'][0]
        for key, bad in [('mergedAt','2026-01-03T00:00:00Z'),('updatedAt','2026-01-03T00:00:00Z'),
                         ('mergeCommit',{'oid':'b'*40}),('number',2),('diff',''),('isGitCommit',True)]:
            with self.subTest(key=key):
                original = dict(pr); pr[key] = bad
                with self.assertRaises(ValueError): validate_pr_manifest(self.corpus, self.tasks)
                pr.clear(); pr.update(original)
        self.corpus['cacheSource'] = 'exploration'
        with self.assertRaisesRegex(ValueError, 'session distillation is forbidden'):
            validate_pr_manifest(self.corpus, self.tasks)

    def test_pr_ancestry_must_be_verified_at_freeze(self):
        with patch('pr_cache.subprocess.check_output',return_value='2026-01-02T00:00:00Z'), patch('pr_cache.subprocess.run') as run:
            run.return_value.returncode=1
            with self.assertRaisesRegex(ValueError, 'ancestor'): validate_pr_manifest(self.corpus, self.tasks, self.out)
            run.return_value.returncode=0
            validate_pr_manifest(self.corpus, self.tasks, self.out)

    def test_collection_filters_updated_time_before_bounded_search(self):
        pr = self.corpus['tasks']['task']['prs'][0]
        queries = []
        def output(args, **kwargs):
            if args[0] == 'git': return '2026-01-02T00:00:00Z'
            if args[:3] == ['gh','pr','list']:
                queries.append(args[args.index('--search')+1])
                return json.dumps([pr])
            if args[:3] == ['gh','pr','diff']: return pr['diff']
            if args[:2] == ['gh','api']: return '[]'
            raise AssertionError(args)
        with patch('collect_prs.subprocess.check_output',side_effect=output), patch('collect_prs.subprocess.run') as run:
            run.return_value.returncode = 0
            result = collect(self.tasks,self.out,20)
        self.assertEqual(result['tasks']['task']['prs'][0]['number'],1)
        self.assertEqual(queries,['merged:<2026-01-02T00:00:00Z updated:<2026-01-02T00:00:00Z sort:updated-desc'])

    def test_github_replay_blocks_unfrozen_requests(self):
        corpus = self.corpus['tasks']['task']
        args = ['pr','list','--repo','pallets/click','--state','merged','--limit','60','--search',
                'merged:<2026-01-02T00:00:00Z','--json','number,title,body,mergedAt,additions,files']
        self.assertEqual(json.loads(replay(args,corpus)), corpus['prs'])
        for bad in [['pr','diff','2'], ['api','repos/private/repo'], args[:-1]+['other-fields']]:
            with self.assertRaisesRegex(ValueError, 'Unfrozen'): replay(bad,corpus)

    def test_exploration_entrypoint_is_rejected_before_any_setup(self):
        env = {**os.environ, 'THINKER_TEST':'1', 'THINKER_PERF_DIR':str(self.out/'nonexistent')}
        r = subprocess.run([sys.executable,str(HERE/'run.py'),'learn','opus'],env=env,text=True,capture_output=True)
        self.assertNotEqual(r.returncode,0)
        self.assertIn('exploration/session distillation is forbidden',r.stderr)
        self.assertFalse((self.out/'nonexistent').exists())

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
        (self.out / 'tasks.json').write_text(json.dumps(self.tasks))
        config = {'guardrailsVersion':2, 'cacheSource':'recent-merged-prs', 'cacheBuildPath':'minePrs', 'prsSha256':digest(self.out/'prs.json'),'models':MODELS,'effort':'high','fallback':False,
                  'tasksSha256':digest(self.out / 'tasks.json'),'thinkerCommit':'head',
                  'sourceHashes':{'file':'hash'},'agentSeconds':600}
        with patch('guardrails.ROOT',self.out), patch('guardrails.source_hashes',return_value={'file':'hash'}), patch('guardrails.subprocess.check_output',return_value='head'):
            (self.out / 'execution.json').write_text(json.dumps(config))
            validate_execution(self.out)
            for key, bad in [('effort','medium'),('thinkerCommit','other'),('sourceHashes',{}),('tasksSha256','changed'),('agentSeconds',99999),('cacheSource','session'),('cacheBuildPath','distillFile'),('prsSha256','changed')]:
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
