"""Root-only metadata issuance after actual build/runtime/READY; never launches H10."""
import argparse
import ast
import hashlib
import json
import os
from pathlib import Path
import shlex
import signal
import stat
import sys
import time
from types import SimpleNamespace

R = Path('/PRIVATE_UNSET/binding_2')
T = Path('/PRIVATE_UNSET/binding_3')
P = Path('/PRIVATE_UNSET/binding_4')
W = Path('/PRIVATE_UNSET/binding_5')
V9 = Path('/PRIVATE_UNSET/binding_6')
HEAD = '717641f575ef69b1038cad1274f767e46c7e05ac'
TREE = '0a547d9ef2dae92470fceaebcd7482f338fb90ed'
PACKAGE_SHA = '98b5c07f6d8119148d5af7c76d46aa63b9bb430eae1058c80db87c8704e23916'


def need(ok, message):
    if not ok:
        raise RuntimeError(message)


def identity(s):
    return (s.st_dev, s.st_ino, s.st_size, s.st_mode, s.st_nlink, s.st_mtime_ns, s.st_ctime_ns)


def sha(path):
    path = Path(path)
    need(path.is_absolute() and path.resolve() == path, 'noncanonical path: ' + str(path))
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        before = os.fstat(fd)
        need(stat.S_ISREG(before.st_mode), 'not a regular file: ' + str(path))
        digest = hashlib.sha256()
        while data := os.read(fd, 8 * 1024 * 1024):
            digest.update(data)
        need(identity(before) == identity(os.fstat(fd)) == identity(path.lstat()), 'file changed: ' + str(path))
        return digest.hexdigest()
    finally:
        os.close(fd)


def ref(path):
    return {'path': str(path), 'sha256': sha(path)}


def checked(item):
    path = Path(item['path'])
    need(path.is_absolute() and path.resolve() == path and stat.S_ISREG(path.lstat().st_mode),
         'noncanonical metadata path: ' + str(path))
    data = path.read_bytes()
    need(len(data) <= 16 * 1024 * 1024 and hashlib.sha256(data).hexdigest() == item['sha256'],
         'metadata hash/cap mismatch: ' + str(path))
    return json.loads(data)


def pinned(path, digest):
    return checked({'path': str(path), 'sha256': digest})


def write(path, value):
    data = (json.dumps(value, indent=2, sort_keys=True, allow_nan=False) + '\n').encode()
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC, 0o400)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    return ref(path)


def proof_pass(proof, raw_sha):
    need(proof['status'] == 'independently_verified_pass' and proof['result_sha256'] == raw_sha,
         'Root independent proof must bind this actual passed result')
    need(type(proof['original_bash_actual_exit']) is int and proof['original_bash_actual_exit'] == 0
         and proof['remaining_owned'] == [] and proof['bash_child_count'] == 0,
         'Root actual Bash exit and independent cleanup required')


def native_pass(result, stage):
    need(result['head'] == HEAD and result['stage'] == stage and result['status'] == 'passed'
         and result['error'] is None, 'actual candidate native stage did not pass')
    c = result['cleanup']
    need(c['cleanup_complete'] is True and c['kernel_no_children'] is True
         and not c['remaining_live_owned'] and not c['unreaped_owned']
         and all(x['reaped'] is True and type(x['exit']) is int and x['exit'] == 0 for x in c['root_children']),
         'native owned cleanup incomplete')


def snapshot(path, expected_sha, independent=False):
    need(sha(path) == expected_sha, 'new executable bytes differ')
    s = Path(path).lstat()
    need(s.st_uid == os.geteuid() and stat.S_IMODE(s.st_mode) == 0o500
         and (not independent or s.st_nlink == 1), 'executable metadata differs')
    return dict(path=str(path), sha256=expected_sha, bytes=s.st_size, device=s.st_dev,
                inode=s.st_ino, nlink=s.st_nlink, mode='0500', mtime_ns=s.st_mtime_ns)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--evidence', required=True)
    parser.add_argument('--evidence-sha256', required=True)
    parser.add_argument('--root-accept-observer-rebind-and-issue-h10', action='store_true', required=True)
    args = parser.parse_args()
    started_wall = time.time(); started_boot = time.clock_gettime(time.CLOCK_BOOTTIME)
    signal.signal(signal.SIGALRM, lambda *_: (_ for _ in ()).throw(TimeoutError('90s finalizer cap')))
    signal.setitimer(signal.ITIMER_REAL, 90)
    evidence_ref = {'path': args.evidence, 'sha256': args.evidence_sha256}
    actual = checked(evidence_ref)
    need(actual['schema'] == 'quality717641-root-actual-evidence-v1'
         and actual['candidate_head'] == HEAD and actual['candidate_tree'] == TREE,
         'explicit Root-pinned new717 actual-evidence manifest required')
    owner_ref, runtime_proof_ref, ready_proof_ref = actual['owner'], actual['runtime_proof'], actual['ready_proof']
    owner, rp, qp = checked(owner_ref), checked(runtime_proof_ref), checked(ready_proof_ref)
    bash = owner['bash']
    need(os.getppid() == bash['pid'], 'invoke directly from the independently admitted original Root Bash')
    fields = Path('/proc/' + str(bash['pid']) + '/stat').read_text().rsplit(') ', 1)[1].split()
    need(fields[19] == bash['start'] and int(fields[1]) == owner['holder']['pid'],
         'original Root Bash birth/holder parent changed')
    wall, boot_end = owner['fixed_expiry_epoch'] - 20, owner['fixed_expiry_boot'] - 20
    need(owner['HOLD_unchanged'] is True and wall - time.time() > 3100
         and boot_end - time.clock_gettime(time.CLOCK_BOOTTIME) > 3100,
         'full original3000s H10 phase plus100s margin must fit fixed owner; never shorten or renew')
    build_ref, runtime_ref = actual['build'], actual['runtime_raw']
    need(build_ref['path'] == str(W / 'stages/build/result.json')
         and runtime_ref['path'] == str(W / 'stages/runtime/result.json'),
         'actual new717 build/runtime paths required; no old qualification transfer')
    build, runtime = checked(build_ref), checked(runtime_ref)
    bp = checked(actual['build_proof'])
    BUILD_SHA = build_ref['sha256']
    ready_ref = qp['result']
    ready = checked(ready_ref)
    proof_pass(bp, BUILD_SHA); proof_pass(rp, runtime_ref['sha256'])
    need(qp['status'] == 'independently_verified_pass' and qp['result'] == ready_ref
         and type(qp['actual_bash_exit']) is int and qp['actual_bash_exit'] == 0
         and qp['all_owned_gone'] is True and qp['bash_child_count'] == 0
         and qp['model_or_test_executed'] is False, 'Root READY result/actual exit/independent cleanup required')
    native_pass(build, 'build'); native_pass(runtime, 'runtime')
    need(runtime['extra']['native_contract_count'] == 23 and runtime['extra']['model_invoked'] is False,
         '23 model-free contracts plus extraction wrapper required')
    contracts = W / 'stages/runtime/native-contract-results.json'
    cr = pinned(contracts, runtime['extra']['native_contract_results_sha256'])
    selectors = pinned(T / 'NATIVE-SELECTORS.json', '64c6eb02df6d8cd21b45540a7b459913b6446c31db8f19bac9872cbd304a5f76')
    need(cr['head'] == selectors['candidate_head'] == HEAD
         and cr['count'] == len(cr['selectors']) == len(selectors['selectors']) == 23
         and cr['model_invoked'] is False
         and [row['selector'] for row in cr['selectors']] == selectors['selectors']
         and len(set(selectors['selectors'])) == 23
         and all(type(row['actual_exit_code']) is int and row['actual_exit_code'] == 0
                 and row['passed'] == 1 and row['failed'] == row['ignored'] == 0
                 and row['model_invoked'] is False for row in cr['selectors']),
         'exact ordered23 new717 native rows each1pass/0failed/0ignored/exit0 required')
    wrappers = [x for x in runtime['commands'] if x['name'] == 'actual-wrapper']
    need(len(wrappers) == 1 and type(wrappers[0]['exit']) is int and wrappers[0]['exit'] == 0 and wrappers[0]['root_reaped'] is True,
         'actual extraction wrapper exit0 required')
    need(ready['status'] == 'diagnostic-observed-and-owned-cleaned' and ready['error'] is None
         and ready['target_userspace_permitted'] is False and ready['model_or_test_executed'] is False
         and ready['python_ready_before_seize_required'] is True
         and ready['cleanup']['cleanup_complete'] is True and ready['cleanup']['kernel_no_children'] is True
         and ready['cleanup']['no_unbound_children'] is True,
         'actual READY-before-SEIZE/EXEC diagnostic required')
    selection = build['extra']['artifact_selection']
    need(selection == json.loads((W / 'stages/build/artifact-selection.json').read_bytes()), 'build selection differs')
    need(all(bp['artifacts_sha256'][k] == v['sha256'] for k, v in selection['artifacts'].items()), 'Root build hashes differ')
    need(all(item['fresh'] is False for item in selection['actual_cargo_artifacts'].values())
         and selection['non_test_root_library']['fresh'] is False,
         'new717 root-package artifacts must actually rebuild')
    helper_path, harness_path = W / 'target/debug/mycarlos-tauri-poc', W / 'bundle/harness'
    need(selection['actual_cargo_artifacts']['helper']['path'] == str(helper_path), 'compile-time helper path differs')
    helper = snapshot(helper_path, selection['artifacts']['helper']['sha256'])
    harness = snapshot(harness_path, selection['artifacts']['harness']['sha256'], independent=True)
    observation = ready['observation']; record = observation['strict_record']
    need(all(observation[k] is True for k in ('strict_identity_matches','strict_hash_matches','strict_argv_matches'))
         and record['actual_argv'] == [str(harness_path), '--list']
         and record['kernel_exec_stop_before_userspace'] is True and record['hash_read_from_kernel_exe_fd'] is True,
         'READY actual harness identity/hash/argv observation differs')
    need(qp['strict_record'] == record and record['kernel_exe_sha256'] == harness['sha256']
         and record['kernel_exe_identity'] == [harness[k] for k in ('device','inode','bytes','mtime_ns')],
         'actual READY record does not bind current harness bytes and instance')
    binding = checked(actual['ready_binding'])
    need(binding['expected_harness'] == harness and binding['expected_argv'] == [str(harness_path), '--list'], 'READY binding does not match current harness instance')
    ready_source = Path('/PRIVATE_UNSET/binding_7')
    need(actual['ready_binding']['path'] == str(ready_source / 'BINDING.json')
         and binding['coordinator_directory'] == str(P)
         and ready['coordinator_freeze'] == binding['coordinator_files']['FREEZE.json']
         and binding['coordinator_files']['FREEZE.json'] == sha(P / 'FREEZE.json'),
         'actual READY must bind this exact fresh717 coordinator freeze')
    for name, digest in binding['files'].items():
        need(sha(ready_source / name) == digest, 'actual READY source changed')
    package = pinned(P / 'source-manifest.json', PACKAGE_SHA)
    need(set(package['files']) == {p.name for p in P.glob('*.py')}, 'coordinator inventory differs')
    for name, digest in package['files'].items():
        need(sha(P / name) == digest and stat.S_IMODE((P / name).stat().st_mode) == 0o400, 'frozen coordinator source changed')
    sys.path.insert(0, str(P))
    import safety
    import phase
    clock = safety.budget(80, min(started_wall + 90, time.time() + 80),
                          min(started_boot + 90, safety.boot() + 80))
    issued = time.time()
    need(owner['HOLD_unchanged'] is True and 3100 < wall - issued <= 7200
         and 3100 < boot_end - safety.boot() <= 7200, 'fresh complete H10 phase does not fit owner window')
    approval = pinned(T / 'RUNTIME-APPROVAL.UNISSUED.json', '8de894bf5f18b04a67f6ce4b604e2784c5356f03443b76e570408717ae0fe6e9')
    grant = pinned(T / 'H10.GRANT.UNISSUED.json', '1073a39cf2b0749fc65f09c65cd1a3a9a86adf9e53bcc32cae53d615ef2a3fe6')
    need(approval['candidate_head'] == grant['candidate_head'] == HEAD
         and approval['candidate_tree'] == grant['candidate_tree'] == TREE, 'candidate identity differs')
    for r in grant['actual_prerequisite_artifacts']:
        checked(r)
    inventory = checked(approval['source_inventory'])
    need(inventory['candidate_head'] == HEAD and inventory['candidate_tree'] == TREE
         and len(inventory['files']) == 656, 'whole source inventory incomplete')
    for r in inventory['files']:
        need(sha(r['path']) == r['sha256'], 'application source changed')
    evidence = pinned(T / 'OBSERVER-REBIND-EVIDENCE.json', '1d7f055b7bac4186da68530fe5e14aa042c4a71df99170b11b97e60bb85c6612')
    for name in evidence['byte_identical_modules']:
        need((V9 / name).read_bytes() == (P / name).read_bytes(), 'historical observer source differs')
    for name, names in evidence['AST_identical_functions'].items():
        def definitions(path):
            return {n.name: ast.dump(n, include_attributes=False) for n in ast.parse(path.read_text()).body if hasattr(n, 'name')}
        old, new = definitions(V9 / name), definitions(P / name)
        need(all(old[n] == new[n] for n in names), 'historical observation/ownership callback differs')
    observer = pinned(T / 'OBSERVER-QUALIFICATION.UNACCEPTED.json', '74891cb21e5ee08bf2059141f645dcdf828cd5dd8c28c15376d2a9f0a793b874')
    for r in observer['actual_artifacts'] + [observer['qualification_origin'], observer['actual_run_observer_source'], observer['actual_run_phase_source']]:
        need(sha(r['path']) == r['sha256'], 'historical actual observer evidence changed')
    need(checked(observer['qualification_origin'])['root_accepted'] is True
         and observer['root_accepted'] is False and observer['new_candidate_live_run_performed'] is False,
         'unexpected observer template authority')
    observer.update(root_accepted=True, state='ROOT_ACCEPTED_EXACT_OBSERVER_CALLBACK_IDENTITY_REBIND',
                    root_accepted_epoch=time.time(), root_acceptance_scope=evidence['scope'])
    observer_ref = write(R / 'quality717641-observer-rebind-ROOT-ACCEPTED.json', observer)
    model = approval['model']
    need(sha(model['path']) == model['sha256'] and Path(model['path']).stat().st_size == model['bytes'], 'actual GGUF changed')
    fresh = write(R / 'quality717641-H10-fresh-native-model-source.json', dict(checked_epoch=time.time(),
                  helper=helper, harness=harness, model=model, source_inventory=approval['source_inventory'],
                  source_files_verified=656, coordinator_package=grant['coordinator_package'], model_executed=False))
    approval.update(helper=helper, harness=harness, helper_sha256=helper['sha256'], harness_sha256=harness['sha256'],
                    compiletime_helper_path=str(helper_path), native_runtime_passed=True, harness_no_run_passed=True,
                    independently_root_verified=True, issued_epoch=time.time(), fresh_model_file_hash=fresh,
                    exact_readiness_native_exec_actual=ready_proof_ref, state='ROOT_VERIFIED_NATIVE_RUNTIME_MODEL_GRANT_SEPARATE')
    approval['kernel_exec_observer']['actual_qualification'] = observer_ref
    approval['actual_qualification_artifacts'] = [actual['build_proof'], build_ref, runtime_proof_ref,
        ready_proof_ref, runtime_ref, ready_ref, observer_ref, fresh]
    need(approval['model_inference_authorized'] is False and approval['summary_build_actually_observed'] is False,
         'no model execution or observed model header may be preclaimed')
    approval_ref = write(R / 'candidate717641-runtime-approval-H10-a1-ISSUED.json', approval)
    old = pinned(R / 'model-grant-literal6595-H10-v9task-exit-a1-ISSUED-20261113.json',
                 '3a0b3f31454d2e745267626bcce6e64d79d21c73733eb88fa5cbb265edc67a73')
    holder = {k: owner['holder'][k] for k in ('pid', 'start')}
    holder.update(fd=owner['lock']['fd'], lock_device=owner['lock']['device'], lock_inode=owner['lock']['inode'])
    grant.update(holder=holder, retained_hold=old['retained_hold'], root_fresh_admission=owner_ref,
                 runtime_approval=approval_ref, issued_at_epoch=time.time(), absolute_expiry_epoch=wall,
                 boot_deadline=boot_end, boot_id=Path('/proc/sys/kernel/random/boot_id').read_text().strip(),
                 model_execution_authorized=True, own_descendant_ptrace_authorized=True, state='ROOT_ISSUED_ONE_H10_PHASE_ONLY')
    grant['actual_prerequisite_artifacts'] += [evidence_ref, actual['build_proof'], build_ref, runtime_proof_ref, ready_proof_ref, observer_ref, fresh]
    need(not Path(grant['output_directory']).exists(), 'H10 output must be fresh; no resume/retry')
    preview = SimpleNamespace(grant=grant, clock=clock)
    safety.runtime_approval(preview); phase.require_helper_exec_observer(preview, approval)
    phase.roster(preview, 'H10'); phase.m8_gate(preview)
    grant_ref = write(R / 'model-grant-quality717641-H10-a1-ISSUED.json', grant)
    authority = safety.Authority(grant_ref, clock, wall, boot_end, grant['coordinator_package'])
    authority.check()
    need(wall - time.time() > 3050 and boot_end - safety.boot() > 3050, 'full phase plus launch margin no longer fits')
    argv = ['/usr/bin/taskset','-c','0','/usr/bin/python3','-I','-B',str(P / 'entry.py'),'phase','--stage','H10',
            '--grant',grant_ref['path'],'--grant-sha256',grant_ref['sha256'],'--package-manifest',str(P / 'source-manifest.json'),
            '--package-manifest-sha256',PACKAGE_SHA,'--absolute-expiry-epoch',str(wall),'--boot-deadline',str(boot_end),
            '--out',grant['output_directory']]
    command = R / 'quality717641-H10-a1-COMMAND.txt'
    with command.open('x') as stream:
        stream.write(shlex.join(argv) + '\n')
    command.chmod(0o400)
    receipt = write(R / 'quality717641-H10-a1-ISSUANCE.json', dict(runtime=approval_ref, grant=grant_ref,
        command=ref(command), owner=owner_ref, observer=observer_ref, fresh=fresh,
        exact_Authority_runtime_observer_roster_checks_passed=True, model_launched=False, actual_evidence=evidence_ref,
        launch_note='Root runs the command in its admitted Bash at nice<=10; capture actual Bash exit. No M8 or retry authority.'))
    print(json.dumps(receipt))
    clock.disarm()


if __name__ == '__main__':
    main()
