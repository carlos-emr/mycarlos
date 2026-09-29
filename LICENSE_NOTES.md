# Licence

myCarlos is licensed under the **GNU Affero General Public License, version 3 or (at your option)
any later version** (`AGPL-3.0-or-later`): the licence whose text this repository's `LICENSE` file
held from its first commit.

| Where | What it says |
| --- | --- |
| [LICENSE](LICENSE) | The text of the GNU Affero General Public License, version 3: the same text as in this repository's first commit |
| `src-tauri/Cargo.toml`, `security-tests/glib-variant/Cargo.toml` | `license = "AGPL-3.0-or-later"` |
| `package.json` | `"license": "AGPL-3.0-or-later"` |
| [UPSTREAM_NOTICE.md](UPSTREAM_NOTICE.md) | The CARLOS repository's project-wide notice, retained |

Source files carry no licence headers; these declarations cover them.

The AGPL is the GPL, version 3, with one duty more (its section 13): whoever runs a modified
version for users who reach it over a network must offer those users its source. The app itself
runs on the patient's device, so this matters mainly for any server part built later. A server
written separately is under the licence its authors choose, and comes under the AGPL only if it
contains myCarlos code. Sharing with CARLOS now goes one way: myCarlos code can go into CARLOS
under CARLOS's own licence only if its author offers it under that licence as well.

## The libraries the apps are built with

Some libraries that Tauri brings in carry the terms of the Apache License 2.0 with no alternative
that GPL version 2 would accept: `tao` (its window layer), under Apache-2.0 alone, in every build; `dpi`, which
declares "Apache-2.0 AND MIT", so that both sets of terms apply, in every build; and
`sync_wrapper`, under Apache-2.0 alone, in the Android and iOS builds. In the Free Software
Foundation's view, Apache-2.0 is compatible with version 3 of the GPL and of the AGPL, and not with
version 2 of the GPL, so the built apps can be passed on under the AGPL, version 3. Under GPL
version 2 alone they could not.

The other dependencies that were checked are under permissive licences (MIT, Apache-2.0 offered
with MIT, BSD, 0BSD, ISC, Zlib, Unicode, CC0, Unlicense) or the Mozilla Public License 2.0, which
can be combined with the AGPL. This was taken from the licences the packages declare, for the
packages the supported builds use. It does not cover the platforms' own webviews and system
libraries, nor tools used only to build (such as `target-lexicon`, under Apache-2.0 with the LLVM
exception), and it has to be checked again when dependencies change. The licences stay recorded in
the packages and in the generated SBOMs; see [DEPENDENCY_REVIEW.md](DEPENDENCY_REVIEW.md).

## Code from CARLOS

The application was written in the CARLOS repository by its author, Ben Heerema, who relicensed it
on 2026-09-29, and declared there `GPL-2.0-or-later`. Copies already published under that licence
(in CARLOS, and in this repository before this change) remain available under it. Code by anyone else is not known to be in it, but it has not
been checked line by line. Any that is would keep its own terms: under GPL-2.0-or-later it can be
taken under version 3 and combined with the AGPL, which section 13 of the AGPL and of GPL version 3
allow, and would carry the GPL version 3 text; under GPL version 2 alone it could not be. This is part of the review below.

## Open: app stores

Whether an AGPL or GPL app may be distributed through Apple's App Store is **not settled**. The
store's terms add restrictions that the Free Software Foundation regards as incompatible with
version 3 of these licences, and apps under them have been withdrawn from it over this. The
copyright holders can grant an additional permission for store distribution, which takes the
agreement of every one of them, those of any code that came from CARLOS included, and of every
later contributor. While the author is the only known holder, it is theirs alone to grant; each
outside contribution adds a holder.
**This needs a lawyer's view before any release through a store.** Until then, no store release is
planned. Google Play's terms are not known to conflict in the same way, but should be part of the
same review.

## History

- The application was developed in the CARLOS repository and declared `GPL-2.0-or-later`; see
  [HANDOFF.md](HANDOFF.md) for the source revision and the original contribution history. It
  moved here with that declaration, and the GPL version 2 text in a `COPYING` file.
- This repository started with a `LICENSE` file holding the AGPL version 3 text. Until this change
  the application was not declared to be under it.
- The application's author relicensed it `AGPL-3.0-or-later` on 2026-09-29. `LICENSE` holds the
  same text as at the start, and `COPYING`, which held the GPL version 2 text for the earlier
  declaration, is gone.

This file records what the project declares. It is not legal advice.
