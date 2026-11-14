"""Package selected Cargo build outputs. Does not execute native code or read a model."""
from pathlib import Path
import hashlib
import json
import os
import shutil
import stat
import subprocess
import tarfile


def sha(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def main():
    root = Path(os.environ['NATIVE_ROOT'])
    source, target, logs = root / 'source', root / 'target', root / 'logs'
    overrides = {name: os.environ.get(name) for name in
                 ['CARGO_PROFILE_DEV_DEBUG', 'CARGO_PROFILE_TEST_DEBUG', 'CARGO_INCREMENTAL']}
    assert all(value == '0' for value in overrides.values())
    head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=source, text=True).strip()
    tree = subprocess.check_output(['git', 'rev-parse', 'HEAD^{tree}'], cwd=source, text=True).strip()
    assert head == os.environ['SOURCE_COMMIT'] and root == Path('/opt/mycarlos-native') / head
    output = root / 'export'
    output.mkdir()
    bundle = output / 'bundle'
    bundle.mkdir()
    manifest_path = str(source / 'src-tauri/Cargo.toml')
    witnesses = {}
    artifacts = {}
    log = logs / 'native.jsonl'
    rows = [json.loads(line) for line in log.read_text().splitlines() if line.strip()]
    assert any(row.get('reason') == 'build-finished' and row.get('success') is True for row in rows)
    shutil.copyfile(log, output / log.name)
    # One Cargo command emits exactly one fresh root-package artifact per role.
    roles = [('helper', 'mycarlos-tauri-poc', False),
             ('harness', 'model_engine', True),
             ('libtest', 'mycarlos_tauri_poc_lib', True),
             ('root-library', 'mycarlos_tauri_poc_lib', False)]
    for role, name, test in roles:
        selected = [row for row in rows if row.get('reason') == 'compiler-artifact'
                    and row.get('manifest_path') == manifest_path
                    and row['target']['name'] == name and row['profile']['test'] is test]
        assert len(selected) == 1, (role, len(selected))
        witness = selected[0]
        assert witness['fresh'] is False, role
        assert sorted(witness['features']) == ['ai-helper-stub', 'default', 'experimental-mtp']
        profile = witness['profile']
        assert profile['opt_level'] == '1' and profile['debuginfo'] == 0
        assert profile['debug_assertions'] is True and profile['overflow_checks'] is True
        if role == 'root-library':
            files = [Path(name) for name in witness['filenames'] if name.endswith('.rlib')]
            assert len(files) == 1
            original = files[0]
            destination = bundle / 'root-library.rlib'
        else:
            original = Path(witness['executable'])
            destination = bundle / role
        assert original.is_relative_to(target) and original.resolve() == original
        assert stat.S_ISREG(original.lstat().st_mode)
        if role == 'helper':
            assert original == target / 'debug/mycarlos-tauri-poc'
        shutil.copyfile(original, destination)
        destination.chmod(0o400 if role == 'root-library' else 0o500)
        assert destination.stat().st_nlink == 1
        digest = sha(destination)
        assert digest == sha(original)
        artifacts[role] = {'archive_path': str(destination.relative_to(output)),
                           'compiled_path': str(original), 'sha256': digest,
                           'bytes': destination.stat().st_size}
        witnesses[role] = witness
    # Keep the actual sys-crate native configuration, never native object/archive caches.
    sys_builds = [row for row in rows if row.get('reason') == 'build-script-executed'
                  and 'llama-cpp-sys-2@0.1.160' in row.get('package_id', '')]
    assert len(sys_builds) == 1
    native_out = Path(sys_builds[0]['out_dir'])
    assert native_out.is_relative_to(target) and native_out.resolve() == native_out
    cache_files = list(native_out.rglob('CMakeCache.txt'))
    cpu_flags = list(native_out.rglob('ggml-cpu.dir/flags.make'))
    assert len(cache_files) == 1 and len(cpu_flags) == 1
    native_config = output / 'native-config'
    native_config.mkdir()
    for original, name in [(cache_files[0], 'CMakeCache.txt'), (cpu_flags[0], 'cpu-flags.make')]:
        assert stat.S_ISREG(original.lstat().st_mode) and original.stat().st_size <= 2 * 1024 * 1024
        shutil.copyfile(original, native_config / name)
    # Hash the public tracked checkout, including source/config/lockfiles, without uploading it.
    tracked = subprocess.check_output(['git', 'ls-files', '-z'], cwd=source).split(b'\0')
    inventory = []
    for raw in tracked:
        if not raw:
            continue
        relative = os.fsdecode(raw)
        path = source / relative
        assert stat.S_ISREG(path.lstat().st_mode) and path.resolve() == path
        inventory.append({'relative_path': relative, 'path': str(path),
                          'sha256': sha(path), 'bytes': path.stat().st_size})
    (output / 'source-inventory.json').write_text(json.dumps(
        {'head': head, 'tree': tree, 'source_root': str(source), 'files': inventory}, indent=2) + '\n')
    (output / 'cargo-artifact-selection.json').write_text(json.dumps(
        {'head': head, 'tree': tree, 'explicit_features': ['ai-helper-stub', 'experimental-mtp'],
         'artifacts': artifacts, 'compiler_artifacts': witnesses,
         'profile_overrides': overrides,
         'model_invoked': False, 'native_runtime_qualified': False}, indent=2) + '\n')
    for filename in ['toolchain.txt', 'native-environment.txt', 'commands.txt']:
        shutil.copyfile(logs / filename, output / filename)
    # Retain exactly the outputs above, never target/, registry caches, inputs or weights.
    members = sorted(path for path in output.rglob('*') if path.is_file())
    total = sum(path.stat().st_size for path in members)
    assert total <= 512 * 1024 * 1024, total
    (output / 'SHA256SUMS').write_text(''.join(
        sha(path) + '  ' + str(path.relative_to(output)) + '\n' for path in members))
    archive = root / 'mycarlos-mtp-native.tar.gz'
    with tarfile.open(archive, 'w:gz', compresslevel=6) as tar:
        for path in sorted(output.rglob('*')):
            if path.is_file():
                tar.add(path, arcname=str(path.relative_to(output)), recursive=False)
    assert archive.stat().st_size < 1024 * 1024 * 1024
    print(json.dumps({'archive': str(archive), 'sha256': sha(archive),
                      'bytes': archive.stat().st_size, 'uncompressed_files_bytes': total}))


if __name__ == '__main__':
    main()
