from pathlib import Path
from contextlib import ExitStack
import ctypes
import hashlib
import json
import os
import signal
import subprocess
import sys
import unittest
from unittest.mock import patch

root = Path(__file__).parent
sys.path.insert(0, str(root))
def forbidden(*args, **kwargs):
    raise AssertionError('Real process/native/signaling primitive forbidden in source controls')
def cases(suite):
    for item in suite:
        if isinstance(item, unittest.TestSuite):
            yield from cases(item)
        else:
            yield item.id()
with ExitStack() as stack:
    for module, names in ((ctypes, ('CDLL', 'PyDLL')),
            (subprocess, ('Popen',)),
            (os, ('fork', 'forkpty', 'pidfd_open', 'kill', 'killpg', 'wait', 'waitpid', 'waitid',
                  'sched_setaffinity', 'setpriority', 'execve', 'execv', 'execvp', 'execvpe',
                  'system', 'posix_spawn', 'posix_spawnp')),
            (signal, ('signal', 'setitimer', 'pthread_sigmask', 'pidfd_send_signal'))):
        for name in names:
            if hasattr(module, name):
                stack.enter_context(patch.object(module, name, side_effect=forbidden))
    suite = unittest.defaultTestLoader.discover(str(root), pattern='test_*.py')
    identifiers = list(cases(suite))
    with (root / 'test.log').open('w') as stream:
        result = unittest.TextTestRunner(stream=stream, verbosity=2).run(suite)
report = {'schema': 'astra-timer12f874-splitdir-native-mocks-v1', 'tests': result.testsRun,
    'passed': result.wasSuccessful(), 'failures': len(result.failures), 'errors': len(result.errors),
    'skipped': len(result.skipped), 'case_ids': identifiers,
    'source_files': {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
        for p in sorted(root.glob('*.py')) if p.name != 'run_mock_checks.py'},
    'real_kernel_model_build_scorer': False, 'timeout_seconds': 60, 'cpus': [0], 'nice': 19}
(root / 'RESULT.json').write_text(json.dumps(report, indent=2, sort_keys=True) + '\n')
print(json.dumps({k: v for k, v in report.items() if k not in ('case_ids', 'source_files')}))
for case, trace in result.failures + result.errors:
    print(case.id(), trace)
raise SystemExit(not result.wasSuccessful())
