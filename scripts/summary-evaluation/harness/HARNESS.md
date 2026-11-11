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
`facts`, `traps` (wrong statements to watch for), `trap_checks`, `notes`, and (rule 7, DRAFT) an optional
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
- `trap_checks`: one per listed trap, in order. A check with a `pending` reason (rule 6) stands for a
  question not decided yet (contact02's pharmacy phone: Ben's open question 2): it is checked like
  the others but never flags or counts, until the question is answered. Either a `pattern` (a regular expression on the
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

**Joined facts split (draft 7, 11 Nov, after round 2b's review; Agent 4):** a fact that joined two
claims gave "vague" to a sentence stating one of them, and nothing to a variant that wrote them as two
sentences. Each is now two facts (`split_from` names the old one), with the old fact's category and
`required`: `bakeoff-long-discharge-summary` salt_fluid_limits → salt_limit + fluid_limit (required)
and iv_furosemide_fluid → iv_furosemide + fluid_lost_5_2; `bakeoff-ptbr-endocrinology` water_hygiene →
water_intake + intimate_hygiene (required); `demo-gastro-referral` anemia_values → hemoglobin_104 +
ferritin_6; `bakeoff-imaging-report` no_new_findings → no_new_consolidation + heart_size_normal. The
rescore line's facts are unchanged.

`prepare` sends at most the first 50 pages of a document (`TEXT_READ_PAGES`): the app reads no more
(`MAX_TEXT_PAGES`) and the helper refuses more. A document's facts may lie past them, as in
`long03-heart-failure-54p`; no variant can carry those, and the run is marked `cut`. Such a fact is
`required: false` with a `beyond_text_read` reason (`check` insists), so it is kept to show what the
cut costs a patient without counting as a must-have; the reading report counts it as "never sent".
Not modelled: the app's 180-second text-read time limit (`TEXT_READ_TIME_LIMIT`), which can stop
the read of a slow PDF before page 50; `prepare` always sends the first 50 pages. Still to add: an image-only scan and a form
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
  - `CONTACT_DETAILS:<kinds>` (rule 7, DRAFT): the sentence repeats a phone number, an e-mail address, a
    street address or postal code, or an identity number (a health card, RAMQ, PESEL, record, chart,
    visit, referral or requisition number, or any run of 8 or more digits that is not a date) that
    is not in the document's `patient_contacts`. Kinds: `phone`, `email`, `address`, `identity`.
    The count per run is in `compare.md` (`contacts`). Not flagged: dates, lab values, doses, "911",
    "ST depression", TNM stages, years and year spans ("2025-2026"), a hyphenated range or a plain
    pair of values ("1500-7000", "1200 1500"; a pair is kept when a group starts with 0, as on
    cards), "St John's wort", and a health card named without its number. A phone given to the
    patient matches with or without its area code (the last 7 digits), and every bare 7-digit number
    after a phone word is checked. A contact document's pattern traps for the same details double
    the screen on purpose: such a sentence counts in both "traps" and "contacts".
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

**Version 7 (DRAFT for the next freeze; not used for the 10–11 Nov runs, which are scored with
version 6 of the rescore line, 7d07955f on agent2/rescore-v5-20261111; numbered 7 so the two cannot
be confused; it was called 6 until the rescore line took that number for Ben's decisions)** includes
versions 5 and 6 of the rescore line (merged on 11 Nov: "to check" rows, the LANGUAGE fix, the
reading report, whose labels here also name facts on pages never sent, full review, named facts,
page text as read, and Ben's checks 1 and 5) and adds the `CONTACT_DETAILS` screen, the documents' `patient_contacts`, and
three FAKE contact cases. A flagged sentence goes on the review sheet like any other, so a fact it
carries is held until reviewed; the screen changes no verdict by itself. It was written on 11 Nov to
make the contact rule of prompt variant L2 measurable: version 4 sees a repeated contact detail only
by eye, and B0 repeated two (a spouse's phone in `bakeoff-quebec-referral`, a PESEL in
`new-polish-discharge`), both flagged by this screen with no other B0 sentence flagged.

**Screens for unsafe sentences (rule 7, DRAFT; built 11 Nov, revised after Agent 3's unseen test).**
Round 2 and 2b's reviewer named nine kinds of sentence unsafe for a patient whatever the verdict; no
screen of rule 5 flagged any. Each screen below needs only the sentence, its quote and the document
text (folded), so each could run in the app as a summary is written. A flag ending in `_MARK` is a
weaker signal. **Trust in the app** (Agent 3's levels): DROP only `ACTION_FROM_HEADER`; MARK
("check this in the document") `GENERALIZED_SUBJECT`, `COUNT_DROPPED`, `HOLD_DROPPED`,
`ACTION_NOT_IN_QUOTE_MARK`, `FREQUENCY_DROPPED_MARK` and `LANGUAGE` by letters; not yet
`INSTRUCTION_ADDED` and `ALTERNATIVE_DROPPED` (to revisit on unseen sentences after their fixes).
- `GENERALIZED_SUBJECT` (en, fr, pl, pt-BR, es words): a general word for medicines (medicines, leki,
  médicaments…) with a date, a duration, "until" or "all", while the quote's own clause names one drug
  or a narrower class and no general word.
- `INSTRUCTION_ADDED` (en, fr, pl, pt-BR, es): an imperative, "if you…" or "you must…" sentence whose
  quote's own clause (and, for a list item, the list's heading) has no real instruction verb, is no
  dosing line, and is not a status the sentence fairly restates ("unchanged" for "keep taking",
  "stopped" for "stop"). Statuses such as "continued" are states, not instructions.
- `ALTERNATIVE_DROPPED` (cues: if, when, in case of, si, quand, lorsque, en cas de, jeśli, gdy, w razie,
  w przypadku, em caso de, en caso de): a condition in the quote's document sentence ends at the main
  clause ("…, call …", "— pilny kontakt"); its alternatives are split at commas and or/ou/lub/albo/o,
  bracketed examples left out; the summary sentence names the first but leaves one out. Every cue of the
  sentence is tried. Only within one language. Sentence ends skip decimals and titles ("38.5", "Dr.").
- `COUNT_DROPPED` (en, fr, pl, pt-BR, es): a single dose (once, one puff, une seule fois, jednorazowo,
  uma vez…) not followed by a frequency, absent from the sentence.
- `FREQUENCY_DROPPED_MARK`: a medicine's frequency (twice a day, une fois par jour, co 12 godzin,
  uma vez ao dia…) left out of a sentence that does not say "unchanged" or "keep taking".
- `ACTION_FROM_HEADER`: an appointment or action with a date or time whose non-empty quote is a header or
  timestamp line (Reported, Report printed, Collected, DOB, Data wypisu, imprimé…). An empty quote (the
  app empties one it cannot find) never fires.
- `ACTION_NOT_IN_QUOTE_MARK`: the same sentence whose non-empty quote is not a header but has no action
  word (see, visit, appointment, arrive, wizyta…).
- `HOLD_DROPPED` (stop and hold words in en, fr, es, pl, pt-BR and zh): the quote holds or stops a
  medicine (not "after stopping", a time) and the sentence says no stop, hold or quit; an end of course
  ("then stop") is kept by "until <date>".
- `LANGUAGE` by letters: a sentence with too few stopwords is still flagged by letters only one language
  uses here (ł ą ę ż ś ć ń ź; ã õ; œ ù û ë ï è; ñ), the first word included and later capitalized words
  (names) skipped. French stopwords now include en, au, aux, dans, pas, ne, l', d'.
- The doctor-to-doctor "Please call me at 613-555-0142 ext. 21…" is `CONTACT_DETAILS`.

**How they measure (11 Nov).** Neither set is unseen any more: the first was designed from, the second
(Agent 3's) was used to fix the screens.
| Screen | round 2b: unsafe kinds (of 9) | round 2b: correct flagged (of 186) | Agent 3's pairs: caught | Agent 3's: correct flagged |
|---|---|---|---|---|
| GENERALIZED_SUBJECT | 2 | 0 | 4/4 | 0 |
| INSTRUCTION_ADDED | 3 | 0 | 6/6 | 0 |
| ALTERNATIVE_DROPPED | 1 | 1 (a real dropped trigger) | 4/4 | 0 |
| COUNT_DROPPED | 1 | 0 | 1/1 | 0 |
| FREQUENCY_DROPPED_MARK | 0 | 0 | 3/3 | 0 |
| ACTION_FROM_HEADER | 2 | 0 | 3/3 | 0 |
| ACTION_NOT_IN_QUOTE_MARK | 0 | 0 | 0/0 | 0 |
| HOLD_DROPPED | 1 | 0 | 3/3 | 0 |
| LANGUAGE by letters | 1 | 7 (wrong-language sentences it is meant to count) | 1/2 | 0 |
- Round 2b (214 B0, E1 and E4 sentences): 9 of 9 unsafe kinds, 6 of 12 wrong or unsupported (the six
  missed are claims quoted from another place or stronger than the document, which only the review sees).
- Agent 3's 47 pairs and 4 probes (`tests/screen_pairs_agent3.json`): 24 of 25 should-flag caught, 26 of 26
  correct left alone. At dfed8955 it was 13 of 24 and 22 of 23. The one miss is "Kontrola za 7 dni." in an
  English summary: no letter only Polish uses, too few stopwords. Its two frequency cases count as
  `FREQUENCY_DROPPED_MARK`, as its review's S3 asks.
- On the 352 approved statements: 4 flags, 2 real dropped triggers in two `daily_weight` wordings and 2
  frequency marks on the Polish antibiotic course ("co 12 godzin" left out).

**Held out:** the next unseen test is the next runs' new sentences (E2, E3, L1, L2 and any later
variant), once blind-reviewed: count what each screen flags among their reviewed-correct and
reviewed-unsafe sentences before any screen is changed again.

**Review coverage, 11 Nov (after B0 and E1 had been scored and reviewed):** every distinct
sentence now goes on the review sheet (`REVIEW_SAMPLE` 1.0, was 0.2), for every run alike. The 20%
sample let an invented appointment through by chance in round 2 (it reached the sheet only because
it was sampled), so more like it could hide in any run, B0 included. This changes review coverage
only: the credit and the decision rule are as in version 5, and a set where every sentence has a
verdict gets the same decisions at either sample (a test). Tests that are about a partial sample
pin it to 0.2.

**Page text as the runs read it, 11 Nov (after round 2b):** a run records the fingerprint of the
page text it read (`pagesSha256`). `score` and `noise` take `--pages <folder>` (the folder `prepare`
wrote for those runs) and check every run's fingerprint against it, or against the current document
when no folder is given: a run is never scored against text it did not read, and the runs of one
scoring must have read the same text. Quotes are placed, the sheet's contexts cut and the reviewer's
`review/docs/` written from that one text; the facts, spans and traps stay the frozen ones. Until
then contexts came from the current documents while `docs/` held the run-time text: they differed
in two lab reports, whose telephone line was changed after the runs (1-800-555-0100 to
613-555-0150, freeze 2); that change stays, for future runs.

**Rows that list several facts, 11 Nov (after round 2):** a `correct` row whose `fact_it_may_state`
lists several facts must name in its note the ones it states (`states: 1, 3` or `states: all`).
Only those are credited; for the others the sentence counts as `vague` (a fact whose every carrier
is turned down is "rejected", i.e. lost). Such a row without a `states:` note is not reviewed yet.
`prefill` carries the note over by the facts' wording. Rows listing one fact, and the decision rule,
are unchanged. Made after B0 and E1 had been scored: 5 of round 2's 6 several-fact rows were
`correct` with no such note.

**Version 6 of the rescore line** (11 Nov; the DRAFT next freeze is renumbered 7 so the two cannot be
confused) records **Ben's decisions, made after B0, E1 and E4 had been scored and reviewed** (E2 had
finished but was not scored): "compare to today" for wrong statements, any reviewer-marked unsafe
sentence the baseline lacks fails a variant, and a summary may take up to about 3 minutes (checks 1
and 5 above). The review sheet gains the `unsafe` column (`yes` or blank, a reason in `note`; "mild"
counts as unsafe). Facts, credit and the other checks are as in version 5. Under it, on the round-2b
review: B0 median 87 s, E1 81 s, E4 77 s per document.

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
1. **Wrong and unsafe statements, compared with today (rule 6).**
   - a. The variant's sentences reviewed `wrong` or `unsupported` on the decision documents are no
     more than the baseline's. A sentence both runs wrote counts on both sides. While rows are
     unreviewed the check is pending, unless no review could change its answer.
   - b. No sentence the reviewer marked **unsafe** (the sheet's `unsafe` column) that the baseline
     did not also write, on any document, holdout included. The baseline's own unsafe sentences are
     listed apart in `compare.md` (and `unsafe_sentences` in `scores.json`).
   - (Rules 2 to 5: no sentence reviewed `wrong` or `unsupported` at all.)
2. **Must-haves kept.** At most `margin_lost` required facts that the baseline had (credited or
   held) are lost.
3. **Patient actions not worse.** Patient actions found are at least the baseline's −
   `margin_actions`.
   - For a variant named with `--require-gain-for LABEL` (an experiment aimed at them), they must be
     more than the baseline + `margin_actions`.
   - Other variants in the same call are held to "not worse". So a speed, fit or model-swap variant
     can pass.
4. **Quotes.** Quotes found are within 2 points of the baseline.
5. **Time (rule 6).** The median of the wall time per answered decision document is at most 180 s,
   and no decision document fails, by the time limit or otherwise, that the baseline answered.
   (Rules 2 to 5: the median at most 30% above the baseline's.)

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
