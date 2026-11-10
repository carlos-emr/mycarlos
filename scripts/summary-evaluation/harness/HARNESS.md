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
- **Must-have facts found:** a sentence equal to an approved statement, or one that names the fact
  (`match`) **and** whose quote covers the fact's source evidence. Anything else is "not found" and
  can be looked at in the review sheet: a paraphrase may hide a fact.
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
  each with its quote, the facts it carries and the document's traps. A reviewer fills `verdict`
  (`correct`, `wrong`, `unsupported`, `vague`). One `wrong` or `unsupported` fails a variant.
- Sentences, quotes found, prompt and answer tokens and times, `capped` (stopped at the token cap),
  `cut` (the last page did not fit, or only its start did), time limit, failures, and `answerHash`
  (token-for-token comparison: greedy decoding repeats exactly on the same build and threads).

## The decision rule (written before any run)
The first run given to `score` is the baseline. A variant **passes** only if all of these hold:
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
A stopped run resumes where it stopped (same build, model, language and threads). Keep runs, review
sheets and tables outside the repository; summarize them in the pull request.

## Tests
```sh
python3 -m unittest discover -s scripts/summary-evaluation/harness/tests -v
```
They score hand-made run files: no model, no network.
