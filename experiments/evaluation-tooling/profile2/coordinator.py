"""Concrete one-phase C -> G -> qualified harness -> canonical helper runner.

ROOT admits H10 and M8 separately. This module issues no grant or grade adapter.
"""
import argparse
import os
from pathlib import Path
import re
import signal
import sys
import time

import guard_support as base
import profile2
from interfaces import COUNTS, HEAD, TREE, completion_payload
from phase import (check_staged, completed_run, exec_harness, export_sources,
                   m8_gate, prepare_phase, require_helper_exec_observer, run_guard, spawn_gated)
from safety import (Authority, PACKAGE, PHASE_CAPS, StrictOwned, boot, budget, cleanup,
                    file_ref, now, private_directory, publish, read_json_ref, require,
                    runtime_approval, set_subreaper)


def run_phase(args, deadlines, entry_boot):
    clock = budget(PHASE_CAPS[args.stage], *deadlines)
    clock.hard_end = min(clock.hard_end, entry_boot + PHASE_CAPS[args.stage])
    clock.work_end = clock.hard_end - 10
    clock.check()
    clock.arm()
    authority = Authority({'path': args.grant, 'sha256': args.grant_sha256}, clock, *deadlines,
                          {'path': args.package_manifest, 'sha256': args.package_manifest_sha256})
    g = authority.grant
    require(g['stage'] == args.stage and g['output_directory'] == args.out,
            'stage/output differ from explicit one-phase ROOT model grant')
    require(isinstance(g['attempt'], str) and re.fullmatch(r'[A-Za-z0-9_]{1,80}', g['attempt'])
            and g['candidate_label'] == 'M2literal6595-' + g['attempt'] + '-' + args.stage,
            'fresh literal candidate attempt/label required')
    require(Path(args.out).is_absolute() and str(Path(args.out)) == args.out,
            'canonical absolute new output directory required')
    require(Path(args.out) != PACKAGE and PACKAGE not in Path(args.out).parents,
            'actual output must be outside the readonly reviewed source package')
    # Admission forecasts use the full fixed phase cap, not optimistic speed claims.
    require(clock.remaining(final=True) >= PHASE_CAPS[args.stage] - 5,
            'full phase cap plus its cleanup cannot fit this ROOT owner window')
    clock.work_hook = authority.hook
    require(os.getpriority(os.PRIO_PROCESS, 0) <= 10,
            'controller nice exceeds10; cannot assume CAP_SYS_NICE to raise worker priority')
    os.sched_setaffinity(0, {0})
    os.setpriority(os.PRIO_PROCESS, 0, 10)
    set_subreaper()
    owner = StrictOwned(clock)
    child, terminal, snap, failure = None, None, None, None
    phase_dir, guard, header, target, sources, run, staged = None, None, None, None, None, None, None
    try:
        approval, _, _ = runtime_approval(authority)
        require_helper_exec_observer(authority, approval)
        m8_gate(authority)
        authority.check()
        phase_dir = private_directory(args.out, clock)
        staged_ref = prepare_phase(authority, args.stage, phase_dir)
        staged = check_staged(authority, args.stage, staged_ref)
        parent = base.proc(os.getpid(), clock)
        # Reserve post-run source/binary/model rechecks and publication inside cap.
        phase_hard = min(clock.hard_end - 70, boot() + PHASE_CAPS[args.stage] - 70)
        require(phase_hard - boot() >= 30, 'no bounded phase work/cleanup remains')
        argv = [sys.executable, '-I', '-B', str(PACKAGE / 'entry.py'), '_guard',
            '--stage', args.stage, '--grant', args.grant, '--grant-sha256', args.grant_sha256,
            '--absolute-expiry-epoch', str(deadlines[0]), '--boot-deadline', str(deadlines[1]),
            '--package-manifest', args.package_manifest,
            '--package-manifest-sha256', args.package_manifest_sha256,
            '--phase-hard-boot', str(phase_hard), '--phase-dir', args.out,
            '--staged-inputs', staged_ref['path'], '--staged-inputs-sha256', staged_ref['sha256'],
            '--parent-pid', str(os.getpid()), '--parent-start', parent['start']]
        terminal = open(phase_dir / 'guardian-terminal.log', 'xb', buffering=0)
        os.chmod(phase_dir / 'guardian-terminal.log', 0o600)
        def record_bound_guardian(bound_child, bound_key):
            publish(phase_dir / 'guardian-dispatch.json', {'schema': 'candidate6595-guardian-dispatch-v1',
                'actual_argv': argv, 'pid': bound_child.pid, 'start': bound_key[1], 'pidfd_bound_before_release': True,
                'parent_pid': os.getpid(), 'parent_start': parent['start'], 'model_grant': authority.ref,
                'coordinator_package': g['coordinator_package'], 'observed_at': now()}, clock)
        child, key = spawn_gated(argv, clock, owner, terminal, on_bound=record_bound_guardian)
        # G already inherited nice10; lowering C now cannot demote its child.
        os.setpriority(os.PRIO_PROCESS, 0, 19)
        while child.returncode is None:
            clock.check()
            owner.discover()
            require(not owner.invalid_observations, 'coordinator observed unbound descendants')
            owner.reap()
            if child.returncode is None:
                time.sleep(min(.1, clock.remaining()))
        require(type(child.returncode) is int and child.returncode == 0, 'actual phase guardian did not exit0')
        authority.check()
        guard = read_json_ref(file_ref(phase_dir / 'phase-guard.json', clock), clock)
        require(guard['status'] == 'actual-observed' and guard['failure'] is None
                and guard['model_grant'] == authority.ref and guard['staged_inputs'] == staged_ref
                and guard['runtime_approval'] == g['runtime_approval']
                and guard['approved_roster'] == g['approved_roster']
                and guard['source_inventory'] == g['source_inventory'], 'actual raw guardian provenance differs')
        if args.stage == 'P2':
            require(guard.get('diagnostic_only') is True and guard.get('profile') == profile2.context(g),
                    'actual diagnostic guardian plan/leg differs')
        staged = check_staged(authority, args.stage, staged_ref)
        # Rehash original canonical helper/bundle/model/source after actual child exit.
        approval_after, _, _ = runtime_approval(authority)
        require(approval_after == approval, 'runtime/source approval changed during model work')
        header, target = completed_run(authority, args.stage, phase_dir, staged, approval, guard)
        os.chmod(phase_dir / 'run.jsonl', 0o400)
        run = file_ref(phase_dir / 'run.jsonl', clock)
        require(guard['run'] == run and guard['terminal'] == file_ref(phase_dir / 'harness-terminal.log', clock),
                'raw guardian run/terminal hashes differ')
        sources = export_sources(authority, args.stage, phase_dir, staged, run)
    except BaseException as error:
        failure = type(error).__name__ + ': ' + str(error)
    finally:
        try:
            snap = cleanup(owner, clock)
            require(snap['cleanup_complete'] and snap['kernel_no_children']
                    and snap['no_unbound_children'] and snap['cleanup_error'] is None,
                    'coordinator did not reach clean owned ECHILD')
        except BaseException as error:
            failure = (failure + '; ' if failure else '') + type(error).__name__ + ': ' + str(error)
        if terminal is not None:
            try:
                os.fsync(terminal.fileno())
                terminal.close()
                os.chmod(phase_dir / 'guardian-terminal.log', 0o400)
            except BaseException as error:
                failure = (failure + '; ' if failure else '') + 'guardian terminal finalization: ' + str(error)
    try:
        if failure is not None:
            if phase_dir is not None:
                publish(phase_dir / 'coordinator-failure.json', {'schema': 'candidate6595-coordinator-failure-v1',
                    'candidate_head': HEAD, 'candidate_tree': TREE, 'stage': args.stage,
                    'candidate_label': g['candidate_label'], 'failure': failure,
                    'observed_guard_exit': None if child is None else child.returncode,
                    'cleanup': snap, 'model_grant': authority.ref, 'observed_at': now(),
                    'preserve_failed_attempt_no_resume': True}, clock)
            print(failure, file=sys.stderr, flush=True)
            return 1
        authority.check()
        result = completion_payload(stage=args.stage, label=g['candidate_label'], run=run,
            guard_ref=file_ref(phase_dir / 'phase-guard.json', clock),
            terminal=file_ref(phase_dir / 'harness-terminal.log', clock),
            guard_terminal=file_ref(phase_dir / 'guardian-terminal.log', clock),
            guard=guard, observed_guard_exit=child.returncode, header=header,
            runtime_approval=g['runtime_approval'], approved_roster=g['approved_roster'],
            source_inventory=g['source_inventory'], source_exports=sources,
            coordinator_source_sha256=file_ref(PACKAGE / 'coordinator.py', clock)['sha256'],
            attempt=g['attempt'], observed_at=now())
        result.update({'coordinator_cleanup': snap, 'model_grant': authority.ref,
            'coordinator_package': g['coordinator_package'], 'target_assessment': target,
            'actual_parent_exit_requires_root_observation': True,
            'next_stage_automatic': False, 'scoring_or_grade_pass_not_inferred': True})
        result['controller'] = {'pid': os.getpid(), 'cpus': sorted(os.sched_getaffinity(0)),
                                'nice': os.getpriority(os.PRIO_PROCESS, 0)}
        ref = publish(phase_dir / 'completion.json', result, clock)
        print('Raw actual phase evidence: ' + ref['path'] + ' SHA256 ' + ref['sha256'], flush=True)
        return 0
    finally:
        owner.close()
        clock.disarm()


def main(argv, deadlines, entry_boot):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    phase = sub.add_parser('phase', help='one separately ROOT-admitted H10 or M8 actual model phase')
    guard = sub.add_parser('_guard', help=argparse.SUPPRESS)
    execute = sub.add_parser('_exec', help=argparse.SUPPRESS)
    for command in (phase, guard, execute):
        command.add_argument('--absolute-expiry-epoch', type=float, required=True)
        command.add_argument('--boot-deadline', type=float, required=True)
        command.add_argument('--package-manifest', required=True)
        command.add_argument('--package-manifest-sha256', required=True)
    for command in (phase, guard, execute):
        command.add_argument('--stage', choices=tuple(COUNTS), required=True)
        command.add_argument('--grant', required=True)
        command.add_argument('--grant-sha256', required=True)
    for command in (guard, execute):
        command.add_argument('--parent-pid', type=int, required=True)
        command.add_argument('--parent-start', required=True)
        command.add_argument('--start-gate-fd', type=int, required=True)
    phase.add_argument('--out', required=True)
    guard.add_argument('--phase-hard-boot', type=float, required=True)
    guard.add_argument('--phase-dir', required=True)
    guard.add_argument('--staged-inputs', required=True)
    guard.add_argument('--staged-inputs-sha256', required=True)
    execute.add_argument('--exec-spec', required=True)
    execute.add_argument('--exec-spec-sha256', required=True)
    execute.add_argument('--phase-dir', required=True)
    execute.add_argument('--phase-hard-boot', type=float, required=True)
    execute.add_argument('--staged-inputs', required=True)
    execute.add_argument('--staged-inputs-sha256', required=True)
    execute.add_argument('--exec-ready-fd', type=int, required=True)
    args = parser.parse_args(argv)
    if args.command == '_exec':
        require(argv.count('--exec-ready-fd') == 1, 'one exact EXEC readiness descriptor required')
        return exec_harness(args, deadlines, entry_boot)
    if args.command == '_guard':
        return run_guard(args, deadlines, entry_boot)
    return run_phase(args, deadlines, entry_boot)
