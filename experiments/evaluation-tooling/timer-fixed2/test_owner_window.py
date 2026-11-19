"""Pure mocked weekend-owner clock controls; no real grants or process operations."""
from contextlib import ExitStack
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import coordinator
import entry
import guard_support as base
import safety

SATURDAY = 1794618000  # Synthetic 2026-11-14T01:00:00Z.
MONDAY = SATURDAY + 2 * 86400
PACKAGE = {'path': '/FAKE/source-manifest.json', 'sha256': 'a' * 64}


class OwnerEntryControls(unittest.TestCase):
    def invoke(self, command='phase', wall=SATURDAY, span=7200, boot_end=8200,
               current_wall=None, current_boot=1000, parent_end=7000):
        argv = [command, '--absolute-expiry-epoch', str(wall + span),
                '--boot-deadline', str(boot_end)]
        if command != '_exec':
            argv += ['--stage', 'H10']
        if command in ('_guard', '_exec'):
            argv += ['--phase-hard-boot', str(parent_end)]
        with patch.multiple(entry, _ENTRY_BOOT=1000, _ENTRY_WALL=wall), \
             patch.object(entry.time, 'time', return_value=wall if current_wall is None else current_wall), \
             patch.object(entry.time, 'clock_gettime', return_value=current_boot), \
             patch.object(entry.signal, 'pthread_sigmask', return_value=set()), \
             patch.object(entry.signal, 'signal'), \
             patch.object(entry.signal, 'setitimer') as timer:
            result = entry.entry_deadline(argv)
            return result, timer.call_args.args[1]

    def test_saturday_and_monday_entry_keep_three_thousand_second_cap(self):
        for wall in (SATURDAY, MONDAY):
            with self.subTest(wall=wall):
                result, alarm = self.invoke(wall=wall)
                self.assertEqual(result, (wall + 7200, 8200))
                self.assertEqual(alarm, 2990)

    def test_guard_inherits_shorter_original_phase_end(self):
        self.assertEqual(self.invoke('_guard', parent_end=1200)[1], 190)

    def test_exec_elapsed_time_stays_inside_original_sixty_seconds(self):
        self.assertEqual(self.invoke('_exec', current_boot=1007, current_wall=SATURDAY + 7)[1], 43)

    def test_utc_and_boottime_each_independently_shorten_entry(self):
        self.assertEqual(self.invoke(span=75)[1], 65)
        self.assertEqual(self.invoke(boot_end=1060)[1], 50)

    def test_backward_wall_step_cannot_extend_original_boot_cap(self):
        self.assertEqual(self.invoke(current_wall=SATURDAY - 86400)[1], 2990)

    def test_forward_wall_step_limits_remaining_budget(self):
        self.assertEqual(self.invoke(current_wall=SATURDAY + 7190 - 1)[1], 1)

    def test_expired_or_cleanup_only_window_refuses_before_timer(self):
        for kwargs in ({'span': 0}, {'boot_end': 1000}, {'span': 10},
                       {'current_wall': SATURDAY + 7200}):
            with self.subTest(kwargs=kwargs), self.assertRaises(RuntimeError):
                self.invoke(**kwargs)

    def test_nonfinite_utc_boot_and_parent_deadlines_refuse(self):
        for number in (float('inf'), -float('inf'), float('nan')):
            for kwargs in ({'span': number}, {'boot_end': number}, {'parent_end': number}):
                with self.subTest(kwargs=kwargs), self.assertRaises(RuntimeError):
                    self.invoke('_guard', **kwargs)


class OwnerBudgetControls(unittest.TestCase):
    def setUp(self):
        self.boot = 1000
        self.wall = SATURDAY
        original = base.Budget
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.object(safety, 'boot', side_effect=lambda: self.boot))
        self.stack.enter_context(patch.object(base, 'Budget', side_effect=lambda *a, **kw:
            original(*a, **kw, wall=lambda: self.wall)))
        self.stack.enter_context(patch.object(safety.signal, 'signal'))
        self.timer = self.stack.enter_context(patch.object(safety.signal, 'setitimer'))

    def test_weekend_budget_retains_phase_cap_and_ten_second_reserve(self):
        for stage in ('H10', 'M8'):
            clock = safety.budget(safety.PHASE_CAPS[stage], self.wall + 7200, 8200)
            self.assertEqual((clock.hard_end, clock.work_end), (4000, 3990))
            self.assertEqual(self.timer.call_args.args[1], 2990)

    def test_each_independent_budget_limit_can_be_the_earliest(self):
        for relative, span, boot_end, expected in ((3000, 90, 8200, 1090),
                (3000, 7200, 1200, 1200), (50, 7200, 8200, 1050)):
            clock = safety.budget(relative, self.wall + span, boot_end)
            self.assertEqual(clock.hard_end, expected)
            self.assertEqual(clock.work_end, expected - 10)

    def test_expired_and_cleanup_only_budget_refuses(self):
        for span, boot_end in ((0, 8200), (10, 8200), (7200, 1000), (7200, 1010)):
            with self.subTest(span=span, boot_end=boot_end), self.assertRaises(safety.Refusal):
                safety.budget(3000, self.wall + span, boot_end)

    def test_forward_wall_step_still_expires_a_running_budget(self):
        clock = safety.budget(3000, self.wall + 7200, 8200)
        self.wall += 7200
        with self.assertRaises(safety.Refusal):
            clock.check(final=True)

    def test_boottime_expiry_survives_backward_wall_step(self):
        clock = safety.budget(3000, self.wall + 7200, 8200)
        self.wall -= 86400
        self.boot = 4000
        with self.assertRaises(safety.Refusal):
            clock.check(final=True)

    def test_cleanup_never_extends_original_hard_deadline(self):
        clock = safety.budget(3000, self.wall + 7200, 8200)
        self.boot = 3993
        owner = SimpleNamespace(discover=Mock(), reap=Mock(), signal_all=Mock(),
            snapshot=lambda: {'cleanup_complete': True})
        safety.cleanup(owner, clock)
        self.assertEqual(clock.hard_end, 4000)
        self.assertEqual(self.timer.call_args.args[1], 7)


def fake_grant(wall=SATURDAY):
    return {'coordinator_package': PACKAGE,
        'schema': 'root-timer12f874-model-evaluation-grant-v1',
        'purpose': 'pr316-known-H10-M8-model-evaluation',
        'candidate_head': safety.HEAD, 'candidate_tree': safety.TREE,
        'stage': 'H10', 'stages': ['H10'], 'model_execution_authorized': True,
        'retain_existing_root_pr_validation_hold': True,
        'own_descendant_ptrace_authorized': True,
        'kernel_exec_observer_mode': 'owned-descendant-PTRACE_SEIZE-TRACEEXEC-v1',
        'attempt': 'FAKE', 'candidate_label': 'M2timer12f874-FAKE-H10',
        'output_directory': '/FAKE/output', 'absolute_expiry_epoch': wall + 7200,
        'boot_deadline': 8200, 'max_total_seconds': 7200, 'issued_at_epoch': wall,
        'target_seconds_per_document': 180, 'preserve_original_strict_quality': True,
        'cpus': [1, 2, 3, 4], 'nice': 10, 'threads': 3, 'language': 'en',
        'start_memory_bytes': 8 * safety.GIB, 'stop_memory_bytes': 4 * safety.GIB}


class OwnerAuthorityControls(unittest.TestCase):
    def create(self, grant, current_wall=SATURDAY, wall=None, boot_end=None):
        clock = SimpleNamespace(started=1000, hard_end=4000, work_end=3990, arm=Mock())
        with patch.object(safety, 'read_json_ref', return_value=grant), \
             patch.object(safety.time, 'time', return_value=current_wall), \
             patch.object(safety.os, 'stat'), patch.object(safety.Authority, 'check'):
            authority = safety.Authority({'path': '/FAKE/grant', 'sha256': 'b' * 64}, clock,
                grant['absolute_expiry_epoch'] if wall is None else wall,
                grant['boot_deadline'] if boot_end is None else boot_end, PACKAGE)
        return authority

    def test_weekend_grant_keeps_phase_end_and_original_quality(self):
        for wall in (SATURDAY, MONDAY):
            authority = self.create(fake_grant(wall), current_wall=wall)
            self.assertEqual((authority.clock.hard_end, authority.clock.work_end), (4000, 3990))
            self.assertEqual(authority.grant['target_seconds_per_document'], 180)
            self.assertIs(authority.grant['preserve_original_strict_quality'], True)

    def test_nonpositive_nonfinite_and_over_two_hour_maximum_refuse(self):
        for value in (0, -1, 7201, float('inf'), float('nan')):
            grant = fake_grant(); grant['max_total_seconds'] = value
            with self.subTest(value=value), self.assertRaises(safety.Refusal):
                self.create(grant)

    def test_old_or_future_issue_time_cannot_extend_window(self):
        for issued in (SATURDAY - 1, SATURDAY + 1):
            grant = fake_grant(); grant['issued_at_epoch'] = issued
            with self.subTest(issued=issued), self.assertRaises(safety.Refusal):
                self.create(grant)

    def test_supplied_deadlines_must_equal_immutable_grant_deadlines(self):
        for values in ({'wall': SATURDAY + 7201}, {'boot_end': 8201}):
            with self.subTest(values=values), self.assertRaises(safety.Refusal):
                self.create(fake_grant(), **values)

    def test_shorter_grant_maximum_only_reduces_existing_end(self):
        grant = fake_grant(); grant['max_total_seconds'] = 60
        authority = self.create(grant)
        self.assertEqual((authority.clock.hard_end, authority.clock.work_end), (1060, 1050))

    def test_running_grant_utc_or_boot_expiry_refuses_before_artifact_access(self):
        authority = self.create(fake_grant())
        for wall, boot in ((SATURDAY + 7200, 1000), (SATURDAY, 8200)):
            with patch.object(safety.time, 'time', return_value=wall), \
                 patch.object(safety, 'boot', return_value=boot), \
                 patch.object(safety.os, 'stat') as stat:
                with self.assertRaises(safety.Refusal):
                    authority.check()
                stat.assert_not_called()

    def test_partial_window_cannot_start_a_full_phase(self):
        clock = SimpleNamespace(started=1000, hard_end=3994, work_end=3984,
            check=Mock(), arm=Mock(), remaining=lambda final=False: 2994)
        grant = fake_grant()
        args = SimpleNamespace(stage='H10', grant='/FAKE/grant', grant_sha256='b' * 64,
            package_manifest=PACKAGE['path'], package_manifest_sha256=PACKAGE['sha256'],
            out='/FAKE/output')
        with patch.object(coordinator, 'budget', return_value=clock), \
             patch.object(coordinator, 'Authority', return_value=SimpleNamespace(grant=grant)), \
             patch.object(coordinator.os, 'sched_setaffinity') as affinity, \
             patch.object(coordinator.os, 'setpriority') as priority:
            with self.assertRaisesRegex(safety.Refusal, 'full phase cap'):
                coordinator.run_phase(args, (SATURDAY + 7200, 8200), 1000)
            affinity.assert_not_called()
            priority.assert_not_called()


if __name__ == '__main__':
    raise SystemExit('Use the separately bounded mocked harness; no real process operations.')
