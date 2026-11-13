"""Prompt0929 raw actual-evidence interfaces. Definitions only; no model authority.

These payloads are raw coordinator exports, NOT exact-carry-run-evidence-v1.
A separately admitted exporter plus independent ROOT verification creates adapters.
"""
import hashlib
import json
from pathlib import Path
import struct

HEAD = '0929f4ac398bfb027021379a9dff448eb2814c21'
TREE = 'f63dd22faae241e3836b4fed6069e8421066567e'
SCORER_SHA256 = 'bc3b898f3869465d15344b93bb566aa1267d250d4c8d16d08d7e8de9f04798fc'
EXPECTED_BUILD_FINGERPRINT = '499b10b8949a54c976eea63418ccde4c0c856962bd7698100fe40294a06656f4'
EXPECTED_BUILD_DESCRIPTOR_SHA256 = '3e9b165b612f7a4b8017fb3d23674ca620c85da71f96e6501bf5e7ed96bde316'
COUNTS = {'H10': 10, 'M8': 8}
COMPLETION_SCHEMA = 'candidate0929-actual-completion-v1'
GUARD_SCHEMA = 'candidate0929-phase-guard-v1'
SOURCE_EXPORT_SCHEMA = 'candidate0929-source-exports-v1'
SCORER_INVOCATION_SCHEMA = 'candidate0929-neutral-invocation-v2'
ROOT_VERIFICATION_SCHEMA = 'candidate0929-root-phase-verification-v1'


def require(ok, reason):
    if not ok:
        raise ValueError(reason)


def canonical_bytes(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True,
                      separators=(',', ':'), allow_nan=False).encode('utf-8')


def canonical_sha256(value):
    return hashlib.sha256(canonical_bytes(value)).hexdigest()


def pages_preimage(document):
    """Exact full Rust harness input preimage, with no text normalization."""
    pages = document['pages']
    require(isinstance(pages, list) and pages, 'nonempty input pages required')
    out, previous = bytearray(), -1
    for page in pages:
        index, text = page['index'], page['text']
        require(type(index) is int and previous < index < 2**32 and isinstance(text, str),
                'strictly increasing u32 page index and exact UTF8 text required')
        data = text.encode('utf-8')
        out.extend(struct.pack('<IQ', index, len(data)))
        out.extend(data)
        previous = index
    return bytes(out)


def documents_manifest(documents):
    result = {}
    for document in documents:
        identifier, language = document['id'], document['lang']
        require(isinstance(identifier, str) and identifier and identifier not in result,
                'unique nonempty document ID required')
        require(isinstance(language, str), 'document language required')
        result[identifier] = {'pagesSha256': hashlib.sha256(pages_preimage(document)).hexdigest(),
                              'docLang': language}
    require(result, 'empty document manifest')
    return result


def reference(path, sha256):
    path = Path(path)
    require(path.is_absolute() and isinstance(sha256, str) and len(sha256) == 64
            and all(c in '0123456789abcdef' for c in sha256), 'exact canonical artifact reference required')
    return {'path': str(path), 'sha256': sha256}


def completion_payload(*, stage, label, run, guard_ref, terminal, guard_terminal,
                       guard, observed_guard_exit, header, runtime_approval,
                       approved_roster, source_inventory, source_exports,
                       coordinator_source_sha256, attempt, observed_at):
    """Called by actual parent AFTER test+guardian exit and verified cleanup.

    The caller independently reads/hashes run/guard/terminal and crosses the
    approved roster/runtime against the raw header before invoking this factory.
    ROOT must still independently verify this export before an A2 carry adapter.
    """
    require(stage in COUNTS and label.startswith('M2prompt0929-') and label.endswith(stage), 'exact stage/label')
    require(guard['schema'] == GUARD_SCHEMA and guard.get('candidate_head') == HEAD
            and guard['stage'] == stage and guard['candidate_label'] == label,
            'raw phase guardian identity mismatch')
    require(type(observed_guard_exit) is int and observed_guard_exit == 0 and
            type(guard['actual_exit_code']) is int and guard['actual_exit_code'] == 0,
            'observed actual test and guardian exits must both be0')
    require(guard['cleanup']['kernel_no_children'] is True and guard['cleanup']['cleanup_complete'] is True
            and guard['cleanup'].get('remaining_live_owned') == []
            and guard['cleanup'].get('unreaped_owned') == []
            and not guard['cleanup'].get('unbound_root_children')
            and isinstance(guard['cleanup'].get('root_children'), list)
            and guard['cleanup']['root_children']
            and all(child.get('reaped') is True and child.get('pidfd_bound') is True
                    and type(child.get('exit')) is int and child['exit'] == 0
                    for child in guard['cleanup']['root_children'])
            and guard['no_unbound_children'] is True, 'actual owned cleanup incomplete')
    require(header.get('kind') == 'run' and header['commit'] == HEAD
            and header['variant'] == label and header['lang'] == 'en'
            and type(header['threads']) is int and header['threads'] == 3
            and isinstance(header['documents'], dict) and len(header['documents']) == COUNTS[stage],
            'raw run header identity')
    return {'schema': COMPLETION_SCHEMA, 'status': 'actual-complete-pending-independent-root-verification',
        'candidate_head': HEAD, 'candidate_tree': TREE, 'stage': stage, 'candidate_label': label,
        'attempt': attempt, 'run': run, 'guard': guard_ref, 'terminal': terminal, 'guard_terminal': guard_terminal,
        'actual_exit_code': guard['actual_exit_code'], 'guard_exit_code': observed_guard_exit,
        'kernel_no_children': True, 'no_unbound_children': True,
        'header_sha256': canonical_sha256(header), 'helper_sha256': header['runnerSha256'],
        'harness_sha256': header['harnessSha256'], 'model_sha256': header['model']['sha256'],
        'documents_manifest_sha256': canonical_sha256(header['documents']),
        'runtime_approval': runtime_approval, 'approved_roster': approved_roster,
        'source_inventory': source_inventory, 'source_exports': source_exports,
        'coordinator_source_sha256': coordinator_source_sha256, 'observed_at': observed_at,
        'independent_root_verification_required': True,
        'not_a_grade_carry_adapter_or_next_stage_grant': True}


def neutral_invocation_payload(*, stage, label, argv, actual_exit_code, scorer_source,
                               direct_run, baselines, scoring_inputs, thresholds_identity,
                               approved_scoring_runs,
                               neutral_sheet, stdout, stderr, observed_at,
                               seed_current_review=None, seed_provenance=None):
    """Parent's actual frozen-scorer invocation witness, not a blank adapter."""
    require(stage in COUNTS and scorer_source['sha256'] == SCORER_SHA256, 'frozen scorer/stage required')
    require(type(actual_exit_code) is int and actual_exit_code == 0, 'actual scorer exit0 required')
    review_positions = [i for i, arg in enumerate(argv) if arg == '--review' or arg.startswith('--review=')]
    if seed_current_review is None:
        require(not review_positions and seed_provenance is None, 'initial neutral pass forbids review preload')
    else:
        require(len(review_positions) == 1 and argv[review_positions[0]] == '--review' and
                review_positions[0] + 1 < len(argv) and
                argv[review_positions[0] + 1] == seed_current_review['path'] and seed_provenance is not None,
                'only an explicit current-candidate seed is allowed for later T/P generation')
    require(isinstance(approved_scoring_runs, list) and len(approved_scoring_runs) >= 2,
            'independent ordered label/exact-artifact scoring catalog required')
    require(isinstance(baselines, list) and baselines, 'explicit ordered frozen baselines required')
    expected_refs = baselines + [direct_run]
    labels = set()
    for item in approved_scoring_runs:
        require(isinstance(item, dict) and set(item) <=
                {'label', 'run', 'expected_document_ids', 'legacy_pages_not_recorded'}
                and {'label', 'run'} <= set(item)
                and isinstance(item['label'], str) and item['label'] and item['label'] not in labels,
                'unique actual catalog labels and explicit exact run refs required')
        labels.add(item['label'])
        require(reference(item['run']['path'], item['run']['sha256']) == item['run'],
                'catalog exact canonical artifact ref required')
    require(len(approved_scoring_runs) == len(expected_refs)
            and [item['run'] for item in approved_scoring_runs] == expected_refs
            and approved_scoring_runs[-1]['label'] == label,
            'approved catalog must preserve baseline order and actual candidate ref/label')
    run_arguments = []
    for position, word in enumerate(argv):
        if word == '--run':
            require(position + 1 < len(argv), 'missing actual --run path')
            run_arguments.append(argv[position + 1])
        elif word.startswith('--run='):
            run_arguments.append(word[len('--run='):])
    # Immutable bc3b compare.py passes these values directly to Path(path).
    # Labels belong in the independent catalog/header, never in --run filenames.
    require(run_arguments == [item['run']['path'] for item in approved_scoring_runs],
            'actual bare --run paths must exactly match independent catalog order')
    return {'schema': SCORER_INVOCATION_SCHEMA, 'stage': stage, 'candidate_head': HEAD,
        'candidate_label': label, 'actual_argv': list(argv), 'actual_exit_code': actual_exit_code,
        'prior_review_supplied': False, 'seed_current_review': seed_current_review,
        'seed_provenance': seed_provenance, 'only_current_candidate_seed_allowed': True,
        'scorer_source': scorer_source, 'direct_run': direct_run,
        'approved_scoring_runs': list(approved_scoring_runs),
        'frozen_baseline_runs': list(baselines), 'frozen_scoring_inputs': list(scoring_inputs),
        'thresholds_identity': thresholds_identity, 'neutral_sheet': neutral_sheet,
        'stdout': stdout, 'stderr': stderr, 'observed_at': observed_at,
        'root_verification_and_context_export_required': True}
