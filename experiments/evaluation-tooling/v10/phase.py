"""One qualified literal6595 model phase, actual observations and source exports."""
import hashlib
import json
import os
from pathlib import Path
import signal
import stat
import subprocess
import sys
import time

import guard_support as base
from exec_observer import ExecObserver
from interfaces import (HEAD, TREE, COUNTS, GUARD_SCHEMA, SOURCE_EXPORT_SCHEMA,
                        canonical_sha256, documents_manifest, pages_preimage)
from safety import (Authority, FREEZES, GIB, PACKAGE, PHASE_CAPS, Refusal, StrictOwned,
                    available_bytes, boot, budget, cleanup, file_ref, now, private_directory,
                    publish, read_json_ref, read_ref, require, runtime_approval,
                    set_subreaper, write_bytes)

STAGE_DOCUMENTS = {
    'H10': 'd0811e16f0074f65410b97d7d4e290d21f20dbeeeff7d1f50c5ec90fcf28b396',
    'M8': '6ce3ed6ecf628869c954e4cf603cba3fe05bf5ca6d6117acf8f916954392923d'}


class InstanceExited(Refusal):
    """A pidfd-confirmed exit, distinct from a contradictory live observation."""


class DiagnosticExecObserver(ExecObserver):
    """Bounded private metadata precedes unchanged strict image qualification."""
    def capture(self, tid):
        fd, error = None, None
        diagnostic = {'tid': tid, 'diagnostic_only': True, 'qualification_not_inferred': True}
        try:
            tracee = self.stopped(tid)
            role = 'harness' if tracee['key'] == self.root_key else 'helper'
            expected = self.approval[role]
            diagnostic.update(role=role, pid=tid, start=tracee['start'],
                expected_device=expected['device'], expected_inode=expected['inode'],
                expected_bytes=expected['bytes'], expected_sha256=expected['sha256'])
            path = '/proc/' + str(tid) + '/exe'
            fd = os.open(path, os.O_RDONLY | os.O_CLOEXEC)
            info = os.fstat(fd)
            link = os.readlink(path)
            raw = self.proc_bytes(tid, 'cmdline')
            words = [word for word in raw[:8192].split(b'\0') if word]
            diagnostic.update(observed_device=info.st_dev, observed_inode=info.st_ino,
                observed_bytes=info.st_size, observed_mode=info.st_mode,
                actual_exe_link=link[:4096], exe_link_truncated=len(link) > 4096,
                actual_argv=[word.decode('utf-8', 'backslashreplace') for word in words[:256]],
                actual_argv_truncated=len(raw) > 8192 or len(words) > 256,
                cmdline_bytes=len(raw), hash_not_read_by_diagnostic=True)
            self.stopped(tid)
        except BaseException as failure:
            error = type(failure).__name__ + ': ' + str(failure)[:240]
        finally:
            if fd is not None:
                try:
                    os.close(fd)
                except OSError as failure:
                    error = (error + '; ' if error else '') + type(failure).__name__ + ': ' + str(failure)[:240]
        diagnostic['diagnostic_error'] = error
        self.event('prequalification-exec-image', **diagnostic)
        # No CONT/DETACH, fallback image, skipped EXEC or replacement qualification.
        # Even a diagnostic fault cannot bypass the original strict capture call.
        record = super().capture(tid)
        self.require(error is None, 'EXEC diagnostic failed before strict capture: ' + str(error))
        return record


def require_helper_exec_observer(authority, approval):
    """Exact independently qualified observer, with no new privilege/capability."""
    mode = 'owned-descendant-PTRACE_SEIZE-TRACEEXEC-v1'
    g, clock = authority.grant, authority.clock
    require(g['own_descendant_ptrace_authorized'] is True and g['kernel_exec_observer_mode'] == mode,
            'new explicit ROOT own-process ptrace scope required')
    selected = approval['kernel_exec_observer']
    actual_source = file_ref(PACKAGE / 'exec_observer.py', clock)
    require(selected['mode'] == mode and selected['source'] == actual_source
            and selected['helper_detached_before_first_instruction'] is True
            and selected['unchanged_helper_denies_exec_after_confinement'] is True,
            'qualified exact observer/source/helper-confinement contract required')
    qualified = read_json_ref(selected['actual_qualification'], clock)
    required = {'seize_before_gate', 'fork_from_nonleader_thread', 'pidfd_thread_supported',
                'actual_exec_fd_hash', 'dumpable0_acknowledged', 'retained_fd_after_dumpable0',
                'post_dump_metadata_and_affinity', 'actual_normal_exits', 'owned_kernel_cleanup',
                'no_application_or_privilege_changes'}
    require(qualified['schema'] == 'root-owned-exec-stop-qualification-v1'
            and qualified['root_accepted'] is True and qualified['observer_source'] == actual_source
            and qualified['mode'] == mode and qualified['kernel_no_children'] is True
            and qualified['no_unbound_children'] is True
            and type(qualified['actual_exit_code']) is int and qualified['actual_exit_code'] == 0
            and set(qualified['checks']) == required and all(qualified['checks'][key] is True for key in required),
            'actual independent tiny observer permission/exec/thread/cleanup qualification required')
    require(isinstance(qualified['actual_artifacts'], list) and qualified['actual_artifacts'],
            'actual observer qualification artifacts missing')
    for artifact in qualified['actual_artifacts']:
        read_ref(artifact, clock)
    return selected


def roster(authority, stage):
    g, clock = authority.grant, authority.clock
    approved = read_json_ref(g['approved_roster'], clock)
    require(approved['schema'] == 'candidate6595-approved-roster-v1'
            and approved['candidate_head'] == HEAD and approved['candidate_tree'] == TREE
            and approved['stage'] == stage and isinstance(approved['documents'], dict)
            and len(approved['documents']) == COUNTS[stage]
            and approved['documents_directory_sha256'] == STAGE_DOCUMENTS[stage],
            'independently approved full phase roster required')
    require(approved['freeze']['sha256'] == FREEZES[stage], 'known phase freeze differs')
    read_ref(approved['freeze'], clock)
    documents, manifest = [], {}
    total = 0
    input_bytes = []
    for identifier in sorted(approved['documents']):
        item = approved['documents'][identifier]
        require(set(item) == {'docLang', 'source_document', 'pagesSha256'}, 'roster document fields differ')
        require(isinstance(identifier, str) and identifier and '/' not in identifier and
                '\\' not in identifier and identifier not in ('.', '..') and identifier not in manifest,
                'unique filename-safe document IDs required')
        data = read_ref(item['source_document'], clock)
        total += len(data)
        require(total <= 256 * 1024 * 1024, 'full phase source cap exceeded')
        document = json.loads(data, object_pairs_hook=base.unique_object)
        require(document['id'] == identifier and document['lang'] == item['docLang'], 'input ID/language differs')
        preimage = pages_preimage(document)
        require(hashlib.sha256(preimage).hexdigest() == item['pagesSha256'], 'independent pages pin differs')
        manifest[identifier] = {'pagesSha256': item['pagesSha256'], 'docLang': item['docLang']}
        documents.append(({'id': identifier, **item}, data, preimage))
        input_bytes.append(data)
    require(len(manifest) == COUNTS[stage], 'full independent roster required')
    require(hashlib.sha256(b''.join(input_bytes)).hexdigest() == STAGE_DOCUMENTS[stage],
            'foreign cohort or changed original full source bytes')
    return approved, documents, manifest


def prepare_phase(authority, stage, phase_dir):
    clock = authority.clock
    approved, documents, manifest = roster(authority, stage)
    docs_dir = private_directory(phase_dir / 'documents', clock)
    pages_dir = private_directory(phase_dir / 'pages-preimage', clock)
    staged = {}
    for item, data, preimage in documents:
        identifier = item['id']
        source = write_bytes(docs_dir / (identifier + '.json'), data, clock)
        pages = write_bytes(pages_dir / (identifier + '.bin'), preimage, clock)
        require(source['sha256'] == item['source_document']['sha256']
                and pages['sha256'] == item['pagesSha256'], 'staged inputs differ')
        staged[identifier] = {'source_document': source, 'pages_as_run': pages}
    payload = {'schema': 'candidate6595-staged-phase-v1', 'candidate_head': HEAD,
        'candidate_tree': TREE, 'stage': stage, 'manifest': manifest, 'documents': staged,
        'approved_roster': authority.grant['approved_roster']}
    return publish(phase_dir / 'staged-inputs.json', payload, clock)


def check_staged(authority, stage, staged_ref):
    clock = authority.clock
    approved, documents, manifest = roster(authority, stage)
    staged = read_json_ref(staged_ref, clock)
    require(staged['schema'] == 'candidate6595-staged-phase-v1'
            and staged['candidate_head'] == HEAD and staged['candidate_tree'] == TREE
            and staged['stage'] == stage and staged['manifest'] == manifest
            and staged['approved_roster'] == authority.grant['approved_roster'], 'staged roster differs')
    require(set(staged['documents']) == set(manifest), 'staged source roster membership differs')
    for item, original, preimage in documents:
        artifacts = staged['documents'][item['id']]
        require(read_ref(artifacts['source_document'], clock) == original and
                read_ref(artifacts['pages_as_run'], clock) == preimage, 'staged full input bytes differ')
    return staged


def m8_gate(authority):
    """ROOT owns the H10 independent grade/quality decision; this never grants it."""
    g, clock = authority.grant, authority.clock
    if g['stage'] == 'H10':
        require(g['h10_acceptance'] is None, 'H10 cannot preload an unrelated prior acceptance')
        return
    gate = read_json_ref(g['h10_acceptance'], clock)
    require(gate['schema'] == 'root-literal6595-H10-to-M8-admission-v1'
            and gate['candidate_head'] == HEAD and gate['candidate_tree'] == TREE
            and gate['next_stage'] == 'M8' and gate['independently_root_verified'] is True
            and gate['all_original_strict_quality_checks_pass'] is True
            and gate['external_baseline_membership_preserved'] is True
            and gate['runtime_approval'] == g['runtime_approval']
            and gate['source_inventory'] == g['source_inventory'],
            'fresh independently accepted actual H10 quality required before M8')
    require(type(gate['target_seconds_per_document']) is int and gate['target_seconds_per_document'] == 180
            and type(gate['target_met']) is bool and gate['target_miss_not_waived'] is True,
            'H10 target assessment required without a waiver')
    for key in ('actual_h10_completion', 'independent_completion_verification', 'filled_review',
                'exact_carry_lineage', 'frozen_score', 'per_key_report'):
        read_ref(gate[key], clock)
    completion = read_json_ref(gate['actual_h10_completion'], clock)
    require(completion['schema'] == 'candidate6595-actual-completion-v1'
            and completion['candidate_head'] == HEAD and completion['stage'] == 'H10'
            and completion['runtime_approval'] == g['runtime_approval']
            and completion['target_assessment']['target_met'] == gate['target_met'],
            'acceptance does not bind actual H10 target/runtime evidence')
    proof = read_json_ref(gate['independent_completion_verification'], clock)
    require(proof['schema'] == 'candidate6595-root-phase-verification-v1'
            and proof['completion'] == gate['actual_h10_completion'] and proof['candidate_head'] == HEAD
            and proof['candidate_tree'] == TREE and proof['stage'] == 'H10'
            and proof['candidate_label'] == completion['candidate_label']
            and proof['runtime_approval'] == g['runtime_approval']
            and proof['source_inventory'] == g['source_inventory']
            and proof['kernel_no_children'] is True and proof['no_unbound_children'] is True
            and all(type(proof[field]) is int and proof[field] == 0
                    for field in ('actual_exit_code', 'guard_exit_code', 'coordinator_exit_code')),
            'independent actual H10 test/G/C exit and cleanup witness required')


def proc_bytes(pid, leaf, maximum=65536):
    fd = os.open('/proc/' + str(pid) + '/' + leaf, os.O_RDONLY | os.O_NONBLOCK | os.O_CLOEXEC)
    try:
        data = os.read(fd, maximum + 1)
        require(len(data) <= maximum, 'proc observation cap exceeded')
        return data
    finally:
        os.close(fd)


def await_bound_exit(pid, start, pidfd, clock):
    """Resolve disappearing metadata only by the already-bound process exiting.

    Linux can clear cmdline before the process pidfd becomes ready. Give that
    transition at most 0.5s, within the original work deadline. Persistent live
    empty metadata is still a failure; no empty argv is accepted as correct.
    """
    end = clock.clock() + .5
    while True:
        clock.check()
        if base.Owned.exited(pidfd):
            raise InstanceExited('bound process exited during metadata observation')
        info = base.proc(pid, clock)
        if base.Owned.exited(pidfd):
            raise InstanceExited('bound process exited during metadata observation')
        require(info is None or info['start'] == start,
                'process birth changed during metadata exit transition')
        remaining = min(end - clock.clock(), clock.remaining())
        require(remaining > 0, 'live process metadata unavailable without bound exit proof')
        time.sleep(min(.01, remaining))


def observe_helper_argv(pid, start, pidfd, expected, clock):
    """Compare live argv, distinguishing a proven exit from a live mismatch."""
    clock.check()
    if base.Owned.exited(pidfd):
        raise InstanceExited('helper exited before argv observation')
    before = base.proc(pid, clock)
    if before is None:
        await_bound_exit(pid, start, pidfd, clock)
    require(before['start'] == start, 'helper birth changed before argv observation')
    try:
        raw = proc_bytes(pid, 'cmdline')
    except (FileNotFoundError, ProcessLookupError):
        await_bound_exit(pid, start, pidfd, clock)
    if raw == b'':
        await_bound_exit(pid, start, pidfd, clock)
    current = [word.decode('utf-8', 'strict') for word in raw.split(b'\0') if word]
    # A positive nonempty contradiction is never waived by a later exit.
    require(current == expected, 'post-confinement argv differs from actual EXEC stop')
    after = base.proc(pid, clock)
    if after is None:
        await_bound_exit(pid, start, pidfd, clock)
    require(after['start'] == start, 'helper birth changed after argv observation')
    if base.Owned.exited(pidfd):
        raise InstanceExited('helper exited after argv observation')
    return current


def observe_tasks(pid, start, pidfd, clock):
    clock.check()
    try:
        names = sorted(os.listdir('/proc/' + str(pid) + '/task'))
    except (FileNotFoundError, ProcessLookupError):
        await_bound_exit(pid, start, pidfd, clock)
    observations = []
    for name in names:
        clock.check()
        require(len(observations) < 512, 'helper task cap exceeded')
        tid = int(name)
        try:
            raw = proc_bytes(pid, 'task/' + name + '/stat', 4096)
            fields = raw.rsplit(b') ', 1)[1].split()
            task_start = fields[19].decode('ascii')
            mask = sorted(os.sched_getaffinity(tid))
            priority = os.getpriority(os.PRIO_PROCESS, tid)
            after = proc_bytes(pid, 'task/' + name + '/stat', 4096)
            status = proc_bytes(pid, 'task/' + name + '/status', 16384)
        except (FileNotFoundError, ProcessLookupError):
            continue  # A transient task is not claimed as observed.
        require(after.rsplit(b') ', 1)[1].split()[19].decode() == task_start,
                'task birth changed across affinity observation')
        tgid = [line for line in status.splitlines() if line.startswith(b'Tgid:')]
        require(len(tgid) == 1 and int(tgid[0].split()[1]) == pid and mask == [1, 2, 3, 4]
                and priority == 10, 'actual helper task CPU/nice differs')
        observations.append({'tid': tid, 'start': task_start, 'cpus': mask, 'nice': priority})
    after = base.proc(pid, clock)
    require(after is None or after['start'] == start,
            'helper birth changed after task observation')
    if after is None or not observations:
        await_bound_exit(pid, start, pidfd, clock)
    if base.Owned.exited(pidfd):
        raise InstanceExited('helper exited during task observation')
    return observations


def command_environment(approval, stage, label, phase_dir):
    return {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'LC_ALL': 'C.UTF-8',
        'TMPDIR': str(phase_dir / 'tmp'),
        'MYCARLOS_TEST_MODEL': approval['model']['path'],
        'MYCARLOS_EVAL_EXPECT_SHA256': approval['model']['sha256'],
        'MYCARLOS_EVAL_DOCS': str(phase_dir / 'documents'),
        'MYCARLOS_EVAL_OUT': str(phase_dir / 'run.jsonl'),
        'MYCARLOS_EVAL_VARIANT': label, 'MYCARLOS_EVAL_COMMIT': HEAD,
        'MYCARLOS_TEST_LANG': 'en', 'MYCARLOS_TEST_THREADS': '3',
        'MYCARLOS_TEST_CHAT_FORMAT': approval['model']['chat_format']}


def parent_death(parent_pid, parent_start):
    import ctypes
    libc = ctypes.CDLL(None, use_errno=True)
    require(libc.prctl(1, signal.SIGTERM, 0, 0, 0) == 0, 'PDEATHSIG setup failed')
    info = base.proc(parent_pid)
    require(os.getppid() == parent_pid and info is not None and info['start'] == parent_start,
            'direct parent instance changed at startup')


def parent_role(args, role):
    """A3's parent pidfd/birth bracket, aligned with the actual -I caller API."""
    fd = os.pidfd_open(args.parent_pid, 0)
    try:
        before = base.proc(args.parent_pid)
        require(before is not None and before['start'] == args.parent_start and
                os.getppid() == args.parent_pid and not base.Owned.exited(fd), 'parent instance no longer live')
        observed = [word.decode('utf-8', 'strict') for word in
                    proc_bytes(args.parent_pid, 'cmdline').split(b'\0') if word]
        actual_interpreter = os.stat('/proc/' + str(args.parent_pid) + '/exe')
        expected_interpreter = os.stat(sys.executable)
        require([actual_interpreter.st_dev, actual_interpreter.st_ino] ==
                [expected_interpreter.st_dev, expected_interpreter.st_ino]
                and observed[1:5] == ['-I', '-B', str(PACKAGE / 'entry.py'), role],
                'internal role lacks the actual reviewed direct parent role')
        words = observed[5:]
        require(len(words) % 2 == 0, 'actual parent named argument/value pairs required')
        pairs = list(zip(words[::2], words[1::2]))
        flags = dict(pairs)
        common = {'--stage', '--grant', '--grant-sha256', '--absolute-expiry-epoch', '--boot-deadline',
                  '--package-manifest', '--package-manifest-sha256'}
        extra = {'--out'} if role == 'phase' else {'--phase-hard-boot', '--phase-dir', '--staged-inputs',
                 '--staged-inputs-sha256', '--parent-pid', '--parent-start', '--start-gate-fd'}
        require(role in ('phase', '_guard') and len(flags) == len(pairs) and set(flags) == common | extra,
                'actual parent role flag inventory differs')
        expected = {'--grant': args.grant, '--grant-sha256': args.grant_sha256, '--stage': args.stage,
                    '--package-manifest': args.package_manifest,
                    '--package-manifest-sha256': args.package_manifest_sha256}
        require(all(flags[key] == value for key, value in expected.items())
                and float(flags['--absolute-expiry-epoch']) == args.absolute_expiry_epoch
                and float(flags['--boot-deadline']) == args.boot_deadline, 'actual parent scope/package/deadline differs')
        if role == 'phase':
            require(flags['--out'] == args.phase_dir, 'actual C output differs from model phase')
        else:
            require(flags['--phase-dir'] == args.phase_dir and flags['--staged-inputs'] == args.staged_inputs
                    and flags['--staged-inputs-sha256'] == args.staged_inputs_sha256
                    and float(flags['--phase-hard-boot']) == args.phase_hard_boot,
                    'actual G phase/staged input/clock scope differs')
        after = base.proc(args.parent_pid)
        require(after is not None and after['start'] == args.parent_start and after['ppid'] == before['ppid']
                and os.getppid() == args.parent_pid and not base.Owned.exited(fd),
                'actual parent instance changed across role observation')
        return {'pid': args.parent_pid, 'start': args.parent_start, 'pidfd_bound': True,
                'actual_argv': observed, 'role': role}
    finally:
        os.close(fd)


def wait_exec_ready(read_fd, key, clock, owner, deadline):
    """A private R+EOF proves Python bootstrap reached userspace, not native exec."""
    require(type(deadline) in (int, float) and boot() < deadline <= clock.work_end,
            'original bounded EXEC dispatch deadline required')
    os.set_blocking(read_fd, False)
    pipe = os.fstat(read_fd)
    require(stat.S_ISFIFO(pipe.st_mode), 'private EXEC readiness pipe required')
    received = b''
    lowest_memory = None
    while True:
        clock.check()
        require(boot() < deadline, 'EXEC bootstrap readiness deadline exhausted')
        available = available_bytes()
        lowest_memory = available if lowest_memory is None else min(lowest_memory, available)
        require(available >= 4 * GIB, 'memory floor below 4 GiB during EXEC readiness')
        # Before SEIZE only, ordinary owned reaping is still the sole wait consumer.
        owner.reap()
        owner.discover()
        require(not owner.invalid_observations, 'unbound observation before EXEC readiness')
        entry = owner.entries.get(key)
        info = base.proc(key[0], clock)
        require(entry is not None and not owner.exited(entry['fd']) and info is not None
                and info['start'] == key[1] and info['ppid'] == os.getpid(),
                'bound H ended or changed before EXEC readiness')
        try:
            data = os.read(read_fd, 2)
        except BlockingIOError:
            time.sleep(min(.01, max(0, deadline - boot()), clock.remaining()))
            continue
        if not data:
            require(received == b'R', 'EXEC readiness EOF without exact R')
            return {'pid': key[0], 'start': key[1], 'ready_pipe_device': pipe.st_dev,
                    'ready_pipe_inode': pipe.st_ino, 'ready_observed_boot': boot(),
                    'ready_eof': True, 'absolute_dispatch_boot': deadline,
                    'lowest_available_bytes': lowest_memory,
                    'bootstrap_only_not_native_exec': True}
        received += data
        require(received == b'R', 'malformed/duplicate EXEC readiness byte')


def exec_bootstrap_gate(args, clock):
    """After verified entry/imports: ACK on a separate pipe, then wait for G."""
    ready_fd, gate_fd = args.exec_ready_fd, args.start_gate_fd
    owned = {fd for fd in (ready_fd, gate_fd) if type(fd) is int and fd > 2}
    try:
        require(type(ready_fd) is int and type(gate_fd) is int
                and ready_fd > 2 and gate_fd > 2 and ready_fd != gate_fd,
                'distinct private EXEC ready/gate descriptors required')
        ready, gate = os.fstat(ready_fd), os.fstat(gate_fd)
        require(stat.S_ISFIFO(ready.st_mode) and stat.S_ISFIFO(gate.st_mode)
                and (ready.st_dev, ready.st_ino) != (gate.st_dev, gate.st_ino),
                'EXEC readiness and release must be separate pipes')
        clock.check()
        require(os.write(ready_fd, b'R') == 1, 'EXEC bootstrap readiness ACK failed')
        owned.remove(ready_fd)
        os.close(ready_fd)  # Parent requires R followed by EOF before SEIZE.
        clock.check()
        require(os.read(gate_fd, 2) == b'G', 'no pidfd-bound parent release')
    finally:
        errors = []
        for fd in sorted(owned):
            try:
                os.close(fd)
            except OSError as error:
                errors.append(str(error))
        require(not errors, 'EXEC bootstrap channel close failed: ' + '; '.join(errors))


def spawn_gated(argv, clock, owner, terminal, *, environment=None, on_bound=None,
                exec_ready_deadline=None):
    owned_fds = set()
    child = None
    try:
        read_end, write_end = os.pipe2(os.O_CLOEXEC)
        owned_fds.update((read_end, write_end))
        child_fds = [read_end]
        command = argv + ['--start-gate-fd', str(read_end)]
        ready_read, ready_write = None, None
        if exec_ready_deadline is not None:
            require(callable(on_bound), 'EXEC readiness requires the bound-child observer callback')
            require(type(exec_ready_deadline) in (int, float)
                    and boot() < exec_ready_deadline <= clock.work_end,
                    'original EXEC readiness deadline required before spawn')
            ready_read, ready_write = os.pipe2(os.O_CLOEXEC)
            owned_fds.update((ready_read, ready_write))
            child_fds.append(ready_write)
            command += ['--exec-ready-fd', str(ready_write)]
        child = subprocess.Popen(command, stdin=subprocess.DEVNULL,
            stdout=terminal, stderr=subprocess.STDOUT, close_fds=True, pass_fds=tuple(child_fds),
            env=environment or {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'LC_ALL': 'C.UTF-8'})
        pending = {'pid': child.pid, 'start': None, 'pidfd_bound': False, 'observed_exit': None}
        owner.unbound_root_children.append(pending)
        for fd in child_fds:
            owned_fds.remove(fd)
            os.close(fd)  # Parent must not keep the readiness writer open.
        info = base.proc(child.pid, clock)
        if info is not None:
            pending['start'] = info['start']
        require(info is not None and info['ppid'] == os.getpid(), 'gated direct child identity missing')
        key = owner.bind(child.pid, info)
        require(key is not None, 'gated direct child could not be pidfd bound')
        owner.roots.append((child, key))
        owner.unbound_root_children.remove(pending)
        if exec_ready_deadline is not None:
            child._exec_ready_proof = wait_exec_ready(
                ready_read, key, clock, owner, exec_ready_deadline)
            clock.check()
            require(boot() < exec_ready_deadline, 'no time left to seize ready H')
        if on_bound is not None:
            on_bound(child, key)
        clock.check()
        if exec_ready_deadline is not None:
            require(boot() < exec_ready_deadline, 'no time left for qualified native EXEC')
        require(os.write(write_end, b'G') == 1, 'gated release failed')
        return child, key
    finally:
        errors = []
        for fd in sorted(owned_fds):
            try:
                os.close(fd)
            except OSError as error:
                errors.append(str(error))
        require(not errors, 'parent launch channel close failed: ' + '; '.join(errors))
        # Before release, closing the pipe causes a child to refuse without exec.


def exec_harness(args, deadlines, entry_boot):
    parent_death(args.parent_pid, args.parent_start)
    clock = budget(60, deadlines[0], min(deadlines[1], args.phase_hard_boot, entry_boot + 60))
    exec_bootstrap_gate(args, clock)
    # Internal dispatch is independently authority checked. A schema-shaped spec
    # plus a caller-created gate cannot authorize an arbitrary executable/model.
    authority = Authority({'path': args.grant, 'sha256': args.grant_sha256}, clock, *deadlines,
                          {'path': args.package_manifest, 'sha256': args.package_manifest_sha256})
    clock.work_hook = authority.hook
    g = authority.grant
    parent_role(args, '_guard')
    phase_dir = Path(args.phase_dir)
    require(g['stage'] == args.stage and g['output_directory'] == str(phase_dir)
            and args.exec_spec == str(phase_dir / 'dispatch.json')
            and args.staged_inputs == str(phase_dir / 'staged-inputs.json'),
            'internal dispatch paths/stage differ from explicit ROOT model scope')
    approval, _, _ = runtime_approval(authority)
    require_helper_exec_observer(authority, approval)
    check_staged(authority, args.stage, {'path': args.staged_inputs, 'sha256': args.staged_inputs_sha256})
    m8_gate(authority)
    spec = read_json_ref({'path': args.exec_spec, 'sha256': args.exec_spec_sha256}, clock)
    expected_argv = [approval['harness']['path'], '--ignored', '--nocapture', '--exact',
                     'a_real_model_evaluation_run', '--test-threads=1']
    require(spec['schema'] == 'candidate6595-qualified-harness-dispatch-v1'
            and spec['runtime_approval'] == g['runtime_approval']
            and spec['candidate_head'] == HEAD and spec['candidate_tree'] == TREE
            and spec['stage'] == args.stage and spec['candidate_label'] == g['candidate_label']
            and spec['model_grant'] == authority.ref and spec['source_inventory'] == g['source_inventory']
            and spec['approved_roster'] == g['approved_roster']
            and spec['staged_inputs'] == {'path': args.staged_inputs, 'sha256': args.staged_inputs_sha256}
            and spec['parent'] == {'pid': args.parent_pid, 'start': args.parent_start}
            and spec['absolute_expiry_epoch'] == deadlines[0] and spec['boot_deadline'] == deadlines[1]
            and type(spec['phase_hard_boot']) in (float, int)
            and boot() < spec['phase_hard_boot'] <= args.phase_hard_boot <= deadlines[1]
            and spec['argv'] == expected_argv
            and spec['environment'] == command_environment(approval, args.stage, g['candidate_label'], phase_dir),
            'only the independently qualified actual harness/known inputs/configuration may exec')
    clock.hard_end = min(clock.hard_end, spec['phase_hard_boot'])
    clock.work_end = clock.hard_end - 10
    clock.check()
    clock.arm()
    require(not (phase_dir / 'run.jsonl').exists() and available_bytes() >= 8 * GIB,
            'internal dispatch refuses existing output or low startup memory')
    dispatch = read_json_ref(file_ref(phase_dir / 'guardian-dispatch.json', clock), clock)
    require(dispatch['pid'] == args.parent_pid and dispatch['start'] == args.parent_start
            and dispatch['model_grant'] == authority.ref and dispatch['pidfd_bound_before_release'] is True,
            'internal exec lacks actual C-bound guardian lineage')
    coordinator = base.proc(dispatch['parent_pid'], clock)
    require(coordinator is not None and coordinator['start'] == dispatch['parent_start'],
            'actual coordinator lineage has ended')
    authority.check()
    os.sched_setaffinity(0, {1, 2, 3, 4})
    os.setpriority(os.PRIO_PROCESS, 0, 10)
    require(sorted(os.sched_getaffinity(0)) == [1, 2, 3, 4]
            and os.getpriority(os.PRIO_PROCESS, 0) == 10, 'model process CPU/nice setup failed')
    clock.check()
    clock.disarm()
    os.execve(spec['argv'][0], spec['argv'], spec['environment'])


def run_guard(args, deadlines, entry_boot):
    """Actual G parent of the harness. Parent C separately observes G exit."""
    parent_death(args.parent_pid, args.parent_start)
    clock = budget(PHASE_CAPS[args.stage], deadlines[0],
                   min(deadlines[1], args.phase_hard_boot, entry_boot + PHASE_CAPS[args.stage]))
    require(os.read(args.start_gate_fd, 2) == b'G', 'guardian lacks pidfd-bound coordinator release')
    os.close(args.start_gate_fd)
    set_subreaper()
    authority = Authority({'path': args.grant, 'sha256': args.grant_sha256}, clock, *deadlines,
                          {'path': args.package_manifest, 'sha256': args.package_manifest_sha256})
    require(authority.grant['stage'] == args.stage, 'guardian stage differs from explicit model scope')
    clock.work_hook = authority.hook
    phase_dir = Path(args.phase_dir)
    require(str(phase_dir) == authority.grant['output_directory']
            and str(phase_dir / 'staged-inputs.json') == args.staged_inputs,
            'guardian output/staged-input path differs from explicit grant')
    parent_role(args, 'phase')
    dispatch = read_json_ref(file_ref(phase_dir / 'guardian-dispatch.json', clock), clock)
    own = base.proc(os.getpid(), clock)
    require(dispatch['pid'] == os.getpid() and dispatch['start'] == own['start']
            and dispatch['parent_pid'] == args.parent_pid and dispatch['parent_start'] == args.parent_start
            and dispatch['model_grant'] == authority.ref and dispatch['pidfd_bound_before_release'] is True,
            'guardian lacks actual C-bound dispatch lineage')
    owner = StrictOwned(clock)
    observer = None
    child, root_key, terminal = None, None, None
    helper_records, harness_record, samples = {}, None, 0
    actual_exit, failure, snap = None, None, None
    started_wall, started_boot = time.time(), boot()
    start_memory, lowest_memory = None, None
    try:
        approval, _, _ = runtime_approval(authority)
        observer_qualification = require_helper_exec_observer(authority, approval)
        staged = check_staged(authority, args.stage,
            {'path': args.staged_inputs, 'sha256': args.staged_inputs_sha256})
        m8_gate(authority)
        authority.check()
        require(not (phase_dir / 'run.jsonl').exists(), 'output exists; resume forbidden')
        start_memory = lowest_memory = available_bytes()
        require(start_memory >= 8 * GIB, 'less than 8 GiB available before model start')
        private_directory(phase_dir / 'tmp', clock)
        label = authority.grant['candidate_label']
        env = command_environment(approval, args.stage, label, phase_dir)
        actual_argv = [approval['harness']['path'], '--ignored', '--nocapture', '--exact',
                       'a_real_model_evaluation_run', '--test-threads=1']
        parent = base.proc(os.getpid(), clock)
        spec = publish(phase_dir / 'dispatch.json', {'schema': 'candidate6595-qualified-harness-dispatch-v1',
            'candidate_head': HEAD, 'candidate_tree': TREE, 'stage': args.stage, 'candidate_label': label,
            'model_grant': authority.ref, 'source_inventory': authority.grant['source_inventory'],
            'approved_roster': authority.grant['approved_roster'],
            'staged_inputs': {'path': args.staged_inputs, 'sha256': args.staged_inputs_sha256},
            'parent': {'pid': os.getpid(), 'start': parent['start']},
            'absolute_expiry_epoch': deadlines[0], 'boot_deadline': deadlines[1],
            'phase_hard_boot': clock.hard_end, 'argv': actual_argv, 'environment': env,
            'runtime_approval': authority.grant['runtime_approval']}, clock)
        argv = [sys.executable, '-I', '-B', str(PACKAGE / 'entry.py'), '_exec',
            '--stage', args.stage, '--grant', args.grant, '--grant-sha256', args.grant_sha256,
            '--absolute-expiry-epoch', str(deadlines[0]), '--boot-deadline', str(deadlines[1]),
            '--package-manifest', args.package_manifest,
            '--package-manifest-sha256', args.package_manifest_sha256,
            '--parent-pid', str(os.getpid()), '--parent-start', parent['start'],
            '--exec-spec', spec['path'], '--exec-spec-sha256', spec['sha256'],
            '--phase-dir', str(phase_dir), '--phase-hard-boot', str(args.phase_hard_boot),
            '--staged-inputs', args.staged_inputs, '--staged-inputs-sha256', args.staged_inputs_sha256]
        terminal = open(phase_dir / 'harness-terminal.log', 'xb', buffering=0)
        os.chmod(phase_dir / 'harness-terminal.log', 0o600)
        def validate_exec(role, record):
            clock.check()
            authority.check()
            require(available_bytes() >= 4 * GIB, 'memory floor before stopped-image release')
            expected = actual_argv if role == 'harness' else [approval['helper']['path'],
                '--mycarlos-model-helper', '--threads', '3', '--name', 'FAKE test model',
                '--sha256', approval['model']['sha256'], '--chat-format', approval['model']['chat_format'],
                '--model-fd', '3']
            require(record['actual_argv'] == expected and record['kernel_exec_stop_before_userspace'] is True
                    and record['hash_read_from_kernel_exe_fd'] is True,
                    'full actual EXEC-stop role/argv differs from qualified literal6595 dispatch')
            require(sorted(os.sched_getaffinity(record['pid'])) == [1, 2, 3, 4]
                    and os.getpriority(os.PRIO_PROCESS, record['pid']) == 10,
                    'EXEC-stop CPU/nice differs')

        def seize_bound_harness(bound_child, bound_key):
            nonlocal observer
            ready = bound_child._exec_ready_proof
            require(ready['pid'] == bound_key[0] and ready['start'] == bound_key[1]
                    and ready['ready_eof'] is True
                    and boot() < ready['absolute_dispatch_boot'],
                    'only the same ready-bound H may be seized')
            observer = DiagnosticExecObserver(owner, clock, base, approval, bound_key, proc_bytes,
                                    on_exec=validate_exec)
            observer.event('exec-bootstrap-ready-before-seize', **ready)
            observer.seize(bound_child, bound_key)

        # One original 60s covers bootstrap READY, SEIZE, gate G and actual native EXEC.
        dispatch_deadline = min(boot() + 60, clock.work_end)
        child, root_key = spawn_gated(argv, clock, owner, terminal,
            on_bound=seize_bound_harness, exec_ready_deadline=dispatch_deadline)
        lowest_memory = min(lowest_memory, child._exec_ready_proof['lowest_available_bytes'])
        # H has inherited nice10. G may now become the CPU0/nice19 controller.
        os.sched_setaffinity(0, {0})
        os.setpriority(os.PRIO_PROCESS, 0, 19)
        while child.returncode is None:
            clock.check()
            available = available_bytes()
            lowest_memory = min(lowest_memory, available)
            require(available >= 4 * GIB, 'memory floor below 4 GiB')
            owner.reap()  # The observer is the ONLY __WALL status consumer.
            owner.discover()
            require(not owner.invalid_observations, 'unbound process observation invalidates this run')
            for key, entry in list(owner.entries.items()):
                pid, start = key
                if owner.exited(entry['fd']):
                    continue
                info = base.proc(pid, clock)
                if owner.exited(entry['fd']):
                    continue
                if info is None:
                    try:
                        await_bound_exit(pid, start, entry['fd'], clock)
                    except InstanceExited:
                        require(key in helper_records or (key == root_key and harness_record is not None),
                                'process exited before a qualified live observation')
                        continue
                require(info is not None and info['start'] == start, 'owned live process became unobservable')
                if key == root_key:
                    if key not in observer.records:
                        require(harness_record is None and boot() < dispatch_deadline,
                                'qualified harness kernel EXEC stop never observed')
                        continue
                    record = observer.record(key)
                    require(record['actual_argv'] == actual_argv, 'actual harness argv differs')
                    require(sorted(os.sched_getaffinity(pid)) == [1, 2, 3, 4]
                            and os.getpriority(os.PRIO_PROCESS, pid) == 10, 'harness CPU/nice differs')
                    if harness_record is None:
                        harness_record = record
                    continue
                require(info['ppid'] == child.pid, 'unexpected/adopted live descendant during model work')
                if key not in observer.records:
                    waiting = observer.tracees.get(pid)
                    require(waiting is not None and waiting['key'] == key
                            and boot() < waiting['registered_boot'] + 60,
                            'helper lacks a bounded owned kernel EXEC-stop transition')
                    continue
                record = observer.record(key)
                # Actual startup argv was captured before first instruction.
                # Qualify the separate post-DUMPABLE0 metadata interfaces too.
                try:
                    observe_helper_argv(pid, start, entry['fd'], record['actual_argv'], clock)
                except InstanceExited:
                    require(key in helper_records and owner.exited(entry['fd']),
                            'helper exited before a qualified live observation')
                    continue
                argv_observed = record['actual_argv']
                require('--mycarlos-model-helper' in argv_observed and '--stub' not in argv_observed,
                        'unexpected helper mode')
                for flag, expected in (('--threads', '3'), ('--sha256', approval['model']['sha256']),
                                       ('--chat-format', approval['model']['chat_format'])):
                    require(argv_observed.count(flag) == 1 and argv_observed.index(flag) + 1 < len(argv_observed)
                            and argv_observed[argv_observed.index(flag) + 1] == expected,
                            'actual helper argument differs: ' + flag)
                try:
                    tasks = observe_tasks(pid, start, entry['fd'], clock)
                except (FileNotFoundError, ProcessLookupError, InstanceExited):
                    if key in helper_records and owner.exited(entry['fd']):
                        continue
                    raise
                if key not in helper_records:
                    record['first_task_observations'] = tasks
                    helper_records[key] = record
                helper_records[key]['last_task_observations'] = tasks
                helper_records[key]['last_observed_at'] = now()
                helper_records[key]['sample_count'] = helper_records[key].get('sample_count', 0) + 1
                samples += 1
            owner.reap()
            if child.returncode is None:
                time.sleep(min(.1, clock.remaining()))
        actual_exit = child.returncode
        require(type(actual_exit) is int and actual_exit == 0 and harness_record is not None
                and helper_records and samples > 0, 'actual harness exit/exec/helper observation missing or failed')
        require(all(key == root_key or key in helper_records for key in owner.entries),
                'registered descendant lacks actual helper exec evidence')
        authority.check()
    except BaseException as error:
        failure = type(error).__name__ + ': ' + str(error)
    finally:
        try:
            snap = cleanup(owner, clock)
            if child is not None:
                actual_exit = child.returncode
            require(snap['cleanup_complete'] and snap['kernel_no_children']
                    and snap['no_unbound_children'] and snap['cleanup_error'] is None,
                    'guardian cleanup or instance evidence incomplete')
        except BaseException as error:
            failure = (failure + '; ' if failure else '') + type(error).__name__ + ': ' + str(error)
        if terminal is not None:
            try:
                terminal.flush()
                os.fsync(terminal.fileno())
                terminal.close()
                os.chmod(phase_dir / 'harness-terminal.log', 0o400)
            except BaseException as error:
                failure = (failure + '; ' if failure else '') + 'terminal finalization: ' + str(error)
    try:
        payload = {'schema': GUARD_SCHEMA, 'candidate_head': HEAD, 'candidate_tree': TREE,
            'stage': args.stage, 'candidate_label': authority.grant['candidate_label'],
            'actual_exit_code': actual_exit, 'status': 'actual-observed' if failure is None else 'failed',
            'failure': failure, 'harness': harness_record, 'helpers': list(helper_records.values()),
            'actual_argv': None if child is None else actual_argv,
            'actual_environment': None if child is None else env,
            'start_epoch': started_wall, 'end_epoch': time.time(), 'start_boot': started_boot, 'end_boot': boot(),
            'absolute_expiry_epoch': deadlines[0], 'boot_deadline': deadlines[1],
            'phase_hard_boot': args.phase_hard_boot,
            'memory': {'start_available_bytes': start_memory, 'lowest_available_bytes': lowest_memory,
                       'start_floor_bytes': 8 * GIB, 'stop_floor_bytes': 4 * GIB},
            'run': None if not (phase_dir / 'run.jsonl').exists() else file_ref(phase_dir / 'run.jsonl', clock),
            'terminal': None if child is None else file_ref(phase_dir / 'harness-terminal.log', clock),
            'runtime_approval': authority.grant['runtime_approval'],
            'approved_roster': authority.grant['approved_roster'],
            'source_inventory': authority.grant['source_inventory'],
            'model_grant': authority.ref, 'staged_inputs': {'path': args.staged_inputs,
                                                          'sha256': args.staged_inputs_sha256},
            'cleanup': snap, 'no_unbound_children': snap is not None and snap['no_unbound_children'],
            'controller': {'pid': os.getpid(), 'cpus': sorted(os.sched_getaffinity(0)),
                           'nice': os.getpriority(os.PRIO_PROCESS, 0)},
            'kernel_exec_observer': None if observer is None else observer.snapshot(),
            'kernel_exec_observer_qualification': None if observer is None else observer_qualification,
            'polling_observation_limit': 'instance/task samples; no claim to observe tasks fully born and reaped between samples',
            'independent_root_verification_required': True}
        publish(phase_dir / 'phase-guard.json', payload, clock)
        return 0 if failure is None else 1
    finally:
        try:
            if observer is not None:
                observer.close()  # Retain true EXEC FDs through receipt publication.
        finally:
            owner.close()
            clock.disarm()


def completed_run(authority, stage, phase_dir, staged, approval, guard):
    clock = authority.clock
    data = base.read_path(phase_dir / 'run.jsonl', 64 * 1024 * 1024, clock)
    require(data and data.endswith(b'\n'), 'complete newline-terminated actual run required')
    rows = [json.loads(line, object_pairs_hook=base.unique_object) for line in data.splitlines()]
    require(len(rows) == COUNTS[stage] + 2 and rows[0]['kind'] == 'run' and rows[-1]['kind'] == 'end',
            'exact header/full roster/end required')
    header, end = rows[0], rows[-1]
    g = authority.grant
    require(header['commit'] == HEAD and header['variant'] == g['candidate_label'] and header['lang'] == 'en'
            and type(header['threads']) is int and header['threads'] == 3
            and header['runnerSha256'] == approval['helper']['sha256']
            and header['harnessSha256'] == approval['harness']['sha256']
            and header['documents'] == staged['manifest'] and header['build'] == approval['expected_build']
            and header['model']['sha256'] == approval['model']['sha256']
            and header['model']['bytes'] == approval['model']['bytes']
            and header['model']['chatFormat'] == approval['model']['chat_format'], 'actual raw header differs from independent pins')
    require(guard['start_epoch'] - 1 <= header['startedAt'] <= end['finishedAt'] <= guard['end_epoch'] + 1
            and end['answered'] == COUNTS[stage], 'actual run timing/end count inconsistent')
    identifiers, durations = [], []
    for row in rows[1:-1]:
        require(row['kind'] == 'document' and 'error' not in row and isinstance(row['result'], dict),
                'failed/incomplete document')
        identifier = row['id']
        require(identifier in staged['manifest'] and identifier not in identifiers and
                row['pagesSha256'] == staged['manifest'][identifier]['pagesSha256'] and
                row['docLang'] == staged['manifest'][identifier]['docLang'], 'document identity differs')
        stats = row['result']['stats']
        require(type(stats['threads']) is int and stats['threads'] == 3
                and type(stats['batchThreads']) is int and stats['batchThreads'] == 3,
                'actual decode/batch thread stats differ from 3/3')
        require(type(row['wallMs']) is int and row['wallMs'] >= 0, 'actual duration missing')
        identifiers.append(identifier)
        durations.append(row['wallMs'])
    require(set(identifiers) == set(staged['manifest']), 'actual complete roster differs')
    return header, {'target_seconds_per_document': 180, 'documents': len(durations),
        'documents_over_target': sum(value > 180000 for value in durations),
        'target_met': all(value <= 180000 for value in durations),
        'max_wall_ms': max(durations), 'total_wall_ms': sum(durations), 'quality_pass_not_inferred': True}


def export_sources(authority, stage, phase_dir, staged, run):
    payload = {'schema': SOURCE_EXPORT_SCHEMA, 'candidate_head': HEAD, 'stage': stage,
        'candidate_label': authority.grant['candidate_label'], 'run': run,
        'approved_roster': authority.grant['approved_roster'],
        'runtime_approval': authority.grant['runtime_approval'],
        'source_inventory': authority.grant['source_inventory'], 'documents': staged['documents']}
    return publish(phase_dir / 'source-exports.json', payload, authority.clock)
