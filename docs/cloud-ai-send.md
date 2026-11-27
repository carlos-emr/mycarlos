# Cloud AI send with the patient's own key (#72): proposed, not built

Status: **proposed**. This page records the decisions so the threat model and privacy review can cover
them before any code that sends. No network code and no real key exist for it. Written 21 November 2026.

## What it is

An optional way, for one tool first (the plain-words **Summary**), to send one document's text to one
provider, **Anthropic**, from myCarlos itself, using the **patient's own API key**. The text-file way
(save a de-identified file and take it to any service) stays. Computers only first.

## Decisions

- **One provider, one host:** `api.anthropic.com`, paths `POST /v1/messages` and `GET /v1/models` only,
  HTTPS with the platform's certificate verifier, no redirects, no proxy, no cookies. The address is a
  constant in Rust (THREAT_MODEL NET-09).
- **The key:** stored encrypted in the vault (a manifest field, so a format bump taken at merge), only ever
  in Rust, shown masked, removable, never returned to the page; an admin key (`sk-ant-admin…`) is refused.
  It is in backups; older backups keep it after removal.
- **Consent, layered, off by default:** the `cloud-ai` Cargo feature (off in release builds until #25
  signs off) -> a device setting after reading the notice -> a key -> a preview and **a trusted native
  confirmation for each send**. No background send, no "always allow".
- **The page never sends and never holds the key.** Rust re-checks the final text (as it does before a
  save), builds and sends the request, validates the answer, restores the placeholders from the removed
  list the page hands it (checked natively: exact placeholders of this export that stand in the text sent,
  bounded; a stated residual, not a proof, because only the page holds the document), and keeps the answer natively, labelled as written in the cloud.
- **Recorded:** history entries for the send (written before it) and the answer: time, provider, model,
  document, request id, token counts. Never the text, the answer, the removed list or the key.
- **No claims about the provider's data use.** The notice says the patient's account rules apply. The
  documented provider offers no Canadian processing region (a point for #25).
- **No automatic retry**; "Try again" asks again.

## Choices made as "supervisor default while Ben away" (21 November 2026; Ben may change any)

| Question | Default |
|---|---|
| Default model | Claude Opus 5.5; Sonnet 5.5 and Haiku 5.5 selectable |
| Key in backups | No special case; the dialogs warn plainly |
| Server-side fallbacks | On, with a plain message if the whole chain refuses |
| Cost warning | Bold when the estimate is over $0.50 |
| Canada | Accept with a plain notice; #25 decides before real data |
| Platforms | Computers first |
| Stored monthly total | Not now (tokens are in the history) |
| Retry | None automatic |

Still for Ben or the reviewer: who writes the notice in seven languages (English first here), the #25
review of this way, and who runs the one live contract check (a real key on FAKE text, by hand, once).

## Build order

0. This documents-only change. 1. The native core behind `cloud-ai` with a fake transport. 2. The key in
the vault. 3. The send path and the native confirmation. 4. The screens. 5. The release-build check.
