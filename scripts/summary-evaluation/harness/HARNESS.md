# Real-model evaluation of the AI summary

A repeatable way to tell whether a change makes the AI summary better or worse: the same FAKE
documents, summarized by the real model through the app's own helper, scored the same way, and
compared with a baseline under a rule written down before the run.

Nothing here runs in CI and nothing here runs a model on its own. Every document is synthetic.

## Pieces
- `src-tauri/tests/model_engine.rs` → `a_real_model_evaluation_run` (ignored): starts the real
  myCarlos executable as the sandboxed model helper, exactly as the app does (the model handed over
  sealed, the production prompt, grammar, caps and time limit, greedy decoding), and writes one JSON
  line per document. Its first line names the build: a fingerprint of the system text, summary
  request, grammar and caps, and the model file's SHA-256 as it was handed over.
- `harness/documents/*.json`: the harness documents, each with its pages and its facts. PR 295's
  12 EN/FR cases (`../fixtures.json`) are used as they are.
- `harness/compare.py`: `check` the set, `prepare` a run's input folder, `score` one or more runs.

## Documents and facts
Each document: `id`, `title`, `lang`, `synthetic: true`, `source`, `pages` (`index`, `text`),
`facts`, `traps` (wrong statements to watch for, shown to the reviewer) and `notes`.

Each fact follows PR 295's fixture schema: `id`, `category`, `required`, `critical`,
`source_evidence` (verbatim from the document), `approved_statements`, `anchors`,
`expected_attributes`, optional `quantity_check`. It adds `match`: groups of words, every group
needed, any word of a group enough (case and accents folded), so a fact can be recognized in any
summary language. Categories add `instruction`, `timing` and `follow_up`. Those, with PR 295's
`conditional_instruction` and `date_instruction`, are reported together as **patient actions**.

| Group | Documents |
|---|---|
| Demo | `demo-gastro-referral`, `demo-celiac-lab` |
| 5 Nov texts | `fake01-cardiology-referral`, `fake02-cardiac-discharge`, `fake03-cardiac-lab` |
| Bake-off (29 Oct) | 9 `bakeoff-*`: six short (one French) and three longer (one Brazilian Portuguese) |
| New | `new-rheumatology-letter` (instructions and timing at the end), `new-french-nephrology`, `new-polish-discharge`, `new-long-hospital-record` (18 pages, about 26 KB / 6k tokens, instructions on the last page) |
| PR 295 | 12 EN/FR cases, 48 facts |

Still to add: an image-only scan and a form page, run through the app's own text extraction once
and kept as their `pages`.

## What a run measures, per document
- **Must-have facts found:** approved wording needs a located quote that occurs in the current
  document and contains the fact's source evidence (ignoring a trailing sentence terminator).
  Matching topic words alone produces a **candidate**, not verified credit. The reviewer must
  explicitly confirm which candidate facts are carried; polarity, direction, frequency and other
  qualifiers are human judgments. A candidate never silently raises a verified action count.
  Unit-case distinctions such as `mg` versus `Mg` are preserved by quantity diagnostics.
- **Patient actions found:** the same, for the instruction, timing and follow-up facts.
- **Flags for the hand review** (never verdicts on their own):
  - `SOURCE_NOT_FOUND`: the app's own check could not find the quote;
  - `NUMBER_NOT_IN_QUOTE`: a number in the sentence that its quote does not have;
  - `NEGATION_MISMATCH`: a negation or absence word on one side only;
  - `ACTOR_SHIFT`: the sentence talks to the patient while the quote names a doctor or clinic as
    the one who acts;
  - `ADVICE_OR_JUDGEMENT`: should, must, normal, abnormal, worry… not in the quote;
  - `LANGUAGE`: not the summary language;
  - `QUANTITY_MISMATCH`: a value or unit that differs from a fact's own.
- **The review sheet** (`review.csv`) has every flagged sentence and a seeded fifth of the others,
  each with its quote, candidate facts and the document's traps. All unfamiliar fact candidates
  are included, even if no other screen flags them. A reviewer fills `verdict` (`correct`, `wrong`,
  `unsupported`, `vague`) for sentence fidelity, and `confirmed_facts` with the space-separated
  listed fact IDs actually carried, or `-` for none. Blank fact confirmation on a correct candidate
  remains pending. Sentence correctness alone does not assert every candidate fact.
  Each row has a content-bound `review_id`: edited/stale/unknown or duplicate identities are refused.
  Every currently required row must be present with a verdict before PASS; missing/header-only,
  blank or partial sheets do not count as completed review. One `wrong` or `unsupported` still fails
  a variant even if other rows remain pending. Completed review files are preserved; changed runs
  receive a new `review-<identity>.csv`, named in `scores.json` and `compare.md`.
- **Helper memory** (Linux runs): the helper's resident memory once the model has loaded, and each
  document's own peak (reset just before the document), with its anonymous, file and shared parts
  and the memory the computer still had. `compare.md` sets the highest peak above the model file
  against the 1,536 MiB the app allows for working memory.
- Sentences, quotes found, prompt and answer tokens and times, `capped` (stopped at the token cap),
  `cut` (the last page did not fit, or only its start did), time limit, failures, and `answerHash`
  (token-for-token comparison: greedy decoding repeats exactly on the same build and threads).

## The decision rule (written before any run)
The first run given to `score` is the baseline. It must cover the selected input set; use the
same explicit `score --only <id>` subset when a smaller comparison is intended. Current input page
hashes are checked using the Rust writer's byte format: little-endian u32 index, little-endian
u64 UTF-8 byte length, then exact UTF-8 text per page. Missing/malformed answers to a document the
baseline answered count as new failures. A variant **passes** only if all of these hold:
1. no reviewed wrong or unsupported statement;
2. no required fact that the baseline found is lost, on any document;
3. patient actions found on more facts than the baseline;
4. quotes found within 2 points of the baseline;
5. median time at most 30% above the baseline, and no document fails that the baseline answered.

Until the review sheet is filled in, a variant that clears 2–5 is `PENDING`. Ties go to the
smaller change.

## Running it (on a computer with ≥ 8 GiB free, one model run at a time)
```sh
# 1. The input folder (all documents, or --only <id> ...)
python3 scripts/summary-evaluation/harness/compare.py prepare --out /path/to/run-docs

# 2. One run per variant: build the variant's commit, then
cd src-tauri
MYCARLOS_TEST_MODEL=/path/to/Qwen_Qwen3.5-4B-Q4_K_M.gguf \
MYCARLOS_EVAL_EXPECT_SHA256=13c16f426047e2de38cd075bdade4a7bcbc8c774384876f677740cda65f8a983 \
MYCARLOS_EVAL_DOCS=/path/to/run-docs MYCARLOS_EVAL_OUT=/path/to/B0.jsonl \
MYCARLOS_EVAL_VARIANT=B0 MYCARLOS_EVAL_COMMIT="$(git rev-parse HEAD)" \
MYCARLOS_TEST_LANG=en MYCARLOS_TEST_THREADS=3 \
cargo test --offline --locked --features ai-helper-stub --test model_engine -- \
  --ignored --nocapture a_real_model_evaluation_run

# 3. Score and compare (baseline first)
python3 scripts/summary-evaluation/harness/compare.py score \
  --run B0.jsonl --run E1.jsonl --out /path/to/compare-B0-E1 [--review filled.csv]
```
A stopped run resumes only with the same actual helper and harness executable SHA-256 hashes,
recorded commit and variant, build, model SHA/chat format, language, explicit positive thread count,
and complete ID/language/page-hash manifest. `MYCARLOS_EVAL_VARIANT`, `MYCARLOS_EVAL_COMMIT` and
`MYCARLOS_TEST_THREADS` are required. No header or document is appended until validation succeeds.
The first actual failure is synced and ends the run immediately, so a dead helper cannot poison
unattempted documents with `NotRunning`. An explicit later run may attempt the remaining IDs;
the original failure remains in the output and still counts against the written comparison rule.
A completed output is not appended to, and terminal `answered` counts all recorded attempts.
An empty output is a new run. A malformed/partial final write or a final line without a newline
is refused with a recovery message; it is never truncated silently. Preserve the original file,
recover a separate copy only after verifying the last fully synced record, and document the
recovery before reuse. Older outputs lacking the new identity fields cannot be resumed with this
writer; do not fabricate missing metadata or rewrite historical evidence.

`repeat` checks chat configuration and recorded implementation identity, recomputes page hashes,
checks sentence data as well as token hashes, and reports mismatched/incomplete coverage as
not comparable. By default both runs must cover the full selected set. Use the same explicit
`repeat --only <id>` subset to compare an intentional shared subset; the reported `compared`
count is that subset, never an implicit intersection presented as a full repeat.
Keep runs, review sheets and tables outside the repository; summarize them in the pull request.
These changes concern this PR's harness only, not the separate frozen v9.1 live evaluation scorer.
No frozen fixtures, live evaluation branches, held-out sets, model prompts or decision thresholds
are changed by this follow-up. Scan/form inputs and actual-model validation of this fixed head
remain separate owner items; this documentation does not waive them.

## Tests
```sh
python3 -m unittest discover -s scripts/summary-evaluation/harness/tests -v
```
They score hand-made run files: no model, no network.

## Resume/failure evidence tests
`src-tauri/tests/model_engine_support/evidence.rs` has model-free tests for identity refusal,
Unicode input hashes, empty/partial files, terminal completion, and a stub timeout followed by
explicit continuation of only the unattempted IDs. These are distinct from running the real-model
ignored test. A standalone check using compatible cached serde_json/sha2 libraries validates this
support module; it does not substitute for the full native integration build or a real-model run.

All documents are marked synthetic in metadata. The 18 harness documents also contain textual
markers; the 12 unchanged PR 295 page texts do not all say synthetic. PR 295 is already closed.
No source fixtures are rewritten to change that distinction.
