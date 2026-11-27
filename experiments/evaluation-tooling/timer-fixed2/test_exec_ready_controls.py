"""SOURCE ONLY, UNRUN READY/order/failure controls. Every process/FD/clock operation is mocked.

No import or execution is authorized without ROOT's separate control admission.
"""
from types import SimpleNamespace
import stat
import unittest
from unittest.mock import Mock, patch

import coordinator
import phase
import safety
from test_runtime_contracts import FakeClock


KEY = (123456, '777')
PARENT = 234567


class ReadyClock(FakeClock):
    def __init__(self):
        super().__init__()
        self.work_end, self.hard_end = 200, 210


def pipe_stat(inode):
    return SimpleNamespace(st_mode=stat.S_IFIFO | 0o600, st_dev=7, st_ino=inode)


def owner_fixture(events=None):
    def bind(pid, info):
        if events is not None:
            events.append('BIND')
        return KEY
    return SimpleNamespace(entries={KEY: {'fd': 998}}, roots=[], unbound_root_children=[],
        invalid_observations=[], exited=Mock(return_value=False), reap=Mock(), discover=Mock(),
        bind=Mock(side_effect=bind))


class ReadyReadControls(unittest.TestCase):
    def invoke(self, reads, *, owner=None, process=None, times=100, available=9 * phase.GIB):
        owner = owner or owner_fixture()
        info = process or {'start': KEY[1], 'ppid': PARENT}
        with patch.object(phase, 'boot', side_effect=times if isinstance(times, list) else None,
                          return_value=times if not isinstance(times, list) else 100), \
             patch.object(phase, 'available_bytes', return_value=available), \
             patch.object(phase.os, 'set_blocking'), \
             patch.object(phase.os, 'fstat', return_value=pipe_stat(93)), \
             patch.object(phase.os, 'getpid', return_value=PARENT), \
             patch.object(phase.base, 'proc', return_value=info), \
             patch.object(phase.os, 'read', side_effect=reads), \
             patch.object(phase.time, 'sleep'):
            return phase.wait_exec_ready(93, KEY, ReadyClock(), owner, 160)

    def test_exact_R_then_writer_EOF_is_bootstrap_proof_only(self):
        proof = self.invoke([b'R', b''])
        self.assertEqual((proof['pid'], proof['start']), KEY)
        self.assertTrue(proof['ready_eof'])
        self.assertTrue(proof['bootstrap_only_not_native_exec'])
        self.assertEqual(proof['absolute_dispatch_boot'], 160)
        self.assertEqual(proof['lowest_available_bytes'], 9 * phase.GIB)

    def test_empty_wrong_duplicate_or_extra_ACK_refuses(self):
        for reads in ([b''], [b'X'], [b'RR'], [b'R', b'R']):
            with self.subTest(reads=reads), self.assertRaises(safety.Refusal):
                self.invoke(reads)

    def test_delayed_ACK_and_EOF_wait_under_the_same_deadline(self):
        proof = self.invoke([BlockingIOError(), b'R', BlockingIOError(), b''])
        self.assertEqual(proof['absolute_dispatch_boot'], 160)

    def test_stalled_bootstrap_exhausts_original_dispatch_clock(self):
        with self.assertRaises(safety.Refusal):
            self.invoke([BlockingIOError()], times=[100, 161])

    def test_child_exit_birth_change_and_unbound_observation_refuse(self):
        exited = owner_fixture()
        exited.exited.return_value = True
        invalid = owner_fixture()
        invalid.invalid_observations.append({'kind': 'FAKE-unbound'})
        for owner, process in ((exited, None), (owner_fixture(), {'start': '999', 'ppid': PARENT}),
                               (invalid, None)):
            with self.subTest(owner=owner, process=process), self.assertRaises(safety.Refusal):
                self.invoke([b'R', b''], owner=owner, process=process)

    def test_low_memory_and_read_fault_cannot_admit_ready_H(self):
        with self.assertRaises(safety.Refusal):
            self.invoke([b'R'], available=3 * phase.GIB)
        with self.assertRaises(OSError):
            self.invoke([OSError('FAKE-read-error')])


class ChildBootstrapControls(unittest.TestCase):
    def invoke(self, *, gate=b'G', written=1, same_pipe=False, write_error=None,
               ready_fd=94, gate_fd=91, close_error=None):
        actions = []
        def write(fd, value):
            actions.append(('WRITE', fd, value))
            if write_error is not None:
                raise write_error
            return written
        def read(fd, cap):
            actions.append(('READ', fd, cap))
            return gate
        def close(fd):
            actions.append(('CLOSE', fd))
            if fd == close_error:
                raise OSError('FAKE-close-error')
        args = SimpleNamespace(exec_ready_fd=ready_fd, start_gate_fd=gate_fd)
        with patch.object(phase.os, 'fstat', side_effect=[pipe_stat(1), pipe_stat(1 if same_pipe else 2)]), \
             patch.object(phase.os, 'write', side_effect=write), \
             patch.object(phase.os, 'read', side_effect=read), \
             patch.object(phase.os, 'close', side_effect=close):
            try:
                phase.exec_bootstrap_gate(args, ReadyClock())
            finally:
                self.actions = actions
        return actions

    def test_ACK_ready_close_precedes_gate_read_and_both_channels_close(self):
        self.assertEqual(self.invoke(), [('WRITE', 94, b'R'), ('CLOSE', 94),
                                         ('READ', 91, 2), ('CLOSE', 91)])

    def test_missing_wrong_or_duplicate_gate_never_succeeds(self):
        for gate in (b'', b'X', b'GG'):
            with self.subTest(gate=gate), self.assertRaises(safety.Refusal):
                self.invoke(gate=gate)
            self.assertIn(('CLOSE', 91), self.actions)
            self.assertIn(('CLOSE', 94), self.actions)

    def test_failed_ACK_closes_both_and_never_reads_gate(self):
        for error, written in ((None, 0), (BrokenPipeError('FAKE-parent-ended'), 1)):
            with self.subTest(error=error), self.assertRaises((safety.Refusal, BrokenPipeError)):
                self.invoke(written=written, write_error=error)
            self.assertFalse(any(a[0] == 'READ' for a in self.actions))
            self.assertIn(('CLOSE', 91), self.actions)
            self.assertIn(('CLOSE', 94), self.actions)

    def test_alias_pipe_or_descriptor_refuses_before_any_ACK(self):
        for same_pipe, ready in ((True, 94), (False, 91)):
            with self.subTest(same_pipe=same_pipe, ready=ready), self.assertRaises(safety.Refusal):
                self.invoke(same_pipe=same_pipe, ready_fd=ready)
            self.assertFalse(any(a[0] == 'WRITE' for a in self.actions))

    def test_one_close_fault_does_not_skip_the_other_channel(self):
        with self.assertRaises(OSError):
            self.invoke(close_error=94)
        self.assertIn(('CLOSE', 91), self.actions)
        self.assertIn(('CLOSE', 94), self.actions)


class ParentLaunchControls(unittest.TestCase):
    def invoke(self, *, stage_failure=None, close_failure=None, expire_after_ready=False):
        events, closed = [], []
        owner = owner_fixture(events)
        child = SimpleNamespace(pid=KEY[0], returncode=None)
        def popen(*args, **kwargs):
            self.command, self.options = args[0], kwargs
            if stage_failure == 'popen':
                raise OSError('FAKE-Popen-failed')
            return child
        def ready(*args):
            events.append('READY')
            if stage_failure == 'ready':
                raise safety.Refusal('FAKE-ready-failure')
            return {'pid': KEY[0], 'start': KEY[1], 'ready_eof': True,
                    'absolute_dispatch_boot': 160, 'lowest_available_bytes': 9 * phase.GIB}
        def seize(*args):
            events.append('SEIZE')
            if stage_failure == 'seize':
                raise OSError('FAKE-SEIZE-failed')
        def release(fd, value):
            events.append('G')
            self.assertEqual((fd, value), (92, b'G'))
            if stage_failure == 'release':
                raise BrokenPipeError('FAKE-release-failure')
            return 1
        def close(fd):
            closed.append(fd)
            if fd == close_failure:
                raise OSError('FAKE-close-failure')
        if stage_failure == 'bind':
            owner.bind.side_effect = safety.Refusal('FAKE-bind-failure')
        with patch.object(phase.os, 'pipe2', side_effect=[(91, 92), (93, 94)]), \
             patch.object(phase.subprocess, 'Popen', side_effect=popen), \
             patch.object(phase.os, 'close', side_effect=close), \
             patch.object(phase.os, 'write', side_effect=release), \
             patch.object(phase.os, 'getpid', return_value=PARENT), \
             patch.object(phase.base, 'proc', return_value={'start': KEY[1], 'ppid': PARENT}), \
             patch.object(phase, 'boot', side_effect=[100, 161] if expire_after_ready else None,
                          return_value=100), \
             patch.object(phase, 'wait_exec_ready', side_effect=ready):
            try:
                result = phase.spawn_gated(['FAKE-Python', 'FAKE-entry', '_exec'],
                    ReadyClock(), owner, object(), on_bound=seize, exec_ready_deadline=160)
            finally:
                self.events, self.closed, self.owner = events, closed, owner
        return result

    def test_pidfd_bind_then_READY_then_SEIZE_then_G_and_exact_passed_FDs(self):
        child, key = self.invoke()
        self.assertEqual(key, KEY)
        self.assertEqual(self.events, ['BIND', 'READY', 'SEIZE', 'G'])
        self.assertEqual(self.options['pass_fds'], (91, 94))
        self.assertEqual(self.command[-4:], ['--start-gate-fd', '91', '--exec-ready-fd', '94'])
        self.assertEqual(sorted(self.closed), [91, 92, 93, 94])
        self.assertTrue(child._exec_ready_proof['ready_eof'])

    def test_every_launch_failure_closes_both_pipes_and_preserves_owned_cleanup_ledger(self):
        for stage in ('popen', 'bind', 'ready', 'seize', 'release'):
            with self.subTest(stage=stage), self.assertRaises((OSError, safety.Refusal)):
                self.invoke(stage_failure=stage)
            self.assertEqual(sorted(self.closed), [91, 92, 93, 94])
            if stage in ('ready', 'seize', 'release'):
                self.assertEqual(len(self.owner.roots), 1)
                self.assertEqual(self.owner.roots[0][1], KEY)
            if stage in ('popen', 'bind', 'ready', 'seize'):
                self.assertNotIn('G', self.events)
            if stage in ('popen', 'bind', 'ready'):
                self.assertNotIn('SEIZE', self.events)

    def test_parent_channel_close_fault_still_attempts_all_other_closes(self):
        with self.assertRaises(OSError):
            self.invoke(close_failure=91)
        self.assertEqual(sorted(self.closed), [91, 92, 93, 94])
        self.assertNotIn('G', self.events)

    def test_READY_never_resets_the_original_dispatch_deadline(self):
        with self.assertRaises(safety.Refusal):
            self.invoke(expire_after_ready=True)
        self.assertNotIn('SEIZE', self.events)
        self.assertNotIn('G', self.events)
        self.assertEqual(sorted(self.closed), [91, 92, 93, 94])


class ExactParserControls(unittest.TestCase):
    def argv(self):
        return ['_exec', '--absolute-expiry-epoch', '300', '--boot-deadline', '200',
            '--package-manifest', '/FAKE/source-manifest.json', '--package-manifest-sha256', 'b' * 64,
            '--stage', 'H10', '--grant', '/FAKE/grant', '--grant-sha256', 'a' * 64,
            '--parent-pid', str(PARENT), '--parent-start', '888', '--start-gate-fd', '91',
            '--exec-spec', '/FAKE/spec', '--exec-spec-sha256', 'c' * 64,
            '--phase-dir', '/FAKE/out', '--phase-hard-boot', '190',
            '--staged-inputs', '/FAKE/staged', '--staged-inputs-sha256', 'd' * 64,
            '--exec-ready-fd', '94']

    def test_exec_parser_requires_one_named_ready_descriptor(self):
        with patch.object(coordinator, 'exec_harness', return_value=0) as execute:
            self.assertEqual(coordinator.main(self.argv(), (300, 200), 100), 0)
            self.assertEqual(execute.call_args.args[0].exec_ready_fd, 94)
            with self.assertRaises(safety.Refusal):
                coordinator.main(self.argv() + ['--exec-ready-fd', '95'], (300, 200), 100)
            self.assertEqual(execute.call_count, 1)

    def test_missing_or_foreign_ready_flag_never_reaches_dispatch(self):
        with patch.object(coordinator, 'exec_harness') as execute, \
             patch.object(coordinator.sys, 'stderr'):
            for argv in (self.argv()[:-2], self.argv() + ['--foreign-ready-fd', '95']):
                with self.subTest(argv=argv), self.assertRaises(SystemExit):
                    coordinator.main(argv, (300, 200), 100)
            execute.assert_not_called()


class PrequalificationDiagnosticControls(unittest.TestCase):
    def observer(self, *, raw=b'FAKE-native\0--list\0'):
        observer = object.__new__(phase.DiagnosticExecObserver)
        observer.root_key = KEY
        observer.approval = {'harness': {'device': 7, 'inode': 11, 'bytes': 123,
                                         'sha256': 'a' * 64}}
        observer.stopped = Mock(return_value={'key': KEY, 'start': KEY[1]})
        observer.proc_bytes = Mock(return_value=raw)
        observer.events, observer.event_count = [], 0
        observer.require = safety.require
        return observer

    def invoke(self, observer, *, strict_failure=None, link_error=None, link='FAKE-native'):
        observed = SimpleNamespace(st_dev=8, st_ino=22, st_size=456, st_mode=stat.S_IFREG | 0o500)
        def strict(tid):
            self.assertEqual(tid, KEY[0])
            self.assertEqual(observer.events[-1]['kind'], 'prequalification-exec-image')
            self.close.assert_called_once_with(999)
            if strict_failure is not None:
                raise strict_failure
            return {'FAKE': 'unchanged-strict-record'}
        with patch.object(phase.os, 'open', return_value=999), \
             patch.object(phase.os, 'fstat', return_value=observed), \
             patch.object(phase.os, 'readlink', side_effect=link_error, return_value=link), \
             patch.object(phase.os, 'close') as close, \
             patch.object(phase.ExecObserver, 'capture', side_effect=strict) as capture:
            self.close = close
            try:
                result = observer.capture(KEY[0])
            finally:
                self.strict_calls = capture.call_count
        return result

    def test_actual_image_metadata_survives_the_unchanged_inode_refusal(self):
        observer = self.observer()
        with self.assertRaisesRegex(safety.Refusal, 'EXEC inode not qualified'):
            self.invoke(observer, strict_failure=safety.Refusal('EXEC inode not qualified'))
        event = observer.events[-1]
        self.assertEqual((event['observed_device'], event['observed_inode'], event['observed_bytes']), (8, 22, 456))
        self.assertEqual((event['expected_device'], event['expected_inode'], event['expected_bytes']), (7, 11, 123))
        self.assertEqual(event['actual_argv'], ['FAKE-native', '--list'])
        self.assertTrue(event['diagnostic_only'])
        self.assertEqual(self.strict_calls, 1)

    def test_success_returns_only_the_unchanged_strict_capture_result(self):
        observer = self.observer()
        self.assertEqual(self.invoke(observer), {'FAKE': 'unchanged-strict-record'})
        self.assertEqual(self.strict_calls, 1)
        self.assertIsNone(observer.events[-1]['diagnostic_error'])

    def test_diagnostic_error_still_calls_strict_capture_and_never_returns_success(self):
        observer = self.observer()
        with self.assertRaisesRegex(safety.Refusal, 'diagnostic failed'):
            self.invoke(observer, link_error=OSError('FAKE-readlink-fault'))
        self.assertEqual(self.strict_calls, 1)
        self.assertIn('FAKE-readlink-fault', observer.events[-1]['diagnostic_error'])

    def test_private_diagnostic_argv_and_link_are_bounded(self):
        observer = self.observer(raw=b'x\0' * 5000)
        self.invoke(observer, link='x' * 5000)
        event = observer.events[-1]
        self.assertEqual(len(event['actual_argv']), 256)
        self.assertTrue(event['actual_argv_truncated'])
        self.assertEqual(len(event['actual_exe_link']), 4096)
        self.assertTrue(event['exe_link_truncated'])


if __name__ == '__main__':
    raise SystemExit('UNRUN source-only READY controls; separate ROOT admission required')
