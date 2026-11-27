"""One fixed diagnostic topology experiment; never H10/M8 or adoption authority."""
from pathlib import Path
import math
import re

from guard_support import require

GRANT_SCHEMA = 'root-literal6595-profile2-topology-grant-v1'
PURPOSE = 'pr313-fixed-profile2-topology-diagnostic'
PLAN_SCHEMA = 'root-literal6595-profile2-topology-plan-v1'
PHASE_CAP = 600
DOCUMENTS_SHA256 = '8012fae371786b36506b6141b6025d16f316a2779b42aee2a44aeaa5065bd118'
INPUT_FREEZE_SHA256 = '69dc1b83ca38baf4db4f1816db3444cc5ff46a534173eba6da5565789ea1336b'
LEGS = ('A1', 'B1', 'B2', 'A2')
MASKS = {'A1': [1, 2, 3, 4], 'B1': [1, 2, 4], 'B2': [1, 2, 4], 'A2': [1, 2, 3, 4]}
H10_PROOF_CHECKS = {'raw_artifact_hashes', 'actual_normal_exits', 'owned_kernel_cleanup',
    'independently_approved_runtime_and_exec', 'full_frozen_roster_and_input_bytes',
    'whole_source_inventory', 'actual_source_exports'}


def validate_scope(grant, plan):
    require(grant['schema'] == GRANT_SCHEMA and grant['purpose'] == PURPOSE
            and grant['stage'] == 'P2' and grant['stages'] == ['P2'],
            'distinct fixed-two diagnostic grant required')
    experiment, leg = grant['profile_experiment'], grant['profile_leg']
    require(isinstance(experiment, str) and re.fullmatch(r'[A-Za-z0-9_]{1,60}', experiment)
            and leg in LEGS and grant['attempt'] == experiment + '_' + leg,
            'exact named ABBA experiment and leg required')
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
            'only the fixed-input unchanged-three-thread ABBA plan is supported')
    for key in ('runtime_approval', 'source_inventory', 'coordinator_package', 'approved_roster', 'holder'):
        require(plan[key] == grant[key], 'all four legs must retain the same plan-bound ' + key)
    require(all(type(plan[key]) in (int, float) and math.isfinite(plan[key]) for key in
                ('owner_absolute_expiry_epoch', 'owner_boot_deadline', 'owner_issued_at_epoch'))
            and 0 < plan['owner_issued_at_epoch'] <= grant['issued_at_epoch']
            and grant['absolute_expiry_epoch'] <= plan['owner_absolute_expiry_epoch']
            and grant['boot_deadline'] <= plan['owner_boot_deadline']
            and 0 < plan['owner_absolute_expiry_epoch'] - plan['owner_issued_at_epoch'] <= 7200,
            'diagnostic plan owner window cannot be extended')
    outputs = plan['outputs']
    require(isinstance(outputs, dict) and set(outputs) == set(LEGS)
            and len(set(outputs.values())) == 4, 'four distinct fixed diagnostic outputs required')
    for output in outputs.values():
        require(isinstance(output, str) and Path(output).is_absolute()
                and str(Path(output)) == output and '..' not in Path(output).parts,
                'canonical absolute diagnostic output required')
    require(grant['output_directory'] == outputs[leg], 'diagnostic leg output differs from shared plan')
    require(isinstance(plan['h10_completion'], dict) and isinstance(plan['h10_verification'], dict),
            'independently closed H10 must precede diagnostic profiling')


def context(grant):
    return {'experiment': grant['profile_experiment'], 'leg': grant['profile_leg'],
            'cpus': grant['cpus'], 'threads': 3, 'plan': grant['profile_plan'],
            'diagnostic_only': True, 'adoption_authorized': False}
