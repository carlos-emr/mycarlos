# Licence

myCarlos is licensed under the **GNU General Public License, version 2 or (at your option) any
later version** (`GPL-2.0-or-later`), the same as CARLOS, where it was first developed.

| Where | What it says |
| --- | --- |
| [LICENSE](LICENSE) and [COPYING](COPYING) | The text of the GNU General Public License, version 2 |
| `src-tauri/Cargo.toml`, `security-tests/glib-variant/Cargo.toml` | `license = "GPL-2.0-or-later"` |
| `package.json` | `"license": "GPL-2.0-or-later"` |
| [UPSTREAM_NOTICE.md](UPSTREAM_NOTICE.md) | The CARLOS repository's project-wide notice, retained |

Source files carry no licence headers; these declarations cover them.

## Why "or any later version" matters

The source is offered under version 2 or any later version. The **built apps** can only be passed
on under **version 3 or later**: two libraries that every build includes through Tauri, `tao` (its
window layer) and `sync_wrapper`, are under the Apache License 2.0 alone, which is compatible with
version 3 of the GPL and not with version 2. "Or any later version" is what lets the built apps
comply. Without it they could not be distributed at all.

The other dependencies are under permissive licences (MIT, Apache-2.0 offered with MIT, BSD, ISC,
Zlib, Unicode, CC0, Unlicense) or the Mozilla Public License 2.0, all of which can be combined with
the GPL. Their licences stay recorded in their packages and in the generated SBOMs; see
[DEPENDENCY_REVIEW.md](DEPENDENCY_REVIEW.md). This list was taken from the dependency metadata and
has to be checked again when dependencies change.

## Open: app stores

Whether a GPL app may be distributed through Apple's App Store is **not settled**. The store's
terms add restrictions that the Free Software Foundation regards as incompatible with the GPL, and
GPL apps have been withdrawn from it over this. A copyright holder can grant an additional
permission for store distribution, which every later contributor would then have to agree to.
**This needs a lawyer's view before any release through a store.** Until then, no store release is
planned. Google Play's terms are not known to conflict in the same way, but should be part of the
same review.

## History

- The application was developed in the CARLOS repository under `GPL-2.0-or-later` and moved here
  with its declaration and notices; see [HANDOFF.md](HANDOFF.md) for the source revision and the
  original contribution history.
- This repository's first commit held only a two-line README and a `LICENSE` file with the text of
  the GNU Affero General Public License, version 3. No application code was ever published here
  under that licence alone: the move did not relicense the application, and these notes said so.
  `LICENSE` now holds the GPL version 2 text, so that every declaration agrees.

This file records what the project declares. It is not legal advice.
