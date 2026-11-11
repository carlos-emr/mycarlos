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
- `harness/documents/*.json`: the harness documents, each with its pages, its facts and its traps.
  PR 295's 12 EN/FR cases (`../fixtures.json`) are used as they are.
- `harness/HARNESS-FREEZE.json`: the SHA-256 of every harness document. `check` fails when a
  document differs from it.
- `harness/compare.py`: `check` the set, `prepare` a run's input folder, `score` one or more runs,
  `repeat` (token for token), `noise` (an A/A pair).

## Documents and facts
Each document: `id`, `title`, `lang`, `synthetic: true`, `source`, `pages` (`index`, `text`),
`facts`, `traps` (wrong statements to watch for), `trap_checks` and `notes`.

Each fact follows PR 295's fixture schema: `id`, `category`, `required`, `critical`,
`source_evidence` (verbatim from the document), `approved_statements`, `anchors`,
`expected_attributes`, optional `quantity_check`. The harness adds:
- `match`: groups of words. Every group is needed, and any word of a group is enough (case and
  accents folded).
  - Each word must start at a word start, so `iron` is not found in "environment".
  - Words of 3 characters or fewer, and words with a digit, must be whole words: `alt` is not
    "although", `2` is not "12" or "2.5".
  - Longer words are stems: `week` finds "weeks", `prediabet` "prediabetes".
- `evidence_spans` (optional): other verbatim places that state the fact, such as a table row
  beside its comment line.
- `no_qualifier` (optional): why a required fact has a single group. Otherwise every required fact
  has a **qualifier group** that carries its meaning:
  - the direction (high, low), the status (new, stopped, unchanged) or the value;
  - the hedge ("suggests") for a result that only suggests.

  So a sentence that names the fact but says something else is not credited: "Your iron is fine."
  for iron-deficiency anemia, or "Your liver is damaged." for a mildly high ALT to repeat.
- `trap_checks`: one per listed trap, in order. Either a `pattern` (a regular expression on the
  sentence's folded text) with an `example` sentence that must fall into it, or the `screens`
  that already check it (wrong numbers: `NUMBER_NOT_IN_QUOTE`, `QUANTITY_MISMATCH`).

`check` holds every harness fact to this:
- its evidence and spans are in the document;
- every approved statement names every group;
- every required fact has a qualifier or a reason;
- every trap has a check whose example trips it, and no approved statement of the document trips
  it;
- the document matches the freeze.

PR 295's cases are frozen by its own `FIXTURE-FREEZE.json` and checked as they are. Their 26 critical
facts keep their single anchor group, so they rely on the critical rule below: none counts before a
reviewer has accepted a sentence carrying it.

Categories add `instruction`, `timing` and `follow_up`. Those, with PR 295's
`conditional_instruction` and `date_instruction`, are reported together as **patient actions**.

| Group | Documents |
|---|---|
| Demo | `demo-gastro-referral`, `demo-celiac-lab` |
| 5 Nov texts | `fake01-cardiology-referral`, `fake02-cardiac-discharge`, `fake03-cardiac-lab` |
| Bake-off (29 Oct) | 9 `bakeoff-*`: six short (one French) and three longer (one Brazilian Portuguese) |
| New | `new-rheumatology-letter` (instructions and timing at the end), `new-french-nephrology`, `new-polish-discharge`, `new-long-hospital-record` (18 pages, about 26 KB / 6k tokens, instructions on the last page) |
| PR 295 | 12 EN/FR cases, 48 facts: 6 development and 6 holdout |

The facts of the demo, 5 Nov and bake-off documents were written after model summaries of them
existed (`outputs_seen_before_facts` in the freeze). Still to add: an image-only scan and a form
page, run through the app's own text extraction once and kept as their `pages`.

## What a run measures, per document
- **Must-have facts found.** A fact is carried by a sentence that either:
  - equals one of its approved statements, or
  - names every group **and** whose quote lies on one of the fact's evidence spans *in the
    document*: the two places overlap by at least 20 folded characters, or all of the shorter one.

  A quote from another place never counts, even when it shares words with the evidence (a dose
  table's repeated "mg daily changed (was"). A quote that cannot be found in the folded document
  falls back to comparing its text with the spans.
- **Credit.** A fact counts as found (**credited**) only through a carrying sentence that a reviewer
  marked `correct`, or one that is not on the review sheet.
  - **On the sheet:** every flagged sentence, every sentence carrying a critical fact, and a fifth of
    the others, chosen by the sentence itself (a hash), so a sentence two runs share is chosen in both or
    neither.
  - **Held:** every sentence carrying the fact is on the sheet with no verdict yet. Tables show it as
    "+N held".
  - **Rejected:** the review marked every carrying sentence `wrong`, `unsupported` or `vague`.
  - Paraphrases that name no group are not found; the review sheet can show them.
- **Patient actions found:** the same, for the instruction, timing and follow-up facts.
- **Flags for the hand review.** They are never verdicts on their own, but a flag holds the credit
  of the facts its sentence carries:
  - `SOURCE_NOT_FOUND`: the app's own check could not find the quote.
  - `NUMBER_NOT_IN_QUOTE`: a number in the sentence that its quote does not have.
  - `NEGATION_MISMATCH`: a negation or absence word on one side only ("ruled out", "excluded",
    "unremarkable" and "free of" included).
  - `HEDGE_DROPPED`: the quote hedges ("suggests", "probably", "possible"…) and the sentence does
    not: certainty inflation. A purpose ("needed to confirm it") is not a hedge.
  - `CERTAINTY_ADDED`: "confirmed", "definite", "proven"… in the sentence, not the quote. "Diagnosed
    with" counts only against a quote that hedges.
  - `EXPERIENCER`: a family member on one side only. A family doctor is not one.
  - `ACTOR_SHIFT`: the sentence talks to the patient while the quote names a doctor or clinic as the
    one who acts.
  - `ADVICE_OR_JUDGEMENT`: should, must, normal, abnormal, fine, worry… not in the quote.
  - `LANGUAGE`: not the summary language. A standalone "à" is not counted (rule 5): folded, it is
    the Portuguese stopword "a", so French sentences rich in "à" were read as Portuguese.
  - `QUANTITY_MISMATCH`: a value or unit that differs from a fact's own.
  - `TRAP:<n>`: the sentence falls into the document's listed trap `n`.
- **To check** (rule 5): a required fact that no sentence carries, while a sentence that carries no
  fact quotes its source (the quote lies on the fact's evidence or spans), puts that sentence on the
  sheet "to check" with the fact's own wording. A reviewer's `correct` credits the fact in every run
  that wrote the sentence; `wrong`, `unsupported` or `vague` credit nothing (and `wrong` or
  `unsupported` count as a wrong statement, as for any row). Until then the fact is held, not lost.
  This is how a summary in English of a French document is judged: PR 295's French cases have
  French approved wordings only, so "Stop taking ibuprofen." (quoting "Arrêter l'ibuprofène.") was
  never recognized while a copy of the French was. The frozen PR 295 cases are unchanged.
  **For the reviewer:** a "to check" row is `correct` only if the sentence states the listed fact
  (all of them, when several are listed) correctly; otherwise `vague` or `wrong`.
- **The review sheet is blind** (`review/review.csv`).
  - **One row per distinct sentence** (document, words, quote) on the sheet in any run.
  - **Opaque id:** a hash of the sentence, the same in every run and scoring. Rows are in id order, so
    they are shuffled.
  - **Columns:** the document, the sentence, its quote, the page text around the quote, and the
    document's own wording of the facts it may state.
  - **Nothing else:** no run, no flag, no score.
  - **The key** (`key/review-key.csv`, outside `review/`) maps each id to every (run, sentence) it
    stands for. Give the reviewer only `review/`.
  - **Filling:** a reviewer fills `verdict` (`correct`, `wrong`, `unsupported`, `vague`).
    `score --review` applies each verdict to every run that wrote that sentence. A row whose sentence
    does not match its id is refused, and so are two verdicts for one sentence.
  - **A sheet made by hand** with its own ids is read with `--review-key` and must match its key.
  - **Reuse:** `prefill` copies such a sheet's verdicts into the scorer's sheet, by sentence. An
    existing `review/review.csv` is never overwritten; the current sheet is then `review-latest.csv`.
- **Helper memory** (Linux runs):
  - the helper's resident memory once the model has loaded;
  - each document's own peak (reset just before the document), with its anonymous, file and shared
    parts;
  - the memory the computer still had.

  `compare.md` sets the highest peak above the model file against the 1,536 MiB the app allows for
  working memory.
- **Also recorded:**
  - sentences, quotes found, prompt and answer tokens and times;
  - `capped` (stopped at the token cap) and `cut` (the last page did not fit, or only its start did);
  - the time limit and any failures;
  - `answerHash` (token-for-token comparison: greedy decoding repeats exactly on the same build and
    threads).

- **Reading report** (`reading.md`, `reading.json`; reporting only, no score or decision uses it):
  - each required fact of a decision document is labelled per run by the pages its evidence is on:
    `read` (the model read such a page whole), `partly read` (only the page it read in part) or
    `not read`, from the answer's `lastPage`, `lastPageCut` and `tailPage`;
  - per run: credited / held / lost in each group, and credited of read. A fact lost on a read
    page was left out by the model; one lost on a page not read was never seen. So a variant that
    reads pages 1-15 and 18 of the 18-page record is not charged with "missing" what it never read;
  - `scores.json`, `compare.md` and the review sheet are byte for byte the same with and without it
    (a test).

## What decides a score is pinned
`scores.json` (`scoring`) and the first line of `compare.md` name, by SHA-256:
- `compare.py` itself;
- every document as scored (facts, traps and pages, PR 295's cases included);
- the rule's fixed numbers and margins.

`HARNESS-FREEZE.json` pins the 18 harness document files, `compare.py`'s SHA-256, the rule version,
and the hash of every document as scored.
- `check` fails when any of them differs.
- `score` marks a decision `UNFROZEN`, never PASS, when the scorer, the rule or the documents differ
  from the freeze, and says so in `compare.md` and `scores.json` (`frozen`).
- A change needs a new freeze version and a reason, and runs scored before and after it are not
  compared.

## The decision rule
**Version 1** was written on 10 Nov, before any run.

**Version 2** was written on 11 Nov, after the review of version 1 and before any 10–11 Nov run was
scored. It does three things:
- turns check 3 into "not worse" by default;
- adds margins from an A/A pair;
- keeps PR 295's holdout cases out of the decision.

**Review coverage, 11 Nov (after B0 and E1 had been scored and reviewed):** every distinct
sentence now goes on the review sheet (`REVIEW_SAMPLE` 1.0, was 0.2), for every run alike. The 20%
sample let an invented appointment through by chance in round 2 (it reached the sheet only because
it was sampled), so more like it could hide in any run, B0 included. This changes review coverage
only: the credit and the decision rule are as in version 5, and a set where every sentence has a
verdict gets the same decisions at either sample (a test). Tests that are about a partial sample
pin it to 0.2.

**Rows that list several facts, 11 Nov (after round 2):** a `correct` row whose `fact_it_may_state`
lists several facts must name in its note the ones it states (`states: 1, 3` or `states: all`).
Only those are credited; for the others the sentence counts as `vague` (a fact whose every carrier
is turned down is "rejected", i.e. lost). Such a row without a `states:` note is not reviewed yet.
`prefill` carries the note over by the facts' wording. Rows listing one fact, and the decision rule,
are unchanged. Made after B0 and E1 had been scored: 5 of round 2's 6 several-fact rows were
`correct` with no such note.

**Version 5** was written on 11 Nov **after model outputs had been seen**:
- B0's outputs were read in full (the rescore and Agent 4's blind review of its 94 rows);
- E1's outputs were read by Agent 1, who reported the ibuprofen pair above;
- B0R (5 documents) and the running E4 existed but were not read for this change.

It adds the "to check" rows and the LANGUAGE fix. It never removes a credit: carriers and their
standing are as in version 4; a fact that version 4 lost can only become held, and credited after a
`correct` verdict. LANGUAGE flags change only in which language they name for a sentence in another
language than the run's, except that French sentences in a French run are no longer flagged as
Portuguese. Use it for every run of 10-11 Nov (B0, B0R, E1, E4, L1, L2 and later), all alike.

**Version 4** was written on 11 Nov, after a third review and before any variant was scored:
- one verdict per distinct sentence, from a blind sheet;
- a sampled sentence also waits for its verdict, so no FAIL rests on an unreviewed row;
- three screens and two traps over-flagged less.

**Version 3** was written on 11 Nov, after a second review and still before any 10–11 Nov run was
scored. It does five things:
- a critical fact counts only once a reviewer has accepted a sentence carrying it;
- check 1 waits for those reviews;
- the gain in check 3 is required per variant;
- margins come only from a noise pair;
- the freeze is enforced.

To reproduce version 1, use `compare.py` as of 8fbc23e5.

The first run given to `score` is the baseline. Only documents in the decision count; PR 295's
6 holdout cases are scored and reported on their own line, never decided on. A variant **passes**
only if all of these hold:
1. **No wrong statement.** No sentence was reviewed `wrong` or `unsupported`, and every sentence on
   the review sheet (flagged, carrying a critical fact, or sampled) has a verdict.
2. **Must-haves kept.** At most `margin_lost` required facts that the baseline had (credited or
   held) are lost.
3. **Patient actions not worse.** Patient actions found are at least the baseline's −
   `margin_actions`.
   - For a variant named with `--require-gain-for LABEL` (an experiment aimed at them), they must be
     more than the baseline + `margin_actions`.
   - Other variants in the same call are held to "not worse". So a speed, fit or model-swap variant
     can pass.
4. **Quotes.** Quotes found are within 2 points of the baseline.
5. **Time.** The median time is at most 30% above the baseline, and no document fails that the
   baseline answered.

Held facts are counted both ways: as found and as not found.
- A check that passes either way holds; one that fails either way fails.
- One that depends on them is `PENDING` until the review.
- A variant with no review is `PENDING` at best.

Ties go to the smaller change.

### Margins and the noise floor
Greedy decoding repeats exactly, so two runs of one build and thread count (B0 and B0R) answer
token for token. `repeat` checks that, and such a pair measures only run-to-run noise: zero facts
should flip. It cannot tell how far answers move when anything at all changes, because any change
to the prompt, caps or fit reshuffles every answer.

That chance movement is measured by an **A/A′ pair**: the baseline and the baseline with a change
meant to make no difference (a blank line in the system text, say), over the same documents.

- `compare.py noise --run A.jsonl --run A2.jsonl` counts the required facts, and the patient-action
  facts, that one run's answers carry and the other's do not (before any review).
- Those counts are the margins: `score --noise A.jsonl --noise A2.jsonl` sets `margin_lost` and
  `margin_actions` from them, and `compare.md` says so. There is no other way to set a margin.
- Without an A/A′ pair, both margins are 0 (the B0/B0R floor).

A one-fact difference then decides nothing it should not. Write the margins in the pull request
before scoring a variant.

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

# 3. Score and compare (baseline first). Margins from an A/A' pair, or 0.
python3 scripts/summary-evaluation/harness/compare.py score \
  --run B0.jsonl --run E1.jsonl --run E4.jsonl --out /path/to/compare \
  [--require-gain-for E1] [--noise B0.jsonl --noise B0p.jsonl] [--review filled.csv]
# A hand-made sheet with its own ids: copy its verdicts into the scorer's sheet first.
python3 scripts/summary-evaluation/harness/compare.py prefill --sheet /path/to/compare/review/review.csv \
  --from hand.csv --key hand-key.csv --run B0.jsonl --out /path/to/compare/review/prefilled.csv
```
A stopped run resumes where it stopped (same build, model, language and threads). Keep runs, review
sheets and tables outside the repository; summarize them in the pull request.

Only English summaries are run today (`MYCARLOS_TEST_LANG=en`). A run in another language needs
that language's words in the `match` groups first.

## Tests
```sh
python3 -m unittest discover -s scripts/summary-evaluation/harness/tests -v
```
They score hand-made run files and the repository's FAKE documents: no model, no network.
