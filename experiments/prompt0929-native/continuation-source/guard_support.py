"""Bounded I/O and process-instance helpers; definitions only on import."""
import errno
import hashlib
import json
import math
import os
from pathlib import Path, PurePosixPath
import select
import signal
import stat
import time

CHUNK = 65536
GIB = 1024 ** 3


class Refusal(RuntimeError):
    pass


def require(condition, message):
    if not condition:
        raise Refusal(message)


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "duplicate JSON field")
        result[key] = value
    return result


class Budget:
    def __init__(self, relative, absolute_expiry, cleanup_margin, minimum_work=1,
                 monotonic=time.monotonic, wall=time.time):
        require(math.isfinite(absolute_expiry) and cleanup_margin > 0, "invalid root expiry/margin")
        self.clock, self.wall = monotonic, wall
        self.started = monotonic()
        self.absolute_expiry = absolute_expiry
        self.hard_end = min(self.started + relative,
                            self.started + absolute_expiry - wall())
        self.work_end = self.hard_end - cleanup_margin
        self.phase = "work"
        self.cancelled = None
        self.work_hook = None
        require(self.work_end - self.started >= minimum_work, "insufficient remaining root holder budget")

    def check(self, final=False):
        require(not self.cancelled, self.cancelled or "cancelled")
        end = self.hard_end if final or self.phase == "final" else self.work_end
        require(self.clock() < end and self.wall() < self.absolute_expiry,
                "absolute/monotonic budget exhausted")
        if not final and self.phase == "work" and self.work_hook is not None:
            self.work_hook()

    def remaining(self, final=False):
        end = self.hard_end if final or self.phase == "final" else self.work_end
        return max(0, min(end - self.clock(), self.absolute_expiry - self.wall()))

    def enter_final(self):
        self.phase = "final"
        self.cancelled = None

    def arm(self):
        def expired(number, frame):
            raise Refusal("synchronous deadline interrupted")
        signal.signal(signal.SIGALRM, expired)
        signal.setitimer(signal.ITIMER_REAL, max(0.001, self.remaining()))

    def disarm(self):
        signal.setitimer(signal.ITIMER_REAL, 0)


def canonical_start(value):
    require(type(value) is str and value.isdigit() and str(int(value)) == value and int(value) > 0,
            "canonical positive decimal string start epoch required")
    return value


def identity(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns)


def relative_parts(value):
    path = PurePosixPath(value)
    require(not path.is_absolute() and path.parts and all(p not in ("", ".", "..") for p in path.parts),
            "unsafe relative path")
    require(str(path) == value, "non-normalized relative path")
    return path.parts


def directory_fd(path, budget):
    budget.check()
    path = Path(path)
    require(path.is_absolute(), "absolute root required")
    fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        for part in path.parts[1:]:
            budget.check()
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                              dir_fd=fd)
            os.close(fd)
            fd = next_fd
        return fd
    except BaseException:
        os.close(fd)
        raise


def parent_fd(root, relative, budget, create=False):
    parts = relative_parts(relative)
    fd = directory_fd(root, budget)
    try:
        for part in parts[:-1]:
            budget.check()
            if create:
                try:
                    os.mkdir(part, mode=0o700, dir_fd=fd)
                except FileExistsError:
                    pass
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                              dir_fd=fd)
            os.close(fd)
            fd = next_fd
        return fd, parts[-1]
    except BaseException:
        os.close(fd)
        raise


def checked_source(root, relative, budget, expected_size=None, expected_identity=None):
    parent, leaf = parent_fd(root, relative, budget)
    fd = None
    try:
        before = os.stat(leaf, dir_fd=parent, follow_symlinks=False)
        require(stat.S_ISREG(before.st_mode), "nonregular/symlink source refused")
        fd = os.open(leaf, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC,
                     dir_fd=parent)
        opened = os.fstat(fd)
        require(stat.S_ISREG(opened.st_mode) and identity(opened) == identity(before),
                "source instance changed before first read")
        if expected_size is not None:
            require(opened.st_size == expected_size, "approved source size differs")
        if expected_identity is not None:
            require(list(identity(opened)) == expected_identity, "approved source instance differs")
        budget.check()
        return fd, parent, leaf, before
    except BaseException:
        if fd is not None:
            os.close(fd)
        os.close(parent)
        raise


def read_fd(fd, maximum, budget):
    size = os.fstat(fd).st_size
    require(size <= maximum, "bounded read size exceeded")
    result = bytearray()
    while True:
        budget.check()
        data = os.read(fd, min(CHUNK, maximum - len(result) + 1))
        require(len(result) + len(data) <= maximum, "bounded stream grew")
        if not data:
            break
        result.extend(data)
    budget.check()
    return bytes(result)


def read_path(path, maximum, budget):
    path = Path(path)
    fd, parent, leaf, before = checked_source(path.parent, path.name, budget)
    try:
        data = read_fd(fd, maximum, budget)
        require(identity(os.fstat(fd)) == identity(before)
                == identity(os.stat(leaf, dir_fd=parent, follow_symlinks=False)), "source changed during read")
        return data
    finally:
        os.close(fd)
        os.close(parent)


def digest_fd(fd, maximum, budget):
    info = os.fstat(fd)
    require(stat.S_ISREG(info.st_mode) and info.st_size <= maximum, "hash size/type refused")
    hasher, total = hashlib.sha256(), 0
    while total < info.st_size:
        budget.check()
        require(identity(os.fstat(fd)) == identity(info), "hash source changed")
        data = os.read(fd, min(CHUNK, info.st_size - total))
        require(data, "short hash input")
        hasher.update(data)
        total += len(data)
    require(identity(os.fstat(fd)) == identity(info), "hash source changed")
    budget.check()
    return hasher.hexdigest()


def digest(path, budget, maximum=8 * GIB):
    path = Path(path)
    fd, parent, leaf, before = checked_source(path.parent, path.name, budget)
    try:
        value = digest_fd(fd, maximum, budget)
        require(identity(os.stat(leaf, dir_fd=parent, follow_symlinks=False)) == identity(before),
                "hash pathname changed")
        return value
    finally:
        os.close(fd)
        os.close(parent)


def load_json(path, budget, maximum=16 * 1024 * 1024):
    return json.loads(read_path(path, maximum, budget), object_pairs_hook=unique_object)


def sync(fd, budget):
    budget.check()
    os.fsync(fd)
    budget.check()


def immutable_json(path, value, budget):
    """Publish only after all content/permission/directory syncs succeed.

    Before the commit unlink, final is either absent or has two links plus an
    explicit partial sibling, so committed_json rejects it. The final unlink
    is the commit point. A crash before its directory persistence may restore
    the partial link, which causes conservative refusal rather than false pass.
    """
    budget.check()
    data = (json.dumps(value, indent=2, sort_keys=True) + "\n").encode()
    require(len(data) <= 8 * 1024 * 1024, "receipt size exceeded")
    path = Path(path)
    parent, leaf = parent_fd(path.parent, path.name, budget)
    partial = "." + leaf + ".partial." + str(os.getpid()) + "." + str(time.monotonic_ns())
    fd, created, linked, committed = None, None, False, False
    try:
        fd = os.open(partial, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                     0o600, dir_fd=parent)
        mine = os.fstat(fd)
        created = (mine.st_dev, mine.st_ino)
        for offset in range(0, len(data), CHUNK):
            view = memoryview(data[offset:offset + CHUNK])
            while view:
                budget.check()
                count = os.write(fd, view)
                require(count > 0, "short receipt write")
                view = view[count:]
        sync(fd, budget)
        os.fchmod(fd, 0o400)
        sync(fd, budget)
        sync(parent, budget)
        budget.check()
        os.link(partial, leaf, src_dir_fd=parent, dst_dir_fd=parent, follow_symlinks=False)
        linked = True
        sync(parent, budget)
        budget.check()
        # Last fallible publication operation. No sync/chmod/check follows commit.
        os.unlink(partial, dir_fd=parent)
        committed = True
    except BaseException:
        # Retain explicit partial evidence; invalidate only our newly linked final.
        if linked:
            try:
                current = os.stat(leaf, dir_fd=parent, follow_symlinks=False)
                if (current.st_dev, current.st_ino) == created:
                    os.unlink(leaf, dir_fd=parent)
            except FileNotFoundError:
                pass
        raise
    finally:
        # Closing after successful commit cannot change publication classification.
        for descriptor in (fd, parent):
            if descriptor is not None:
                try:
                    os.close(descriptor)
                except OSError:
                    if not committed:
                        raise


def committed_json(path, budget, maximum=8 * 1024 * 1024, expected_sha=None):
    """Accept only a finalized readonly independent inode with no partial sibling."""
    path = Path(path)
    fd, parent, leaf, before = checked_source(path.parent, path.name, budget)
    try:
        require(before.st_uid == os.geteuid() and stat.S_IMODE(before.st_mode) == 0o400
                and before.st_nlink == 1, "receipt is not committed readonly independent file")
        with os.scandir(parent) as entries:
            for number, entry in enumerate(entries):
                budget.check()
                require(number < 10000, "receipt directory entry cap exceeded")
                require(not entry.name.startswith("." + leaf + ".partial."), "uncommitted partial receipt exists")
        data = read_fd(fd, maximum, budget)
        after = os.fstat(fd)
        require(identity(after) == identity(before) and after.st_nlink == 1
                and stat.S_IMODE(after.st_mode) == 0o400
                and identity(os.stat(leaf, dir_fd=parent, follow_symlinks=False)) == identity(before),
                "committed receipt instance changed")
        require(expected_sha is None or hashlib.sha256(data).hexdigest() == expected_sha,
                "committed receipt bytes differ from root-observed hash")
        return json.loads(data, object_pairs_hook=unique_object)
    finally:
        os.close(fd)
        os.close(parent)


def stable_copy(source_root, relative, destination_root, destination_relative, budget,
                maximum, expected_sha=None, expected_size=None, expected_identity=None,
                executable=False, validate_bytes=None):
    fd, source_parent, leaf, before = checked_source(source_root, relative, budget,
                                                     expected_size, expected_identity)
    destination_parent = None
    outgoing = None
    copied = 0
    try:
        destination_parent, target = parent_fd(destination_root, destination_relative, budget, create=True)
        require(before.st_size <= maximum, "remaining copy cap exceeded before read")
        # A required public config is validated in its already-approved descriptor before any copy.
        if validate_bytes is not None:
            require(before.st_size <= 4096, "public config too large")
            validate_bytes(read_fd(fd, 4096, budget))
            os.lseek(fd, 0, os.SEEK_SET)
        outgoing = os.open(target, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
                           | os.O_NONBLOCK | os.O_CLOEXEC, 0o600, dir_fd=destination_parent)
        hasher = hashlib.sha256()
        while copied < before.st_size:
            budget.check()
            require(identity(os.fstat(fd)) == identity(before), "copy source changed/grown")
            remaining = min(before.st_size - copied, maximum - copied)
            require(remaining > 0, "copy cap exhausted")
            data = os.read(fd, min(CHUNK, remaining))
            require(data, "short copy input")
            hasher.update(data)
            view = memoryview(data)
            while view:
                budget.check()
                count = os.write(outgoing, view)
                require(count > 0, "short copy write")
                view = view[count:]
            copied += len(data)
        require(identity(os.fstat(fd)) == identity(before)
                == identity(os.stat(leaf, dir_fd=source_parent, follow_symlinks=False)),
                "copy source changed")
        require(expected_sha is None or hasher.hexdigest() == expected_sha, "approved copy hash differs")
        os.lseek(outgoing, 0, os.SEEK_SET)
        require(digest_fd(outgoing, maximum, budget) == hasher.hexdigest(), "copy verification failed")
        info = os.fstat(outgoing)
        require(info.st_nlink == 1 and info.st_size == copied, "independent regular copy required")
        os.fchmod(outgoing, 0o500 if executable else 0o600 | (stat.S_IMODE(before.st_mode) & 0o111))
        sync(outgoing, budget)
        sync(destination_parent, budget)
        return {"sha256": hasher.hexdigest(), "bytes": copied,
                "path": str(Path(destination_root) / destination_relative)}
    except BaseException:
        if outgoing is not None:
            try:
                current = os.stat(target, dir_fd=destination_parent, follow_symlinks=False)
                if (current.st_dev, current.st_ino) == (os.fstat(outgoing).st_dev, os.fstat(outgoing).st_ino):
                    os.unlink(target, dir_fd=destination_parent)
            except FileNotFoundError:
                pass
        raise
    finally:
        if outgoing is not None:
            os.close(outgoing)
        os.close(fd)
        os.close(source_parent)
        if destination_parent is not None:
            os.close(destination_parent)


def proc(pid, budget=None):
    if budget is not None:
        budget.check()
    try:
        # /proc stat is a kernel-generated small regular pseudo-file; cap independent of st_size.
        fd = os.open(f"/proc/{pid}/stat", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
        try:
            data = os.read(fd, 4096)
            require(len(data) < 4096, "oversized proc stat")
        finally:
            os.close(fd)
        parts = data.decode().rsplit(") ", 1)[1].split()
        return {"state": parts[0], "ppid": int(parts[1]), "pgrp": int(parts[2]), "start": parts[19]}
    except (FileNotFoundError, ProcessLookupError):
        return None


class Owned:
    def __init__(self, budget):
        require(hasattr(os, "pidfd_open") and hasattr(signal, "pidfd_send_signal"),
                "safe pidfd primitives unavailable; no numeric signal fallback")
        self.budget = budget
        self.entries = {}
        self.roots = []
        self.no_children = False
        self.binding_events = []
        self.binding_event_count = 0

    def _binding_event(self, kind, pid, expected, observed, proof):
        # Bounded PRIVATE process diagnostics; an event never grants ownership.
        self.binding_event_count += 1
        self.binding_events.append({"kind": kind, "pid": pid, "expected_start": expected.get("start"),
            "expected_ppid": expected.get("ppid"), "observed": observed, "parent_proof": proof})
        if len(self.binding_events) > 64:
            del self.binding_events[0]

    def _parent_proof(self, ppid):
        if ppid == os.getpid():
            return {"owned": True, "kind": "guard", "pid": ppid}
        matches = [(key, entry) for key, entry in self.entries.items() if key[0] == ppid]
        current = proc(ppid, self.budget)
        if current is None:
            vanished = any(self.exited(entry["fd"]) for _, entry in matches)
            return {"owned": False, "kind": "known_parent_gone" if vanished else "unknown_parent",
                "pid": ppid, "tracked_starts": [key[1] for key, _ in matches]}
        for key, entry in matches:
            if current["start"] == key[1]:
                exited = self.exited(entry["fd"])
                return {"owned": not exited or current["state"] == "Z",
                    "kind": "owned_zombie" if exited and current["state"] == "Z" else
                        "owned_live" if not exited else "owned_parent_transition",
                    "pid": ppid, "start": key[1], "state": current["state"], "pidfd_exited": exited}
        return {"owned": False, "kind": "parent_birth_changed" if matches else "foreign_parent",
            "pid": ppid, "start": current["start"], "state": current["state"],
            "tracked_starts": [key[1] for key, _ in matches]}

    def bind(self, pid, expected, *, discovery_defer=False):
        self.budget.check()
        require(len(self.entries) < 4096, "owned-instance bound exceeded")
        try:
            fd = os.pidfd_open(pid, 0)
        except ProcessLookupError:
            self._binding_event("gone_before_open", pid, expected, None, None)
            return None
        after, proof = None, None
        try:
            # One bounded revalidation closes the mixed-time child-PPID/parent-exit
            # race. Exact birth/parent proof is still required before registration.
            for _ in range(2):
                self.budget.check()
                after = proc(pid, self.budget)
                if after is None and discovery_defer and self.exited(fd):
                    self._binding_event("discovery_child_gone", pid, expected, None, proof)
                    return None
                if after is None or after["start"] != expected["start"]:
                    self._binding_event("refused_child_birth", pid, expected, after, proof)
                    require(False, "process changed before pidfd binding")
                key = (pid, after["start"])
                if key in self.entries:
                    return key
                proof = self._parent_proof(after["ppid"])
                if not proof["owned"]:
                    continue
                confirmed = proc(pid, self.budget)
                if confirmed is None or confirmed["start"] != expected["start"]:
                    if confirmed is None and discovery_defer and self.exited(fd):
                        self._binding_event("discovery_child_gone", pid, expected, None, proof)
                        return None
                    self._binding_event("refused_child_birth", pid, expected, confirmed, proof)
                    require(False, "process changed before pidfd binding")
                if confirmed["ppid"] != after["ppid"]:
                    continue
                final_parent = self._parent_proof(confirmed["ppid"])
                if not final_parent["owned"]:
                    proof = final_parent
                    continue
                # Parent must still be the SAME independently tracked instance.
                if proof.get("start") != final_parent.get("start"):
                    proof = final_parent
                    continue
                self.entries[key] = {"fd": fd, "identity": confirmed, "reaped": False}
                fd = None
                return key
            if discovery_defer and proof and proof["kind"] in ("known_parent_gone", "owned_parent_transition"):
                self._binding_event("discovery_parent_transition", pid, expected, after, proof)
                return None
            self._binding_event("refused_parent", pid, expected, after, proof)
            require(False, "pidfd instance is not an owned descendant; private binding_events retained")
        finally:
            if fd is not None:
                os.close(fd)

    @staticmethod
    def exited(fd):
        # select() cannot represent valid descriptors >=FD_SETSIZE. poll() has no
        # such numeric limit and creates no additional persistent descriptor.
        watcher = select.poll()
        watcher.register(fd, select.POLLIN)
        events = watcher.poll(0)
        require(len(events) <= 1 and all(number == fd for number, _ in events),
                "unexpected pidfd poll descriptor")
        require(not any(flags & (select.POLLNVAL | select.POLLERR) for _, flags in events),
                "invalid/error pidfd poll observation")
        return any(flags & (select.POLLIN | select.POLLHUP) for _, flags in events)

    def discover(self):
        self.budget.check()
        count = 0
        changed = True
        while changed:
            changed = False
            owners = {os.getpid()} | {pid for (pid, _), entry in self.entries.items()
                                      if not self.exited(entry["fd"])}
            with os.scandir("/proc") as entries:
                for entry in entries:
                    self.budget.check()
                    if not entry.name.isdigit():
                        continue
                    count += 1
                    require(count <= 200000, "proc discovery cap exceeded")
                    pid = int(entry.name)
                    if pid == os.getpid():
                        continue
                    info = proc(pid, self.budget)
                    if info is not None and info["ppid"] in owners and (pid, info["start"]) not in self.entries:
                        if self.bind(pid, info, discovery_defer=True) is not None:
                            changed = True

    def signal_all(self, number):
        # The descriptor targets the bound instance even if its numeric PID is later reused.
        for entry in self.entries.values():
            if not self.exited(entry["fd"]):
                try:
                    signal.pidfd_send_signal(entry["fd"], number, None, 0)
                except ProcessLookupError:
                    pass

    def reap(self):
        self.no_children = False
        for child, key in self.roots:
            child.poll()
            if child.returncode is not None:
                self.entries[key]["reaped"] = True
        while True:
            try:
                pid, wait_status = os.waitpid(-1, os.WNOHANG)
            except ChildProcessError:
                self.no_children = True
                break
            if pid == 0:
                break
            for child, key in self.roots:
                if child.pid == pid:
                    child.returncode = os.waitstatus_to_exitcode(wait_status)
                    self.entries[key]["reaped"] = True
            for (owned_pid, _), entry in self.entries.items():
                if owned_pid == pid and self.exited(entry["fd"]):
                    entry["reaped"] = True

    def snapshot(self):
        self.reap()
        live, unreaped, identities = [], [], []
        for (pid, start), entry in self.entries.items():
            item = {"pid": pid, "start": start, "pidfd_bound": True,
                    "exited": self.exited(entry["fd"]), "reaped": entry["reaped"]}
            identities.append(item)
            if not item["exited"]:
                live.append(item)
            # Descendants reaped by their real parent are gone, not ours to waitpid.
            elif not item["reaped"]:
                info = proc(pid, self.budget)
                if info is not None and info["start"] == start and info["ppid"] == os.getpid():
                    unreaped.append(item)
        roots = [{"pid": child.pid, "start": key[1], "reaped": child.returncode is not None,
                  "exit": child.returncode, "pidfd_bound": True} for child, key in self.roots]
        return {"binding_events": list(self.binding_events), "binding_event_count": self.binding_event_count,
                "owned_instances": identities, "remaining_live_owned": live,
                "unreaped_owned": unreaped, "root_children": roots,
                "kernel_no_children": self.no_children,
                "cleanup_complete": self.no_children and not live and not unreaped and all(item["reaped"] for item in roots)}

    def close(self):
        for entry in self.entries.values():
            os.close(entry["fd"])
