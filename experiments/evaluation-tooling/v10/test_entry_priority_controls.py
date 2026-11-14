"""FAKE-only controls for early deadlines and inherited worker priority; UNRUN.

These controls use mocked clocks/signals and source-order assertions only. They
must not be imported or executed without a separate ROOT admission.
"""
import ast
from pathlib import Path
from types import MappingProxyType
import unittest
from unittest.mock import patch

import entry
import phase
import safety
from test_fake_interfaces import fake_neutral_kwargs
from interfaces import neutral_invocation_payload


PACKAGE = Path(__file__).parent


class FakeEnvironmentAndScorerControls(unittest.TestCase):
    def test_hostile_home_is_not_forwarded_to_model_environment(self):
        approval = {'model': {'path': '/FAKE/model.gguf', 'sha256': 'a' * 64,
                              'chat_format': 'FAKE-format'}}
        # Mock a read-only inherited mapping; never set the real HOME variable.
        with patch.object(phase.os, 'environ', MappingProxyType({'HOME': '/FAKE/hostile-home'})):
            environment = phase.command_environment(
                approval, 'H10', 'M2literal6595-FAKE-H10', PACKAGE / 'FAKE-run')
        self.assertNotIn('HOME', environment)
        self.assertNotEqual(environment.get('HOME'), '/FAKE/hostile-home')

    def test_frozen_scorer_accepts_equals_form_with_exact_bare_path(self):
        args = fake_neutral_kwargs()
        args['argv'] = [
            'FAKE-scorer',
            '--run=/FAKE/baseline.json',
            '--run=/FAKE/run.json',
        ]
        payload = neutral_invocation_payload(**args)
        self.assertEqual(
            [item['run']['path'] for item in payload['approved_scoring_runs']],
            ['/FAKE/baseline.json', '/FAKE/run.json'],
        )


class FakeEarlyAlarmControls(unittest.TestCase):
    def test_entry_deadline_arms_before_any_package_import_or_validation(self):
        source = (PACKAGE / 'entry.py').read_text(encoding='utf-8')
        module = ast.parse(source)
        main_guard = next(
            node for node in module.body
            if isinstance(node, ast.If)
            and isinstance(node.test, ast.Compare)
            and isinstance(node.test.left, ast.Name)
            and node.test.left.id == '__name__'
        )
        main_try = next(node for node in main_guard.body if isinstance(node, ast.Try))
        deadline_line = next(
            node.lineno for statement in main_try.body for node in ast.walk(statement)
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
            and node.func.id == 'entry_deadline'
        )
        verify_line = next(
            node.lineno for statement in main_try.body for node in ast.walk(statement)
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
            and node.func.id == 'verify_package_before_import'
        )
        coordinator_import_line = next(
            node.lineno for node in main_try.body
            if isinstance(node, ast.ImportFrom) and node.module == 'coordinator'
        )
        self.assertLess(deadline_line, verify_line)
        self.assertLess(verify_line, coordinator_import_line)

    def test_early_entry_alarm_reserves_ten_seconds_and_installs_handler_first(self):
        events = []

        def record_handler(number, handler):
            events.append(('handler', number))

        def record_timer(which, seconds):
            events.append(('timer', which, seconds))

        argv = [
            '_exec', '--absolute-expiry-epoch', '2000', '--boot-deadline', '2000',
            '--phase-hard-boot', '150',
        ]
        with patch.object(entry, '_ENTRY_WALL', 1000), \
             patch.object(entry, '_ENTRY_BOOT', 100), \
             patch.object(entry.time, 'time', return_value=1000), \
             patch.object(entry.time, 'clock_gettime', return_value=100), \
             patch.object(entry.signal, 'pthread_sigmask', return_value=set()), \
             patch.object(entry.signal, 'signal', side_effect=record_handler), \
             patch.object(entry.signal, 'setitimer', side_effect=record_timer):
            entry.entry_deadline(argv)

        self.assertEqual(
            [event[1] for event in events if event[0] == 'handler'],
            [entry.signal.SIGALRM, entry.signal.SIGHUP,
             entry.signal.SIGTERM, entry.signal.SIGINT],
        )
        self.assertEqual(events[-1], ('timer', entry.signal.ITIMER_REAL, 40))
        self.assertLess(
            max(i for i, event in enumerate(events) if event[0] == 'handler'),
            next(i for i, event in enumerate(events) if event[0] == 'timer'),
        )

    def test_entry_refuses_work_budget_without_cleanup_reserve(self):
        argv = [
            'phase', '--stage', 'H10', '--absolute-expiry-epoch', '1010',
            '--boot-deadline', '1010',
        ]
        with patch.object(entry, '_ENTRY_WALL', 1000), \
             patch.object(entry, '_ENTRY_BOOT', 1000), \
             patch.object(entry.time, 'time', return_value=1000), \
             patch.object(entry.time, 'clock_gettime', return_value=1000), \
             patch.object(entry.signal, 'pthread_sigmask', return_value=set()), \
             patch.object(entry.signal, 'signal') as install, \
             patch.object(entry.signal, 'setitimer') as timer:
            with self.assertRaises(RuntimeError):
                entry.entry_deadline(argv)
        install.assert_not_called()
        timer.assert_not_called()


class FakeWorkCleanupAlarmControls(unittest.TestCase):
    def test_work_alarm_rearms_only_for_remaining_bounded_cleanup(self):
        owner = type('FakeOwner', (), {
            'discover': lambda self: None,
            'signal_all': lambda self, number: None,
            'reap': lambda self: None,
            'snapshot': lambda self: {
                'cleanup_complete': True, 'kernel_no_children': True,
            },
        })()
        with patch.object(safety, 'boot', return_value=100), \
             patch.object(safety.signal, 'signal'), \
             patch.object(safety.signal, 'setitimer') as timer:
            clock = safety.budget(60, 9_000_000_000, 160, cleanup=10)
            original_hard_end = clock.hard_end
            result = safety.cleanup(owner, clock)

        self.assertEqual(original_hard_end, 160)
        self.assertEqual(clock.hard_end, 110)
        self.assertTrue(result['cleanup_complete'])
        self.assertEqual(
            [call.args[1] for call in timer.call_args_list], [50, 0, 10])


def _ordered_calls(path, function_name):
    module = ast.parse(path.read_text(encoding='utf-8'))
    function = next(
        node for node in module.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        and node.name == function_name
    )
    calls = [node for node in ast.walk(function) if isinstance(node, ast.Call)]
    return sorted(calls, key=lambda node: (node.lineno, node.col_offset))


def _call_name(call):
    if isinstance(call.func, ast.Name):
        return call.func.id
    if isinstance(call.func, ast.Attribute):
        return call.func.attr
    return None


def _priority_value(call):
    if _call_name(call) != 'setpriority' or len(call.args) != 3:
        return None
    value = call.args[2]
    return value.value if isinstance(value, ast.Constant) else None


class FakePriorityInheritanceControls(unittest.TestCase):
    def test_coordinator_and_guard_demote_only_after_spawning_nice10_children(self):
        coordinator_calls = _ordered_calls(PACKAGE / 'coordinator.py', 'run_phase')
        c_priority_10 = next(i for i, call in enumerate(coordinator_calls)
                              if _priority_value(call) == 10)
        spawn_guard = next(i for i, call in enumerate(coordinator_calls)
                           if _call_name(call) == 'spawn_gated')
        c_priority_19 = next(i for i, call in enumerate(coordinator_calls)
                              if _priority_value(call) == 19)
        self.assertLess(c_priority_10, spawn_guard)
        self.assertLess(spawn_guard, c_priority_19)

        guard_calls = _ordered_calls(PACKAGE / 'phase.py', 'run_guard')
        spawn_harness = next(i for i, call in enumerate(guard_calls)
                             if _call_name(call) == 'spawn_gated')
        g_priority_19 = next(i for i, call in enumerate(guard_calls)
                             if _priority_value(call) == 19)
        self.assertLess(spawn_harness, g_priority_19)
        self.assertFalse(any(_priority_value(call) == 19
                             for call in guard_calls[:spawn_harness]))

    def test_exec_child_sets_nice10_before_replacing_it_with_model_harness(self):
        calls = _ordered_calls(PACKAGE / 'phase.py', 'exec_harness')
        priority_10 = next(i for i, call in enumerate(calls)
                           if _priority_value(call) == 10)
        replace_process = next(i for i, call in enumerate(calls)
                              if _call_name(call) == 'execve')
        self.assertLess(priority_10, replace_process)


if __name__ == '__main__':
    raise SystemExit('FAKE controls are authored and unrun; ROOT admission is required')
