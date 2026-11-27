#!/usr/bin/env python3
"""Finite ROOT-admitted evaluation entry. No default execution or model grant."""
import sys
import time
import signal

_ENTRY_BOOT = time.clock_gettime(time.CLOCK_BOOTTIME)
_ENTRY_WALL = time.time()


def entry_deadline(argv):
    def number(key):
        positions = [i for i, word in enumerate(argv) if word == key]
        if len(positions) != 1 or positions[0] + 1 >= len(argv):
            raise RuntimeError('one explicit ' + key + ' required')
        result = float(argv[positions[0] + 1])
        if not -float('inf') < result < float('inf'):
            raise RuntimeError('finite deadline required')
        return result
    wall = number('--absolute-expiry-epoch')
    boot = number('--boot-deadline')
    command = argv[0] if argv else None
    if command in ('phase', '_guard'):
        stage_positions = [i for i, word in enumerate(argv) if word == '--stage']
        if len(stage_positions) != 1 or stage_positions[0] + 1 >= len(argv):
            raise RuntimeError('one explicit known stage required before import')
        stage = argv[stage_positions[0] + 1]
        if stage not in ('H10', 'M8'):
            raise RuntimeError('only H10/M8 are supported')
        cap = {'H10': 3000, 'M8': 3000}[stage]
    elif command == '_exec':
        cap = 60
    else:
        raise RuntimeError('explicit phase command required')
    hard_boot = min(_ENTRY_BOOT + cap, _ENTRY_BOOT + wall - _ENTRY_WALL, boot,
                    _ENTRY_BOOT + 1794614399 - _ENTRY_WALL)  # Proposed Friday23:59:59UTC ceiling before imports; Ben release/ROOT grant pending.
    if command in ('_guard', '_exec'):
        hard_boot = min(hard_boot, number('--phase-hard-boot'))
    remaining = min(hard_boot - time.clock_gettime(time.CLOCK_BOOTTIME), wall - time.time())
    if remaining <= 10:
        raise RuntimeError('entry budget exhausted')
    if signal.pthread_sigmask(signal.SIG_BLOCK, set()).intersection(
            {signal.SIGALRM, signal.SIGHUP, signal.SIGTERM, signal.SIGINT}):
        raise RuntimeError('deadline/cancellation signals are blocked')
    def interrupted(number, frame):
        raise RuntimeError('early entry interrupted: ' + str(number))
    for number in (signal.SIGALRM, signal.SIGHUP, signal.SIGTERM, signal.SIGINT):
        signal.signal(number, interrupted)
    signal.setitimer(signal.ITIMER_REAL, remaining - 10)
    return wall, boot


def verify_package_before_import(argv):
    # Only stdlib loads precede this verification, under the already armed timer.
    # ROOT independently pins THIS minimal entry source before invoking Python.
    if not sys.flags.isolated or not sys.dont_write_bytecode:
        raise RuntimeError('trusted entry requires Python -I -B before any package imports')
    import hashlib
    import json
    import os
    import stat

    def argument(key):
        positions = [i for i, word in enumerate(argv) if word == key]
        if len(positions) != 1 or positions[0] + 1 >= len(argv):
            raise RuntimeError('one explicit ' + key + ' required before import')
        return argv[positions[0] + 1]

    package_path = os.path.dirname(os.path.abspath(__file__))
    manifest_path = argument('--package-manifest')
    expected_hash = argument('--package-manifest-sha256')
    if manifest_path != package_path + '/source-manifest.json' or len(expected_hash) != 64 or any(
            character not in '0123456789abcdef' for character in expected_hash):
        raise RuntimeError('exact local ROOT-reviewed source manifest/hash required')
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        for component in package_path.split('/')[1:]:
            if component in ('', '.', '..'):
                raise RuntimeError('noncanonical package path')
            next_fd = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                              dir_fd=fd)
            os.close(fd)
            fd = next_fd

        def read_regular(name, cap):
            opened = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=fd)
            try:
                before = os.fstat(opened)
                if not stat.S_ISREG(before.st_mode) or before.st_uid != os.geteuid() or \
                        stat.S_IMODE(before.st_mode) != 0o400 or before.st_nlink != 1 or before.st_size > cap:
                    raise RuntimeError('package source must be bounded committed readonly independent file')
                data = bytearray()
                while True:
                    block = os.read(opened, min(65536, cap - len(data) + 1))
                    if not block:
                        break
                    data.extend(block)
                    if len(data) > cap:
                        raise RuntimeError('source read cap exceeded')
                after = os.fstat(opened)
                path_stat = os.stat(name, dir_fd=fd, follow_symlinks=False)
                def identity(value):
                    return (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns,
                            value.st_ctime_ns, value.st_mode, value.st_nlink)
                if identity(before) != identity(after) or identity(after) != identity(path_stat):
                    raise RuntimeError('package source changed during verification')
                return bytes(data)
            finally:
                os.close(opened)

        raw = read_regular('source-manifest.json', 1024 * 1024)
        if hashlib.sha256(raw).hexdigest() != expected_hash:
            raise RuntimeError('ROOT-reviewed source manifest bytes differ')
        def unique(pairs):
            result = {}
            for key, value in pairs:
                if key in result:
                    raise RuntimeError('duplicate source manifest key')
                result[key] = value
            return result
        manifest = json.loads(raw, object_pairs_hook=unique)
        if manifest.get('schema') != 'literal6595-coordinator-source-manifest-v1' or \
                manifest.get('candidate_head') != '6595b3c25beb32c2cbd44892698c3fd66265ad2f' or \
                manifest.get('candidate_tree') != '62c4705b58968c20abc69a5029b0ca6449aa08d7':
            raise RuntimeError('wrong literal source package')
        files = manifest['files']
        names = os.listdir(fd)
        for name in names:
            if not stat.S_ISREG(os.stat(name, dir_fd=fd, follow_symlinks=False).st_mode) or \
                    name.endswith(('.pyc', '.pyo', '.so', '.pyd')):
                raise RuntimeError('package must contain only regular files and no bytecode/native import shadow')
        actual_names = {name for name in names if name.endswith('.py')}
        if not isinstance(files, dict) or not files or len(files) > 128 or set(files) != actual_names:
            raise RuntimeError('complete local Python source inventory required')
        total = 0
        for name, expected in files.items():
            if '/' in name or '\\' in name or name in ('.', '..') or not name.endswith('.py'):
                raise RuntimeError('unsafe source manifest name')
            data = read_regular(name, 16 * 1024 * 1024)
            total += len(data)
            if total > 64 * 1024 * 1024 or hashlib.sha256(data).hexdigest() != expected:
                raise RuntimeError('package module bytes differ')
    finally:
        os.close(fd)


if __name__ == '__main__':
    try:
        deadlines = entry_deadline(sys.argv[1:])
        verify_package_before_import(sys.argv[1:])
        import os
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        from coordinator import main
        result = main(sys.argv[1:], deadlines, _ENTRY_BOOT)
    except BaseException as error:
        print(type(error).__name__ + ': ' + str(error), file=sys.stderr, flush=True)
        result = 1
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
    sys.exit(result)
