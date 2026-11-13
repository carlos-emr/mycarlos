"""Authored fake controls only; not executed as part of source preparation."""
import types
import unittest
from unittest.mock import patch
from exec_observer import ExecObserver, Kernel
import os


class AdoptedPrewaitControls(unittest.TestCase):
    def fixture(self, observations):
        observer = ExecObserver.__new__(ExecObserver)
        key = (123, 'birth')
        observer.owner = types.SimpleNamespace(entries={key: {'fd': 77, 'reaped': False}},
            invalid_observations=[], roots=[], unbound_root_children=[],
            exited=unittest.mock.Mock(return_value=True))
        observer.clock = types.SimpleNamespace(check=lambda: None)
        values = iter(observations)
        observer.base = types.SimpleNamespace(proc=lambda pid, clock: next(values))
        observer.require = lambda condition, message: self.assertTrue(condition, message)
        observer.detached_helpers = {123: key}
        observer.records = {key: {}}
        observer.tracees, observer.pending = {}, {}
        observer.events, observer.event_count = [], 0
        return observer, key

    def test_same_birth_adopted_before_wait_preserves_actual_signal_exit(self):
        info = {'start': 'birth', 'ppid': 42}
        observer, key = self.fixture([info, info])
        with patch('exec_observer.os.getpid', return_value=42):
            proof = observer.adopted_before_wait(types.SimpleNamespace(si_pid=123, si_code=os.CLD_KILLED))
        observer.exited(123, 9, proof)
        self.assertTrue(observer.owner.entries[key]['reaped'])
        self.assertEqual(observer.events[-1]['exit'], -9)
        self.assertFalse(observer.owner.invalid_observations)

    def test_adoption_after_no_event_is_proven_on_later_exact_peek(self):
        info = {'start': 'birth', 'ppid': 42}
        observer, key = self.fixture([info, info])
        pending = types.SimpleNamespace(si_pid=123, si_code=os.CLD_KILLED, si_status=9)
        observer.kernel = types.SimpleNamespace(
            peek=unittest.mock.Mock(side_effect=[None, pending, None]),
            consume=unittest.mock.Mock(return_value=(123, 9)))
        with patch('exec_observer.os.getpid', return_value=42):
            observer.drain()
            self.assertFalse(observer.owner.entries[key]['reaped'])
            observer.drain()
        self.assertTrue(observer.owner.entries[key]['reaped'])
        observer.kernel.consume.assert_called_once_with(pending)

    def test_terminal_peek_without_ready_bound_pidfd_is_not_proof(self):
        observer, _ = self.fixture([])
        observer.owner.exited.return_value = False
        pending = types.SimpleNamespace(si_pid=123, si_code=os.CLD_KILLED)
        self.assertEqual(observer.adopted_before_wait(pending), {})

    def test_bound_pidfd_poll_exception_fails_closed(self):
        observer, _ = self.fixture([])
        observer.owner.exited.side_effect = RuntimeError('bad bound descriptor')
        pending = types.SimpleNamespace(si_pid=123, si_code=os.CLD_KILLED)
        with self.assertRaises(RuntimeError):
            observer.adopted_before_wait(pending)

    def test_bound_fd_changes_during_birth_bracket_refuses_proof(self):
        info = {'start': 'birth', 'ppid': 42}
        observer, key = self.fixture([])
        def observe(pid, clock):
            observer.owner.entries[key]['fd'] = 88
            return info
        observer.base.proc = observe
        pending = types.SimpleNamespace(si_pid=123, si_code=os.CLD_KILLED)
        with patch('exec_observer.os.getpid', return_value=42):
            self.assertEqual(observer.adopted_before_wait(pending), {})

    def test_historical_pid_without_prewait_proof_remains_unknown(self):
        observer, key = self.fixture([])
        observer.exited(123, 9)
        self.assertFalse(observer.owner.entries[key]['reaped'])
        self.assertTrue(observer.owner.invalid_observations[0]['no_preconsume_birth_attribution'])

    def test_reused_birth_is_never_adopted_proof(self):
        observer, _ = self.fixture([{'start': 'replacement', 'ppid': 42}])
        with patch('exec_observer.os.getpid', return_value=42):
            self.assertEqual(observer.adopted_before_wait(types.SimpleNamespace(si_pid=123, si_code=os.CLD_KILLED)), {})

    def test_helper_still_parented_by_harness_is_not_proof(self):
        observer, _ = self.fixture([{'start': 'birth', 'ppid': 99}])
        with patch('exec_observer.os.getpid', return_value=42):
            self.assertEqual(observer.adopted_before_wait(types.SimpleNamespace(si_pid=123, si_code=os.CLD_KILLED)), {})

    def test_birth_disappearing_inside_bracket_refuses_proof(self):
        observer, _ = self.fixture([{'start': 'birth', 'ppid': 42}, None])
        with patch('exec_observer.os.getpid', return_value=42):
            self.assertEqual(observer.adopted_before_wait(types.SimpleNamespace(si_pid=123, si_code=os.CLD_KILLED)), {})

    def test_changed_bound_fd_after_prewait_refuses_consumed_status(self):
        info = {'start': 'birth', 'ppid': 42}
        observer, key = self.fixture([info, info])
        with patch('exec_observer.os.getpid', return_value=42):
            proof = observer.adopted_before_wait(types.SimpleNamespace(si_pid=123, si_code=os.CLD_KILLED))
        observer.owner.entries[key]['fd'] = 88
        with self.assertRaises(AssertionError):
            observer.exited(123, 0, proof)
        self.assertFalse(observer.owner.entries[key]['reaped'])


class PeekConsumeControls(unittest.TestCase):
    def test_peek_never_consumes_and_includes_wall_stops(self):
        kernel = Kernel.__new__(Kernel)
        with patch('exec_observer.os.waitid', return_value=None) as wait:
            self.assertIsNone(kernel.peek())
        wait.assert_called_once_with(os.P_ALL, 0,
            os.WEXITED | os.WSTOPPED | os.WNOHANG | os.WNOWAIT | 0x40000000)

    def test_terminal_targeted_consume_preserves_signal(self):
        kernel = Kernel.__new__(Kernel)
        pending = types.SimpleNamespace(si_pid=123, si_code=os.CLD_KILLED, si_status=9)
        with patch('exec_observer.os.waitpid', return_value=(123, 9)) as wait:
            self.assertEqual(kernel.consume(pending), (123, 9))
        wait.assert_called_once_with(123, os.WNOHANG | 0x40000000)

    def test_changed_targeted_status_refuses(self):
        kernel = Kernel.__new__(Kernel)
        pending = types.SimpleNamespace(si_pid=123, si_code=os.CLD_KILLED, si_status=9)
        with patch('exec_observer.os.waitpid', return_value=(123, 0)):
            with self.assertRaises(RuntimeError):
                kernel.consume(pending)

    def test_ptrace_event_bits_preserved(self):
        kernel = Kernel.__new__(Kernel)
        stop = 5 | (4 << 8)
        pending = types.SimpleNamespace(si_pid=123, si_code=os.CLD_TRAPPED, si_status=stop)
        status = (stop << 8) | 0x7f
        with patch('exec_observer.os.waitpid', return_value=(123, status)):
            self.assertEqual(kernel.consume(pending), (123, status))
