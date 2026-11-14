"""One fixed two-document timer diagnostic; never H10/M8 or adoption authority."""
from pathlib import Path
import math
import re

from guard_support import require
from interfaces import HEAD, TREE

GRANT_SCHEMA = 'root-timer12f874-timer2-instrumentation-grant-v1'
PURPOSE = 'pr316-fixed-timer2-instrumentation-diagnostic'
PLAN_SCHEMA = 'root-timer12f874-timer2-instrumentation-plan-v1'
PHASE_CAP = 600
DOCUMENTS_SHA256 = '8012fae371786b36506b6141b6025d16f316a2779b42aee2a44aeaa5065bd118'
INPUT_FREEZE_SHA256 = '69dc1b83ca38baf4db4f1816db3444cc5ff46a534173eba6da5565789ea1336b'
LEGS = ('T1',)
MASKS = {'T1': [1, 2, 3, 4]}


def validate_scope(grant, plan):
    require(grant['schema'] == GRANT_SCHEMA and grant['purpose'] == PURPOSE
            and grant['stage'] == 'T2' and grant['stages'] == ['T2'],
            'distinct fixed-two diagnostic grant required')
    experiment, leg = grant['profile_experiment'], grant['profile_leg']
    require(isinstance(experiment, str) and re.fullmatch(r'[A-Za-z0-9_]{1,60}', experiment)
            and leg in LEGS and grant['attempt'] == experiment + '_' + leg,
            'exact named single-run timer experiment and leg required')
    require(type(grant['cpus']) is list and all(type(cpu) is int for cpu in grant['cpus'])
            and grant['cpus'] == MASKS[leg] and grant['threads'] == 3,
            'diagnostic leg CPU mask or three-thread setting differs')
    require(grant['h10_acceptance'] is None and grant['diagnostic_only'] is True
            and grant['adoption_authorized'] is False,
            'profile grant cannot claim quality/adoption or M8 admission')
    require(plan['schema'] == PLAN_SCHEMA and plan['experiment'] == experiment
            and plan['diagnostic_only'] is True and plan['adoption_authorized'] is False
            and plan['sequence'] == [{'leg': name, 'cpus': MASKS[name]} for name in LEGS]
            and plan['threads'] == 3 and plan['phase_cap_seconds'] == PHASE_CAP
            and plan['documents_directory_sha256'] == DOCUMENTS_SHA256,
            'only the fixed-input unchanged-three-thread single-run timer plan is supported')
    for key in ('runtime_approval', 'source_inventory', 'coordinator_package', 'approved_roster', 'holder'):
        require(plan[key] == grant[key], 'the fixed run must retain the same plan-bound ' + key)
    require(all(type(plan[key]) in (int, float) and math.isfinite(plan[key]) for key in
                ('owner_absolute_expiry_epoch', 'owner_boot_deadline', 'owner_issued_at_epoch'))
            and 0 < plan['owner_issued_at_epoch'] <= grant['issued_at_epoch']
            and grant['absolute_expiry_epoch'] <= plan['owner_absolute_expiry_epoch']
            and grant['boot_deadline'] <= plan['owner_boot_deadline']
            and 0 < plan['owner_absolute_expiry_epoch'] - plan['owner_issued_at_epoch'] <= 7200,
            'diagnostic plan owner window cannot be extended')
    outputs = plan['outputs']
    require(isinstance(outputs, dict) and set(outputs) == set(LEGS)
            and len(set(outputs.values())) == 1, 'one fixed diagnostic output required')
    for output in outputs.values():
        require(isinstance(output, str) and Path(output).is_absolute()
                and str(Path(output)) == output and '..' not in Path(output).parts,
                'canonical absolute diagnostic output required')
    require(grant['output_directory'] == outputs[leg], 'diagnostic leg output differs from shared plan')
    require('h10_completion' not in plan and 'h10_verification' not in plan,
            'historical H10 acceptance cannot qualify new timer executables')


def context(grant):
    return {'experiment': grant['profile_experiment'], 'leg': grant['profile_leg'],
            'cpus': grant['cpus'], 'threads': 3, 'plan': grant['profile_plan'],
            'diagnostic_only': True, 'adoption_authorized': False}


def require_native_ready(approval, clock, read_json_ref):
    """New timer executable evidence; historical H10/observer proofs cannot replace it."""
    require(approval['schema'] == 'candidate12f874-runtime-approval-v1'
            and approval['candidate_head'] == HEAD and approval['candidate_tree'] == TREE
            and approval['native_runtime_passed'] is True and approval['harness_no_run_passed'] is True
            and approval['independently_root_verified'] is True, 'fresh timer native qualification required')
    proof = read_json_ref(approval['exact_readiness_native_exec_actual'], clock)
    require(proof['status'] == 'independently_verified_pass'
            and type(proof['actual_bash_exit']) is int and proof['actual_bash_exit'] == 0
            and proof['all_owned_gone'] is True and proof['bash_child_count'] == 0
            and proof['model_or_test_executed'] is False, 'actual Root-verified timer READY required')
    raw = read_json_ref(proof['result'], clock)
    require(raw['status'] == 'diagnostic-observed-and-owned-cleaned' and raw['error'] is None
            and raw['model_or_test_executed'] is False and raw['target_userspace_permitted'] is False
            and raw['python_ready_before_seize_required'] is True
            and raw['cleanup']['cleanup_complete'] is True and raw['cleanup']['kernel_no_children'] is True
            and raw['cleanup']['no_unbound_children'] is True,
            'new timer READY raw result or owned cleanup differs')
    harness, record = approval['harness'], proof['strict_record']
    require(record == raw['observation']['strict_record']
            and record['actual_argv'] == [harness['path'], '--list']
            and record['kernel_exe_sha256'] == harness['sha256']
            and record['kernel_exe_identity'] == [harness[k] for k in ('device', 'inode', 'bytes', 'mtime_ns')]
            and record['kernel_exec_stop_before_userspace'] is True
            and record['hash_read_from_kernel_exe_fd'] is True,
            'READY must bind the actual new timer harness bytes and instance')


def validate_timing(stats):
    timing = stats.get('answerTiming')
    require(isinstance(timing, dict)
            and set(timing) == {'pickUs', 'pickCalls', 'emitUs', 'decodeUs', 'decodeCalls'}
            and all(type(v) is int and v >= 0 for v in timing.values()), 'five actual integer timing fields required')
    require(type(stats['answerMs']) is int and stats['answerMs'] >= 0
            and type(stats['answerTokens']) is int and stats['answerTokens'] >= 0
            and type(stats['capped']) is bool, 'actual answer timing/count scope required')
    require(timing['decodeCalls'] == stats['answerTokens']
            and timing['pickCalls'] == stats['answerTokens'] + (0 if stats['capped'] else 1),
            'timer pick/decode count contract differs')
    require(timing['pickUs'] + timing['emitUs'] + timing['decodeUs'] <= stats['answerMs'] * 1000 + 999,
            'timer buckets exceed enclosing answer wall time')
