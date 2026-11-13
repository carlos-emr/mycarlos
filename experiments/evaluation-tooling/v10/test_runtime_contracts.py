"""Authored UNRUN synthetic runtime controls; no models, child processes or real signals.

Separate ROOT review/admission is required before importing or invoking these.
"""
import copy
from pathlib import Path
from types import MappingProxyType, SimpleNamespace
import unittest
from unittest.mock import patch

import phase
import safety
import exec_observer
from interfaces import HEAD


class FakeClock:
    def __init__(self):
        self.hard_end, self.phase = 999, 'work'
    def check(self, *args, **kwargs):
        pass
    def disarm(self):
        pass
    def enter_final(self):
        self.phase = 'final'
    def remaining(self, final=False):
        return 9


def fake_run_fixture():
    documents = {f'FAKE-{i}': {'pagesSha256': 'a' * 64, 'docLang': 'en'} for i in range(10)}
    approval = {'helper': {'sha256': 'b' * 64}, 'harness': {'sha256': 'c' * 64},
        'model': {'sha256': 'd' * 64, 'bytes': 123, 'chat_format': 'FAKE-format'},
        'expected_build': {'FAKE-build': True}}
    label = 'M2literal6595-FAKE-H10'
    header = {'kind': 'run', 'commit': HEAD, 'variant': label, 'lang': 'en', 'threads': 3,
        'runnerSha256': 'b' * 64, 'harnessSha256': 'c' * 64, 'documents': documents,
        'build': approval['expected_build'], 'model': {'sha256': 'd' * 64, 'bytes': 123,
        'chatFormat': 'FAKE-format'}, 'startedAt': 10}
    rows = [header] + [{'kind': 'document', 'id': key, 'docLang': 'en', 'pagesSha256': 'a' * 64,
        'wallMs': 120000, 'result': {'stats': {'threads': 3, 'batchThreads': 3}}} for key in documents]
    rows.append({'kind': 'end', 'answered': 10, 'finishedAt': 20})
    authority = SimpleNamespace(clock=FakeClock(), grant={'candidate_label': label})
    return rows, authority, {'manifest': documents}, approval, {'start_epoch': 9, 'end_epoch': 21}


def check_fake_rows(rows, fixture):
    import json
    _, authority, staged, approval, guard = fixture
    data = b''.join(json.dumps(row).encode() + b'\n' for row in rows)
    with patch.object(phase.base, 'read_path', return_value=data):
        return phase.completed_run(authority, 'H10', Path('/FAKE'), staged, approval, guard)


class ActualRunBoundaryControls(unittest.TestCase):
    def test_complete_fake_run_records_target_without_granting_quality(self):
        fixture = fake_run_fixture()
        _, target = check_fake_rows(fixture[0], fixture)
        self.assertTrue(target['target_met'])
        self.assertTrue(target['quality_pass_not_inferred'])

    def test_same_count_substituted_document_is_refused(self):
        fixture = fake_run_fixture()
        rows = copy.deepcopy(fixture[0])
        rows[1]['id'] = 'FAKE-foreign'
        with self.assertRaises(safety.Refusal):
            check_fake_rows(rows, fixture)

    def test_truncated_or_duplicate_or_failed_document_is_refused(self):
        fixture = fake_run_fixture()
        for mutation in ('truncate', 'duplicate', 'error'):
            rows = copy.deepcopy(fixture[0])
            if mutation == 'truncate':
                rows.pop()
            elif mutation == 'duplicate':
                rows[2] = copy.deepcopy(rows[1])
            else:
                rows[1]['error'] = 'FAKE failure'
            with self.subTest(mutation=mutation), self.assertRaises(safety.Refusal):
                check_fake_rows(rows, fixture)

    def test_actual_header_binary_and_model_must_match_independent_pins(self):
        fixture = fake_run_fixture()
        for field in ('runnerSha256', 'harnessSha256'):
            rows = copy.deepcopy(fixture[0])
            rows[0][field] = 'e' * 64
            with self.subTest(field=field), self.assertRaises(safety.Refusal):
                check_fake_rows(rows, fixture)
        rows = copy.deepcopy(fixture[0])
        rows[0]['model']['sha256'] = 'e' * 64
        with self.assertRaises(safety.Refusal):
            check_fake_rows(rows, fixture)

    def test_reported_thread_capacity_does_not_replace_actual_batch_stats(self):
        fixture = fake_run_fixture()
        for value in (4, True):
            rows = copy.deepcopy(fixture[0])
            rows[4]['result']['stats']['batchThreads'] = value
            with self.subTest(value=value), self.assertRaises(safety.Refusal):
                check_fake_rows(rows, fixture)

    def test_target_miss_is_measured_and_never_fabricated_as_pass(self):
        fixture = fake_run_fixture()
        rows = copy.deepcopy(fixture[0])
        rows[5]['wallMs'] = 180001
        _, target = check_fake_rows(rows, fixture)
        self.assertFalse(target['target_met'])
        self.assertEqual(target['documents_over_target'], 1)


class OwnershipBoundaryControls(unittest.TestCase):
    def test_readiness_error_does_not_skip_later_owned_signal_targets(self):
        owner = safety.StrictOwned(FakeClock())
        owner.entries = {(101, '1'): {'fd': 2048}, (102, '2'): {'fd': 2049}}
        with patch.object(owner, 'exited', side_effect=[safety.Refusal('FAKE bad pidfd'), False]), \
             patch.object(safety.signal, 'pidfd_send_signal') as send:
            with self.assertRaises(safety.Refusal):
                owner.signal_all(safety.signal.SIGTERM)
            send.assert_called_once_with(2049, safety.signal.SIGTERM, None, 0)
        self.assertTrue(owner.invalid_observations)

    def test_wait_readiness_error_is_retained_but_later_children_still_reap(self):
        owner = safety.StrictOwned(FakeClock())
        owner.entries = {(101, '1'): {'fd': 2048, 'reaped': False},
                         (102, '2'): {'fd': 2049, 'reaped': False}}
        first, second = SimpleNamespace(pid=101, returncode=None), SimpleNamespace(pid=102, returncode=None)
        owner.roots = [(first, (101, '1')), (second, (102, '2'))]
        events = [SimpleNamespace(si_pid=101), SimpleNamespace(si_pid=102), ChildProcessError()]
        with patch.object(safety.os, 'waitid', side_effect=events), \
             patch.object(safety.os, 'waitpid', side_effect=[(101, 0), (102, 0)]) as wait, \
             patch.object(safety.base, 'proc', side_effect=[{'start': '1'}, {'start': '2'}]), \
             patch.object(owner, 'exited', side_effect=[safety.Refusal('FAKE bad pidfd'), True]):
            owner.reap()
        self.assertEqual(wait.call_count, 2)
        self.assertEqual((first.returncode, second.returncode), (0, 0))
        self.assertTrue(owner.no_children)
        self.assertTrue(owner.invalid_observations)
        self.assertTrue(owner.entries[(102, '2')]['reaped'])

    def test_cleanup_uses_original_hard_end_and_records_only_owned_signals(self):
        clock = FakeClock()
        owner = SimpleNamespace(discover=lambda: None, reap=lambda: None,
            signal_all=lambda number: observed.append(number),
            snapshot=lambda: {'cleanup_complete': True, 'kernel_no_children': True})
        observed = []
        with patch.object(safety, 'boot', return_value=100), patch.object(safety.signal, 'setitimer'):
            result = safety.cleanup(owner, clock)
        self.assertEqual(clock.hard_end, 110)
        self.assertEqual(clock.phase, 'final')
        self.assertEqual(observed, [safety.signal.SIGTERM])
        self.assertIsNone(result['cleanup_error'])
        clock.hard_end = 104
        with patch.object(safety, 'boot', return_value=100), patch.object(safety.signal, 'setitimer'):
            safety.cleanup(owner, clock)
        self.assertEqual(clock.hard_end, 104)

    def test_unknown_waitable_child_is_recorded_before_reap(self):
        owner = safety.StrictOwned(FakeClock())
        event = SimpleNamespace(si_pid=987654)
        with patch.object(safety.os, 'waitid', side_effect=[event, ChildProcessError()]), \
             patch.object(safety.os, 'waitpid', return_value=(987654, 0)), \
             patch.object(safety.base, 'proc', return_value={'start': '123'}):
            owner.reap()
        self.assertEqual(owner.invalid_observations[0]['kind'], 'unbound-child-before-reap')
        self.assertTrue(owner.no_children)
        self.assertTrue(owner.invalid_observations)  # ECHILD alone never clears evidence failure.

    def test_kernel_exe_wrong_inode_is_refused_before_hash(self):
        expected = {'device': 1, 'inode': 2, 'bytes': 100, 'sha256': 'a' * 64}
        actual = SimpleNamespace(st_mode=0o100500, st_dev=1, st_ino=3, st_size=100)
        observer = object.__new__(exec_observer.ExecObserver)
        observer.stopped = lambda tid: {'tgid': 56, 'key': (56, '55'), 'start': '55'}
        observer.kernel = SimpleNamespace(message=lambda tid: tid)
        observer.root_key, observer.records = (56, '55'), {}
        observer.approval = {'harness': expected}
        observer.clock, observer.require, observer.base = FakeClock(), safety.require, phase.base
        with patch.object(phase.base, 'proc', return_value={'start': '55', 'ppid': 44}), \
             patch.object(exec_observer.os, 'open', return_value=999), \
             patch.object(exec_observer.os, 'fstat', return_value=actual), \
             patch.object(exec_observer.os, 'close'), \
             patch.object(phase.base, 'digest_fd', side_effect=AssertionError('hash must not run')):
            with self.assertRaises(safety.Refusal):
                observer.capture(56)

    def test_environment_does_not_inherit_model_or_loader_override(self):
        approval = {'model': {'path': '/FAKE/model.gguf', 'sha256': 'a' * 64, 'chat_format': 'builtin'}}
        # Read-only FAKE inherited mapping; no putenv/real HOME assignment occurs.
        inherited = MappingProxyType({'HOME': '/FAKE/inherited-system-home',
            'LD_PRELOAD': '/FAKE/evil.so', 'CARGO_BIN_EXE_mycarlos-tauri-poc': '/FAKE/helper'})
        with patch.object(phase.os, 'environ', inherited):
            environment = phase.command_environment(approval, 'H10', 'M2literal6595-FAKE-H10', Path('/FAKE/run'))
        self.assertNotIn('LD_PRELOAD', environment)
        self.assertNotIn('CARGO_BIN_EXE_mycarlos-tauri-poc', environment)
        self.assertNotIn('HOME', environment)
        self.assertEqual(environment['MYCARLOS_TEST_THREADS'], '3')


if __name__ == '__main__':
    raise SystemExit('UNRUN source controls; only separately admitted ROOT control command may import them')
