"""Pure synthetic controls; real processes, affinity and ptrace are forbidden."""
import copy
import signal
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import helper_affinity as affinity
import phase
import profile2
from test_argv_exit import Clock
from test_profile2 import fixture, ref


class ScopeControls(unittest.TestCase):
    def test_old_whole_process_schema_refused(self):
        grant, plan = fixture()
        grant['schema'] = 'root-literal6595-profile2-topology-grant-v1'
        with self.assertRaises(phase.Refusal): profile2.validate_scope(grant, plan)

    def test_explicit_helper_scope_and_typed_masks_required(self):
        for key, value in (('affinity_scope', 'all-H-threads'),
                ('helper_affinity_at_exec_authorized', False), ('helper_affinity_at_exec_authorized', 1),
                ('bootstrap_harness_cpus', [1, 2, 4]), ('bootstrap_harness_cpus', [True, 2, 3, 4]),
                ('workload_helper_cpus', [1, 2, 3, 4]), ('nice', 19), ('threads', 2)):
            grant, plan = fixture('B1'); grant[key] = value
            with self.subTest(key=key, value=value), self.assertRaises(phase.Refusal):
                profile2.validate_scope(grant, plan)

    def test_missing_scope_authorization_refused(self):
        grant, _ = fixture(); del grant['helper_affinity_at_exec_authorized']
        with self.assertRaises(phase.Refusal): profile2.validate_helper_scope(grant)

    def test_shared_plan_cannot_substitute_scope_or_qualification(self):
        for key, value in (('affinity_scope', 'whole-process'),
                ('bootstrap_harness_cpus', [1, 2, 4]), ('helper_affinity_at_exec_authorized', False),
                ('helper_affinity_qualification', ref('old-negative-only'))):
            grant, plan = fixture(); plan[key] = value
            with self.subTest(key=key), self.assertRaises(phase.Refusal): profile2.validate_scope(grant, plan)

    def test_all_legs_have_fixed_harness_but_selected_helper_context(self):
        for leg in profile2.LEGS:
            grant, plan = fixture(leg); profile2.validate_scope(grant, plan)
            self.assertEqual(profile2.harness_cpus(grant), [1, 2, 3, 4])
            context = profile2.context(grant)
            self.assertEqual(context['bootstrap_harness_cpus'], [1, 2, 3, 4])
            self.assertEqual(context['workload_helper_cpus'], profile2.MASKS[leg])
            self.assertEqual(context['affinity_scope'], profile2.SCOPE)
        self.assertEqual(profile2.harness_cpus({'stage': 'H10', 'cpus': [1, 2, 3, 4]}), [1, 2, 3, 4])


class AffinityStopControls(unittest.TestCase):
    def setUp(self):
        self.grant, _ = fixture('B1')
        self.clock = Clock()
        self.tracee = {'key': (20, '100'), 'start': '100', 'tgid': 20, 'thread_fd': None,
                      'stopped_status': (affinity.EXEC << 16) | (signal.SIGTRAP << 8) | 0x7f}
        self.record = {'pid': 20, 'start': '100', 'ppid': 10, 'pidfd_bound': True,
            'kernel_exec_stop_before_userspace': True, 'hash_read_from_kernel_exe_fd': True,
            'ptrace_event': affinity.EXEC, 'actual_argv': ['helper', '--threads', '3']}
        self.order = []
        self.observer = SimpleNamespace(root_key=(10, '90'), records={(10, '90'): {}},
            owner=SimpleNamespace(entries={(10, '90'): {'fd': 66}, (20, '100'): {'fd': 77}},
                                  exited=Mock(return_value=False)),
            base=SimpleNamespace(proc=Mock(return_value={'start': '100', 'ppid': 10})),
            stopped=Mock(side_effect=lambda pid: self.stop(pid)), event=Mock())
        self.mask = {1, 2, 3, 4}
        self.setter = Mock(side_effect=self.set_mask)
        self.listdir = Mock(return_value=['20'])
        self.priority = Mock(return_value=10)
        self.getter = Mock(side_effect=lambda pid: set(self.mask))
        for name, value in (('sched_setaffinity', self.setter), ('sched_getaffinity', self.getter),
                             ('listdir', self.listdir), ('getpriority', self.priority)):
            p = patch.object(affinity.os, name, value); p.start(); self.addCleanup(p.stop)

    def stop(self, pid):
        self.order.append(('stop', pid)); return self.tracee

    def set_mask(self, pid, mask):
        self.order.append(('set', pid, sorted(mask))); self.mask = mask

    def apply(self):
        return affinity.apply_at_exec(self.observer, self.record, self.grant, self.clock)

    def refused_before_mutation(self):
        with self.assertRaises(phase.Refusal): self.apply()
        self.setter.assert_not_called()
        self.assertNotIn('helper_affinity_transition', self.record)

    def test_A_and_B_set_same_bound_helper_once_between_stop_checks(self):
        for leg in ('A1', 'B1'):
            self.grant, _ = fixture(leg)
            self.mask = {1, 2, 3, 4}; self.order.clear(); self.setter.reset_mock()
            self.record.pop('helper_affinity_transition', None)
            self.apply()
            self.setter.assert_called_once_with(20, set(profile2.MASKS[leg]))
            self.assertEqual(self.order, [('stop', 20), ('set', 20, profile2.MASKS[leg]), ('stop', 20)])
            proof = self.record['helper_affinity_transition']
            self.assertEqual(proof['initial_cpus'], [1, 2, 3, 4])
            self.assertEqual(proof['selected_cpus'], profile2.MASKS[leg])
            self.assertIs(proof['harness_affinity_mutated'], False)

    def test_harness_cannot_be_mutated(self):
        self.record.update(pid=10, start='90'); self.refused_before_mutation()

    def test_record_proof_or_direct_parent_mismatch_refused(self):
        for key, value in (('ppid', 999), ('pidfd_bound', False),
                ('kernel_exec_stop_before_userspace', False), ('hash_read_from_kernel_exe_fd', False),
                ('ptrace_event', 128)):
            original = self.record[key]; self.record[key] = value
            with self.subTest(key=key): self.refused_before_mutation()
            self.record[key] = original

    def test_wrong_missing_duplicate_thread_argv_refused(self):
        for argv in (['helper', '--threads', '2'], ['helper'], ['helper', '--threads'],
                     ['helper', '--threads', '3', '--threads', '3']):
            self.record['actual_argv'] = argv
            with self.subTest(argv=argv): self.refused_before_mutation()

    def test_second_helper_or_repeated_transition_refused(self):
        self.observer.records[(30, '200')] = {}
        self.refused_before_mutation()
        del self.observer.records[(30, '200')]
        self.apply(); self.setter.reset_mock()
        with self.assertRaises(phase.Refusal): self.apply()
        self.setter.assert_not_called()

    def test_unqualified_harness_or_unbound_helper_refused(self):
        self.observer.records.clear(); self.refused_before_mutation()
        self.observer.records[(10, '90')] = {}
        del self.observer.owner.entries[(20, '100')]; self.refused_before_mutation()

    def test_changed_birth_nonleader_or_nonexec_stop_refused(self):
        for key, value in (('key', (20, '101')), ('start', '101'), ('tgid', 21), ('thread_fd', 88),
                ('stopped_status', 0), ('stopped_status', (128 << 16) | (signal.SIGTRAP << 8) | 0x7f),
                ('stopped_status', (affinity.EXEC << 16) | (signal.SIGSTOP << 8) | 0x7f)):
            original = self.tracee[key]; self.tracee[key] = value
            with self.subTest(key=key, value=value): self.refused_before_mutation()
            self.tracee[key] = original

    def test_actual_stop_verifier_failure_prevents_setter(self):
        self.observer.stopped.side_effect = phase.Refusal('actual tracer/birth mismatch')
        self.refused_before_mutation()

    def test_non_singleton_or_missing_task_inventory_refused(self):
        for tasks in ([], ['20', '21'], ['21']):
            self.listdir.return_value = tasks
            with self.subTest(tasks=tasks): self.refused_before_mutation()

    def test_exited_bound_helper_or_harness_refused(self):
        for exited_fd in (66, 77):
            self.observer.owner.exited.side_effect = lambda fd: fd == exited_fd
            with self.subTest(fd=exited_fd): self.refused_before_mutation()

    def test_parent_or_birth_changes_before_setter_refused(self):
        for info in (None, {'start': '101', 'ppid': 10}, {'start': '100', 'ppid': 999}):
            self.observer.base.proc.return_value = info
            with self.subTest(info=info): self.refused_before_mutation()

    def test_wrong_initial_mask_and_nice_refused(self):
        self.mask = {1, 2, 4}; self.refused_before_mutation()
        self.mask = {1, 2, 3, 4}; self.priority.return_value = 19; self.refused_before_mutation()

    def test_setter_failure_has_no_success_proof(self):
        self.setter.side_effect = PermissionError('mock denial')
        with self.assertRaises(PermissionError): self.apply()
        self.assertNotIn('helper_affinity_transition', self.record)
        self.observer.event.assert_not_called()

    def test_readback_mismatch_has_no_success_proof(self):
        self.setter.side_effect = None
        with self.assertRaises(phase.Refusal): self.apply()
        self.assertNotIn('helper_affinity_transition', self.record)

    def test_task_or_bound_fd_changes_after_setter_has_no_success_proof(self):
        for change in ('task', 'fd', 'tracee'):
            def mutate(pid, mask):
                self.set_mask(pid, mask)
                if change == 'task': self.listdir.return_value = ['20', '21']
                if change == 'fd': self.observer.owner.entries[(20, '100')]['fd'] = 88
                if change == 'tracee': self.tracee = dict(self.tracee)
            self.mask = {1, 2, 3, 4}; self.listdir.return_value = ['20']
            self.observer.owner.entries[(20, '100')]['fd'] = 77
            self.setter.side_effect = mutate
            with self.subTest(change=change), self.assertRaises(phase.Refusal): self.apply()
            self.assertNotIn('helper_affinity_transition', self.record)

    def test_expired_deadline_prevents_mutation(self):
        self.clock.at = self.clock.end; self.refused_before_mutation()


class CallbackControls(unittest.TestCase):
    def setUp(self):
        self.grant, _ = fixture('B1')
        self.owner = SimpleNamespace(grant=self.grant, clock=Clock(), check=Mock())
        self.approval = {'helper': {'path': '/FAKE/helper'},
                         'model': {'sha256': 'fake-model', 'chat_format': 'fake-format'}}
        self.argv = ['/FAKE/helper', '--mycarlos-model-helper', '--threads', '3', '--name',
            'FAKE test model', '--sha256', 'fake-model', '--chat-format', 'fake-format', '--model-fd', '3']
        self.record = {'pid': 20, 'actual_argv': self.argv,
                      'kernel_exec_stop_before_userspace': True, 'hash_read_from_kernel_exe_fd': True}
        self.setter = Mock()
        for module, name, value in ((phase, 'available_bytes', Mock(return_value=8 * phase.GIB)),
                (phase.os, 'sched_getaffinity', Mock(return_value={1, 2, 3, 4})),
                (phase.os, 'getpriority', Mock(return_value=10)),
                (affinity, 'apply_at_exec', self.setter)):
            p = patch.object(module, name, value); p.start(); self.addCleanup(p.stop)

    def test_full_argv2_refused_before_any_affinity_mutation(self):
        self.argv[3] = '2'
        with self.assertRaisesRegex(phase.Refusal, 'full actual EXEC-stop'):
            phase.validate_exec_image(self.owner, self.approval, None, ['harness'], 'helper', self.record)
        self.setter.assert_not_called()

    def test_harness_validates_fixed1234_without_helper_setter(self):
        self.record['actual_argv'] = ['harness']
        phase.validate_exec_image(self.owner, self.approval, None, ['harness'], 'harness', self.record)
        self.setter.assert_not_called()

    def test_selected_helper_invokes_setter_after_full_argv_check(self):
        observer = object()
        phase.validate_exec_image(self.owner, self.approval, observer, ['harness'], 'helper', self.record)
        self.setter.assert_called_once_with(observer, self.record, self.grant, self.owner.clock)

    def test_official_h10_does_not_gain_affinity_mutation(self):
        self.grant.update(stage='H10', cpus=[1, 2, 3, 4])
        phase.validate_exec_image(self.owner, self.approval, None, ['harness'], 'helper', self.record)
        self.setter.assert_not_called()


class QualificationControls(unittest.TestCase):
    def setUp(self):
        grant, _ = fixture()
        self.owner = SimpleNamespace(grant=grant, clock=Clock())
        self.sources = {name: ref(name) for name in
                        ('phase.py', 'profile2.py', 'helper_affinity.py', 'exec_observer.py')}
        self.qualified = {'schema': affinity.QUALIFICATION_SCHEMA, 'root_accepted': True,
            'actual_live_controls': True, 'coordinator_package': grant['coordinator_package'],
            'sources': self.sources, 'affinity_scope': profile2.SCOPE, 'kernel_no_children': True,
            'no_unbound_children': True, 'actual_exit_code': 0,
            'checks': {name: True for name in affinity.QUALIFICATION_CHECKS},
            'actual_artifacts': [ref('actual-A'), ref('actual-B')]}
        self.reader = Mock(return_value=b'FAKE')
        for name, value in (('file_ref', Mock(side_effect=lambda path, clock: ref(path.name))),
                ('read_json_ref', Mock(side_effect=lambda value, clock: self.qualified)),
                ('read_ref', self.reader)):
            p = patch.object(phase, name, value); p.start(); self.addCleanup(p.stop)

    def test_exact_new_source_and_actual_artifacts_required(self):
        self.assertEqual(phase.require_helper_affinity_qualification(self.owner), self.qualified)
        self.assertEqual(self.reader.call_count, 2)

    def test_old_negative_only_or_mock_acceptance_refused(self):
        for key, value in (('schema', 'root-owned-exec-stop-qualification-v1'),
                ('root_accepted', False), ('actual_live_controls', False), ('actual_exit_code', False),
                ('actual_exit_code', 1), ('kernel_no_children', False), ('no_unbound_children', False),
                ('coordinator_package', ref('old-package')), ('sources', {}), ('actual_artifacts', [])):
            original = self.qualified[key]; self.qualified[key] = value
            with self.subTest(key=key, value=value), self.assertRaises(phase.Refusal):
                phase.require_helper_affinity_qualification(self.owner)
            self.qualified[key] = original

    def test_every_actual_check_must_be_exact_true(self):
        for name in affinity.QUALIFICATION_CHECKS:
            self.qualified['checks'][name] = 1
            with self.subTest(name=name), self.assertRaises(phase.Refusal):
                phase.require_helper_affinity_qualification(self.owner)
            self.qualified['checks'][name] = True
        self.qualified['checks']['extra'] = True
        with self.assertRaises(phase.Refusal): phase.require_helper_affinity_qualification(self.owner)

    def test_artifact_hash_failure_propagates(self):
        self.reader.side_effect = phase.Refusal('artifact changed')
        with self.assertRaisesRegex(phase.Refusal, 'artifact changed'):
            phase.require_helper_affinity_qualification(self.owner)
