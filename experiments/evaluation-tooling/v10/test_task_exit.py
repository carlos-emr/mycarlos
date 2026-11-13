"""Exit interleavings for the exact task observer; every process API is mocked."""
import unittest
from unittest.mock import Mock, patch

import phase
from test_argv_exit import Clock


def task_stat(start='100'):
    return b'20 (helper) ' + b' '.join([b'S'] + [b'0'] * 18 + [start.encode()])


class TaskExitTests(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.fd = 77
        self.exited = Mock(return_value=False)
        self.proc = Mock(return_value={'start': '100', 'ppid': 10})
        self.listdir = Mock(return_value=['20'])
        self.read = Mock(side_effect=lambda pid, name, cap:
                         b'Tgid:\t20\n' if name.endswith('/status') else task_stat())
        self.affinity = Mock(return_value={1, 2, 3, 4})
        self.priority = Mock(return_value=10)
        for module, name, value in (
            (phase.base, 'proc', self.proc),
            (phase.base.Owned, 'exited', self.exited),
            (phase.os, 'listdir', self.listdir),
            (phase, 'proc_bytes', self.read),
            (phase.os, 'sched_getaffinity', self.affinity),
            (phase.os, 'getpriority', self.priority),
            (phase.time, 'sleep', self.clock.sleep),
        ):
            p = patch.object(module, name, value)
            p.start()
            self.addCleanup(p.stop)

    def observe(self):
        return phase.observe_tasks(20, '100', self.fd, self.clock)

    def delayed_exit(self):
        self.exited.side_effect = lambda fd: self.clock.at >= .03

    def test_stable_live_observation_passes(self):
        self.assertEqual(self.observe(), [
            {'tid': 20, 'start': '100', 'cpus': [1, 2, 3, 4], 'nice': 10}])
        self.exited.assert_called_once_with(self.fd)

    def test_exit_after_successful_final_poll_does_not_create_a_second_refusal(self):
        self.exited.side_effect = [False, True]
        self.assertEqual(len(self.observe()), 1)
        self.exited.assert_called_once_with(self.fd)
        self.assertTrue(self.exited(self.fd))

    def test_ready_bound_exit_is_instance_exited(self):
        self.exited.return_value = True
        with self.assertRaises(phase.InstanceExited):
            self.observe()

    def test_missing_directory_waits_for_same_bound_exit(self):
        self.listdir.side_effect = FileNotFoundError()
        self.delayed_exit()
        with self.assertRaises(phase.InstanceExited):
            self.observe()
        self.assertAlmostEqual(self.clock.at, .03)
        self.assertTrue(all(c.args == (self.fd,) for c in self.exited.call_args_list))

    def test_missing_final_stat_waits_for_same_bound_exit(self):
        self.proc.return_value = None
        self.delayed_exit()
        with self.assertRaises(phase.InstanceExited):
            self.observe()
        self.assertAlmostEqual(self.clock.at, .03)

    def test_empty_task_set_waits_for_same_bound_exit(self):
        self.listdir.return_value = []
        self.delayed_exit()
        with self.assertRaises(phase.InstanceExited):
            self.observe()

    def test_all_disappearing_tasks_wait_for_same_bound_exit(self):
        self.read.side_effect = ProcessLookupError()
        self.delayed_exit()
        with self.assertRaises(phase.InstanceExited):
            self.observe()

    def test_persistent_live_missing_metadata_fails_within_half_second(self):
        self.proc.return_value = None
        with self.assertRaisesRegex(phase.Refusal, 'without bound exit'):
            self.observe()
        self.assertAlmostEqual(self.clock.at, .5)

    def test_missing_metadata_cannot_extend_original_deadline(self):
        self.clock.end = .02
        self.proc.return_value = None
        with self.assertRaisesRegex(phase.Refusal, 'original deadline'):
            self.observe()
        self.assertAlmostEqual(self.clock.at, .02)

    def test_changed_process_birth_is_not_waived_by_exit(self):
        self.proc.return_value = {'start': '200'}
        self.exited.return_value = True
        with self.assertRaisesRegex(phase.Refusal, 'birth changed'):
            self.observe()
        self.exited.assert_not_called()

    def test_changed_task_birth_is_not_waived_by_exit(self):
        self.read.side_effect = [task_stat(), task_stat('200'), b'Tgid:\t20\n']
        self.exited.return_value = True
        with self.assertRaisesRegex(phase.Refusal, 'task birth changed'):
            self.observe()
        self.exited.assert_not_called()

    def test_wrong_task_constraints_are_not_waived_by_exit(self):
        for affinity, priority, tgid in [({0}, 10, 20), ({1, 2, 3, 4}, 19, 20),
                                        ({1, 2, 3, 4}, 10, 21)]:
            with self.subTest(affinity=affinity, priority=priority, tgid=tgid):
                self.affinity.return_value = affinity
                self.priority.return_value = priority
                self.read.side_effect = lambda pid, name, cap: (
                    ('Tgid:\t' + str(tgid) + '\n').encode()
                    if name.endswith('/status') else task_stat())
                self.exited.return_value = True
                with self.assertRaisesRegex(phase.Refusal, 'CPU/nice differs'):
                    self.observe()
                self.exited.assert_not_called()

    def test_permission_errors_are_not_exit_proof(self):
        for failing in (self.listdir, self.read):
            with self.subTest(api=failing):
                original = failing.side_effect
                failing.side_effect = PermissionError()
                with self.assertRaises(PermissionError):
                    self.observe()
                self.exited.assert_not_called()
                failing.side_effect = original

    def test_pidfd_error_is_not_exit_proof(self):
        self.exited.side_effect = OSError('bad fd')
        with self.assertRaises(OSError):
            self.observe()
