"""SOURCE ONLY, UNRUN: adverse internal-dispatch authority and parent-instance controls.

No real prctl/timer/FD/PID/signal/exec is performed by these authored mocks.
Separate ROOT control admission is required before importing this module.
"""
import hashlib
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import phase
import safety
from test_runtime_contracts import FakeClock


def fake_args():
    return SimpleNamespace(parent_pid=123456, parent_start='777', phase_hard_boot=200,
        start_gate_fd=999, exec_ready_fd=997,
        grant='/FAKE/model-grant.json', grant_sha256='a' * 64,
        package_manifest='/FAKE/source-manifest.json', package_manifest_sha256='b' * 64,
        stage='H10', phase_dir='/FAKE/output', absolute_expiry_epoch=300, boot_deadline=200,
        staged_inputs='/FAKE/output/staged-inputs.json', staged_inputs_sha256='c' * 64)


def fake_guard_argv(args):
    return [phase.sys.executable, '-I', '-B', str(phase.PACKAGE / 'entry.py'), '_guard',
        '--stage', args.stage, '--grant', args.grant, '--grant-sha256', args.grant_sha256,
        '--absolute-expiry-epoch', str(args.absolute_expiry_epoch), '--boot-deadline', str(args.boot_deadline),
        '--package-manifest', args.package_manifest, '--package-manifest-sha256', args.package_manifest_sha256,
        '--phase-hard-boot', str(args.phase_hard_boot), '--phase-dir', args.phase_dir,
        '--staged-inputs', args.staged_inputs, '--staged-inputs-sha256', args.staged_inputs_sha256,
        '--parent-pid', '234567', '--parent-start', '888', '--start-gate-fd', '998']


class InternalAdmissionControls(unittest.TestCase):
    def test_native_grant_plus_caller_gate_never_authorizes_generic_exec(self):
        args = fake_args()
        native_grant = {'coordinator_package': {'path': args.package_manifest,
                         'sha256': args.package_manifest_sha256},
                        'schema': 'FAKE-native-build-only-grant'}
        with patch.object(phase, 'parent_death'), \
             patch.object(phase, 'budget', return_value=FakeClock()), \
             patch.object(phase, 'exec_bootstrap_gate') as ready_gate, \
             patch.object(phase.os, 'read', return_value=b'G'), \
             patch.object(phase.os, 'close'), \
             patch.object(safety, 'read_json_ref', return_value=native_grant), \
             patch.object(phase, 'runtime_approval') as runtime, \
             patch.object(phase.os, 'execve') as execute:
            with self.assertRaises(safety.Refusal):
                phase.exec_harness(args, (300, 200), 100)
            ready_gate.assert_called_once()
            runtime.assert_not_called()
            execute.assert_not_called()

    def test_authority_rehash_catches_changed_bytes_even_with_same_stat_cache(self):
        authority = object.__new__(safety.Authority)
        authority.grant = {'boot_deadline': 200, 'absolute_expiry_epoch': 300}
        authority.ref = {'path': '/FAKE/grant', 'sha256': hashlib.sha256(b'old').hexdigest()}
        authority.clock, authority.active_check = FakeClock(), False
        identity = SimpleNamespace(st_dev=1, st_ino=2, st_size=3, st_mtime_ns=4)
        authority.grant_stat = identity
        with patch.object(safety, 'boot', return_value=100), \
             patch.object(safety.time, 'time', return_value=100), \
             patch.object(safety.os, 'stat', return_value=identity), \
             patch.object(safety.base, 'read_path', return_value=b'new'), \
             patch.object(safety.base, 'proc') as inspect_process:
            with self.assertRaises(safety.Refusal):
                authority.check()
            inspect_process.assert_not_called()
        self.assertFalse(authority.active_check)


class ParentInstanceControls(unittest.TestCase):
    def check_parent(self, args, argv, processes=None):
        current = {'start': args.parent_start, 'ppid': 234567}
        processes = processes or [dict(current), dict(current)]
        interpreter = SimpleNamespace(st_dev=7, st_ino=8)
        raw = b'\0'.join(word.encode() for word in argv) + b'\0'
        with patch.object(phase.os, 'pidfd_open', return_value=999), \
             patch.object(phase.os, 'getppid', return_value=args.parent_pid), \
             patch.object(phase.os, 'stat', return_value=interpreter), \
             patch.object(phase.os, 'close') as close, \
             patch.object(phase.base, 'proc', side_effect=processes), \
             patch.object(phase.base.Owned, 'exited', return_value=False), \
             patch.object(phase, 'proc_bytes', return_value=raw):
            try:
                return phase.parent_role(args, '_guard')
            finally:
                close.assert_called_once_with(999)

    def test_exact_guard_role_includes_package_and_real_gate_flags(self):
        args = fake_args()
        proof = self.check_parent(args, fake_guard_argv(args))
        self.assertTrue(proof['pidfd_bound'])
        self.assertEqual(proof['start'], args.parent_start)

    def test_duplicate_or_foreign_parent_flags_refuse_before_dispatch(self):
        args = fake_args()
        for extra in (['--grant', args.grant], ['--unapproved', 'FAKE']):
            with self.subTest(extra=extra), self.assertRaises(safety.Refusal):
                self.check_parent(args, fake_guard_argv(args) + extra)

    def test_reused_parent_birth_cannot_satisfy_role_observation(self):
        args = fake_args()
        processes = [{'start': args.parent_start, 'ppid': 234567}, {'start': '999', 'ppid': 234567}]
        with self.assertRaises(safety.Refusal):
            self.check_parent(args, fake_guard_argv(args), processes)


if __name__ == '__main__':
    raise SystemExit('Authored UNRUN dispatch controls; only explicit ROOT control admission may import')
