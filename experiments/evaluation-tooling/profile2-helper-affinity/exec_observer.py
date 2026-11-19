"""Unexecuted source: gated descendant EXEC-stop observation only.

No import-time process, ptrace, signal, timer, model or filesystem action.
No memory/register/syscall inspection, injected code, or application changes.
"""
import ctypes
import os
import signal
import stat

SEIZE = 0x4206
CONT = 7
DETACH = 17
LISTEN = 0x4208
GETEVENTMSG = 0x4201
TRACEFORK, TRACEVFORK, TRACECLONE, TRACEEXEC = 2, 4, 8, 16
EXITKILL = 0x00100000
OPTIONS = TRACEFORK | TRACEVFORK | TRACECLONE | TRACEEXEC | EXITKILL
FORK, VFORK, CLONE, EXEC, STOP = 1, 2, 3, 4, 128
WALL = 0x40000000
GROUP_SIGNALS = {signal.SIGSTOP, signal.SIGTSTP, signal.SIGTTIN, signal.SIGTTOU}


class Kernel:
    def __init__(self):
        self.libc = ctypes.CDLL(None, use_errno=True)
        self.libc.ptrace.argtypes = [ctypes.c_uint, ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p]
        self.libc.ptrace.restype = ctypes.c_long

    def call(self, request, tid, data=0):
        ctypes.set_errno(0)
        result = self.libc.ptrace(request, tid, None, ctypes.c_void_p(data))
        if result == -1:
            error = ctypes.get_errno()
            raise OSError(error, os.strerror(error))
        return result

    def message(self, tid):
        value = ctypes.c_ulong()
        self.call(GETEVENTMSG, tid, ctypes.addressof(value))
        return value.value

    def peek(self):
        return os.waitid(os.P_ALL, 0,
                         os.WEXITED | os.WSTOPPED | os.WNOHANG | os.WNOWAIT | WALL)

    def consume(self, pending):
        tid, status = os.waitpid(pending.si_pid, os.WNOHANG | WALL)
        if tid != pending.si_pid:
            raise RuntimeError('peeked child status disappeared before sole consume')
        if pending.si_code == os.CLD_EXITED:
            same = os.WIFEXITED(status) and os.WEXITSTATUS(status) == pending.si_status
        elif pending.si_code in (os.CLD_KILLED, os.CLD_DUMPED):
            same = (os.WIFSIGNALED(status) and os.WTERMSIG(status) == pending.si_status
                    and bool(os.WCOREDUMP(status)) == (pending.si_code == os.CLD_DUMPED))
        elif pending.si_code in (os.CLD_STOPPED, os.CLD_TRAPPED):
            same = os.WIFSTOPPED(status) and (status >> 8) == pending.si_status
        else:
            same = False
        if not same:
            raise RuntimeError('peeked child status differs from targeted consume')
        return tid, status


def status_fields(data):
    fields = {}
    for line in data.splitlines():
        if b':' in line:
            key, value = line.split(b':', 1)
            fields[key] = value.strip()
    return fields


class ExecObserver:
    """One G owns tracing of its already pidfd-bound, still gated direct H child.

    Kernel stop notifications carry the tracer relationship. Numeric TIDs are
    used only in ptrace requests for those stopped tracees, bracketed by recorded
    birth and TracerPid; process cancellation remains the owner's bound pidfds.
    All thread stops/exits are consumed here, never by Popen.poll or another wait
    consumer. Kernel waitpid ECHILD remains necessary for owner.no_children.
    """
    def __init__(self, owner, clock, base, approval, root_key, proc_bytes,
                 on_exec=None, kernel=None):
        self.owner, self.clock, self.base = owner, clock, base
        self.approval, self.root_key, self.proc_bytes = approval, root_key, proc_bytes
        self.require = base.require
        self.require(callable(on_exec), 'full role argv validation callback is required')
        self.on_exec = on_exec
        self.kernel = kernel if kernel is not None else Kernel()
        self.tracees, self.pending, self.records, self.exe_fds = {}, {}, {}, {}
        self.detached_helpers = {}
        self.events, self.event_count = [], 0
        self.seized = False
        self.closed = False

    def event(self, kind, **values):
        self.event_count += 1
        self.events.append({'kind': kind, **values})
        del self.events[:-128]

    def fields(self, tid):
        return status_fields(self.proc_bytes(tid, 'status'))

    def register(self, tid, parent=None):
        self.clock.check()
        self.require(len(self.tracees) < 4096 and tid not in self.tracees, 'tracee bound/duplicate')
        before = self.base.proc(tid, self.clock)
        self.require(before is not None, 'kernel tracee birth unavailable')
        fields = self.fields(tid)
        tgid = int(fields[b'Tgid'])
        self.require(int(fields[b'TracerPid']) == os.getpid(), 'tracee lacks actual G tracer')
        if tgid == tid:
            key = (tid, before['start'])
            if key not in self.owner.entries:
                self.require(parent is not None and before['ppid'] == parent['tgid'],
                             'kernel fork is not a known traced process child')
                self.require(self.owner.bind(tid, before) == key, 'fork process not safely pidfd bound')
        else:
            self.require(parent is not None and tgid == parent['tgid'], 'foreign clone thread group')
            matches = [key for key in self.owner.entries if key[0] == tgid]
            self.require(len(matches) == 1, 'thread group is not uniquely pidfd bound')
            key = matches[0]
        thread_fd = None
        try:
            if tgid != tid:
                # Linux PIDFD_THREAD is O_EXCL. Require actual kernel support and
                # permission; version/header metadata alone never qualifies it.
                thread_fd = os.pidfd_open(tid, os.O_EXCL)
                self.require(not self.owner.exited(thread_fd), 'new thread pidfd already exited')
            after = self.base.proc(tid, self.clock)
            self.require(after is not None and after['start'] == before['start'], 'tracee birth changed')
            self.tracees[tid] = {'start': before['start'], 'tgid': tgid, 'key': key,
                                 'thread_fd': thread_fd, 'initial_stop': parent is not None,
                                 'stopped_status': None, 'registered_boot': self.clock.clock()}
            thread_fd = None
        finally:
            if thread_fd is not None:
                os.close(thread_fd)
        return self.tracees[tid]

    def seize(self, child, root_key):
        self.require(not self.seized and root_key == self.root_key and child.pid == root_key[0],
                     'only the gated pidfd-bound H root may be seized')
        entry = self.owner.entries[root_key]
        before = self.base.proc(child.pid, self.clock)
        self.require(before is not None and before['start'] == root_key[1]
                     and before['ppid'] == os.getpid() and not self.owner.exited(entry['fd']),
                     'gated root is no longer our live actual child')
        self.clock.check()
        # Must succeed BEFORE caller sends gate G. No capability, sysctl or sandbox change.
        self.kernel.call(SEIZE, child.pid, OPTIONS)
        self.seized = True
        self.owner.reap = self.drain
        # Popen's destructor also calls _internal_poll. Keep even that implicit
        # path from stealing a traced STOP/exit from this one status dispatcher.
        child._internal_poll = lambda *args, **kwargs: child.returncode
        child.poll = lambda: child.returncode
        def observed_wait(*args, **kwargs):
            self.require(child.returncode is not None, 'exclusive observer must dispatch actual child status')
            return child.returncode
        child.wait = observed_wait
        self.register(child.pid)
        self.event('seized-gated-root', pid=child.pid, start=root_key[1], options=OPTIONS)

    def stopped(self, tid):
        self.clock.check()
        self.require(tid in self.tracees, 'ptrace request for unknown tracee')
        tracee = self.tracees[tid]
        before = self.base.proc(tid, self.clock)
        fields = self.fields(tid)
        self.require(before is not None and before['start'] == tracee['start']
                     and before['state'] in ('t', 'T') and tracee.get('stopped_status') is not None
                     and int(fields[b'Tgid']) == tracee['tgid']
                     and int(fields[b'TracerPid']) == os.getpid(), 'tracee stop/birth/tracer mismatch')
        if tracee.get('thread_fd') is not None:
            self.require(not self.owner.exited(tracee['thread_fd']), 'stopped thread pidfd has exited')
        key = tracee['key']
        self.require(key in self.owner.entries and not self.owner.exited(self.owner.entries[key]['fd']),
                     'stopped process group lacks live bound pidfd')
        return tracee

    def resume(self, tid, number=0, listen=False):
        self.stopped(tid)
        self.kernel.call(LISTEN if listen else CONT, tid, number)
        self.tracees[tid]['stopped_status'] = None
        self.tracees[tid]['listening'] = listen

    def capture(self, tid):
        tracee = self.stopped(tid)
        self.require(tid == tracee['tgid'], 'nonleader EXEC identity transition refused')
        former = self.kernel.message(tid)
        self.require(former == tid, 'nonleader EXEC/TID migration refused before continuation')
        key = tracee['key']
        self.require(key not in self.records, 'second EXEC for a qualified process refused')
        role = 'harness' if key == self.root_key else 'helper'
        expected = self.approval[role]
        before = self.base.proc(tid, self.clock)
        self.require(role == 'harness' or before['ppid'] == self.root_key[0],
                     'helper EXEC is not a direct actual H child')
        # Deliberate proc magic-link open at kernel EXEC stop, before any new userspace.
        fd = os.open('/proc/' + str(tid) + '/exe', os.O_RDONLY | os.O_CLOEXEC)
        try:
            info = os.fstat(fd)
            self.require(stat.S_ISREG(info.st_mode) and
                [info.st_dev, info.st_ino, info.st_size] ==
                [expected['device'], expected['inode'], expected['bytes']], 'EXEC inode not qualified')
            digest = self.base.digest_fd(fd, 4 * 1024 ** 3, self.clock)
            self.require(digest == expected['sha256'], 'kernel EXEC fd bytes not qualified')
            argv = [word.decode('utf-8', 'strict') for word in
                    self.proc_bytes(tid, 'cmdline').split(b'\0') if word]
            self.stopped(tid)
            after = os.fstat(fd)
            self.require(self.base.identity(info) == self.base.identity(after), 'EXEC fd changed during hash')
            record = {'pid': tid, 'start': tracee['start'], 'ppid': before['ppid'],
                'pidfd_bound': True, 'kernel_exe_device': info.st_dev, 'kernel_exe_inode': info.st_ino,
                'kernel_exe_bytes': info.st_size, 'kernel_exe_sha256': digest,
                'kernel_exe_identity': list(self.base.identity(info)),
                'hash_read_from_kernel_exe_fd': True, 'actual_argv': argv,
                'kernel_exec_stop_before_userspace': True, 'ptrace_event': EXEC,
                'observer': 'owned-descendant-PTRACE_SEIZE-TRACEEXEC-v1',
                'proof_scope': 'qualified-actual-executable-at-kernel-EXEC-stop',
                'continuous_post_detach_exec_surveillance': False if role == 'helper' else True,
                'observed_boot': self.clock.clock()}
            if self.on_exec is not None:
                self.on_exec(role, record)
            self.records[key] = record
            self.exe_fds[key] = fd
            fd = None
            self.event('qualified-kernel-exec', pid=tid, start=tracee['start'], role=role)
            return record
        finally:
            if fd is not None:
                os.close(fd)

    def handle_stop(self, tid, status):
        self.require(os.WIFSTOPPED(status), 'not a ptrace stop')
        if tid not in self.tracees:
            self.require(len(self.pending) < 4096 and tid not in self.pending, 'pending stop cap/duplicate')
            self.pending[tid] = status
            return
        self.tracees[tid]['stopped_status'] = status
        tracee = self.stopped(tid)
        event, number = status >> 16, os.WSTOPSIG(status)
        if event in (FORK, VFORK, CLONE):
            self.require(number == signal.SIGTRAP, 'fork event signal mismatch')
            child_tid = self.kernel.message(tid)
            self.require(type(child_tid) is int and child_tid > 1, 'invalid kernel fork event TID')
            self.register(child_tid, tracee)
            self.event('kernel-new-tracee', parent_tid=tid, child_tid=child_tid, event=event)
            if getattr(self.clock, 'phase', 'work') == 'work':
                self.resume(tid)
            else:
                self.event('cleanup-stop-held', tid=tid, event=event)
        elif getattr(self.clock, 'phase', 'work') != 'work':
            # Cleanup may bind/drain known tracees but never release a new image
            # into userspace or start model work. Bound pidfd KILL can end a stop.
            self.event('cleanup-stop-held', tid=tid, event=event)
        elif event == EXEC:
            self.require(number == signal.SIGTRAP, 'EXEC event signal mismatch')
            record = self.capture(tid)
            if tracee['key'] != self.root_key:
                # Approved helper is still before first userspace instruction.
                # Detach now so unchanged DUMPABLE0/landlock/seccomp/threads run
                # normally. Keep its true EXEC fd proof and process pidfd.
                self.stopped(tid)
                self.kernel.call(DETACH, tid, 0)
                detached = self.tracees.pop(tid)
                self.detached_helpers[tid] = detached['key']
                self.require(detached.get('thread_fd') is None, 'helper EXEC thread not leader')
                self.event('helper-detached-before-userspace', pid=tid, start=record['start'])
            else:
                self.resume(tid)
        elif event == STOP:
            if number == signal.SIGTRAP and tracee['initial_stop']:
                tracee['initial_stop'] = False
                self.resume(tid)
            elif number == signal.SIGTRAP and tracee.get('listening'):
                # A real SIGCONT wake after LISTEN can report an event-stop.
                # Only the recorded LISTEN transition grants this resume path.
                self.resume(tid)
            elif number in GROUP_SIGNALS:
                self.resume(tid, listen=True)  # Preserve actual group-stop semantics.
            else:
                self.require(False, 'unexpected seized stop event')
        elif event == 0:
            # No syscall tracing; ordinary delivery stops preserve original signal,
            # including SIGTRAP. SEIZE+TRACEEXEC suppress only synthetic exec traps.
            self.resume(tid, number)
        else:
            self.require(False, 'unrequested ptrace event')

    def adopted_before_wait(self, pending):
        """Fresh direct-child birth proof, before the sole wait consumes status.

        waitid WNOWAIT retains this exact terminal child while its fresh birth
        and direct parent are bracketed. Never infer from an old PID/pidfd.
        """
        proof = {}
        if pending.si_code not in (os.CLD_EXITED, os.CLD_KILLED, os.CLD_DUMPED):
            return proof
        tid = pending.si_pid
        candidates = [(tid, self.detached_helpers[tid])] if tid in self.detached_helpers else []
        for tid, key in candidates:
            self.clock.check()
            entry = self.owner.entries.get(key)
            if entry is None or entry.get('reaped') or key not in self.records:
                continue
            bound_fd = entry['fd']
            if not self.owner.exited(bound_fd):
                continue
            before = self.base.proc(tid, self.clock)
            if before is None or before['start'] != key[1] or before['ppid'] != os.getpid():
                continue
            # Retain the same already-bound entry/fd and bracket birth/parent.
            after = self.base.proc(tid, self.clock)
            if (after is not None and after['start'] == key[1]
                    and after['ppid'] == os.getpid()
                    and self.owner.entries.get(key) is entry
                    and entry['fd'] == bound_fd and self.owner.exited(bound_fd)):
                proof[tid] = {'key': key, 'fd': bound_fd}
        return proof

    def exited(self, tid, status, adopted=None):
        self.require(os.WIFEXITED(status) or os.WIFSIGNALED(status), 'not a terminal kernel wait')
        tracee = self.tracees.pop(tid, None)
        if tracee is None and adopted and tid in adopted:
            witnessed = adopted[tid]
            key = witnessed['key']
            entry = self.owner.entries.get(key)
            self.require(self.detached_helpers.get(tid) == key
                         and key in self.records and entry is not None
                         and entry['fd'] == witnessed['fd'],
                         'preconsume adopted helper binding changed')
            entry['reaped'] = True
            self.detached_helpers.pop(tid)
            self.pending.pop(tid, None)
            self.event('adopted-helper-terminal-kernel-wait', tid=tid, start=key[1],
                       exit=os.waitstatus_to_exitcode(status),
                       preconsume_direct_child_birth_verified=True)
            return
        if tracee is None:
            # Status is already consumed. Historical numeric PID + an old exited
            # pidfd cannot attribute a detached/adopted child across PID reuse.
            # Fail unknown strictly; normal H reaps its own detached helpers.
            self.owner.invalid_observations.append({'kind': 'unknown-kernel-wait-exit', 'pid': tid,
                'observed_exit': os.waitstatus_to_exitcode(status),
                'no_preconsume_birth_attribution': True})
            self.pending.pop(tid, None)
            self.event('unattributed-terminal-kernel-wait', tid=tid, exit=os.waitstatus_to_exitcode(status))
            return
        else:
            # No PID can be reused for this outstanding traced identity before its
            # terminal kernel wait is consumed. Thread exits do not become unknown
            # unbound processes, and never grant a new pidfd/signaling authority.
            if tracee.get('thread_fd') is not None:
                os.close(tracee['thread_fd'])
            key = tracee['key']
            if tracee['tgid'] == tid and key in self.owner.entries:
                self.owner.entries[key]['reaped'] = True
        for child, key in self.owner.roots:
            if child.pid == tid:
                child.returncode = os.waitstatus_to_exitcode(status)
                if key in self.owner.entries:
                    self.owner.entries[key]['reaped'] = True
        for pending in self.owner.unbound_root_children:
            if pending['pid'] == tid:
                pending['observed_exit'] = os.waitstatus_to_exitcode(status)
        self.pending.pop(tid, None)
        self.event('terminal-kernel-wait', tid=tid, exit=os.waitstatus_to_exitcode(status))

    def drain(self):
        """The exclusive G wait consumer, for work and existing bounded cleanup."""
        self.owner.no_children = False
        for _ in range(16384):
            self.clock.check()
            try:
                pending_wait = self.kernel.peek()
            except ChildProcessError:
                self.require(not self.tracees and not self.pending, 'ECHILD contradicted outstanding tracees')
                self.owner.no_children = True
                return
            if pending_wait is None:
                return
            adopted = self.adopted_before_wait(pending_wait)
            tid, status = self.kernel.consume(pending_wait)
            if os.WIFSTOPPED(status):
                self.handle_stop(tid, status)
            else:
                self.exited(tid, status, adopted)
            # Linux may report an auto-attached new child stop before its parent's
            # fork event. It stays stopped until that event registers its lineage.
            for pending_tid in list(self.pending):
                if pending_tid in self.tracees:
                    pending_status = self.pending.pop(pending_tid)
                    self.handle_stop(pending_tid, pending_status)
        self.require(False, 'ptrace event drain cap exceeded')

    def record(self, key):
        self.clock.check()
        self.require(key in self.records and key in self.exe_fds, 'actual kernel EXEC stop not observed')
        info = os.fstat(self.exe_fds[key])
        record = self.records[key]
        self.require([info.st_dev, info.st_ino, info.st_size] ==
            [record['kernel_exe_device'], record['kernel_exe_inode'], record['kernel_exe_bytes']],
            'retained true EXEC descriptor changed')
        self.require(list(self.base.identity(info)) == record['kernel_exe_identity'],
                     'retained actual EXEC file identity changed')
        return dict(record)

    def snapshot(self):
        return {'schema': 'owned-exec-stop-observer-v1', 'seized_before_gate_release': self.seized,
            'options': OPTIONS, 'event_count': self.event_count, 'recent_events': list(self.events),
            'qualified_exec_count': len(self.records), 'outstanding_tracees': len(self.tracees),
            'pending_stops': len(self.pending), 'syscall_or_memory_tracing': False,
            'ptrace_interposition_requires_root_comparability_review': True}

    def close(self):
        # Caller first completes original pidfd cancellation/drain, or its outer
        # retains global HOLD. EXITKILL stays set; never detach a live tracee.
        if not self.closed:
            for tracee in self.tracees.values():
                if tracee.get('thread_fd') is not None:
                    os.close(tracee['thread_fd'])
                    tracee['thread_fd'] = None
            for fd in self.exe_fds.values():
                os.close(fd)
            self.exe_fds.clear()
            self.closed = True
