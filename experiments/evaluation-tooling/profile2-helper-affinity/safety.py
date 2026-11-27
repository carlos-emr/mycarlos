"""Instance-bound authority/I/O/process helpers; selected V9 stays byte-for-byte."""
import ctypes
import datetime as dt
import hashlib
import json
import math
import os
from pathlib import Path
import re
import signal
import stat
import time

import guard_support as base
import profile2
from interfaces import HEAD, TREE, COUNTS, canonical_sha256, reference

require = base.require
Refusal = base.Refusal
GIB = 1024 ** 3
PACKAGE = Path(__file__).parent
V9_SHA256 = 'ca396b511f857c0396a5f24fedd76e93df7d5553a7ecc8ea735e97425d4f2bd8'
PHASE_CAPS = {'H10': 3000, 'M8': 3000, 'P2': 600}  # Includes each phase's ten-second cleanup.
FREEZES = {'H10': 'b657b15e20a043bc31dd842e9a5587f2414029b2f8e1e81598ad2c1614c57e63',
           'M8': 'b3b570885e1b05cd18387c7717cd27f02a70ff8ae88b6431c97c11ff32575c08',
           'P2': profile2.INPUT_FREEZE_SHA256}


def boot():
    return time.clock_gettime(time.CLOCK_BOOTTIME)


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def budget(relative, wall, boot_end, cleanup=10):
    clock = base.Budget(relative, wall, cleanup, monotonic=boot)
    clock.hard_end = min(clock.hard_end, boot_end)
    clock.work_end = clock.hard_end - cleanup
    clock.check()
    clock.arm()
    return clock


def read_ref(ref, clock, maximum=64 * 1024 * 1024):
    require(isinstance(ref, dict) and set(ref) == {'path', 'sha256'}, 'exact artifact reference required')
    require(reference(ref['path'], ref['sha256']) == ref and str(Path(ref['path'])) == ref['path'],
            'canonical absolute reference required')
    require('..' not in Path(ref['path']).parts, 'parent traversal is not a canonical artifact reference')
    data = base.read_path(ref['path'], maximum, clock)
    require(hashlib.sha256(data).hexdigest() == ref['sha256'], 'artifact hash mismatch: ' + ref['path'])
    return data


def read_json_ref(ref, clock, maximum=16 * 1024 * 1024):
    return json.loads(read_ref(ref, clock, maximum), object_pairs_hook=base.unique_object,
                      parse_constant=lambda value: (_ for _ in ()).throw(Refusal('nonfinite JSON')))


def file_ref(path, clock, maximum=64 * 1024 * 1024):
    return reference(str(path), base.digest(path, clock, maximum))


def publish(path, payload, clock):
    base.immutable_json(path, payload, clock)
    return file_ref(path, clock)


def private_directory(path, clock):
    path = Path(path)
    parent = base.directory_fd(path.parent, clock)
    try:
        os.mkdir(path.name, 0o700, dir_fd=parent)  # EXCLUSIVE: never resume a prior attempt.
        os.fsync(parent)
    finally:
        os.close(parent)
    return path


def write_bytes(path, data, clock):
    parent, leaf = base.parent_fd(Path(path).parent, Path(path).name, clock)
    fd = None
    try:
        fd = os.open(leaf, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                     0o600, dir_fd=parent)
        view = memoryview(data)
        while view:
            clock.check()
            count = os.write(fd, view[:65536])
            require(count > 0, 'short evidence write')
            view = view[count:]
        os.fsync(fd)
        os.fchmod(fd, 0o400)
        os.fsync(fd)
        os.fsync(parent)
    finally:
        if fd is not None:
            os.close(fd)
        os.close(parent)
    return file_ref(path, clock)


def set_subreaper():
    libc = ctypes.CDLL(None, use_errno=True)
    require(libc.prctl(36, 1, 0, 0, 0) == 0, 'PR_SET_CHILD_SUBREAPER failed')
    result = ctypes.c_int()
    require(libc.prctl(37, ctypes.byref(result), 0, 0, 0) == 0 and result.value == 1,
            'PR_GET_CHILD_SUBREAPER failed')


class StrictOwned(base.Owned):
    """V9 binding, plus fail-closed model evidence and pre-reap unknown detection.

    An event does not grant ownership. Cleanup still uses only V9-bound pidfds.
    Positive unbound exit/defer observations permanently invalidate the attempt.
    """
    def __init__(self, clock):
        super().__init__(clock)
        self.invalid_observations = []
        self.unbound_root_children = []

    def bind(self, pid, expected, *, discovery_defer=False):
        key = super().bind(pid, expected, discovery_defer=discovery_defer)
        if key is None:
            self.invalid_observations.append({'kind': 'positive-unbound-discovery', 'pid': pid,
                                              'expected_start': expected['start']})
        return key

    def reap(self):
        self.no_children = False
        while True:
            self.budget.check()
            try:
                event = os.waitid(os.P_ALL, 0, os.WEXITED | os.WNOHANG | os.WNOWAIT)
            except ChildProcessError:
                self.no_children = True
                return
            if event is None or event.si_pid == 0:
                return
            pid = event.si_pid
            current = base.proc(pid, self.budget)
            matches = []
            for key, entry in self.entries.items():
                if key[0] != pid or current is None or key[1] != current['start']:
                    continue
                try:
                    if self.exited(entry['fd']):
                        matches.append((key, entry))
                except BaseException as error:
                    # The kernel waitid event is still ours to drain. A broken
                    # descriptor invalidates evidence, never blocks later waits.
                    self.invalid_observations.append({'kind': 'pidfd-readiness-before-reap-error',
                        'pid': pid, 'start': key[1], 'error': str(error)})
            if len(matches) != 1:
                self.invalid_observations.append({'kind': 'unbound-child-before-reap',
                    'pid': pid, 'start': None if current is None else current['start']})
            waited, status = os.waitpid(pid, os.WNOHANG)
            require(waited == pid, 'waitid/waitpid observation changed')
            for child, key in self.roots:
                if child.pid == pid:
                    child.returncode = os.waitstatus_to_exitcode(status)
            for item in self.unbound_root_children:
                if item['pid'] == pid:
                    item['observed_exit'] = os.waitstatus_to_exitcode(status)
            for key, entry in matches:
                entry['reaped'] = True

    def snapshot(self):
        result = super().snapshot()
        result['unbound_observations'] = list(self.invalid_observations)
        result['unbound_root_children'] = list(self.unbound_root_children)
        result['no_unbound_children'] = not self.invalid_observations and not self.unbound_root_children
        return result

    def signal_all(self, number):
        failures = []
        for (pid, start), entry in self.entries.items():
            self.budget.check()
            try:
                if self.exited(entry['fd']):
                    continue
                signal.pidfd_send_signal(entry['fd'], number, None, 0)
            except ProcessLookupError:
                continue
            except BaseException as error:
                failures.append({'kind': 'pidfd-signal-error', 'pid': pid, 'start': start,
                                 'signal': number, 'error': str(error)})
        if failures:
            self.invalid_observations.extend(failures)
            raise Refusal('one or more owned pidfd signals failed; all safe targets attempted')


def cleanup(owner, clock):
    """At most ten seconds within the original hard deadline; never extends it."""
    clock.disarm()
    clock.enter_final()
    clock.hard_end = min(clock.hard_end, boot() + 10)
    signal.setitimer(signal.ITIMER_REAL, max(.001, clock.remaining(final=True)))
    began = boot()
    errors = []
    while clock.remaining(final=True) > .05:
        snapshot = None
        actions = (owner.discover,
                   lambda: owner.signal_all(signal.SIGKILL if boot() - began >= 2 else signal.SIGTERM),
                   owner.reap)
        for action in actions:
            try:
                action()
            except BaseException as failure:
                errors.append(type(failure).__name__ + ': ' + str(failure))
                errors = errors[-64:]
        try:
            snapshot = owner.snapshot()
        except BaseException as failure:
            errors.append(type(failure).__name__ + ': ' + str(failure))
            errors = errors[-64:]
        if snapshot is not None and snapshot['cleanup_complete']:
            snapshot['cleanup_error'] = '; '.join(errors) if errors else None
            return snapshot
        time.sleep(min(.05, clock.remaining(final=True)))
    raise Refusal('owned cleanup did not reach ECHILD within original deadline')


def available_bytes():
    with open('/proc/meminfo', 'rb', buffering=0) as stream:
        data = stream.read(65536)
    for line in data.splitlines():
        if line.startswith(b'MemAvailable:'):
            return int(line.split()[1]) * 1024
    raise Refusal('MemAvailable unavailable')


def executable_artifact(item, clock, *, independent=False):
    ref = {'path': item['path'], 'sha256': item['sha256']}
    path = Path(ref['path'])
    fd, parent, leaf, before = base.checked_source(path.parent, path.name, clock)
    try:
        require(before.st_uid == os.geteuid() and stat.S_IMODE(before.st_mode) == 0o500,
                'qualified executable must be readonly owner executable')
        require(before.st_size == item['bytes'] and before.st_dev == item['device']
                and before.st_ino == item['inode'] and before.st_nlink == item['nlink'],
                'qualified executable instance differs')
        require(not independent or before.st_nlink == 1, 'harness bundle must be independent inode')
        require(base.digest_fd(fd, 4 * GIB, clock) == ref['sha256'], 'actual binary hash mismatch')
        require(base.identity(before) == base.identity(os.fstat(fd)) ==
                base.identity(os.stat(leaf, dir_fd=parent, follow_symlinks=False)), 'binary changed')
        return {'ref': ref, 'stat': [before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns]}
    finally:
        os.close(fd)
        os.close(parent)


class Authority:
    """Read-only validation of ROOT's explicit model grant and retained global holder.

    Never creates/acquires/releases a lock, edits a marker, or renews any window.
    The trusted outer ROOT command supplies the exact grant byte hash.
    """
    def __init__(self, grant_ref, clock, wall, boot_end, entry_package):
        self.ref, self.clock = grant_ref, clock
        self.grant = read_json_ref(grant_ref, clock)
        g = self.grant
        require(g['coordinator_package'] == entry_package,
                'explicit model grant must bind the same package verified before import')
        diagnostic = g.get('stage') == 'P2'
        expected_schema = profile2.GRANT_SCHEMA if diagnostic else 'root-literal6595-model-evaluation-grant-v1'
        expected_purpose = profile2.PURPOSE if diagnostic else 'pr313-known-H10-M8-model-evaluation'
        require(g['schema'] == expected_schema and g['purpose'] == expected_purpose
                and g['candidate_head'] == HEAD and g['candidate_tree'] == TREE,
                'a distinct literal6595 model grant is required; native/pilot grants do not authorize this')
        require(g['stage'] in COUNTS and g['stages'] == [g['stage']] and g['model_execution_authorized'] is True
                and g['retain_existing_root_pr_validation_hold'] is True,
                'explicit known-set model/HOLD authority required')
        require(g['own_descendant_ptrace_authorized'] is True
                and g['kernel_exec_observer_mode'] == 'owned-descendant-PTRACE_SEIZE-TRACEEXEC-v1',
                'explicit ROOT-admitted own-descendant EXEC-stop observer scope required')
        require(isinstance(g['attempt'], str) and re.fullmatch(r'[A-Za-z0-9_]{1,80}', g['attempt'])
                and g['candidate_label'] == 'M2literal6595-' + g['attempt'] + '-' + g['stage'],
                'exact fresh literal6595 stage label required in every execution role')
        output = Path(g['output_directory'])
        require(output.is_absolute() and str(output) == g['output_directory'] and '..' not in output.parts,
                'canonical explicit grant-bound output directory required')
        require(g['absolute_expiry_epoch'] == wall and g['boot_deadline'] == boot_end
                and type(wall) in (float, int) and math.isfinite(wall)
                and g['max_total_seconds'] <= 7200,
                'deadline mismatch/renewal forbidden')
        require(0 < g['max_total_seconds'] <= 7200 and 0 < g['issued_at_epoch'] <= time.time()
                and wall - g['issued_at_epoch'] <= 7200, 'fresh finite model window required')
        require(g['target_seconds_per_document'] == 180 and g['preserve_original_strict_quality'] is True,
                'original strict quality and 180 second target required')
        self.profile_plan = None
        if diagnostic:
            self.profile_plan = read_json_ref(g['profile_plan'], clock)
            profile2.validate_scope(g, self.profile_plan)
        require((diagnostic or g['cpus'] == [1, 2, 3, 4]) and g['nice'] == 10 and g['threads'] == 3
                and g['language'] == 'en' and g['start_memory_bytes'] == 8 * GIB
                and g['stop_memory_bytes'] == 4 * GIB, 'reviewed runtime limits differ')
        self.clock.hard_end = min(self.clock.hard_end, self.clock.started + g['max_total_seconds'])
        self.clock.work_end = self.clock.hard_end - 10
        self.clock.arm()
        self.grant_stat = os.stat(grant_ref['path'], follow_symlinks=False)
        self.checked_at = 0
        self.active_check = False
        self.check()

    def check(self):
        if self.active_check:
            return
        self.active_check = True
        try:
            g = self.grant
            require(boot() < g['boot_deadline'] and time.time() < g['absolute_expiry_epoch'],
                    'ROOT model window expired')
            current = os.stat(self.ref['path'], follow_symlinks=False)
            require(base.identity(current) == base.identity(self.grant_stat), 'model grant bytes changed')
            require(hashlib.sha256(base.read_path(self.ref['path'], 16 * 1024 * 1024, self.clock)).hexdigest()
                    == self.ref['sha256'] and base.identity(current) ==
                    base.identity(os.stat(self.ref['path'], follow_symlinks=False)),
                    'actual model grant content/instance changed across authority check')
            holder = g['holder']
            info = base.proc(holder['pid'])
            require(info is not None and info['start'] == holder['start'] and info['state'] not in ('Z', 'X'),
                    'actual ROOT holder instance absent/reused')
            fd_stat = os.stat('/proc/' + str(holder['pid']) + '/fd/' + str(holder['fd']))
            require([fd_stat.st_dev, fd_stat.st_ino] == [holder['lock_device'], holder['lock_inode']],
                    'ROOT holder FD no longer names approved lock')
            wanted = (os.major(holder['lock_device']), os.minor(holder['lock_device']), holder['lock_inode'])
            found = False
            with open('/proc/locks', 'r', encoding='ascii') as stream:
                for number, line in enumerate(stream):
                    require(number < 10000, 'kernel lock row cap exceeded')
                    columns = line.split()
                    if len(columns) >= 8 and columns[1:4] == ['FLOCK', 'ADVISORY', 'WRITE']:
                        major, minor, inode = columns[5].split(':')
                        if int(columns[4]) == holder['pid'] and (int(major, 16), int(minor, 16), int(inode)) == wanted:
                            require(columns[6:8] == ['0', 'EOF'], 'whole-file ROOT lock required')
                            found = True
            require(found, 'approved actual ROOT kernel lock absent')
            marker = g['retained_hold']
            require(marker['path'] == '/root/reports/ai-eval/runs/HOLD-k16'
                    and marker['sha256'] == '074fc16384b12bd4eed66edf03d0b71c72176ecee134cbbce116e4ed12560562',
                    'only the explicitly retained existing ROOT PR-validation HOLD is supported')
            checked = os.stat(marker['path'], follow_symlinks=False)
            expected = ['st_dev', 'st_ino', 'st_uid', 'st_mode', 'st_nlink', 'st_mtime_ns', 'st_ctime_ns']
            require(stat.S_ISREG(checked.st_mode) and all(getattr(checked, key) == marker[key] for key in expected),
                    'exact retained ROOT HOLD metadata changed')
            require(hashlib.sha256(base.read_path(marker['path'], 16384, self.clock)).hexdigest() == marker['sha256'],
                    'exact retained ROOT HOLD bytes changed')
            boot_id = base.read_path('/proc/sys/kernel/random/boot_id', 128, self.clock).decode().strip()
            require(boot_id == g['boot_id'], 'machine boot differs')
        finally:
            self.active_check = False

    def hook(self):
        if boot() >= self.checked_at + 1:
            self.check()
            self.checked_at = boot()


def runtime_approval(authority):
    g, clock = authority.grant, authority.clock
    approval = read_json_ref(g['runtime_approval'], clock)
    require(approval['schema'] == 'candidate6595-runtime-approval-v1'
            and approval['candidate_head'] == HEAD and approval['candidate_tree'] == TREE
            and approval['native_runtime_passed'] is True and approval['harness_no_run_passed'] is True
            and approval['independently_root_verified'] is True
            and approval['source_inventory'] == g['source_inventory'], 'actual native+harness qualification required')
    require(approval['lang'] == 'en' and type(approval['threads']) is int and approval['threads'] == 3
            and approval['helper_sha256'] == approval['helper']['sha256']
            and approval['harness_sha256'] == approval['harness']['sha256']
            and approval['model_sha256'] == approval['model']['sha256'], 'A2 runtime identity fields differ')
    for receipt in approval['actual_qualification_artifacts']:
        read_ref(receipt, clock)
    require(len(approval['actual_qualification_artifacts']) >= 2, 'qualification evidence missing')
    inventory = read_json_ref(g['source_inventory'], clock)
    require(inventory['schema'] == 'root-literal6595-source-inventory-v1'
            and inventory['candidate_head'] == HEAD and inventory['candidate_tree'] == TREE
            and inventory['files'], 'independent literal source inventory required')
    require(len(inventory['files']) <= 10000, 'source inventory cap')
    total = 0
    paths = set()
    for item in inventory['files']:
        require(item['path'] not in paths, 'duplicate source inventory path')
        paths.add(item['path'])
        total += len(read_ref(item, clock))
        require(total <= 512 * 1024 * 1024, 'whole source inventory cap exceeded')
    require(approval['helper']['path'] == approval['compiletime_helper_path'],
            'dispatch must use the qualified compile-time canonical helper path')
    helper = executable_artifact(approval['helper'], clock)
    harness = executable_artifact(approval['harness'], clock, independent=True)
    model = approval['model']
    require(base.digest(model['path'], clock, 16 * GIB) == model['sha256']
            and os.stat(model['path'], follow_symlinks=False).st_size == model['bytes'],
            'qualified actual GGUF bytes differ')
    package = read_json_ref(g['coordinator_package'], clock)
    require(package['schema'] == 'literal6595-coordinator-source-manifest-v1', 'reviewed source package required')
    expected = {path.name for path in PACKAGE.glob('*.py')}
    require(set(package['files']) == expected, 'complete actual coordinator source inventory required')
    for name, digest in package['files'].items():
        require(file_ref(PACKAGE / name, clock)['sha256'] == digest, 'coordinator source changed')
    require(package['files']['guard_support.py'] == V9_SHA256, 'only selected unchanged V9 ownership source allowed')
    return approval, helper, harness
