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

R = Path('/workspace/codex-root-pr-window-20261113')
T = Path('/workspace/codex-astra-prompt0929-execution-prep-20261113')
P = Path('/root/supervisor/handoff/astra-prompt0929-coordinator-20261113')
W = Path('/workspace/codex-root-prompt0929-native-20261113-attempt1')
Q = Path('/workspace/codex-root-native-exec-diag-prompt0929-attempt2-20261113')
V9 = Path('/root/supervisor/handoff/agent1-literal6595-coordinator-20261113-v9task-exit')
HEAD = '0929f4ac398bfb027021379a9dff448eb2814c21'
TREE = 'f63dd22faae241e3836b4fed6069e8421066567e'
PACKAGE_SHA = 'ec4b9cdf850cd49806f208331bd33524d1fa709aa2ac8575d7b883241771af04'
BUILD_SHA = 'e9b0cb97899cb25a8f7cbfbe0b467b00ca37d53637e148723dd3b00e854ee20f'
BUILD_PROOF_SHA = 'c4837096a9fe37ecab8c7b0a879950f9f54116b73ee001f2d874eabe057e55ca'


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
    parser.add_argument('--owner-sha256', required=True)
    parser.add_argument('--runtime-proof-sha256', required=True)
    parser.add_argument('--ready-proof-sha256', required=True)
    parser.add_argument('--root-accept-observer-rebind-and-issue-h10', action='store_true', required=True)
    args = parser.parse_args()
    started_wall = time.time(); started_boot = time.clock_gettime(time.CLOCK_BOOTTIME)
    signal.signal(signal.SIGALRM, lambda *_: (_ for _ in ()).throw(TimeoutError('90s finalizer cap')))
    signal.setitimer(signal.ITIMER_REAL, 90)
    owner_ref = {'path': str(R / 'attempt8-global-independent-admission.json'), 'sha256': args.owner_sha256}
    runtime_proof_ref = {'path': str(R / 'prompt0929-runtime-a3-independent-endproof.json'), 'sha256': args.runtime_proof_sha256}
    ready_proof_ref = {'path': str(R / 'prompt0929-ready-a2-independent-endproof.json'), 'sha256': args.ready_proof_sha256}
    owner, rp, qp = checked(owner_ref), checked(runtime_proof_ref), checked(ready_proof_ref)
    build = pinned(W / 'stages/build-attempt2/result.json', BUILD_SHA)
    bp = pinned(R / 'prompt0929-build-a2-independent-endproof.json', BUILD_PROOF_SHA)
    runtime_ref, ready_ref = ref(W / 'stages/runtime-attempt3/result.json'), ref(Q / 'result.json')
    runtime, ready = checked(runtime_ref), checked(ready_ref)
    proof_pass(bp, BUILD_SHA); proof_pass(rp, runtime_ref['sha256'])
    need(qp['status'] == 'independently_verified_pass' and qp['result'] == ready_ref
         and type(qp['actual_bash_exit']) is int and qp['actual_bash_exit'] == 0
         and qp['all_owned_gone'] is True and qp['bash_child_count'] == 0
         and qp['model_or_test_executed'] is False, 'Root READY result/actual exit/independent cleanup required')
    native_pass(build, 'build'); native_pass(runtime, 'runtime')
    need(runtime['extra']['native_contract_count'] == 23 and runtime['extra']['model_invoked'] is False,
         '23 model-free contracts plus extraction wrapper required')
    contracts = W / 'stages/runtime-attempt3/native-contract-results.json'
    cr = pinned(contracts, runtime['extra']['native_contract_results_sha256'])
    need(cr['head'] == HEAD and cr['count'] == 23 and len(cr['selectors']) == 23
         and all(x['actual_exit_code'] == 0 and x['passed'] == 1 and x['failed'] == 0
                 and x['ignored'] == 0 and x['model_invoked'] is False for x in cr['selectors']),
         'actual exact native contract results required')
    wrappers = [x for x in runtime['commands'] if x['name'] == 'actual-wrapper']
    need(len(wrappers) == 1 and wrappers[0]['exit'] == 0 and wrappers[0]['root_reaped'] is True,
         'actual extraction wrapper exit0 required')
    need(ready['status'] == 'diagnostic-observed-and-owned-cleaned' and ready['error'] is None
         and ready['target_userspace_permitted'] is False and ready['model_or_test_executed'] is False
         and ready['python_ready_before_seize_required'] is True
         and ready['cleanup']['cleanup_complete'] is True and ready['cleanup']['kernel_no_children'] is True,
         'actual READY-before-SEIZE/EXEC diagnostic required')
    selection = build['extra']['artifact_selection']
    need(selection == json.loads((W / 'stages/build-attempt2/artifact-selection.json').read_bytes()), 'build selection differs')
    need(all(bp['artifacts_sha256'][k] == v['sha256'] for k, v in selection['artifacts'].items()), 'Root build hashes differ')
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
    binding = pinned(Path('/workspace/codex-agent3-prompt0929-ready-native-probe-bound-20261113/BINDING.json'),
                     '19dce1b8575d585150505c10069410c35982b4cb68d09cddcfb9b90f8c42a406')
    need(binding['expected_harness'] == harness, 'READY binding does not match current harness instance')
    package = pinned(P / 'source-manifest.json', PACKAGE_SHA)
    need(set(package['files']) == {p.name for p in P.glob('*.py')}, 'coordinator inventory differs')
    for name, digest in package['files'].items():
        need(sha(P / name) == digest, 'frozen coordinator source changed')
    sys.path.insert(0, str(P))
    import safety
    import phase
    clock = safety.budget(80, min(started_wall + 90, time.time() + 80),
                          min(started_boot + 90, safety.boot() + 80))
    issued = time.time(); wall = owner['fixed_expiry_epoch'] - 20; boot_end = owner['fixed_expiry_boot'] - 20
    need(owner['HOLD_unchanged'] is True and 3100 < wall - issued <= 7200
         and 3100 < boot_end - safety.boot() <= 7200, 'fresh complete H10 phase does not fit owner window')
    approval = pinned(T / 'RUNTIME-APPROVAL.V2.UNISSUED.json', '87383a65fc32777d612e4cbbd51d14f6e800188a266e41046cf88faff5cb68ef')
    grant = pinned(T / 'H10.GRANT.UNISSUED.json', '7f4334103c571bea3819f90ddf4d2cfc9cdb59580dada4371d9340fc58631ace')
    need(approval['candidate_head'] == grant['candidate_head'] == HEAD
         and approval['candidate_tree'] == grant['candidate_tree'] == TREE, 'candidate identity differs')
    for r in grant['actual_prerequisite_artifacts']:
        checked(r)
    inventory = checked(approval['source_inventory'])
    need(len(inventory['files']) == 656, 'whole source inventory incomplete')
    for r in inventory['files']:
        need(sha(r['path']) == r['sha256'], 'application source changed')
    evidence = pinned(T / 'OBSERVER-REBIND-EVIDENCE.json', 'a786ba84fa29d467149640c76ad31c9fa3f9453e377a30f86d0535ab4420bdb4')
    for name in evidence['byte_identical_modules']:
        need((V9 / name).read_bytes() == (P / name).read_bytes(), 'historical observer source differs')
    for name, names in evidence['AST_identical_functions'].items():
        def definitions(path):
            return {n.name: ast.dump(n, include_attributes=False) for n in ast.parse(path.read_text()).body if hasattr(n, 'name')}
        old, new = definitions(V9 / name), definitions(P / name)
        need(all(old[n] == new[n] for n in names), 'historical observation/ownership callback differs')
    observer = pinned(T / 'OBSERVER-QUALIFICATION.UNACCEPTED.json', '69413ccc862d485f1cffcaf8d9125d893d5187bf8d72a61fdcc6fe452f6174ef')
    for r in observer['actual_artifacts'] + [observer['qualification_origin'], observer['actual_run_observer_source'], observer['actual_run_phase_source']]:
        need(sha(r['path']) == r['sha256'], 'historical actual observer evidence changed')
    need(observer['root_accepted'] is False and observer['new_candidate_live_run_performed'] is False,
         'unexpected observer template authority')
    observer.update(root_accepted=True, state='ROOT_ACCEPTED_EXACT_OBSERVER_CALLBACK_IDENTITY_REBIND',
                    root_accepted_epoch=time.time(), root_acceptance_scope=evidence['scope'])
    observer_ref = write(R / 'prompt0929-observer-rebind-ROOT-ACCEPTED.json', observer)
    model = approval['model']
    need(sha(model['path']) == model['sha256'] and Path(model['path']).stat().st_size == model['bytes'], 'actual GGUF changed')
    fresh = write(R / 'prompt0929-H10-fresh-native-model-source.json', dict(checked_epoch=time.time(),
                  helper=helper, harness=harness, model=model, source_inventory=approval['source_inventory'],
                  source_files_verified=656, coordinator_package=grant['coordinator_package'], model_executed=False))
    approval.update(helper=helper, harness=harness, helper_sha256=helper['sha256'], harness_sha256=harness['sha256'],
                    compiletime_helper_path=str(helper_path), native_runtime_passed=True, harness_no_run_passed=True,
                    independently_root_verified=True, issued_epoch=time.time(), fresh_model_file_hash=fresh,
                    exact_readiness_native_exec_actual=ready_proof_ref, state='ROOT_VERIFIED_NATIVE_RUNTIME_MODEL_GRANT_SEPARATE')
    approval['kernel_exec_observer']['actual_qualification'] = observer_ref
    approval['actual_qualification_artifacts'] = [ref(R / 'prompt0929-build-a2-independent-endproof.json'), runtime_proof_ref,
        ready_proof_ref, runtime_ref, ready_ref, observer_ref, fresh]
    need(approval['model_inference_authorized'] is False and approval['summary_build_actually_observed'] is False,
         'no model execution or observed model header may be preclaimed')
    approval_ref = write(R / 'candidate0929-runtime-approval-H10-a1-ISSUED.json', approval)
    old = pinned(R / 'model-grant-literal6595-H10-v9task-exit-a1-ISSUED-20261113.json',
                 '3a0b3f31454d2e745267626bcce6e64d79d21c73733eb88fa5cbb265edc67a73')
    holder = {k: owner['holder'][k] for k in ('pid', 'start')}
    holder.update(fd=owner['lock']['fd'], lock_device=owner['lock']['device'], lock_inode=owner['lock']['inode'])
    grant.update(holder=holder, retained_hold=old['retained_hold'], root_fresh_admission=owner_ref,
                 runtime_approval=approval_ref, issued_at_epoch=issued, absolute_expiry_epoch=wall,
                 boot_deadline=boot_end, boot_id=Path('/proc/sys/kernel/random/boot_id').read_text().strip(),
                 model_execution_authorized=True, own_descendant_ptrace_authorized=True, state='ROOT_ISSUED_ONE_H10_PHASE_ONLY')
    grant['actual_prerequisite_artifacts'] += [runtime_proof_ref, ready_proof_ref, observer_ref, fresh]
    need(not Path(grant['output_directory']).exists(), 'H10 output must be fresh; no resume/retry')
    preview = SimpleNamespace(grant=grant, clock=clock)
    safety.runtime_approval(preview); phase.require_helper_exec_observer(preview, approval)
    phase.roster(preview, 'H10'); phase.m8_gate(preview)
    grant_ref = write(R / 'model-grant-prompt0929-H10-a1-ISSUED.json', grant)
    authority = safety.Authority(grant_ref, clock, wall, boot_end, grant['coordinator_package'])
    authority.check()
    need(wall - time.time() > 3050 and boot_end - safety.boot() > 3050, 'full phase plus launch margin no longer fits')
    argv = ['/usr/bin/taskset','-c','0','/usr/bin/python3','-I','-B',str(P / 'entry.py'),'phase','--stage','H10',
            '--grant',grant_ref['path'],'--grant-sha256',grant_ref['sha256'],'--package-manifest',str(P / 'source-manifest.json'),
            '--package-manifest-sha256',PACKAGE_SHA,'--absolute-expiry-epoch',str(wall),'--boot-deadline',str(boot_end),
            '--out',grant['output_directory']]
    command = R / 'prompt0929-H10-a1-COMMAND.txt'
    with command.open('x') as stream:
        stream.write(shlex.join(argv) + '\n')
    command.chmod(0o400)
    receipt = write(R / 'prompt0929-H10-a1-ISSUANCE.json', dict(runtime=approval_ref, grant=grant_ref,
        command=ref(command), owner=owner_ref, observer=observer_ref, fresh=fresh,
        exact_Authority_runtime_observer_roster_checks_passed=True, model_launched=False,
        launch_note='Root runs the command in its admitted Bash at nice<=10; capture actual Bash exit. No M8 or retry authority.'))
    print(json.dumps(receipt))
    clock.disarm()


if __name__ == '__main__':
    main()
