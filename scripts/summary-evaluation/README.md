# Synthetic summary regression evaluation

This offline tool checks bounded engineering examples for the desktop patient
summary. It does not run a model, modify the app, add dependencies or establish
clinical validity. The 12 synthetic EN/FR documents form six bilingual template
families, with three development and three holdout families. They contain 48
required facts covering medication doses/status, negation, uncertainty, units,
dates, conditional instructions, family context and embedded untrusted instructions.
`FIXTURE-FREEZE.json` binds the source text and gold before model evaluation.

The older bake-off's number-anywhere and quote-presence checks can miss a swapped
dose when the wrong number occurs elsewhere in the document. Here, quantity
diagnostics pair a specific fixture concept with its value and unit. A quote may
be present in the source yet refer to another fact. Correct quotation and verified
clinical meaning remain separate checks.

Case and superscripts are preserved in statement/quote matching: `mg` and `Mg`,
or `10⁹/L` and `109/L`, cannot silently inherit the same approval. Cosmetic variants
outside the reviewed set can require review too; this conservative tool does not
claim broad paraphrase equivalence.

Each fact has finite human-reviewed statement variants and exact source evidence.
Only those variants earn automatic fact recognition. A different paraphrase is
marked `UNREVIEWED_STATEMENT`, even if correct; a human must decide whether it is
faithful, unsupported, contradictory or missing a qualifier. It is **not** automatically
called a hallucination or omission. A recognized statement needs its own labelled
evidence, and additional appended text cannot inherit the statement's approval.
Missing facts among otherwise recognized statements remain explicit. This is a
conservative regression aid, not a general entailment or medication parser.

## Input and commands

Use one candidate's output per file, retaining the exact fixture source hash:

```json
{
  "predictions": [{
    "case_id": "en-medication_plan",
    "language": "en",
    "document_sha256": "<document_sha256 from fixtures.json>",
    "sentences": [{
      "text": "Keep taking ramipril 5 mg once daily.",
      "quote": "Continue ramipril 5 mg once daily."
    }]
  }]
}
```

`--format native` requires `{text,quote}` sentences, matching the D1 model output.
`--format legacy` requires `{text,source}` from the old bake-off. No format is
guessed. The wrapper adds `case_id`, requested `language` and source hash; it must
not alter model text or quotes. Preserve original completions and model/prompt/
runtime provenance alongside the predictions. A native app result's model metadata
does not replace the separately pinned runner/weights evidence.

```sh
python3 scripts/summary-evaluation/evaluate.py \
  --predictions /path/to/predictions.json --format native \
  --output /path/to/new-report.json
python3 -m unittest discover -s scripts/summary-evaluation/tests -v
```

All 12 cases are selected by default; missing outputs stay visible. To declare a
smaller scope before a trial, repeat `--case <id>`. Unknown/duplicate/unselected
case IDs and duplicate JSON keys are rejected. Reports never overwrite a file.
Exit 0 means bounded checks are clear, 1 means flags require review, and 2 means
input/report rejection. Every report retains `clinical_validity: not_established`
and a human-review requirement, even when the bounded checks are clear.

The tests include a wrong dose with the same number elsewhere, wrong analyte
values and units, status/negation/uncertainty swaps, altered laterality/dates,
omitted conditional instructions, irrelevant but present quotes, appended advice,
prompt-injection text, and a correct unrecognized paraphrase requiring review.
They execute no model or medical NLP package.

## Human review and trial use

Freeze fixture/scorer/prompt/runner/model hashes before generating summaries.
Do not tune against holdout outputs or relabel them. Keep all failures and source
quotes. An independent reviewer should inspect each output against the full source
and required attributes, recording unsupported additions, contradictions, omitted
instructions, dose/frequency/status, negation/uncertainty, experiencer, dates/units,
source support and readability. An unknown phrase can represent a correct fact;
the machine's recognized-fact count is a conservative lower bound, not clinical
recall. Do not rank models by that number alone or treat citations as entailment.
Any corrected gold needs a new version preserving the original trial and reasons.

## medspaCy fit assessment

medspaCy offers contextual assertion and section components; its current language
table lists French ConText rules and very few French section rules. It could later
flag source/summary negation or uncertainty around declared concepts, but it does
not supply an independent truth ledger or replace semantic review. This is an
assessment from the [maintainers' documentation](https://github.com/medspacy/medspacy),
not an installed or measured integration. The core repository uses
[MIT](https://github.com/medspacy/medspacy/blob/master/LICENSE); optional terminology,
resources and models need their own provenance checks. Before a separate offline
experiment, pin compatible versions and rules, measure added value on fresh heldout
cases, and retain the frozen baseline. Do not add it to the app or modify the
Presidio environment. No medspaCy install was performed for this work.
