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
`facts`, `traps` (wrong statements to watch for), `trap_checks`, `notes`, and (rule 6, DRAFT) an optional
`patient_contacts`: the phone numbers, e-mail addresses and street addresses the document gives the
patient to use ("call the lab at 613-555-0150"), copied from it. A sentence may repeat those; the
`CONTACT_DETAILS` screen flags any other contact detail.

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
- every `patient_contacts` entry is in the document and names a contact detail, and no approved
  statement repeats a contact detail that is not one of them;
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
| Contacts (draft, rule 6) | `contact01-leg-discharge` (a daughter's phone and e-mail, a health card and home address; the ward's number is given to the patient), `contact02-thyroid-letter-fr` (a pharmacy's address and phone, a daughter's phone, RAMQ and file numbers; an e-mail and the clinic's number are given to the patient), `contact03-referral-booking` (a referral number, the patient's own phone on file, the family doctor's phone; the clinic's address and number are given to the patient) |
| Multi-page (draft) | Written by `tools/long_documents.py` (fixed seeds), 800-1,150 tokens a page like the one-page letters: `long01-pneumonia-record` (12 pages; the patient's instructions on page 9 only, and pages 1-8 are longer than the summary's room, so neither the start nor the start plus the last page reads them: the honest failure case); `long02-surgery-blank-last-page` (10 pages; the follow-up on page 9, page 10 a blank scanned back page); `long03-heart-failure-54p` (54 pages, over the 50-page text-read cap; the discharge instructions on page 54, never read); `long04-neurology-consult-3p` (fits whole: the control); `long05-lab-series-6p` (the same header, with a health number, and the same footer, "call the clinic at 613-555-0156", on every page); `long06-lettre-cardio-2p-fr` (two-page French letter, for the language variants). Each has a `reading_note`. |
| PR 295 | 12 EN/FR cases, 48 facts: 6 development and 6 holdout |

The facts of the demo, 5 Nov and bake-off documents were written after model summaries of them
existed (`outputs_seen_before_facts` in the freeze). The contact and multi-page documents were written
on 11 Nov with their facts, before any model read them ("no").

`prepare` sends at most the first 50 pages of a document (`TEXT_READ_PAGES`): the app reads no more
(`MAX_TEXT_PAGES`) and the helper refuses more. A document's facts may lie past them, as in
`long03-heart-failure-54p`; no variant can carry those, and the run is marked `cut`. Still to add: an image-only scan and a form
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
  - `LANGUAGE`: not the summary language.
  - `QUANTITY_MISMATCH`: a value or unit that differs from a fact's own.
  - `TRAP:<n>`: the sentence falls into the document's listed trap `n`.
  - `CONTACT_DETAILS:<kinds>` (rule 6, DRAFT): the sentence repeats a phone number, an e-mail address, a
    street address or postal code, or an identity number (a health card, RAMQ, PESEL, record, chart,
    visit, referral or requisition number, or any run of 8 or more digits that is not a date) that
    is not in the document's `patient_contacts`. Kinds: `phone`, `email`, `address`, `identity`.
    The count per run is in `compare.md` (`contacts`). Not flagged: dates, lab values, doses, "911",
    "ST depression", TNM stages, and a health card named without its number.
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

## What decides a score is pinned
`scores.json` (`scoring`) and the first line of `compare.md` name, by SHA-256:
- `compare.py` itself;
- every document as scored (facts, traps and pages, PR 295's cases included);
- the rule's fixed numbers and margins.

`HARNESS-FREEZE.json` pins the harness document files, `compare.py`'s SHA-256, the rule version,
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

**Version 6 (DRAFT for the next freeze; not used for the 10–11 Nov runs, which are scored with
version 5 of the rescore line, 43bc7612 on agent2/rescore-v5-20261111; numbered 6 so the two
cannot be confused, and to be merged with version 5 before it is frozen)** adds the `CONTACT_DETAILS` screen, the documents' `patient_contacts`, and
three FAKE contact cases. A flagged sentence goes on the review sheet like any other, so a fact it
carries is held until reviewed; the screen changes no verdict by itself. It was written on 11 Nov to
make the contact rule of prompt variant L2 measurable: version 4 sees a repeated contact detail only
by eye, and B0 repeated two (a spouse's phone in `bakeoff-quebec-referral`, a PESEL in
`new-polish-discharge`), both flagged by this screen with no other B0 sentence flagged.

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
