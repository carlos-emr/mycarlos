"""Pure synthetic Cargo artifact controls, authored only; no Cargo/native execution."""
import hashlib
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest

import native_guard as guard


class ArtifactControls(unittest.TestCase):
    def fixture(self, role='helper'):
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        window = Path(temporary.name)
        (window / 'target/debug/deps').mkdir(parents=True)
        source = '/FAKE/source'
        choices = {
            'helper': ('mycarlos-tauri-poc', ['bin'], ['bin'], 'src/main.rs'),
            'libtest': ('mycarlos_tauri_poc_lib', ['staticlib', 'cdylib', 'rlib'], ['staticlib', 'cdylib', 'rlib'], 'src/lib.rs'),
            'harness': ('model_engine', ['test'], ['bin'], 'tests/model_engine.rs'),
        }
        name, kind, crate_types, rel = choices[role]
        target = {'name': name, 'kind': kind, 'crate_types': crate_types,
                  'src_path': source + '/src-tauri/' + rel}
        path = str(window / 'target/debug/deps' / name)
        message = {'reason': 'compiler-artifact', 'package_id': 'FAKE-own',
                   'target': target, 'profile': {'opt_level': '1', 'debug_assertions': True,
                   'overflow_checks': True, 'debuginfo': 2, 'test': role != 'helper'},
                   'features': ['ai-helper-stub', 'default', 'experimental-mtp'], 'fresh': False,
                   'executable': path, 'filenames': [path]}
        return window, {'id': 'FAKE-own', 'targets': [target]}, {'source_root': source}, message

    def select(self, role, values, trailing=None):
        window, own, pins, message = values
        rows = [message, {'reason': 'build-finished', 'success': True}]
        if trailing is not None:
            rows.append(trailing)
        raw = b''.join(json.dumps(row).encode() + b'\n' for row in rows)
        record = {'command': ['/usr/bin/taskset', '-c', '0', '/usr/bin/nice', '-n', '19',
                              *guard.build_command('/FAKE/toolchain/cargo')],
                  'exit': 0, 'root_reaped': True, 'cwd': '/FAKE/source/src-tauri',
                  'stdout_sha256': hashlib.sha256(raw).hexdigest()}
        def require(condition, message):
            if not condition:
                raise ValueError(message)
        return guard.select_artifact(raw, own, role, record, window, pins,
                                     SimpleNamespace(require=require, unique_object=dict),
                                     SimpleNamespace(check=lambda: None))

    def test_all_three_exact_role_profiles_are_required(self):
        for role in ('helper', 'libtest', 'harness'):
            with self.subTest(role=role):
                item = self.select(role, self.fixture(role))
                self.assertEqual(item['profile']['opt_level'], '1')
                self.assertIs(item['profile']['test'], role != 'helper')

    def test_o3_or_release_assertions_overflow_or_debug_changes_refuse(self):
        for key, bad in [('opt_level', '3'), ('debug_assertions', False),
                         ('overflow_checks', False), ('debuginfo', 0), ('test', True)]:
            values = self.fixture()
            values[-1]['profile'][key] = bad
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.select('helper', values)

    def test_preexisting_fresh_true_executable_is_not_compiled_evidence(self):
        for role in ('helper', 'libtest', 'harness'):
            values = self.fixture(role)
            values[-1]['fresh'] = True
            with self.subTest(role=role), self.assertRaises(ValueError):
                self.select(role, values)

    def test_wrong_package_or_features_refuse(self):
        for field, value in [('package_id', 'FAKE-other'), ('features', ['default'])]:
            values = self.fixture()
            values[-1][field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                self.select('helper', values)

    def test_external_target_path_refuses(self):
        values = self.fixture()
        values[-1].update(executable='/FAKE/old/helper', filenames=['/FAKE/old/helper'])
        with self.assertRaises(ValueError):
            self.select('helper', values)

    def test_terminal_finished_is_last(self):
        with self.assertRaises(ValueError):
            self.select('helper', self.fixture(), {'reason': 'compiler-message'})

    def test_missing_executable_never_reuses_a_prior_binary(self):
        for role in ('helper', 'libtest', 'harness'):
            values = self.fixture(role)
            values[-1]['executable'] = None
            with self.subTest(role=role), self.assertRaises(ValueError):
                self.select(role, values)
