"""SOURCE ONLY, UNRUN alarm-boundary controls; all clocks/signals/timers are mocked."""
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import entry
import safety
from test_runtime_contracts import FakeClock


def exec_arguments(phase_end):
    return ['_exec', '--absolute-expiry-epoch', '20000', '--boot-deadline', '10000',
            '--phase-hard-boot', str(phase_end)]


class EntryDeadlineControls(unittest.TestCase):
    def invoke_entry(self, phase_end):
        with patch.multiple(entry, _ENTRY_BOOT=500, _ENTRY_WALL=10000), \
             patch.object(entry.time, 'clock_gettime', return_value=503), \
             patch.object(entry.time, 'time', return_value=10003), \
             patch.object(entry.signal, 'pthread_sigmask', return_value=set()), \
             patch.object(entry.signal, 'signal') as handlers, \
             patch.object(entry.signal, 'setitimer') as timer:
            result = entry.entry_deadline(exec_arguments(phase_end))
            return result, handlers.call_args_list, timer.call_args_list

    def test_bootstrap_elapsed_time_is_inside_original_sixty_seconds(self):
        result, handlers, timers = self.invoke_entry(1000)
        self.assertEqual(result, (20000, 10000))
        self.assertEqual(len(handlers), 4)
        # Original end560 - current503 - cleanup10 =47, never a fresh50.
        self.assertEqual(timers[0].args, (entry.signal.ITIMER_REAL, 47))

    def test_shorter_parent_phase_end_clamps_before_any_package_import(self):
        _, _, timers = self.invoke_entry(540)
        self.assertEqual(timers[0].args, (entry.signal.ITIMER_REAL, 27))

    def test_no_remaining_work_cannot_install_a_later_alarm(self):
        with patch.multiple(entry, _ENTRY_BOOT=500, _ENTRY_WALL=10000), \
             patch.object(entry.time, 'clock_gettime', return_value=503), \
             patch.object(entry.time, 'time', return_value=10003), \
             patch.object(entry.signal, 'signal') as handler, \
             patch.object(entry.signal, 'setitimer') as timer:
            with self.assertRaises(RuntimeError):
                entry.entry_deadline(exec_arguments(510))
            handler.assert_not_called()
            timer.assert_not_called()

    def test_cleanup_arms_final_reserve_even_if_work_time_is_exhausted(self):
        class FinalClock(FakeClock):
            def remaining(self, final=False):
                return 9 if final else 0
        owner = SimpleNamespace(discover=lambda: None, reap=lambda: None,
            signal_all=lambda number: None, snapshot=lambda: {'cleanup_complete': True})
        clock = FinalClock()
        with patch.object(safety, 'boot', return_value=100), \
             patch.object(safety.signal, 'setitimer') as timer:
            safety.cleanup(owner, clock)
            self.assertEqual(timer.call_args.args, (safety.signal.ITIMER_REAL, 9))
        self.assertEqual(clock.hard_end, 110)


if __name__ == '__main__':
    raise SystemExit('UNRUN source alarm controls; no signal/timer operation is authorized')
