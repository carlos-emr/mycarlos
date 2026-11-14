"""Synthetic fixed-two scope controls. No actual model, process or grant is used."""
import copy
import hashlib
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import entry
import interfaces
import phase
import profile2
import safety
import test_task_exit as tasks
from test_fake_interfaces import fake_completion_kwargs, fake_document, fake_neutral_kwargs
from test_owner_window import PACKAGE, SATURDAY, fake_grant
from test_runtime_contracts import FakeClock, fake_run_fixture


def ref(name):
    return {'path': '/FAKE/' + name, 'sha256': 'a' * 64}


def fixture(leg='A1'):
    grant = fake_grant()
    grant.update(schema=profile2.GRANT_SCHEMA, purpose=profile2.PURPOSE, stage='P2', stages=['P2'],
        attempt='FAKE_' + leg, candidate_label='M2literal6595-FAKE_' + leg + '-P2',
        profile_experiment='FAKE', profile_leg=leg, cpus=list(profile2.MASKS[leg]),
        bootstrap_harness_cpus=[1, 2, 3, 4], workload_helper_cpus=list(profile2.MASKS[leg]),
        affinity_scope=profile2.SCOPE, helper_affinity_at_exec_authorized=True,
        helper_affinity_qualification=ref('helper-affinity-qualification'),
        diagnostic_only=True, adoption_authorized=False, h10_acceptance=None,
        profile_plan=ref('plan'), runtime_approval=ref('runtime'), source_inventory=ref('source'),
        approved_roster=ref('roster'), holder={'pid': 999999, 'start': '123', 'fd': 3},
        output_directory='/FAKE/output-' + leg)
    plan = {'schema': profile2.PLAN_SCHEMA, 'experiment': 'FAKE',
        'sequence': [{'leg': name, 'cpus': list(profile2.MASKS[name]),
                      'workload_helper_cpus': list(profile2.MASKS[name])} for name in profile2.LEGS],
        'affinity_scope': profile2.SCOPE, 'bootstrap_harness_cpus': [1, 2, 3, 4],
        'helper_affinity_at_exec_authorized': True,
        'threads': 3, 'phase_cap_seconds': 600, 'documents_directory_sha256': profile2.DOCUMENTS_SHA256,
        'diagnostic_only': True, 'adoption_authorized': False,
        'outputs': {name: '/FAKE/output-' + name for name in profile2.LEGS},
        'owner_absolute_expiry_epoch': SATURDAY + 7200, 'owner_boot_deadline': 8200,
        'owner_issued_at_epoch': SATURDAY, 'h10_completion': ref('H10-completion'),
        'h10_verification': ref('H10-root-proof')}
    for key in ('runtime_approval', 'source_inventory', 'coordinator_package', 'approved_roster',
                'holder', 'helper_affinity_qualification'):
        plan[key] = copy.deepcopy(grant[key])
    return grant, plan


def authority(grant, plan):
    clock = SimpleNamespace(started=1000, hard_end=1600, work_end=1590, arm=Mock())
    def read(value, clock):
        return grant if value['path'] == '/FAKE/grant' else plan
    with patch.object(safety, 'read_json_ref', side_effect=read), \
         patch.object(safety.time, 'time', return_value=SATURDAY), \
         patch.object(safety.os, 'stat'), patch.object(safety.Authority, 'check'):
        return safety.Authority(ref('grant'), clock, grant['absolute_expiry_epoch'],
                                grant['boot_deadline'], PACKAGE)


class ProfileGrantControls(unittest.TestCase):
    def test_all_four_legs_have_exact_masks_and_same_six_hundred_second_cap(self):
        for leg in profile2.LEGS:
            grant, plan = fixture(leg)
            result = authority(grant, plan)
            self.assertEqual(result.grant['cpus'], profile2.MASKS[leg])
            self.assertEqual(result.clock.hard_end, 1600)
            self.assertEqual(result.clock.work_end, 1590)

    def test_official_h10_and_m8_still_refuse_cpu124(self):
        for stage in ('H10', 'M8'):
            grant = fake_grant()
            grant.update(stage=stage, stages=[stage], candidate_label='M2literal6595-FAKE-' + stage,
                         cpus=[1, 2, 4])
            with self.subTest(stage=stage), self.assertRaises(safety.Refusal):
                authority(grant, None)

    def test_profile_and_official_grants_cannot_be_interchanged(self):
        for field, value in (('schema', 'root-literal6595-model-evaluation-grant-v1'),
                             ('purpose', 'pr313-known-H10-M8-model-evaluation')):
            grant, plan = fixture(); grant[field] = value
            with self.subTest(field=field), self.assertRaises(safety.Refusal):
                authority(grant, plan)
        grant, plan = fixture(); grant.update(stage='H10', stages=['H10'])
        with self.assertRaises(safety.Refusal):
            authority(grant, plan)

    def test_wrong_mask_leg_threads_and_adoption_refuse(self):
        for key, value in (('cpus', [1, 2, 4]), ('cpus', [0, 1, 2]), ('cpus', [True, 2, 3, 4]),
                ('threads', 4), ('profile_leg', 'B3'), ('diagnostic_only', False),
                ('adoption_authorized', True), ('h10_acceptance', ref('unrelated-grade'))):
            grant, plan = fixture(); grant[key] = value
            with self.subTest(key=key, value=value), self.assertRaises(safety.Refusal):
                authority(grant, plan)

    def test_plan_rejects_reordered_or_extra_legs(self):
        for sequence in (list(reversed(fixture()[1]['sequence'])), fixture()[1]['sequence'][:3]):
            grant, plan = fixture(); plan['sequence'] = sequence
            with self.assertRaises(safety.Refusal):
                authority(grant, plan)

    def test_all_legs_share_runtime_source_inputs_package_and_holder(self):
        for key in ('runtime_approval', 'source_inventory', 'approved_roster', 'coordinator_package', 'holder'):
            grant, plan = fixture(); plan[key] = ref('substituted')
            with self.subTest(key=key), self.assertRaises(safety.Refusal):
                authority(grant, plan)

    def test_plan_owner_window_cannot_be_extended_or_nonfinite(self):
        for key, value in (('owner_absolute_expiry_epoch', SATURDAY + 7199),
                ('owner_boot_deadline', 8199), ('owner_issued_at_epoch', SATURDAY - 1),
                ('owner_issued_at_epoch', SATURDAY + 1), ('owner_boot_deadline', float('inf'))):
            grant, plan = fixture(); plan[key] = value
            with self.subTest(key=key), self.assertRaises(safety.Refusal):
                authority(grant, plan)

    def test_exact_distinct_absolute_outputs_required(self):
        for changed in ('duplicate', 'relative', 'traversal', 'wrong_current'):
            grant, plan = fixture()
            if changed == 'duplicate': plan['outputs']['B1'] = plan['outputs']['A1']
            if changed == 'relative': plan['outputs']['B1'] = 'relative'
            if changed == 'traversal': plan['outputs']['B1'] = '/FAKE/../other'
            if changed == 'wrong_current': grant['output_directory'] = '/FAKE/other'
            with self.subTest(changed=changed), self.assertRaises(safety.Refusal):
                authority(grant, plan)

    def test_profile_cannot_change_fixed_input_digest_or_phase_cap(self):
        for key, value in (('documents_directory_sha256', 'b' * 64), ('phase_cap_seconds', 1500)):
            grant, plan = fixture(); plan[key] = value
            with self.assertRaises(safety.Refusal):
                authority(grant, plan)

    def test_profile_entry_reserves_cleanup_inside_six_hundred_seconds(self):
        argv = ['phase', '--stage', 'P2', '--absolute-expiry-epoch', str(SATURDAY + 7200),
                '--boot-deadline', '8200']
        with patch.multiple(entry, _ENTRY_BOOT=1000, _ENTRY_WALL=SATURDAY), \
             patch.object(entry.time, 'time', return_value=SATURDAY), \
             patch.object(entry.time, 'clock_gettime', return_value=1000), \
             patch.object(entry.signal, 'pthread_sigmask', return_value=set()), \
             patch.object(entry.signal, 'signal'), patch.object(entry.signal, 'setitimer') as timer:
            entry.entry_deadline(argv)
            self.assertEqual(timer.call_args.args[1], 590)


class ProfileObservationControls(unittest.TestCase):
    def test_task_observation_checks_selected_mask_and_keeps_official_default(self):
        test = tasks.TaskExitTests('test_stable_live_observation_passes'); test.setUp()
        try:
            test.affinity.return_value = {1, 2, 4}
            observed = phase.observe_tasks(20, '100', 77, test.clock, [1, 2, 4])
            self.assertEqual(observed[0]['cpus'], [1, 2, 4])
            with self.assertRaisesRegex(safety.Refusal, 'CPU/nice differs'):
                phase.observe_tasks(20, '100', 77, test.clock)
            with self.assertRaisesRegex(safety.Refusal, 'unsupported task CPU'):
                phase.observe_tasks(20, '100', 77, test.clock, [0])
        finally:
            test.doCleanups()

    def test_profile_wrong_priority_remains_failure(self):
        test = tasks.TaskExitTests('test_stable_live_observation_passes'); test.setUp()
        try:
            test.affinity.return_value = {1, 2, 4}; test.priority.return_value = 19
            with self.assertRaisesRegex(safety.Refusal, 'CPU/nice differs'):
                phase.observe_tasks(20, '100', 77, test.clock, [1, 2, 4])
        finally:
            test.doCleanups()

    def test_two_case_completion_requires_exact_end_and_three_threads(self):
        rows, owner, staged, approval, guard = fake_run_fixture()
        rows = [rows[0], rows[1], rows[2], rows[-1]]
        label = 'M2literal6595-FAKE_A1-P2'
        owner.grant['candidate_label'] = rows[0]['variant'] = label
        staged['manifest'] = {row['id']: rows[0]['documents'][row['id']] for row in rows[1:-1]}
        rows[0]['documents'] = staged['manifest']; rows[-1]['answered'] = 2
        for bad in (None, 'count', 'threads'):
            values = copy.deepcopy(rows)
            if bad == 'count': values[-1]['answered'] = 10
            if bad == 'threads': values[1]['result']['stats']['batchThreads'] = 4
            data = b''.join(json.dumps(row).encode() + b'\n' for row in values)
            with patch.object(phase.base, 'read_path', return_value=data):
                if bad is None:
                    self.assertEqual(phase.completed_run(owner, 'P2', Path('/FAKE'), staged, approval, guard)[1]['documents'], 2)
                else:
                    with self.assertRaises(safety.Refusal):
                        phase.completed_run(owner, 'P2', Path('/FAKE'), staged, approval, guard)

    def test_profile_completion_is_distinct_diagnostic_and_not_adoption(self):
        args = fake_completion_kwargs(); grant, _ = fixture()
        args.update(stage='P2', label=grant['candidate_label'])
        args['header'].update(variant=grant['candidate_label'], documents={'FAKE-0': {}, 'FAKE-1': {}})
        args['guard'].update(stage='P2', candidate_label=grant['candidate_label'],
                             diagnostic_only=True, profile=profile2.context(grant))
        result = interfaces.completion_payload(**args)
        self.assertEqual(result['schema'], 'candidate6595-profile2-helper-affinity-completion-v1')
        self.assertIs(result['diagnostic_only'], True)
        self.assertIs(result['adoption_authorized'], False)
        args['guard']['diagnostic_only'] = False
        with self.assertRaises(ValueError): interfaces.completion_payload(**args)

    def test_profile_is_not_an_official_neutral_scoring_stage(self):
        args = fake_neutral_kwargs(); args['stage'] = 'P2'
        with self.assertRaises(ValueError): interfaces.neutral_invocation_payload(**args)


def roster_fixture():
    documents = [fake_document('FAKE-0'), fake_document('FAKE-1', lang='fr')]
    blobs = {doc['id']: json.dumps(doc).encode() for doc in documents}
    approved = {'schema': 'candidate6595-profile2-roster-v1', 'candidate_head': interfaces.HEAD,
        'candidate_tree': interfaces.TREE, 'stage': 'P2', 'documents': {},
        'documents_directory_sha256': hashlib.sha256(b''.join(blobs.values())).hexdigest(),
        'freeze': {'path': '/FAKE/freeze', 'sha256': profile2.INPUT_FREEZE_SHA256}}
    raw = {'/FAKE/freeze': b'FAKE fixed-input selection'}
    for doc in documents:
        path = '/FAKE/' + doc['id']
        raw[path] = blobs[doc['id']]
        approved['documents'][doc['id']] = {'docLang': doc['lang'],
            'source_document': {'path': path, 'sha256': hashlib.sha256(raw[path]).hexdigest()},
            'pagesSha256': hashlib.sha256(interfaces.pages_preimage(doc)).hexdigest()}
    owner = SimpleNamespace(grant={'approved_roster': ref('roster')}, clock=FakeClock())
    return owner, approved, raw


class ProfileRosterControls(unittest.TestCase):
    def check(self, owner, approved, raw, stage='P2'):
        with patch.dict(phase.STAGE_DOCUMENTS, {'P2': approved['documents_directory_sha256']}), \
             patch.object(phase, 'read_json_ref', return_value=approved), \
             patch.object(phase, 'read_ref', side_effect=lambda r, c: raw[r['path']]):
            return phase.roster(owner, stage)

    def test_exact_two_source_blobs_and_pages_are_required(self):
        owner, approved, raw = roster_fixture()
        self.assertEqual(len(self.check(owner, approved, raw)[2]), 2)
        approved['documents']['FAKE-0']['pagesSha256'] = 'b' * 64
        with self.assertRaisesRegex(safety.Refusal, 'pages pin'):
            self.check(owner, approved, raw)

    def test_same_count_source_substitution_is_not_another_allowed_pair(self):
        owner, approved, raw = roster_fixture()
        raw['/FAKE/FAKE-0'] += b' '
        with self.assertRaisesRegex(safety.Refusal, 'foreign cohort'):
            self.check(owner, approved, raw)

    def test_profile_roster_schema_and_selection_freeze_cannot_be_substituted(self):
        for change in ('schema', 'freeze'):
            owner, approved, raw = roster_fixture()
            if change == 'schema': approved['schema'] = 'candidate6595-approved-roster-v1'
            else: approved['freeze']['sha256'] = safety.FREEZES['H10']
            with self.assertRaises(safety.Refusal): self.check(owner, approved, raw)

    def test_two_inputs_cannot_be_presented_as_official_h10(self):
        owner, approved, raw = roster_fixture()
        approved.update(schema='candidate6595-approved-roster-v1', stage='H10')
        with self.assertRaises(safety.Refusal): self.check(owner, approved, raw, 'H10')


def prerequisite_fixture():
    grant, plan = fixture()
    approval = {name: {'sha256': name + '-FAKE'} for name in ('helper', 'harness', 'model')}
    completion = {'schema': 'candidate6595-actual-completion-v1', 'candidate_head': interfaces.HEAD,
        'candidate_tree': interfaces.TREE, 'stage': 'H10', 'candidate_label': 'M2literal6595-FAKE-H10',
        'source_inventory': grant['source_inventory'], 'runtime_approval': ref('prior-runtime'),
        'kernel_no_children': True, 'no_unbound_children': True, 'actual_exit_code': 0, 'guard_exit_code': 0,
        **{name + '_sha256': approval[name]['sha256'] for name in approval}}
    proof = {'schema': 'candidate6595-root-phase-verification-v1', 'completion': plan['h10_completion'],
        'candidate_head': interfaces.HEAD, 'candidate_tree': interfaces.TREE, 'stage': 'H10',
        'candidate_label': completion['candidate_label'], 'runtime_approval': completion['runtime_approval'],
        'source_inventory': grant['source_inventory'], 'kernel_no_children': True, 'no_unbound_children': True,
        'checks': {key: True for key in profile2.H10_PROOF_CHECKS},
        'actual_exit_code': 0, 'guard_exit_code': 0, 'coordinator_exit_code': 0}
    owner = SimpleNamespace(grant=grant, profile_plan=plan, clock=FakeClock())
    return owner, completion, proof, approval


class ProfilePrerequisiteControls(unittest.TestCase):
    def test_independently_closed_h10_with_same_bytes_allows_diagnosis_only(self):
        owner, completion, proof, approval = prerequisite_fixture()
        with patch.object(phase, 'read_json_ref', side_effect=[completion, proof, approval]):
            phase.m8_gate(owner)
        self.assertIs(owner.grant['adoption_authorized'], False)

    def test_all_seven_exact_root_verification_checks_must_be_true(self):
        for change in ('missing', 'extra', 'false', 'integer', 'not_dict'):
            owner, completion, proof, approval = prerequisite_fixture()
            if change == 'missing': proof['checks'].pop('actual_normal_exits')
            if change == 'extra': proof['checks']['unreviewed'] = True
            if change == 'false': proof['checks']['actual_normal_exits'] = False
            if change == 'integer': proof['checks']['actual_normal_exits'] = 1
            if change == 'not_dict': proof['checks'] = []
            with patch.object(phase, 'read_json_ref', side_effect=[completion, proof, approval]), self.assertRaises(safety.Refusal):
                phase.m8_gate(owner)

    def test_failed_boolean_or_unclosed_h10_never_qualifies(self):
        for target, key, value in (('completion', 'actual_exit_code', -9),
                ('completion', 'guard_exit_code', False), ('proof', 'coordinator_exit_code', 1),
                ('proof', 'kernel_no_children', False), ('proof', 'stage', 'P2')):
            owner, completion, proof, approval = prerequisite_fixture()
            (completion if target == 'completion' else proof)[key] = value
            with patch.object(phase, 'read_json_ref', side_effect=[completion, proof, approval]), self.assertRaises(safety.Refusal):
                phase.m8_gate(owner)

    def test_changed_native_model_or_proof_runtime_refuses(self):
        for kind in ('helper', 'harness', 'model', 'proof'):
            owner, completion, proof, approval = prerequisite_fixture()
            if kind == 'proof': proof['runtime_approval'] = ref('different')
            else: approval[kind]['sha256'] = 'substituted'
            with patch.object(phase, 'read_json_ref', side_effect=[completion, proof, approval]), self.assertRaises(safety.Refusal):
                phase.m8_gate(owner)


if __name__ == '__main__':
    raise SystemExit('Use the bounded blocked-primitives mocked harness only.')
