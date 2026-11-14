import unittest
from unittest.mock import Mock, patch
import phase

class Clock:
    def __init__(self, end=10): self.at=0.; self.end=end
    def clock(self): return self.at
    def remaining(self): return max(0.,self.end-self.at)
    def check(self): phase.require(self.at<self.end,'original deadline')
    def sleep(self,n): self.at+=n

class ArgvExitTests(unittest.TestCase):
    def setUp(self):
        self.clock=Clock(); self.info={'start':'100','ppid':10}; self.fd=77
        self.proc=Mock(return_value=self.info); self.exited=Mock(return_value=False)
        self.read=Mock(return_value=b'helper\0--threads\0' + b'3\0')
        self.expected=['helper','--threads','3']
        for target,name,value in [(phase.base,'proc',self.proc),(phase.base.Owned,'exited',self.exited),
                                  (phase,'proc_bytes',self.read),(phase.time,'sleep',self.clock.sleep)]:
            p=patch.object(target,name,value); p.start(); self.addCleanup(p.stop)
    def observe(self): return phase.observe_helper_argv(20,'100',self.fd,self.expected,self.clock)
    def test_live_matching_argv(self): self.assertEqual(self.observe(),self.expected)
    def test_exit_before_read_uses_bound_fd(self):
        self.exited.return_value=True
        with self.assertRaises(phase.InstanceExited): self.observe()
        self.read.assert_not_called(); self.exited.assert_called_once_with(self.fd)
    def test_empty_before_pidfd_readiness_waits_for_same_bound_exit(self):
        self.read.return_value=b''; self.exited.side_effect=lambda fd:self.clock.at>=.03
        with self.assertRaises(phase.InstanceExited): self.observe()
        self.assertGreaterEqual(self.clock.at,.03); self.assertLess(self.clock.at,.5)
        self.assertTrue(all(c.args==(self.fd,) for c in self.exited.call_args_list))
    def test_persistent_empty_live_process_fails_bounded(self):
        self.read.return_value=b''
        with self.assertRaisesRegex(phase.Refusal,'without bound exit'): self.observe()
        self.assertAlmostEqual(self.clock.at,.5)
    def test_missing_cmdline_needs_bound_exit(self):
        self.read.side_effect=FileNotFoundError(); self.exited.side_effect=lambda fd:self.clock.at>=.02
        with self.assertRaises(phase.InstanceExited): self.observe()
    def test_missing_stat_needs_bound_exit(self):
        self.proc.return_value=None; self.exited.side_effect=lambda fd:self.clock.at>=.02
        with self.assertRaises(phase.InstanceExited): self.observe()
        self.read.assert_not_called()
    def test_original_deadline_cannot_be_extended(self):
        self.clock.end=.02; self.read.return_value=b''
        with self.assertRaisesRegex(phase.Refusal,'original deadline'): self.observe()
        self.assertAlmostEqual(self.clock.at,.02)
    def test_nonempty_mismatch_remains_failure_even_if_exit_follows(self):
        self.read.return_value=b'wrong\0'; self.exited.side_effect=[False,True]
        with self.assertRaisesRegex(phase.Refusal,'argv differs'): self.observe()
        self.assertEqual(self.exited.call_count,1)
    def test_nonempty_all_nuls_is_mismatch_not_empty_exit_transition(self):
        self.read.return_value=b'\0'
        with self.assertRaisesRegex(phase.Refusal,'argv differs'): self.observe()
        self.assertEqual(self.clock.at,0)
    def test_birth_change_before_read_refused(self):
        self.proc.return_value={'start':'other'}
        with self.assertRaisesRegex(phase.Refusal,'birth changed before'): self.observe()
    def test_birth_change_after_read_refused(self):
        self.proc.side_effect=[self.info,{'start':'other'}]
        with self.assertRaisesRegex(phase.Refusal,'birth changed after'): self.observe()
    def test_birth_change_during_empty_transition_refused(self):
        self.proc.side_effect=[self.info,{'start':'other'}]; self.read.return_value=b''
        with self.assertRaisesRegex(phase.Refusal,'birth changed during'): self.observe()
    def test_permission_error_is_not_an_exit(self):
        self.read.side_effect=PermissionError()
        with self.assertRaises(PermissionError): self.observe()
    def test_pidfd_error_is_not_an_exit(self):
        self.exited.side_effect=OSError('badfd')
        with self.assertRaises(OSError): self.observe()
    def test_valid_argv_then_bound_exit_is_not_reclassified_as_mismatch(self):
        self.exited.side_effect=[False,True]
        with self.assertRaises(phase.InstanceExited): self.observe()
