# Open-source notices (store item 18)

myCarlos shows its third-party notices in the app: **Settings > Preferences > About > Open-source
notices**. The screen lists every library and tool that ships in the app with its version and SPDX
licence, opens each one to the licence and notice texts that came with it, and shows myCarlos's own
licence (AGPL-3.0-or-later) in full with the address of its source code (AGPL section 13).

## Where the list comes from

`src/native/notices/third-party-notices.json` is generated from the CI's locked CycloneDX
inventories by `scripts/generate-third-party-notices.mjs`:

```sh
npm ci
npm run sbom:frontend                                   # sbom-frontend.cdx.json
SOURCE_DATE_EPOCH=0 cargo cyclonedx --manifest-path src-tauri/Cargo.toml \
  --format json --target all                            # src-tauri/mycarlos-tauri-poc.cdx.json
mv src-tauri/mycarlos-tauri-poc.cdx.json sbom-native.cdx.json
npm run notices:generate                                # rewrites the committed file
npm run notices:check                                   # fails when the committed file is stale
```

(`cargo-cyclonedx` 0.5.9, as the CI installs it.) Licence texts are read from the installed packages
(`node_modules`, and the Cargo sources `cargo metadata --locked` names). Dev-only npm packages are
left out: they are not in the app.

## What fails the build

The generator exits non-zero, naming the component, when:

- a component declares **no licence**, or an expression it cannot read;
- a licence is **outside the allow-list** (`ALLOWED` in `scripts/third-party-notices.mjs`);
- a licence is **GPL-family, AGPL or other copyleft**: the message says "needs a maintainer decision"
  so the decision is made by a person, not by an allow-list edit made in passing;
- a licence that must be shown with the software (MIT, BSD, ISC, Apache-2.0, MPL-2.0 ...) has **no
  licence text** in its package. Fix it by adding a reviewed text to `scripts/notices/overrides.json`
  (`"name@version"` or `"name"` to `[{name, text}]`), never by guessing a copyright line.

For an "A OR B" expression the first alternative whose licences are all allowed is applied.

## Things that are not crates

`scripts/notices/extra-components.json` lists what the SBOMs do not, each with the text read from the
package that carries it:

- **llama.cpp and ggml** (MIT), built from the source `llama-cpp-sys-2` vendors.
- What llama.cpp's **`common` library** compiles in: nlohmann/json (MIT), cpp-httplib (MIT),
  subprocess.h (Unlicense), xxHash (BSD-2-Clause), rotate-bits (MIT), and the public-domain SHA-256
  and SHA-1 code. `common` is on because `llama-cpp-sys-2`'s own default features enable it
  (`cargo tree -e features -i llama-cpp-sys-2`); `llama-cpp-2` has its defaults off.
- **The Foxit standard PDF fonts** (PDFium, BSD-3-Clause) and the **ICC colour profiles** (CC0)
  embedded by `hayro-interpret`'s `embed-fonts` feature and `hayro-jpeg2000`.

`npm run test:notices` fails if `llama-cpp-2` / `llama-cpp-sys-2` gain a feature that vendors more
code (`mtmd`, `llguidance`, `curl`, `openmp`, ...) or lose `default-features = false` on
`llama-cpp-2`: add that code's licences here first. The AI model a patient adds is not part of
myCarlos; its own licence is shown with the model list.

## How the texts are chosen

- Licence and notice files at the top of the package (`LICENSE*`, `COPYING*`, `NOTICE*`,
  `COPYRIGHT*`). A **NOTICE file alone is not the licence**: its text is kept and the licence text is
  added beside it.
- Otherwise a reviewed override (`scripts/notices/overrides.json`), then the licence's **standard text**
  (`scripts/notices/standard-licences/`) with the copyright line made from the package's authors, or
  "The X authors (repository)". Such an entry is marked "standard text; the package ships no licence
  file". Of a dual licence the alternative needing no holder's name is shown, and the entry says
  which licence it is "Used under".
- npm texts are read from `node_modules` and must be the version the SBOM names: a different
  installed version fails the build.
- Every entry shows the package's source address (the MPL-2.0 ones need it).

## Staying current

`scripts/third-party-notices-current.test.mjs` (`npm run test:notices`) fails when `package-lock.json`,
`src-tauri/Cargo.lock`, the generator, or anything under `scripts/notices/` changed after the file was
generated. `npm run notices:check` is the full
comparison against fresh SBOMs and is meant for the "Locked dependencies and SBOMs" CI job.
