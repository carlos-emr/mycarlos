# Cloud AI send with the patient's own key (#72): proposed, not built

Status: **proposed**. This page records the decisions so the threat model and privacy review can cover
them before any code that sends. No network code and no real key exist for it. Written 21 November 2026.

## What it is

An optional way, for one tool first (the plain-words **Summary**), to send one document's text from
myCarlos to a supported provider chosen by the patient, using the **patient's own API key**.
Patients can still save a de-identified file and take it to any service. The first version is for computers.

## Decisions

- **Fixed provider allowlist:** the planned entries are Anthropic, OpenAI and Google Gemini. Each
  provider has a fixed HTTPS host and an allowlist of API paths defined in Rust. Patients choose a
  provider and model from the app's verified options. HTTPS uses the platform certificate verifier
  and the client sends no redirects, proxies or cookies. See THREAT_MODEL NET-09.
- **The key:** stored encrypted in the vault (a manifest field, so a format bump taken at merge), only ever
  in Rust, shown masked, removable, never returned to the page; an admin key (`sk-ant-admin…`) is refused.
  It is in backups; older backups keep it after removal.
- **Consent, off by default.** The `cloud-ai` Cargo feature is permitted in evaluation builds and
  refused in release builds. The patient reads the notice, enables the device setting and adds a key.
  Consent is required again in each unlocked session and ends when the vault locks. Every send
  also requires a preview and **trusted native confirmation**.
- **The page never sends and never holds the key.** Rust re-checks the final text (as it does before a
  save), builds and sends the request, validates the answer, restores the placeholders from the removed
  list the page hands it (checked natively: exact placeholders of this export that stand in the text sent,
  bounded; a stated residual, not a proof, because only the page holds the document), and keeps the answer natively, labelled as written in the cloud.
- **Recorded:** history entries for the send (written before it) and the answer: time, provider, model,
  document, request id, token counts. Never the text, the answer, the removed list or the key.
- **Provider data handling.** The notice says the selected provider's account rules apply.
  Assess supported providers' processing locations and data-handling terms before approving real data in #25.
- **No automatic retry**; "Try again" asks again.

## Choices made as "supervisor default while Ben away" (21 November 2026; Ben may change any)

| Question | Default |
|---|---|
| Default model | A reviewed model from the selected provider's verified catalogue |
| Key in backups | No special case; the dialogs warn plainly |
| Server-side fallbacks | Off. Show the failure for the chosen model and provider. |
| Cost warning | Bold when the estimate is over $0.50 |
| Processing location | #25 reviews the selected provider's processing locations and notice before real data |
| Platforms | Computers first |
| Stored monthly total | Not now (tokens are in the history) |
| Retry | None automatic |

Ben owns the live contract check using a real key on FAKE text. The seven-language notice and
the #25 review still need owners.

## Build order

0. This documents-only change. 1. The native core behind `cloud-ai` with a fake transport. 2. The key in
the vault. 3. The send path and the native confirmation. 4. The screens. 5. The release-build check.
