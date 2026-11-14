#!/usr/bin/env python3
"""Root-invoked finite stages; no daemon, model control, shared-lock or HOLD API."""
import argparse
import ctypes
import hashlib
import json
import math
import os
from pathlib import Path
import re
import signal
import stat
import struct
import subprocess
import sys
import time
import tomllib

PACKAGE = Path(__file__).resolve().parent
LIMITS = {"cache": 600, "build": 1800, "runtime": 180}
TEST = "extraction_acceptance_tests::actual_document_text_preserves_scan_and_form_extraction_limits"
# Fixed reviewed model-free selectors; no CLI/environment selector override.
CONTRACT_TESTS = (
    'summary_contract::tests::full_text_above_raw_and_glossary_caps_is_preserved_under_the_byte_budget',
    'summary_contract::tests::the_actual_serializer_admits_exact_65536_and_refuses_65537_without_clipping',
    'summary_contract::tests::decoder_cardinality_is_derived_from_reserved_serialization_not_twenty',
    'summary_contract::tests::utf8_escaping_is_counted_by_serde_and_null_sources_cannot_overflow_the_reserve',
    'summary_contract::tests::null_only_actual_fit_does_not_waive_the_explicit_reservation_policy',
    'summary_contract::tests::exact_source_count_and_existing_utf16_geometry_are_retained',
    'summary_contract::tests::native_source_decoder_bounds_allocation_and_preserves_null_absence',
    'summary_contract::tests::counting_overflow_is_an_error_not_wraparound',
    'summary_contract::tests::full_long_rule_and_all_twenty_one_distinct_rules_survive_under_budget',
    'summary_contract::tests::guarded_under_budget_policy_matches_the_original_and_oversize_fails_before_edit',
    'model_runtime::tests::summary_size_error_survives_runner_and_owned_save_boundaries',
    'vault::ai_results::tests::complete_long_text_and_more_than_twenty_rules_round_trip_without_clipping',
    'vault::ai_results::tests::an_oversize_replacement_does_not_publish_objects_or_hide_the_previous_answer',
    'vault::ai_results::tests::a_parent_valid_exact_budget_legacy_answer_still_reads_unlocks_and_restores',
    'tests::ai_errors_carry_their_code_and_words_the_catalogue_has',
    'native_localization_tests::native_localization_errors_retain_context_and_destination_warning_identities',
    'vault::ai_results::tests::an_answer_outside_the_final_shape_or_unchanged_explain_caps_is_refused',
    'model_runtime::tests::summary_read_pages_preserves_sparse_head_and_only_the_reported_tail',
    'model_runtime::tests::kept_tail_source_passes_the_save_contract_but_an_unread_gap_does_not',
    'model_runtime::tests::kept_sources_refuse_absent_pages_inside_the_head_prefix_too',
    'model_runtime::tests::a_kept_summary_is_kept_as_the_reader_keeps_one_with_its_source_places',
    'model_runtime::tests::a_kept_answer_takes_only_sources_that_fit_it',
)


def bootstrap(args):
    # Small, bounded bootstrap before importing the separately hash-verified helper module.
    os.sched_setaffinity(0, {0})
    os.setpriority(os.PRIO_PROCESS, 0, 19)
    began, wall = time.monotonic(), time.time()
    if not math.isfinite(args.absolute_expiry_epoch):
        raise RuntimeError("finite explicit root expiry required")
    hard = min(began + LIMITS[args.stage], began + args.absolute_expiry_epoch - wall)
    work = hard - args.cleanup_margin_seconds
    if not math.isfinite(args.cleanup_margin_seconds) or args.cleanup_margin_seconds < 5 or work - began < 1:
        raise RuntimeError("expired/insufficient root budget before bootstrap")

    def tick():
        if time.monotonic() >= work or time.time() >= args.absolute_expiry_epoch:
            raise RuntimeError("bootstrap absolute/relative budget exhausted")

    def small(path, cap):
        tick()
        path = Path(path)
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_size > cap:
            raise RuntimeError("bootstrap file type/size refused")
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
        try:
            opened = os.fstat(fd)
            if (opened.st_dev, opened.st_ino, opened.st_size, opened.st_mtime_ns) != (
                    info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns):
                raise RuntimeError("bootstrap file changed before read")
            data = bytearray()
            while len(data) < info.st_size:
                tick()
                chunk = os.read(fd, min(65536, info.st_size - len(data)))
                if not chunk:
                    raise RuntimeError("short bootstrap input")
                data.extend(chunk)
            if os.fstat(fd) != opened:
                # atime may change; compare identity fields only below.
                now = os.fstat(fd)
                if (now.st_dev, now.st_ino, now.st_size, now.st_mtime_ns) != (
                        opened.st_dev, opened.st_ino, opened.st_size, opened.st_mtime_ns):
                    raise RuntimeError("bootstrap file changed")
            tick()
            return bytes(data)
        finally:
            os.close(fd)

    manifest_bytes = small(PACKAGE / "package-manifest.json", 65536)
    if hashlib.sha256(manifest_bytes).hexdigest() != args.package_sha256:
        raise RuntimeError("approved guard package differs")
    manifest = json.loads(manifest_bytes)
    expected = {"native_guard.py", "guard_support.py", "scratch_driver.py", "policy.json",
                "README.md", "CONTROL-TEST-PLAN.md"}
    if manifest.get("schema") != 3 or set(manifest.get("files", {})) != expected:
        raise RuntimeError("guard package inventory differs")
    for name, sha in manifest["files"].items():
        if hashlib.sha256(small(PACKAGE / name, 2 * 1024 * 1024)).hexdigest() != sha:
            raise RuntimeError("guard file changed")
    sys.path.insert(0, str(PACKAGE))  # Only after exact package hash verification under -I.
    import guard_support as support
    budget = support.Budget(LIMITS[args.stage], args.absolute_expiry_epoch,
                            args.cleanup_margin_seconds)
    # Bootstrap work counts against the same original stage ceiling.
    budget.started, budget.hard_end, budget.work_end = began, hard, work
    budget.arm()
    return support, budget


EXTRACTION_SOURCE_NAMES = ('src-tauri/Cargo.lock', 'src-tauri/Cargo.toml', 'src-tauri/build.rs', 'src-tauri/src/extraction_acceptance_tests.rs', 'src-tauri/src/lib.rs', 'src-tauri/src/main.rs', 'src-tauri/src/pdf_unlock.rs', 'src-tauri/src/pdf_view.rs', 'src-tauri/src/vault.rs', 'src-tauri/tests/fixtures/extraction-acceptance/fake-flattened-form.pdf', 'src-tauri/tests/fixtures/extraction-acceptance/fake-image-only-scan.pdf', 'src-tauri/tests/fixtures/extraction-acceptance/fake-widget-form.pdf')

def compiled_extraction_names(rust_source, s):
    s.require(rust_source.count('fn compiled_sources()') == 1, 'exact compiled_sources function required')
    section = rust_source.split('fn compiled_sources()', 1)[1].split('\nfn git(', 1)[0]
    pairs = re.findall(r'\(\s*"([^"]+)"\s*,\s*include_bytes!\("([^"]+)"\)', section)
    names = tuple(sorted(name for name, include in pairs))
    s.require(names == EXTRACTION_SOURCE_NAMES and len(set(names)) == 12,
              'compiled include_bytes extraction source set changed')
    for name, include in pairs:
        normalized = Path(os.path.normpath(str(Path('src-tauri/src') / include))).as_posix()
        s.require(name == normalized, 'compiled source name/include_bytes path mismatch')
    return names

def extraction_manifest_projection(original, pins, rust_source, s):
    names = compiled_extraction_names(rust_source, s)
    records = original.get('source_files', [])
    declared = {entry['path']: entry['sha256'] for entry in records}
    s.require(len(records) == len(declared) == 17 and declared == pins['source_sha256'],
              'original manifest must retain exact all17 external pins')
    s.require(original.get('source_revision') == pins['head'], 'projection source revision differs')
    projected = dict(original)
    projected['source_files'] = [{'path': name, 'sha256': pins['source_sha256'][name]} for name in names]
    return projected


def validate_split_certificate(value, args, policy, pins, proof, s, budget):
    split = policy['split_build']
    s.require(value.get('schema') == 'root-timer12f874-splitdir-native-admission-v1'
              and value.get('root_accepted') is True and value.get('window') == args.window
              and args.window == split['final_window']
              and value.get('package_sha256') == args.package_sha256
              and value.get('source_pins_sha256') == args.source_pins_sha256
              and value.get('cache_inventory_sha256') == args.cache_inventory_sha256
              and value.get('candidate_head') == pins['head'] and value.get('candidate_tree') == pins['tree'],
              'exact timer split-directory admission required')
    s.require(all(value.get(key) == proof[key] for key in
                  ('holder_pid', 'holder_start', 'absolute_expiry_epoch')),
              'split-directory owner/deadline changed')
    for key in ('existing315_H10_closed', 'no_old315_native_or_model_processes',
                'sole_heavy_build_authorized', 'candidate_mtime_touch_authorized',
                'dependency_cache_adoption_only_no_old_model_evidence'):
        s.require(value.get(key) is True, 'explicit closed315/split scope required: ' + key)
    for name in ('closed315_proof', 'source_inventory'):
        ref = value.get(name)
        s.require(isinstance(ref, dict) and set(ref) == {'path', 'sha256'}
                  and isinstance(ref['path'], str) and Path(ref['path']).is_absolute()
                  and isinstance(ref['sha256'], str) and re.fullmatch(r'[0-9a-f]{64}', ref['sha256'])
                  and s.digest(Path(ref['path']), budget, 8 * 1024 * 1024) == ref['sha256'],
                  'actual closed315/source inventory evidence required: ' + name)
    s.require(value['source_inventory']['sha256'] == split['source_inventory_sha256'],
              'exact independently reviewed whole-source inventory required')
    inventory = s.load_json(value['source_inventory']['path'], budget, 8 * 1024 * 1024)
    s.require(inventory.get('candidate_head') == pins['head'] and inventory.get('candidate_tree') == pins['tree']
              and len(inventory.get('files', [])) == 656, 'exact timer whole-source inventory required')
    s.require(pins['source_sha256']['src-tauri/Cargo.lock'] == split['cargo_lock_sha256']
              and pins['cargo_configuration_sha256'] == split['cargo_configuration_sha256']
              and value.get('adopted_cache_result_sha256') == split['cache_result_sha256'],
              'dependency graph/cache adoption changed')
    for name in ('shared_build_dir', 'cargo_home'):
        path = private(split[name], s, budget)
        info = path.lstat()
        s.require(value.get('shared_directory_identities', {}).get(name) == [info.st_dev, info.st_ino],
                  'shared directory device/inode changed')
    s.require(Path(split['shared_build_dir']) != Path(args.window) / 'target'
              and not Path(args.window).is_relative_to(Path(split['shared_build_dir']))
              and not Path(split['shared_build_dir']).is_relative_to(Path(args.window)),
              'new final target must be separate from shared intermediates')
    return value


def adopt_shared_cache(stage):
    s, b, split = stage.s, stage.budget, stage.policy['split_build']
    witness = stage.proof['previous_stage']
    s.require(witness == {'stage': 'cache', 'actual_exit_code': 0,
                         'result_sha256': split['cache_result_sha256']},
              'only exact original dependency cache result may be adopted')
    old = s.committed_json(Path(split['cache_result_path']), b, expected_sha=split['cache_result_sha256'])
    cleanup = old.get('cleanup', {})
    s.require(old.get('schema') == 3 and old.get('stage') == 'cache' and old.get('status') == 'passed'
              and old.get('package_sha256') == split['cache_package_sha256']
              and cleanup.get('cleanup_complete') is True and cleanup.get('kernel_no_children') is True
              and cleanup.get('remaining_live_owned') == [] and cleanup.get('unreaped_owned') == [],
              'old dependency cache receipt/cleanup differs')
    record_path = Path(split['cache_result_path']).parent / 'cache-files.json'
    record = s.committed_json(record_path, b, expected_sha=old['extra']['cache_files_sha256'])
    copies = record.get('measured_copies', [])
    s.require(len(copies) == 1284 and record.get('dependency_target_copied') is False
              and record.get('extracted_source_copied') is False, 'exact archive/index cache lineage required')
    # Re-measure only the old private archive/index copies; no target/source copying.
    measured = []
    for item in copies:
        copied = item['copy']; path = Path(copied['path']); info = path.lstat()
        s.require(path.is_relative_to(Path(split['cargo_home']) / 'registry') and path.resolve() == path
                  and stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size == copied['bytes']
                  and s.digest(path, b, 256 * 1024 * 1024) == copied['sha256'],
                  'adopted private cache archive/index bytes changed')
        measured.append({'path': str(path), 'sha256': copied['sha256'], 'bytes': info.st_size})
    s.immutable_json(stage.directory / 'shared-cache-adoption.json', {
        'schema': 1, 'old_cache_result_sha256': split['cache_result_sha256'],
        'old_cache_files_sha256': old['extra']['cache_files_sha256'],
        'new_source_pins_sha256': stage.args.source_pins_sha256,
        'cargo_lock_sha256': split['cargo_lock_sha256'], 'measured_copies': measured,
        'no_old_native_or_model_evidence_transferred': True, 'target_or_source_copied': False}, b)


def artifact_path_allowed(path, role, window, shared_build_dir=None):
    path = Path(path)
    if shared_build_dir is None:
        return path.is_relative_to(Path(window) / 'target')
    if role == 'helper':
        return path == Path(window) / 'target/debug/mycarlos-tauri-poc'
    return path.is_relative_to(Path(shared_build_dir) / 'debug/deps')


def select_non_test_root_library(log_bytes, own, pins, window, shared_build_dir, s, budget):
    targets = [target for target in own.get('targets', []) if target.get('name') == 'mycarlos_tauri_poc_lib']
    s.require(len(targets) == 1 and targets[0].get('src_path') ==
              str(Path(pins['source_root']) / 'src-tauri/src/lib.rs'), 'exact root library target required')
    selected, finished = [], False
    for line in log_bytes.splitlines():
        budget.check()
        s.require(line and len(line) <= 8 * 1024 * 1024 and not finished, 'bounded root library log and terminal ordering required')
        value = json.loads(line, object_pairs_hook=s.unique_object)
        if value.get('reason') == 'build-finished':
            s.require(value.get('success') is True, 'root library build unsuccessful')
            finished = True
            continue
        if (value.get('reason') != 'compiler-artifact' or value.get('package_id') != own['id']
                or value.get('target') != targets[0] or value.get('profile', {}).get('test') is not False):
            continue
        profile = value['profile']
        s.require(profile.get('opt_level') == EXPECTED_APP_OPT_LEVEL and profile.get('debuginfo') == 2
                  and profile.get('debug_assertions') is True and profile.get('overflow_checks') is True
                  and value.get('features') == ['ai-helper-stub', 'default']
                  and value.get('fresh') is False and value.get('executable') is None,
                  'fresh non-test root library O1 witness required')
        filenames = value.get('filenames', [])
        s.require(isinstance(filenames, list) and filenames and any(name.endswith('.rlib') for name in filenames),
                  'non-test root library output filenames required')
        for name in filenames:
            path = Path(name)
            s.require(path.is_absolute() and path.resolve() == path
                      and (path.is_relative_to(Path(window) / 'target')
                           or path.is_relative_to(Path(shared_build_dir) / 'debug/deps')),
                      'root library output outside approved split roots')
            s.require(path.is_file() and not path.is_symlink() and path.stat().st_size > 0,
                      'actual root library file missing')
        selected.append({'package_id': own['id'], 'target': targets[0], 'profile': profile,
                         'features': value['features'], 'fresh': False, 'filenames': filenames})
    s.require(finished and len(selected) == 1, 'exactly one fresh non-test root library witness and successful finish required')
    return selected[0]


def inspect_harness_helper_literals(path, new_helper, old_helper, s, budget):
    data = s.read_path(path, 4 * s.GIB, budget)
    s.require(data[:6] == b'\x7fELF\x02\x01' and len(data) >= 64, 'ELF64 little-endian harness required')
    offset = struct.unpack_from('<Q', data, 32)[0]
    entry_size, count = struct.unpack_from('<HH', data, 54)
    s.require(entry_size == 56 and 0 < count <= 128 and offset + entry_size * count <= len(data),
              'bounded ELF program header table required')
    sections = []
    for index in range(count):
        kind, flags, start, _, _, length, _, _ = struct.unpack_from('<IIQQQQQQ', data, offset + index * entry_size)
        if kind == 1 and not flags & 2:
            s.require(start + length <= len(data), 'ELF load segment exceeds file')
            sections.append(data[start:start + length])
    new, old = new_helper.encode(), old_helper.encode()
    s.require(new and old and new != old and any(new in segment for segment in sections)
              and not any(old in segment for segment in sections), 'new harness helper literal absent or stale315 binding present')
    return {'new_helper_path': new_helper, 'old315_helper_literal_absent_from_readonly_load_segments': True,
            'new_literal_present_in_readonly_load_segment': True,
            'proof_scope': 'loaded string plus pinned env! source and fresh compilation; not live helper EXEC',
            'live_native_helper_EXEC_qualified': False}


def touch_candidate_entries(stage):
    s, b, pins = stage.s, stage.budget, stage.pins
    rows = []
    for name in stage.policy['split_build']['mtime_sources']:
        path = Path(pins['source_root']) / name; before = path.lstat()
        s.require(s.digest(path, b, 16 * 1024 * 1024) == pins['source_sha256'][name],
                  'candidate bytes changed before bounded mtime touch')
        os.utime(path, None, follow_symlinks=False)
        after = path.lstat()
        s.require((before.st_dev, before.st_ino, before.st_size) == (after.st_dev, after.st_ino, after.st_size)
                  and after.st_mtime_ns >= before.st_mtime_ns
                  and s.digest(path, b, 16 * 1024 * 1024) == pins['source_sha256'][name],
                  'only candidate entry mtime may change')
        rows.append({'path': str(path), 'sha256': pins['source_sha256'][name],
                     'mtime_before_ns': before.st_mtime_ns, 'mtime_after_ns': after.st_mtime_ns})
    s.immutable_json(stage.directory / 'candidate-entry-mtimes.json', {'schema': 1, 'entries': rows}, b)


def snapshot_protected315(split, s, budget):
    rows = []
    aliases = list((Path(split['shared_build_dir']) / 'debug/deps').iterdir())
    for expected in split['protected315']:
        path = Path(expected['path']); before = path.lstat()
        s.require(path.resolve() == path and stat.S_ISREG(before.st_mode) and before.st_mode & 0o111
                  and s.digest(path, budget, 4 * s.GIB) == expected['sha256'], 'protected315 executable changed')
        after = path.lstat()
        s.require(s.identity(before) == s.identity(after), 'protected315 changed during hash')
        known_aliases = []
        for alias in aliases:
            try:info = alias.lstat()
            except FileNotFoundError:continue
            if (info.st_dev, info.st_ino) == (before.st_dev, before.st_ino):known_aliases.append(str(alias))
        rows.append({'role': expected['role'], 'path': str(path), 'sha256': expected['sha256'], 'device': before.st_dev,
                     'inode': before.st_ino, 'bytes': before.st_size, 'mode': stat.S_IMODE(before.st_mode),
                     'nlink': before.st_nlink, 'known_shared_deps_aliases': sorted(known_aliases)})
    require_independent315_bundles(rows, s)
    return rows


def require_independent315_bundles(rows, s):
    s.require(len(rows) == 4 and {row['role'] for row in rows} == {'compiletime_helper', 'harness', 'helper', 'libtest'}
              and len({(row['device'], row['inode']) for row in rows}) == 4,
              'four distinct protected315 executable identities required before shared mutation')
    for row in rows:
        if row['role'] != 'compiletime_helper':
            s.require(row['nlink'] == 1 and row['known_shared_deps_aliases'] == [],
                      'protected315 bundles must already be independent before shared mutation')


def reject_protected_artifact_aliases(selections, protected_before, s):
    protected_ids = {(row['device'], row['inode']) for row in protected_before}
    actual = {}
    for role, item in selections.items():
        info = Path(item['path']).lstat()
        s.require((info.st_dev, info.st_ino) not in protected_ids,
                  'new timer artifact aliases a protected315 executable')
        actual[role] = {'path': item['path'], 'device': info.st_dev, 'inode': info.st_ino}
    s.require(len({(row['device'], row['inode']) for row in actual.values()}) == 3,
              'three distinct new timer artifact identities required')
    return actual


def require_protected315_unchanged(before, after, s):
    s.require(len(before) == len(after) == 4, 'all four protected315 executables required')
    for first, last in zip(before, after):
        s.require(all(first[key] == last[key] for key in ('role', 'path', 'sha256', 'device', 'inode', 'bytes', 'mode'))
                  and 1 <= last['nlink'] <= first['nlink']
                  and set(last['known_shared_deps_aliases']) <= set(first['known_shared_deps_aliases']),
                  'protected315 bytes/identity/mode changed or unsafe link growth')


def available():
    fd = os.open("/proc/meminfo", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    try:
        lines = os.read(fd, 16384).decode().splitlines()
        return next(int(line.split()[1]) * 1024 for line in lines if line.startswith("MemAvailable:"))
    finally:
        os.close(fd)


def private(path, s, budget, create=False):
    budget.check()
    path = Path(path)
    if create:
        path.mkdir(mode=0o700)
    info = path.lstat()
    s.require(stat.S_ISDIR(info.st_mode) and not path.is_symlink() and path.resolve() == path
              and path.is_absolute() and info.st_uid == os.geteuid()
              and stat.S_IMODE(info.st_mode) == 0o700, "canonical private0700 owned directory required")
    return path


def load_inputs(args, s, budget):
    policy = s.load_json(PACKAGE / "policy.json", budget, 65536)
    s.require(policy.get("schema") == 3, "reviewed policy schema required")
    for field in ("source_pins", "cache_inventory", "holder_proof", "split_certificate"):
        path = Path(getattr(args, field))
        s.require(path.is_absolute() and path.resolve() == path and not path.is_symlink(),
                  "canonical explicit approved metadata path required")
        s.require(s.digest(path, budget, 32 * 1024 * 1024) == getattr(args, field + "_sha256"),
                  "approved metadata hash differs: " + field)
    pins = s.load_json(args.source_pins, budget)
    s.require(set(pins) == {"schema", "head", "tree", "source_root", "source_sha256",
                           "build_features", "cargo_configuration_sha256"} and pins["schema"] == 2,
              "source pin schema differs")
    s.require(re.fullmatch(r"[0-9a-f]{40}", pins["head"]) and re.fullmatch(r"[0-9a-f]{40}", pins["tree"]),
              "full source identities required")
    s.require(set(pins["source_sha256"]) == set(policy["source_files"])
              and all(re.fullmatch(r"[0-9a-f]{64}", sha) for sha in pins["source_sha256"].values())
              and re.fullmatch(r"[0-9a-f]{64}", pins["cargo_configuration_sha256"]), "source hash set differs")
    s.require(pins["build_features"] == policy["build_features"], "feature pin differs")
    source = Path(pins["source_root"])
    s.require(source.is_absolute() and source.resolve() == source and source.is_relative_to("/workspace"),
              "isolated source root required")
    proof = s.load_json(args.holder_proof, budget, 16384)
    s.require(set(proof) == {"schema", "kind", "holder_pid", "holder_start", "absolute_expiry_epoch",
              "cleanup_margin_seconds", "stage", "window", "package_sha256", "source_pins_sha256",
              "cache_inventory_sha256", "previous_stage"} and proof["schema"] == 2
              and proof["kind"] == "root-external-global-flock", "root external holder metadata differs")
    for field in ("absolute_expiry_epoch", "cleanup_margin_seconds", "stage", "window", "package_sha256",
                  "source_pins_sha256", "cache_inventory_sha256"):
        s.require(proof[field] == getattr(args, field), "root approval binding differs: " + field)
    s.require(type(proof["holder_pid"]) is int and proof["holder_pid"] > 1, "root holder PID required")
    s.canonical_start(proof["holder_start"])
    previous = proof["previous_stage"]
    if args.stage == "cache":
        s.require(previous is None, "cache proof must not claim a previous stage")
    else:
        expected_previous = "cache" if args.stage == "build" else "build"
        s.require(isinstance(previous, dict)
                  and set(previous) == {"stage", "actual_exit_code", "result_sha256"}
                  and previous["stage"] == expected_previous
                  and type(previous["actual_exit_code"]) is int and previous["actual_exit_code"] == 0
                  and re.fullmatch(r"[0-9a-f]{64}", previous["result_sha256"]),
                  "root-observed successful prior exit and result hash required")
    inventory = s.load_json(args.cache_inventory, budget, 32 * 1024 * 1024)
    validate_inventory(inventory, policy, s, pins, budget)
    validate_split_certificate(s.load_json(args.split_certificate, budget, 65536),
                               args, policy, pins, proof, s, budget)
    return policy, pins, proof, inventory


def validate_inventory(value, policy, s, pins, budget):
    """Metadata proposal only: expected lock checksums are never measured hashes."""
    budget.check()
    s.require(set(value) == {"schema", "scope", "measurement_policy", "packages"}
              and value["schema"] == "carlos.mycarlos.public-cargo-cache-inventory.v2",
              "reviewed metadata inventory schema required")
    scope = value["scope"]
    source = "registry+https://github.com/rust-lang/crates.io-index"
    s.require(scope["source_revision"] == pins["head"]
              and scope["lock_path"] == "src-tauri/Cargo.lock"
              and scope["lock_sha256"] == pins["source_sha256"]["src-tauri/Cargo.lock"]
              and scope["registry_source"] == source, "inventory source/lock binding differs")
    measurement = value["measurement_policy"]
    for field in ("archive_bytes_read", "archive_sha256_measured", "credential_or_config_read",
                  "index_bytes_read", "private_registry_traversal"):
        s.require(measurement[field] is False, "metadata inventory claims unexpected measurements")
    lock_bytes = s.read_path(Path(pins["source_root"]) / scope["lock_path"], 4 * 1024 * 1024, budget)
    s.require(hashlib.sha256(lock_bytes).hexdigest() == scope["lock_sha256"], "actual lock differs")
    locked = tomllib.loads(lock_bytes.decode())["package"]
    expected = {(p["name"], p["version"], p["source"], p["checksum"])
                for p in locked if p.get("source") == source}
    packages = value["packages"]
    s.require(isinstance(packages, list) and 0 < len(packages) <= 10000
              and scope["crates_io_package_count"] == len(expected)
              and scope["lock_package_count"] == len(locked), "inventory package counts differ")
    seen, total, candidates = set(), 0, set()
    for item in packages:
        budget.check()
        s.require(set(item) == {"name", "version", "source", "lock_expected_archive_sha256",
                               "archive_candidate", "index_candidate"}, "metadata item fields differ")
        name, version = item["name"], item["version"]
        s.require(re.fullmatch(r"[A-Za-z0-9_-]+", name)
                  and re.fullmatch(r"[0-9][A-Za-z0-9.+_-]*", version)
                  and re.fullmatch(r"[0-9a-f]{64}", item["lock_expected_archive_sha256"]),
                  "invalid locked package identity")
        key = (name, version, item["source"], item["lock_expected_archive_sha256"])
        s.require(key in expected and key not in seen, "unlocked/duplicate public package")
        seen.add(key)
        lower = name.lower()
        shard = ("1/" + lower if len(lower) == 1 else "2/" + lower if len(lower) == 2
                 else "3/" + lower[0] + "/" + lower if len(lower) == 3
                 else lower[:2] + "/" + lower[2:4] + "/" + lower)
        for role in ("archive_candidate", "index_candidate"):
            candidate = item[role]
            s.require(set(candidate) == {"registry_instance", "relative_path", "state", "lstat"},
                      "candidate fields differ")
            namespace = candidate["registry_instance"]
            s.require(re.fullmatch(r"index\.crates\.io-[0-9a-f]{16}", namespace), "private registry refused")
            relative = candidate["relative_path"]
            s.relative_parts(relative)
            wanted = name + "-" + version + ".crate" if role == "archive_candidate" else ".cache/" + shard
            s.require(relative == wanted and candidate["state"] == "regular_file", "candidate path/type differs")
            identity = candidate["lstat"]
            s.require(set(identity) == {"device", "inode", "mtime_ns", "size_bytes"}
                      and all(type(n) is int and n >= 0 for n in identity.values()), "candidate instance required")
            cap = 256 * 1024 * 1024 if role == "archive_candidate" else 32 * 1024 * 1024
            s.require(identity["size_bytes"] <= cap, "candidate size cap exceeded")
            # Several locked versions may intentionally refer to the same sparse-index file.
            candidate_key = (role, namespace, relative)
            if candidate_key not in candidates:
                candidates.add(candidate_key)
                total += identity["size_bytes"]
    s.require(seen == expected and len(packages) == len(seen), "inventory not exact locked public package set")
    s.require(total <= 4 * s.GIB, "explicit public cache cap exceeded")
    budget.check()


def public_index_config(data, s):
    value = json.loads(data, object_pairs_hook=s.unique_object)
    s.require(set(value) <= {"dl", "api", "auth-required"}
              and value.get("dl") == "https://static.crates.io/crates"
              and value.get("api") == "https://crates.io"
              and value.get("auth-required", False) is False, "not the approved public crates.io configuration")


def verify_sparse_index(data, locked_items, s, budget):
    """Validate bounded sparse-cache framing and every requested lock checksum."""
    s.require(len(data) <= 32 * 1024 * 1024 and data.startswith(b"\x03\x02\x00\x00\x00")
              and data.endswith(b"\x00"), "unsupported sparse index framing")
    fields = data[5:].split(b"\x00")
    s.require(fields[0].startswith(b"etag: ") and len(fields[0]) <= 4096
              and fields[-1] == b"" and (len(fields) - 2) % 2 == 0, "sparse framing differs")
    wanted = {item["version"]: item["lock_expected_archive_sha256"] for item in locked_items}
    names = {item["name"] for item in locked_items}
    s.require(len(names) == 1, "mixed package sparse index")
    name = next(iter(names))
    found, versions = {}, set()
    for offset in range(1, len(fields) - 1, 2):
        budget.check()
        s.require(len(fields[offset]) <= 1024 and len(fields[offset + 1]) <= 2 * 1024 * 1024,
                  "index record cap exceeded")
        version = fields[offset].decode("utf-8")
        record = json.loads(fields[offset + 1], object_pairs_hook=s.unique_object)
        s.require(record.get("name") == name and record.get("vers") == version
                  and version not in versions
                  and re.fullmatch(r"[0-9a-f]{64}", record.get("cksum", "")), "index package identity differs")
        versions.add(version)
        if version in wanted:
            s.require(record["cksum"] == wanted[version], "index checksum conflicts with Cargo.lock")
            found[version] = record["cksum"]
    s.require(found == wanted, "locked package missing from public sparse index")


def materialize_public_cache(inventory, policy, destination, s, budget):
    """Only callable inside a capability-checked admitted cache worker.

    Every source archive is independently measured against Cargo.lock before its
    second, descriptor-validated copy pass. No recursive registry/source/target copy.
    """
    registry = Path(policy["registry_source"])
    destination = Path(destination)
    records, indexes = [], {}
    for item in inventory["packages"]:
        budget.check()
        c = item["archive_candidate"]
        relative = "cache/" + c["registry_instance"] + "/" + c["relative_path"]
        info = c["lstat"]
        instance = [info["device"], info["inode"], info["size_bytes"], info["mtime_ns"]]
        fd, parent, leaf, before = s.checked_source(registry, relative, budget, info["size_bytes"], instance)
        try:
            measured = s.digest_fd(fd, 256 * 1024 * 1024, budget)
            s.require(measured == item["lock_expected_archive_sha256"], "archive differs from locked checksum")
            s.require(s.identity(os.stat(leaf, dir_fd=parent, follow_symlinks=False)) == s.identity(before),
                      "archive instance replaced during measurement")
        finally:
            os.close(fd)
            os.close(parent)
        copied = s.stable_copy(registry, relative, destination, relative, budget,
                               256 * 1024 * 1024, expected_sha=measured,
                               expected_size=info["size_bytes"], expected_identity=instance)
        records.append({"role": "archive", "name": item["name"], "version": item["version"],
                        "lock_expected_archive_sha256": item["lock_expected_archive_sha256"],
                        "measured_sha256": measured, "copy": copied})
        c = item["index_candidate"]
        key = (c["registry_instance"], c["relative_path"])
        indexes.setdefault(key, []).append(item)
    for (namespace, path), items in indexes.items():
        budget.check()
        candidate = items[0]["index_candidate"]
        s.require(all(i["index_candidate"] == candidate for i in items), "index instance metadata conflicts")
        info = candidate["lstat"]
        instance = [info["device"], info["inode"], info["size_bytes"], info["mtime_ns"]]
        relative = "index/" + namespace + "/" + path
        fd, parent, leaf, before = s.checked_source(registry, relative, budget, info["size_bytes"], instance)
        try:
            data = s.read_fd(fd, 32 * 1024 * 1024, budget)
            s.require(s.identity(os.fstat(fd)) == s.identity(before)
                      == s.identity(os.stat(leaf, dir_fd=parent, follow_symlinks=False)), "index instance changed")
            verify_sparse_index(data, items, s, budget)
            measured = hashlib.sha256(data).hexdigest()
        finally:
            os.close(fd)
            os.close(parent)
        copied = s.stable_copy(registry, relative, destination, relative, budget,
                               32 * 1024 * 1024, expected_sha=measured,
                               expected_size=info["size_bytes"], expected_identity=instance)
        records.append({"role": "index", "measured_sha256": measured, "copy": copied})
    return records


def own_package(metadata, pins, s, budget):
    root = Path(pins["source_root"]) / "src-tauri"
    manifest = root / "Cargo.toml"
    config = tomllib.loads(s.read_path(manifest, 1024 * 1024, budget).decode())
    package = config["package"]
    matches = [p for p in metadata.get("packages", []) if p.get("manifest_path") == str(manifest)]
    s.require(len(matches) == 1, "own package manifest must select exactly once")
    own = matches[0]
    expected_id = "path+" + root.as_uri() + "#" + package["name"] + "@" + package["version"]
    s.require(own.get("id") == expected_id and own.get("source") is None
              and own.get("name") == package["name"] and own.get("version") == package["version"]
              and own["id"] in metadata.get("workspace_members", []), "own package origin differs")
    return own


EXPECTED_APP_OPT_LEVEL = "1"


def build_command(cargo):
    return [cargo, "test", "--offline", "--locked", "--jobs", "2",
            "--features", "ai-helper-stub", "--lib", "--test", "model_engine",
            "--no-run", "--message-format=json"]


def select_artifact(log_bytes, own, role, command_record, window, pins, s, budget, shared_build_dir=None):
    """Actual Cargo JSON admission, not a guessed filename/profile."""
    s.require(role in {"helper", "libtest", "harness"} and len(log_bytes) <= 64 * 1024 * 1024,
              "artifact role/log cap differs")
    actual = command_record.get("command", [])[6:]
    expected = build_command("cargo")
    s.require(len(actual) == len(expected) and Path(actual[0]).name == "cargo"
              and actual[1:] == expected[1:] and command_record.get("exit") == 0
              and command_record.get("root_reaped") is True
              and command_record.get("cwd") == str(Path(pins["source_root"]) / "src-tauri")
              and command_record.get("stdout_sha256") == hashlib.sha256(log_bytes).hexdigest(),
              "artifact log not bound to exact completed timer12f874 baseline-O1 no-run build")
    names = {"helper": "mycarlos-tauri-poc", "libtest": "mycarlos_tauri_poc_lib", "harness": "model_engine"}
    targets = [t for t in own.get("targets", []) if t.get("name") == names[role]]
    s.require(len(targets) == 1, "own metadata target must select exactly once")
    target = targets[0]
    expected_source = {"helper": "src/main.rs", "libtest": "src/lib.rs", "harness": "tests/model_engine.rs"}[role]
    kinds = {"helper": ["bin"], "libtest": ["staticlib", "cdylib", "rlib"], "harness": ["test"]}[role]
    crates = ["bin"] if role == "harness" else kinds
    s.require(target.get("kind") == kinds and target.get("crate_types") == crates
              and target.get("src_path") == str(Path(pins["source_root"]) / "src-tauri" / expected_source),
              "own target metadata differs")
    selected, finished = [], False
    for line in log_bytes.splitlines():
        budget.check()
        s.require(line and len(line) <= 8 * 1024 * 1024, "Cargo line cap/empty line")
        message = json.loads(line, object_pairs_hook=s.unique_object)
        s.require(not finished, "Cargo data after terminal build-finished")
        if message.get("reason") == "build-finished":
            s.require(message.get("success") is True, "Cargo build unsuccessful")
            finished = True
        elif message.get("reason") == "compiler-artifact" and message.get("target", {}).get("name") == names[role]:
            s.require(message.get("package_id") == own["id"] and message["target"] == target,
                      "same-name artifact has wrong package/target")
            profile = message.get("profile", {})
            if message.get("executable") is None:
                # Integration tests also build the non-test library. It is not the libtest executable.
                s.require(role == "libtest" and profile.get("test") is False,
                          "required executable missing")
                continue
            s.require(profile.get("opt_level") == EXPECTED_APP_OPT_LEVEL and profile.get("debug_assertions") is True
                      and profile.get("overflow_checks") is True and profile.get("debuginfo") == 2
                      and profile.get("test") is (role != "helper")
                      and message.get("features") == ["ai-helper-stub", "default"]
                      and message.get("fresh") is False, "timer12f874 baseline-O1 artifact profile/features differ")
            executable = message["executable"]
            path = Path(executable)
            s.require(isinstance(executable, str) and executable in message.get("filenames", [])
                      and path.is_absolute() and artifact_path_allowed(path, role, window, shared_build_dir)
                      and path.resolve() == path, "artifact outside fresh isolated target")
            selected.append({"path": str(path), "profile": profile, "package_id": own["id"],
                             "target": target, "features": message["features"], "fresh": message["fresh"]})
    s.require(finished and len(selected) == 1, "one actual role executable and successful finish required")
    return selected[0]


def verify_native_flags(window, s, budget, shared_build_dir=None):
    build_dir = Path(shared_build_dir) if shared_build_dir is not None else Path(window) / "target"
    candidates = list((build_dir / "debug/build").glob("llama-cpp-sys-2-*/out/build/CMakeCache.txt"))
    s.require(len(candidates) == 1, "exactly one fresh native CMake configuration required")
    cache = candidates[0]
    flags = cache.parent / "ggml/src/CMakeFiles/ggml-cpu.dir/flags.make"
    cache_raw = s.read_path(cache, 2 * 1024 * 1024, budget)
    flags_raw = s.read_path(flags, 2 * 1024 * 1024, budget)
    values = {}
    for line in cache_raw.decode().splitlines():
        if line and not line.startswith(("#", "//")) and "=" in line and ":" in line.split("=", 1)[0]:
            key, value = line.split("=", 1)
            values[key] = value
    required = {"CMAKE_BUILD_TYPE:STRING": "Release", "GGML_AVX:BOOL": "ON",
                "GGML_AVX2:BOOL": "ON", "GGML_FMA:BOOL": "ON", "GGML_F16C:BOOL": "ON",
                "GGML_BMI2:BOOL": "ON", "GGML_SSE42:BOOL": "ON", "GGML_NATIVE:BOOL": "OFF",
                "GGML_AVX512:BOOL": "OFF", "GGML_AVX_VNNI:BOOL": "OFF", "GGML_CPU:BOOL": "ON",
                "GGML_CUDA:BOOL": "OFF", "GGML_BLAS:BOOL": "OFF", "GGML_OPENMP:BOOL": "OFF"}
    s.require(all(values.get(k) == v for k, v in required.items()), "native optimization/backend changed")
    for prefix in ("C_FLAGS =", "CXX_FLAGS ="):
        lines = [line for line in flags_raw.decode().splitlines() if line.startswith(prefix)]
        s.require(len(lines) == 1 and all(flag in lines[0].split() for flag in
                    ("-O3", "-DNDEBUG", "-mavx2", "-mfma", "-mf16c", "-mbmi2", "-msse4.2")),
                  "actual native CPU compiler flags differ")
    return {"cache_path": str(cache), "cache_sha256": hashlib.sha256(cache_raw).hexdigest(),
            "cpu_flags_path": str(flags), "cpu_flags_sha256": hashlib.sha256(flags_raw).hexdigest(),
            "required_settings": required, "shared_ccache_readonly": True,
            "ccache_hit_rate_or_build_fit_claimed": False}


def copy_elf(path, destination, s, budget):
    path, destination = Path(path), Path(destination)
    fd, parent, leaf, info = s.checked_source(path.parent, path.name, budget)
    try:
        # Cargo may link its own selected artifact inside the private target.
        # Independence is required of the verified destination, not this source.
        s.require(info.st_mode & 0o111 and info.st_size <= 4 * s.GIB,
                  "artifact regular executable required")
        s.require(os.read(fd, 4) == b"\x7fELF", "artifact is not ELF")
        os.lseek(fd, 0, os.SEEK_SET)
        measured = s.digest_fd(fd, 4 * s.GIB, budget)
        s.require(s.identity(os.stat(leaf, dir_fd=parent, follow_symlinks=False)) == s.identity(info),
                  "ELF instance changed")
    finally:
        os.close(fd)
        os.close(parent)
    return s.stable_copy(path.parent, path.name, destination.parent, destination.name, budget,
                         4 * s.GIB, expected_sha=measured, expected_size=info.st_size,
                         expected_identity=list(s.identity(info)), executable=True)


class Stage:
    def __init__(self, args, s, budget, policy, pins, proof, inventory):
        self.args, self.s, self.budget = args, s, budget
        self.policy, self.pins, self.proof, self.inventory = policy, pins, proof, inventory
        self.directory, self.owner = None, None
        self.commands, self.unbound = [], []
        self.minimum = available()
        self.failure = None
        self.preserved315 = None

    def hook(self):
        free = available()
        self.minimum = min(self.minimum, free)
        self.s.require(free >= 4 * self.s.GIB, "stop owned work: memory below4GiB")
        info = self.s.proc(self.proof["holder_pid"])
        self.s.require(info is not None and info["start"] == self.proof["holder_start"]
                       and info["state"] != "Z", "external root holder instance no longer alive")

    def admit(self):
        a, s, b = self.args, self.s, self.budget
        s.require(sys.platform == "linux" and os.isatty(0) and os.isatty(1), "same root global PTY required")
        self.window = private(a.window, s, b)
        source = Path(self.pins["source_root"])
        s.require(str(self.window).startswith(self.policy["window_prefix"])
                  and not self.window.is_relative_to(source) and not source.is_relative_to(self.window),
                  "private approved non-source window required")
        lock = self.window / ".stage.lock"
        info, inherited = lock.lstat(), os.fstat(a.lock_fd)
        s.require(stat.S_ISREG(info.st_mode) and not lock.is_symlink() and info.st_nlink == 1
                  and info.st_uid == os.geteuid() and stat.S_IMODE(info.st_mode) == 0o600
                  and (info.st_dev, info.st_ino) == (inherited.st_dev, inherited.st_ino), "wrong private OFD mutex")
        import fcntl
        fcntl.flock(a.lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        s.require(a.cleanup_margin_seconds == self.policy["cleanup_margin_seconds"], "reviewed cleanup margin required")
        s.require(b.remaining() >= self.policy["minimum_work_seconds"][a.stage], "insufficient holder window")
        self.hook()
        s.require(available() >= 8 * s.GIB, "DEFER: fresh memory below8GiB")
        fs = os.statvfs(self.window)
        s.require(fs.f_bavail * fs.f_frsize >= (2 if a.stage == "runtime" else 40) * s.GIB, "workspace space unavailable")
        stages = self.window / "stages"
        if not stages.exists():
            private(stages, s, b, True)
        else:
            private(stages, s, b)
        self.directory = private(stages / a.stage, s, b, True)
        s.require(ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) == 0, "subreaper unavailable")
        self.owner = s.Owned(b)
        if a.stage == "build":
            for name in ("target", "tmp", "results-parent"):
                private(self.window / name, s, b, True)
        self.environment = {
            "PATH": self.policy["toolchain_bin"] + ":/usr/bin:/bin",
            "RUSTC": self.policy["toolchain_bin"] + "/rustc", "RUSTDOC": self.policy["toolchain_bin"] + "/rustdoc",
            "CARGO_HOME": self.policy["split_build"]["cargo_home"], "CARGO_TARGET_DIR": str(self.window / "target"),
            "CARGO_BUILD_BUILD_DIR": self.policy["split_build"]["shared_build_dir"],
            "CARGO_BUILD_JOBS": "2", "CMAKE_BUILD_PARALLEL_LEVEL": "2", "CARGO_NET_OFFLINE": "true",
            "TMPDIR": str(self.window / "tmp"), "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8",
            "PYTHONDONTWRITEBYTECODE": "1", "GIT_OPTIONAL_LOCKS": "0",
            "CCACHE_CONFIGPATH": "/dev/null", "CCACHE_DIR": "/root/.cache/ccache",
            "CCACHE_READONLY": "true", "CCACHE_NOSTATS": "true", "CCACHE_NOHARDLINK": "true",
            "CCACHE_TEMPDIR": str(self.window / "tmp"),
        }
        b.work_hook = self.hook
        s.immutable_json(self.directory / "admission.json", {"schema": 2, "stage": a.stage,
            "head": self.pins["head"], "package_sha256": a.package_sha256,
            "source_pins_sha256": a.source_pins_sha256, "cache_inventory_sha256": a.cache_inventory_sha256,
            "holder_proof_sha256": a.holder_proof_sha256, "external_holder": self.proof,
            "admitted_available_bytes": self.minimum, "hard_end_monotonic": b.hard_end,
            "work_end_monotonic": b.work_end, "cleanup_margin_seconds": a.cleanup_margin_seconds,
            "environment": self.environment}, b)

    def run(self, name, command, cwd=None, extra_env=None, pass_fds=(), heavy=False):
        s, b = self.s, self.budget
        b.check()
        self.hook()
        if heavy:
            s.require(available() >= 8 * s.GIB, "fresh heavy admission below8GiB")
        out_path, err_path = self.directory / (name + ".stdout"), self.directory / (name + ".stderr")
        env = {**self.environment, **(extra_env or {})}
        cpu_mask = "0,2,4" if self.args.stage == "build" and name == "timer-no-run" else "0"
        argv = ["/usr/bin/taskset", "-c", cpu_mask, "/usr/bin/nice", "-n", "19", *map(str, command)]
        record = {"name": name, "command": argv, "environment": env,
                  "cwd": str(cwd or self.pins["source_root"]), "stdout": str(out_path), "stderr": str(err_path)}
        self.commands.append(record)
        child = None
        began = time.monotonic()
        try:
            with out_path.open("xb") as out, err_path.open("xb") as err:
                child = subprocess.Popen(argv, cwd=record["cwd"], env=env, stdin=subprocess.DEVNULL,
                    stdout=out, stderr=err, close_fds=True, pass_fds=pass_fds, start_new_session=True)
                record["root_child_pid"] = child.pid
                info = s.proc(child.pid, b)
                s.require(info is not None, "root child vanished before safe binding")
                record["root_child_start"] = info["start"]
                key = self.owner.bind(child.pid, info)
                s.require(key is not None, "cannot pidfd-bind root child")
                self.owner.roots.append((child, key))
                record["pidfd_bound"] = True
                while True:
                    b.check()
                    self.owner.discover()
                    s.require(out_path.stat().st_size <= self.policy["max_log_bytes"]
                              and err_path.stat().st_size <= self.policy["max_log_bytes"], "log size cap exceeded")
                    if child.poll() is not None:
                        break
                    time.sleep(min(0.1, b.remaining()))
                record["exit"] = child.wait()
                record["root_reaped"] = True
                b.check()
                s.sync(out.fileno(), b)
                s.sync(err.fileno(), b)
                s.require(record["exit"] == 0, name + " failed; no automatic retry")
        finally:
            record["seconds"] = time.monotonic() - began
            if child is not None and not record.get("pidfd_bound"):
                self.unbound.append({"pid": child.pid, "start": record.get("root_child_start"),
                                     "reaped": child.poll() is not None})
            for path in (out_path, err_path):
                if path.exists():
                    path.chmod(0o400)
                    record[path.suffix[1:] + "_sha256"] = s.digest(path, b, self.policy["max_log_bytes"])
        return out_path

    def worker(self, kind, heavy=False):
        parent = self.s.proc(os.getpid(), self.budget)
        cap = {"parent_pid": os.getpid(), "parent_start": parent["start"], "worker": kind,
               "window": str(self.window), "stage": self.args.stage,
               "work_end": self.budget.work_end, "hard_end": self.budget.hard_end,
               "package_sha256": self.args.package_sha256, "source_pins_sha256": self.args.source_pins_sha256,
               "cache_inventory_sha256": self.args.cache_inventory_sha256}
        payload = json.dumps(cap, sort_keys=True).encode()
        self.s.require(len(payload) < 4096, "worker capability too large")
        rd, wr = os.pipe2(os.O_CLOEXEC | os.O_NONBLOCK)
        try:
            self.s.require(os.write(wr, payload) == len(payload), "worker capability write failed")
            os.close(wr)
            wr = None
            command = [sys.executable, "-I", "-B", str(PACKAGE / "native_guard.py"), self.args.stage,
                "--worker", kind, "--worker-cap-fd", str(rd), "--worker-cap-sha256", hashlib.sha256(payload).hexdigest()]
            for name in ("window", "package_sha256", "source_pins", "source_pins_sha256", "cache_inventory",
                         "cache_inventory_sha256", "holder_proof", "holder_proof_sha256", "absolute_expiry_epoch",
                         "cleanup_margin_seconds", "split_certificate", "split_certificate_sha256"):
                command.extend(["--" + name.replace("_", "-"), str(getattr(self.args, name))])
            return self.run(kind + "-worker", command, pass_fds=(rd,), heavy=heavy)
        finally:
            os.close(rd)
            if wr is not None:
                os.close(wr)

    def sources(self, label):
        s, b = self.s, self.budget
        root = Path(self.pins["source_root"])
        head = s.read_path(self.run(label + "-head", ["/usr/bin/git", "rev-parse", "HEAD"]), 4096, b).decode().strip()
        tree = s.read_path(self.run(label + "-tree", ["/usr/bin/git", "rev-parse", "HEAD^{tree}"]), 4096, b).decode().strip()
        status = s.read_path(self.run(label + "-status", ["/usr/bin/git", "status", "--porcelain"]), 1024 * 1024, b)
        s.require(head == self.pins["head"] and tree == self.pins["tree"] and not status, "source checkout differs")
        for name, sha in self.pins["source_sha256"].items():
            s.require(s.digest(root / name, b, 16 * 1024 * 1024) == sha, "compiled source/input hash differs")
        config = root / "src-tauri/.cargo/config.toml"
        s.require(s.digest(config, b, 65536) == self.pins["cargo_configuration_sha256"], "Cargo config differs")
        for directory in [root / "src-tauri", *list((root / "src-tauri").parents)]:
            for name in ("config", "config.toml"):
                path = directory / ".cargo" / name
                s.require(not path.exists() or path == config, "unapproved ancestor Cargo configuration")
        for name in ("config", "config.toml", "credentials", "credentials.toml"):
            s.require(not (Path(self.policy["split_build"]["cargo_home"]) / name).exists(), "unapproved private Cargo home config")

    def previous(self, name):
        path = self.window / "stages" / name / "result.json"
        witness = self.proof["previous_stage"]
        self.s.require(isinstance(witness, dict)
            and set(witness) == {"stage", "actual_exit_code", "result_sha256"}
            and witness.get("stage") == name
            and type(witness.get("actual_exit_code")) is int and witness["actual_exit_code"] == 0
            and isinstance(witness.get("result_sha256"), str)
            and re.fullmatch(r"[0-9a-f]{64}", witness["result_sha256"]),
            "prior outcome lacks matching root-observed successful exit")
        value = self.s.committed_json(path, self.budget, expected_sha=witness.get("result_sha256"))
        self.s.require(value.get("schema") == 3 and value.get("stage") == name
            and value.get("publication") == "exclusive-link-unlink-v1" and value.get("status") == "passed"
            and value.get("head") == self.pins["head"] and value.get("package_sha256") == self.args.package_sha256
            and value.get("source_pins_sha256") == self.args.source_pins_sha256
            and value.get("cache_inventory_sha256") == self.args.cache_inventory_sha256
            and value.get("cleanup", {}).get("cleanup_complete") is True
            and value["cleanup"].get("remaining_live_owned") == []
            and value["cleanup"].get("unreaped_owned") == []
            and value["cleanup"].get("kernel_no_children") is True
            and all(item.get("reaped") is True for item in value["cleanup"].get("root_children", [])),
            "prior receipt is incompatible or cleanup incomplete")
        old = value["external_holder"]
        self.s.require(all(old[key] == self.proof[key] for key in
            ("holder_pid", "holder_start", "absolute_expiry_epoch")), "outer holder/deadline changed")
        return value

    def finish(self, status, error, extra):
        s, b = self.s, self.budget
        b.hard_end = min(b.hard_end, time.monotonic() + self.args.cleanup_margin_seconds)
        b.enter_final()
        b.arm()
        snapshot = {"cleanup_complete": False, "remaining_live_owned": [], "unreaped_owned": [],
                    "root_children": [], "kernel_no_children": False}
        published = False
        try:
            if self.owner is not None:
                self.owner.discover()
                self.owner.signal_all(signal.SIGTERM)
                until = min(time.monotonic() + 1, b.hard_end - 2)
                while time.monotonic() < until:
                    b.check(final=True)
                    self.owner.discover()
                    self.owner.reap()
                    if self.owner.no_children:
                        break
                    time.sleep(0.025)
                self.owner.signal_all(signal.SIGKILL)
                # A late fork/adoption is still our child under subreaper ancestry.
                # Drain until kernel ECHILD, not just emptiness of registered pidfds.
                until = b.hard_end - 2
                while time.monotonic() < until:
                    b.check(final=True)
                    self.owner.discover()
                    self.owner.signal_all(signal.SIGKILL)
                    self.owner.reap()
                    if self.owner.no_children:
                        break
                    time.sleep(0.025)
                snapshot = self.owner.snapshot()
            if self.unbound:
                snapshot["unbound_root_children"] = self.unbound
                snapshot["cleanup_complete"] = False
            if not snapshot["cleanup_complete"]:
                status, error = "failed", "cleanup incomplete; root retains external global lock/HOLD"
            b.check(final=True)
            if self.preserved315 is not None:
                protected_final = snapshot_protected315(self.policy['split_build'], s, b)
                require_protected315_unchanged(self.preserved315, protected_final, s)
                s.immutable_json(self.directory / 'protected315-final.json', protected_final, b)
                extra['protected315_final_sha256'] = s.digest(self.directory / 'protected315-final.json', b)
            result = {"schema": 3, "publication": "exclusive-link-unlink-v1", "status": status, "error": error, "stage": self.args.stage,
                "head": self.pins["head"], "package_sha256": self.args.package_sha256,
                "source_pins_sha256": self.args.source_pins_sha256,
                "cache_inventory_sha256": self.args.cache_inventory_sha256,
                "external_holder": self.proof, "seconds": time.monotonic() - b.started,
                "lowest_available_bytes": self.minimum, "cleanup": snapshot, "commands": self.commands, "extra": extra}
            if self.directory is not None:
                s.immutable_json(self.directory / "result.json", result, b)
                published = True
            print(json.dumps({"status": status, "receipt": str(self.directory / "result.json") if self.directory else None,
                              "cleanup_complete": snapshot["cleanup_complete"]}), flush=True)
        except BaseException as exc:
            status = "failed"
            if self.owner is not None:
                self.owner.signal_all(signal.SIGKILL)
                self.owner.reap()
            print(json.dumps({"status": "failed", "receipt_not_committed": not published,
                              "receipt_committed_but_guard_failed": published,
                              "reason": type(exc).__name__ + ": " + str(exc),
                              "instruction": "root retains external global lock/HOLD; no next stage"}), flush=True)
        finally:
            b.disarm()
            if self.owner is not None:
                self.owner.close()
        return 0 if status == "passed" else 1


def worker_capability(args, s, b, pins, proof, policy):
    s.require(type(args.worker_cap_fd) is int and args.worker_cap_fd >= 3,
              "standalone workers refused: inherited non-stdio capability FD required")
    capability_fd = args.worker_cap_fd
    try:
        s.require(args.worker_cap_sha256, "inherited parent capability hash required")
        info = os.fstat(capability_fd)
        s.require(stat.S_ISFIFO(info.st_mode), "worker capability must be inherited pipe")
        payload = os.read(capability_fd, 4096)
        s.require(len(payload) < 4096 and os.read(capability_fd, 1) == b""
                  and hashlib.sha256(payload).hexdigest() == args.worker_cap_sha256,
                  "worker capability payload differs")
    finally:
        os.close(capability_fd)
    cap = json.loads(payload, object_pairs_hook=s.unique_object)
    s.require(set(cap) == {"parent_pid", "parent_start", "worker", "window", "stage", "work_end", "hard_end",
                          "package_sha256", "source_pins_sha256", "cache_inventory_sha256"},
              "worker capability fields differ")
    for name in ("worker", "window", "stage", "package_sha256", "source_pins_sha256", "cache_inventory_sha256"):
        s.require(cap[name] == getattr(args, name), "worker capability binding differs")
    s.require(cap["parent_pid"] == os.getppid(), "worker parent changed")
    parent = s.proc(os.getppid(), b)
    s.require(parent and parent["start"] == cap["parent_start"], "worker parent instance differs")
    s.require(all(isinstance(cap[key], (float, int)) and math.isfinite(cap[key]) for key in ("work_end", "hard_end")),
              "finite inherited worker deadline required")
    b.hard_end = min(b.hard_end, cap["hard_end"])
    b.work_end = min(b.work_end, cap["work_end"])
    window = private(args.window, s, b)
    source = Path(pins["source_root"])
    s.require(str(window).startswith(policy["window_prefix"]) and not window.is_relative_to(source)
              and not source.is_relative_to(window), "worker window confinement differs")
    def hook():
        current = s.proc(cap["parent_pid"])
        holder = s.proc(proof["holder_pid"])
        s.require(current and current["start"] == cap["parent_start"] and os.getppid() == cap["parent_pid"],
                  "worker parent no longer valid")
        s.require(holder and holder["start"] == str(proof["holder_start"])
                  and holder["state"] not in {"Z", "X"}, "external holder no longer valid")
        s.require(available() >= 4 * s.GIB, "worker stop: memory below4GiB")
    b.work_hook = hook
    b.arm()
    b.check()
    return window


def worker_main(args, s, b, policy, pins, proof, inventory):
    window = worker_capability(args, s, b, pins, proof, policy)
    directory = private(window / "stages" / args.stage, s, b)
    if args.worker == "cache":
        s.require(args.stage == "cache", "cache worker stage differs")
        for name in ("cargo-home", "target", "tmp", "results-parent"):
            private(window / name, s, b, True)
        registry = private(window / "cargo-home/registry", s, b, True)
        records = materialize_public_cache(inventory, policy, registry, s, b)
        # Generated approved public configuration; never copied from the user's Cargo home.
        for namespace in sorted({i["archive_candidate"]["registry_instance"] for i in inventory["packages"]}):
            parent = private(registry / "index" / namespace, s, b)
            s.immutable_json(parent / "config.json", {"dl": policy["public_registry_download"],
                                                      "api": policy["public_registry_api"]}, b)
        s.immutable_json(directory / "cache-files.json", {"schema": 2,
            "inventory_sha256": args.cache_inventory_sha256, "measured_copies": records,
            "dependency_target_copied": False, "extracted_source_copied": False}, b)
    else:
        s.require(args.worker == "bundle" and args.stage == "build", "bundle worker stage differs")
        complete = s.load_json(directory / "completed-builds.json", b)
        s.require(complete.get("source_pins_sha256") == args.source_pins_sha256,
                  "completed build source binding differs")
        metadata = s.load_json(directory / "metadata.stdout", b, 32 * 1024 * 1024)
        own = own_package(metadata, pins, s, b)
        selections = {}
        # Validate BOTH build logs/artifacts before creating any success-only bundle.
        for role in ("helper", "libtest", "harness"):
            record = complete[role]
            s.require(record["stdout"] == str(directory / "timer-no-run.stdout"), "build stdout path differs")
            log = s.read_path(record["stdout"], 64 * 1024 * 1024, b)
            selections[role] = select_artifact(log, own, role, record, window, pins, s, b,
                                               shared_build_dir=policy["split_build"]["shared_build_dir"])
        protected_before = s.load_json(directory / "protected315-before.json", b)
        require_independent315_bundles(protected_before, s)
        raw_identities = reject_protected_artifact_aliases(selections, protected_before, s)
        root_library = select_non_test_root_library(log, own, pins, window, policy["split_build"]["shared_build_dir"], s, b)
        bundle = private(window / "bundle", s, b, True)
        copies = {role: copy_elf(Path(item["path"]), bundle / role, s, b) for role, item in selections.items()}
        s.immutable_json(directory / "artifact-selection.json", {"schema": 2, "package_id": own["id"],
            "source_pins_sha256": args.source_pins_sha256, "artifacts": copies, "actual_cargo_artifacts": selections,
            "non_test_root_library": root_library, "raw_artifact_identities": raw_identities,
            "harness_helper_literal_inspection": inspect_harness_helper_literals(
                Path(copies["harness"]["path"]), str(window / "target/debug/mycarlos-tauri-poc"),
                policy["split_build"]["protected315"][0]["path"], s, b)}, b)
    b.check()
    print(json.dumps({"status": "worker-completed", "worker": args.worker}), flush=True)
    return 0


def exact_test_pass(text, s):
    """Require one actual single-case summary, never zero-selected/ignored success."""
    summaries = re.findall(r"(?m)^test result: [^\r\n]+$", text)
    s.require(len(summaries) == 1 and re.fullmatch(
        r"test result: ok\. 1 passed; 0 failed; 0 ignored; 0 measured; [0-9]+ filtered out; finished in [^\r\n]+",
        summaries[0]) is not None, "exact native case must pass once with zero ignored")


def main_stage(stage):
    a, s, b, policy, pins = stage.args, stage.s, stage.budget, stage.policy, stage.pins
    stage.sources("before")
    if a.stage == "cache":
        stage.worker("cache", heavy=True)
        info = stage.directory / "cache-files.json"
        s.require(s.load_json(info, b)["inventory_sha256"] == a.cache_inventory_sha256,
                  "cache measurement receipt binding differs")
        extra = {"cache_files_sha256": s.digest(info, b, 8 * 1024 * 1024)}
    elif a.stage == "build":
        preserved315 = snapshot_protected315(policy["split_build"], s, b)
        stage.preserved315 = preserved315
        s.immutable_json(stage.directory / "protected315-before.json", preserved315, b)
        adopt_shared_cache(stage)
        cargo = policy["toolchain_bin"] + "/cargo"
        cwd = Path(pins["source_root"]) / "src-tauri"
        rustc = stage.run("rustc-version", [policy["toolchain_bin"] + "/rustc", "--version"], cwd=cwd)
        s.require(s.read_path(rustc, 4096, b).decode().strip() == policy["rustc_version"], "rustc version differs")
        stage.run("cargo-version", [cargo, "--version"], cwd=cwd)
        stage.run("metadata", [cargo, "metadata", "--offline", "--locked", "--no-deps", "--format-version", "1"], cwd=cwd)
        own_package(s.load_json(stage.directory / "metadata.stdout", b), pins, s, b)
        touch_candidate_entries(stage)
        stage.run("timer-no-run", build_command(cargo), cwd=cwd, heavy=True)
        record = stage.commands[-1]
        s.immutable_json(stage.directory / "completed-builds.json", {"schema": 2,
            "source_pins_sha256": a.source_pins_sha256,
            "helper": record, "libtest": record, "harness": record,
            "cargo_cwd": str(cwd), "cargo_configuration_sha256": pins["cargo_configuration_sha256"],
            "build_features": pins["build_features"], "app_opt_level": EXPECTED_APP_OPT_LEVEL}, b)
        native_flags = verify_native_flags(stage.window, s, b, policy["split_build"]["shared_build_dir"])
        s.require(native_flags["cache_sha256"] == policy["split_build"]["native_cmake_cache_sha256"]
                  and native_flags["cpu_flags_sha256"] == policy["split_build"]["native_cpu_flags_sha256"],
                  "shared native build flags changed")
        s.immutable_json(stage.directory / "native-flags.json", native_flags, b)
        stage.worker("bundle", heavy=True)
        selection = s.load_json(stage.directory / "artifact-selection.json", b)
        receipt = stage.directory / "exact-build-receipt.json"
        s.immutable_json(receipt, {"schema": 2, "head": pins["head"],
            "source_pins_sha256": a.source_pins_sha256, "package_sha256": a.package_sha256,
            "builds_sha256": s.digest(stage.directory / "completed-builds.json", b),
            "selection": selection, "commands": stage.commands}, b)
        helper = selection["artifacts"]["helper"]
        manifest = stage.window / "helper-manifest.json"
        original_manifest = {"schema": 1, "source_revision": pins["head"],
            "source_files": [{"path": name, "sha256": sha} for name, sha in sorted(pins["source_sha256"].items())],
            "build_features": pins["build_features"], "helper_path": helper["path"], "helper_sha256": helper["sha256"],
            "build_receipt_path": str(receipt), "build_receipt_sha256": s.digest(receipt, b)}
        # Keep all17 external build bindings, separately from the wrapper's exact12 ABI.
        s.immutable_json(stage.directory / "external-source-manifest17.json", original_manifest, b)
        rust_source = s.read_path(Path(pins["source_root"]) / "src-tauri/src/extraction_acceptance_tests.rs",
                                  1024 * 1024, b).decode()
        projected = extraction_manifest_projection(original_manifest, pins, rust_source, s)
        s.immutable_json(manifest, projected, b)
        s.immutable_json(stage.directory / "manifest-projection.json", {
            "schema": 1, "all17_source_pins_sha256": a.source_pins_sha256,
            "external_source_manifest17_sha256": s.digest(stage.directory / "external-source-manifest17.json", b),
            "exact12_sources": list(EXTRACTION_SOURCE_NAMES),
            "projected_manifest_sha256": s.digest(manifest, b)}, b)
        after315 = snapshot_protected315(policy["split_build"], s, b)
        require_protected315_unchanged(preserved315, after315, s)
        s.immutable_json(stage.directory / "protected315-after.json", after315, b)
        extra = {"artifact_selection": selection, "helper_manifest_sha256": s.digest(manifest, b),
                 "protected315_before_sha256": s.digest(stage.directory / "protected315-before.json", b),
                 "protected315_after_sha256": s.digest(stage.directory / "protected315-after.json", b)}
    else:
        previous = stage.previous("build")
        manifest = stage.window / "helper-manifest.json"
        s.require(s.digest(manifest, b) == previous["extra"]["helper_manifest_sha256"], "helper manifest changed")
        selection = previous["extra"]["artifact_selection"]["artifacts"]
        for role, item in selection.items():
            path = Path(item["path"])
            info = path.lstat()
            s.require(path == stage.window / "bundle" / role and stat.S_ISREG(info.st_mode)
                      and info.st_nlink == 1 and stat.S_IMODE(info.st_mode) == 0o500
                      and s.digest(path, b) == item["sha256"], "copied executable changed")
        output = stage.window / "results-parent/acceptance"
        log = stage.run("actual-wrapper", [selection["libtest"]["path"], TEST, "--exact", "--ignored", "--nocapture", "--test-threads=1"],
            cwd=Path(pins["source_root"]), heavy=True, extra_env={
                "MYCARLOS_EXTRACTION_ACCEPTANCE_MANIFEST": str(manifest),
                "MYCARLOS_EXTRACTION_ACCEPTANCE_OUTPUT": str(output)})
        exact_test_pass(s.read_path(log, 1024 * 1024, b).decode(), s)
        result = s.load_json(output / "acceptance-result.json", b)
        s.require(result.get("source_revision") == pins["head"]
                  and result.get("helper_sha256") == selection["helper"]["sha256"]
                  and result.get("command") == "vault_document_text" and result.get("model_invoked") is False
                  and result.get("hidden_and_locked_refused_before_helper") is True
                  and result.get("old_session_tickets_refused") is True
                  and len(result.get("observations", [])) == 3, "acceptance semantics differ")
        expected_names = {"helper-provenance.json", "acceptance-result.json"}
        for name in ("fake-image-only-scan.pdf", "fake-widget-form.pdf", "fake-flattened-form.pdf"):
            expected_names.update({name, name + ".pages.json"})
        s.require({p.name for p in output.iterdir()} == expected_names, "retained evidence set differs")
        evidence = {}
        for name in sorted(expected_names):
            b.check()
            path = output / name
            info = path.lstat()
            s.require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, "retained evidence must be independent regular file")
            evidence[name] = s.digest(path, b, 16 * 1024 * 1024)
            path.chmod(0o400)
        s.immutable_json(stage.directory / "native-contract-selection.json", {
            "schema": 1, "head": pins["head"], "selectors": CONTRACT_TESTS,
            "count": len(CONTRACT_TESTS), "model_invoked": False}, b)
        contract_results = []
        for index, selector in enumerate(CONTRACT_TESTS, 1):
            name = "native-contract-" + str(index).zfill(2)
            log = stage.run(name, [selection["libtest"]["path"], selector, "--exact",
                "--nocapture", "--test-threads=1"], cwd=Path(pins["source_root"]), heavy=True)
            exact_test_pass(s.read_path(log, 1024 * 1024, b).decode(), s)
            record = stage.commands[-1]
            contract_results.append({"selector": selector, "name": name, "actual_exit_code": record["exit"],
                "stdout_sha256": record["stdout_sha256"], "stderr_sha256": record["stderr_sha256"],
                "passed": 1, "failed": 0, "ignored": 0, "model_invoked": False})
        contract_receipt = stage.directory / "native-contract-results.json"
        s.immutable_json(contract_receipt, {"schema": 1, "head": pins["head"],
            "selectors": contract_results, "count": len(contract_results), "model_invoked": False}, b)
        for item in selection.values():
            s.require(s.digest(item["path"], b) == item["sha256"], "executable changed during runtime")
        extra = {"evidence_sha256": evidence, "model_invoked": False,
                 "native_contract_results_sha256": s.digest(contract_receipt, b),
                 "native_contract_count": len(contract_results), "deferred_ui_case_count": 3,
                 "scope": "extraction characterization and 22 original model-free Rust contract cases; no timer tiny-model or model-quality claim"}
    stage.sources("after")
    return extra


def install_interruption_handlers(budget, support):
    def interrupted(number, frame):
        budget.cancelled = "received signal " + str(number)
        raise support.Refusal(budget.cancelled)
    for number in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(number, interrupted)


def cli():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("stage", choices=("build", "runtime"))
    for name in ("window", "package-sha256", "source-pins", "source-pins-sha256", "cache-inventory",
                 "cache-inventory-sha256", "holder-proof", "holder-proof-sha256",
                 "split-certificate", "split-certificate-sha256"):
        parser.add_argument("--" + name, required=True)
    parser.add_argument("--absolute-expiry-epoch", type=float, required=True)
    parser.add_argument("--cleanup-margin-seconds", type=float, required=True)
    parser.add_argument("--lock-fd", type=int)
    parser.add_argument("--worker", choices=("cache", "bundle"))
    parser.add_argument("--worker-cap-fd", type=int)
    parser.add_argument("--worker-cap-sha256")
    args = parser.parse_args()
    stage, budget = None, None
    try:
        s, budget = bootstrap(args)
        policy, pins, proof, inventory = load_inputs(args, s, budget)
        s.require(args.cache_inventory_sha256 == policy["cache_inventory_sha256"], "inventory not reviewed policy pin")
        install_interruption_handlers(budget, s)
        if args.worker:
            return worker_main(args, s, budget, policy, pins, proof, inventory)
        s.require(args.lock_fd is not None, "inherited private OFD mutex required")
        stage = Stage(args, s, budget, policy, pins, proof, inventory)
        stage.admit()
        extra = main_stage(stage)
        return stage.finish("passed", None, extra)
    except BaseException as exc:
        if stage is not None:
            return stage.finish("failed", type(exc).__name__ + ": " + str(exc), {})
        print(json.dumps({"status": "refused", "reason": type(exc).__name__ + ": " + str(exc),
                          "admitted": False, "instruction": "root retains external global lock/HOLD"}), flush=True)
        return 1
    finally:
        if budget is not None:
            budget.disarm()


if __name__ == "__main__":
    raise SystemExit(cli())
