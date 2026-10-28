# UI review: screenshots of merged UI changes

For Ben’s review of the myCarlos screen changes merged since 20 October 2026 without a hands-on check. One section per pull request: what changed for the patient, then the screenshots that pull request already published.

- All screenshots use FAKE data. They are not re-hosted: each image link is copied exactly from the pull request and is pinned to the commit it was published from, so it keeps working after that commit was removed from its branch. The exception is #124, which published none: its screenshots were made for this review and are pinned to a commit on this branch.
- Tick **Reviewed by Ben** in the pull request description. In this file the boxes are display only.
- Listed on 28 October 2026, from main at 891a963. Newest first; stacked pull requests follow the one that took them to main.

**With screenshots:** #126, #95, #79, #81, #82, #62, #64, #58, #61, #59, #75, #77, #87, #83, #60

**No screenshots published:** #106, #116, #115, #113, #112, #103, #102, #65, #93

**To add after merge:** #104, #124. **Left out** (no visible change): see the end.

---

### [#126](https://github.com/carlos-emr/mycarlos/pull/126) Allow correcting a person's folder name

- [ ] Reviewed by Ben

A person’s top-level folder gets Rename, so a misspelt name can be corrected. Merged 28 Oct.

**[comment](https://github.com/carlos-emr/mycarlos/pull/126#issuecomment-6445599580)** — 27 Oct, pinned to 3baa81b: the built app with a FAKE native side, not a real device; desktop, and 320 px and 390 px windows at 200% text.

before desktop root

![before desktop root](https://raw.githubusercontent.com/carlos-emr/mycarlos/3baa81bf2c4268ff30790f7972771790b17cd7e7/docs/ui-tests/pr-126/screenshots/before-desktop-root.png)

after desktop saved

![after desktop saved](https://raw.githubusercontent.com/carlos-emr/mycarlos/3baa81bf2c4268ff30790f7972771790b17cd7e7/docs/ui-tests/pr-126/screenshots/after-desktop-saved.png)

before narrow320 reader200 root

![before narrow320 reader200 root](https://raw.githubusercontent.com/carlos-emr/mycarlos/3baa81bf2c4268ff30790f7972771790b17cd7e7/docs/ui-tests/pr-126/screenshots/before-narrow320-reader200-root.png)

after narrow320 reader200 dialog

![after narrow320 reader200 dialog](https://raw.githubusercontent.com/carlos-emr/mycarlos/3baa81bf2c4268ff30790f7972771790b17cd7e7/docs/ui-tests/pr-126/screenshots/after-narrow320-reader200-dialog.png)

before narrow390 reader200 root

![before narrow390 reader200 root](https://raw.githubusercontent.com/carlos-emr/mycarlos/3baa81bf2c4268ff30790f7972771790b17cd7e7/docs/ui-tests/pr-126/screenshots/before-narrow390-reader200-root.png)

after narrow390 reader200 saved

![after narrow390 reader200 saved](https://raw.githubusercontent.com/carlos-emr/mycarlos/3baa81bf2c4268ff30790f7972771790b17cd7e7/docs/ui-tests/pr-126/screenshots/after-narrow390-reader200-saved.png)


---

### [#106](https://github.com/carlos-emr/mycarlos/pull/106) Announce settled library search results (#92)

- [ ] Reviewed by Ben

Screen readers now hear how many folders and documents a library search found, half a second after typing stops. Nothing changes on screen. Merged 26 Oct.

_No screenshots: the change is heard, not seen._

---

### [#116](https://github.com/carlos-emr/mycarlos/pull/116) Show a single visible PDF page counter

- [ ] Reviewed by Ben

The PDF reader shows its page counter once, beside Previous and Next, instead of twice. Merged 26 Oct.

_No screenshots were published on this PR._

---

### [#115](https://github.com/carlos-emr/mycarlos/pull/115) Preserve PDF report line breaks in the reader

- [ ] Reviewed by Ben

In the PDF reader, “Text on this page” keeps a report’s lines apart (title, Patient, Provider, Finding) instead of running them together. Merged 23 Oct.

_No screenshots were published on this PR._

---

### [#113](https://github.com/carlos-emr/mycarlos/pull/113) Choose and remember a language in setup and Preferences

- [ ] Reviewed by Ben

A language choice (System default or one of the five languages) in first setup, vault creation, unlock and Preferences, remembered on this device. Merged 23 Oct.

_No screenshots were published on this PR. Its description has the new wording in all five languages._

---

### [#112](https://github.com/carlos-emr/mycarlos/pull/112) Add a saved High contrast choice in Preferences

- [ ] Reviewed by Ben

Preferences → Appearance gets a fourth choice, High contrast: black background, bright text, strong edges and a cyan focus ring, saved on this device. Merged 23 Oct.

_No screenshots were published on this PR. Its description has the new wording in all five languages._

---

### [#95](https://github.com/carlos-emr/mycarlos/pull/95) feat(camera): take a photo on Android and iPhone too (D97)

- [ ] Reviewed by Ben

Take a photo now works on Android and iPhone too, with phone wording for the camera question and for where to allow a refused camera. Merged 22 Oct.

**[comment](https://github.com/carlos-emr/mycarlos/pull/95#issuecomment-6303230621)** — 20 Oct, pinned to b2c3b02: an Android-sized window (390 px) with Chromium’s fake camera, not a real phone; 100% and 200% text. After only.

| | 100% | 200% |
|---|---|---|
| The library: Take a photo | ![](https://raw.githubusercontent.com/carlos-emr/mycarlos/b2c3b024be336bdca2b13305ae113df2bdaabd46/docs/pr-screenshots/73-phone/after-phone-100-1-library.png) | ![](https://raw.githubusercontent.com/carlos-emr/mycarlos/b2c3b024be336bdca2b13305ae113df2bdaabd46/docs/pr-screenshots/73-phone/after-phone-200-1-library.png) |
| Before the camera: what it is for, and that the phone asks once | ![](https://raw.githubusercontent.com/carlos-emr/mycarlos/b2c3b024be336bdca2b13305ae113df2bdaabd46/docs/pr-screenshots/73-phone/after-phone-100-2-explain.png) | ![](https://raw.githubusercontent.com/carlos-emr/mycarlos/b2c3b024be336bdca2b13305ae113df2bdaabd46/docs/pr-screenshots/73-phone/after-phone-200-2-explain.png) |
| The camera on | ![](https://raw.githubusercontent.com/carlos-emr/mycarlos/b2c3b024be336bdca2b13305ae113df2bdaabd46/docs/pr-screenshots/73-phone/after-phone-100-3-live.png) | ![](https://raw.githubusercontent.com/carlos-emr/mycarlos/b2c3b024be336bdca2b13305ae113df2bdaabd46/docs/pr-screenshots/73-phone/after-phone-200-3-live.png) |
| The photo, before Use photo | ![](https://raw.githubusercontent.com/carlos-emr/mycarlos/b2c3b024be336bdca2b13305ae113df2bdaabd46/docs/pr-screenshots/73-phone/after-phone-100-4-photo.png) | ![](https://raw.githubusercontent.com/carlos-emr/mycarlos/b2c3b024be336bdca2b13305ae113df2bdaabd46/docs/pr-screenshots/73-phone/after-phone-200-4-photo.png) |
| The camera refused: where to allow it on Android | ![](https://raw.githubusercontent.com/carlos-emr/mycarlos/b2c3b024be336bdca2b13305ae113df2bdaabd46/docs/pr-screenshots/73-phone/after-phone-100-refused-5-refused.png) | ![](https://raw.githubusercontent.com/carlos-emr/mycarlos/b2c3b024be336bdca2b13305ae113df2bdaabd46/docs/pr-screenshots/73-phone/after-phone-200-refused-5-refused.png) |

[The PR description](https://github.com/carlos-emr/mycarlos/pull/95) repeats these shots without the library row. A check on a real Android phone and iPhone is still outstanding (D97).

---

### [#103](https://github.com/carlos-emr/mycarlos/pull/103) Keep JPEG photo extensions outside editable names

- [ ] Reviewed by Ben

Renaming a photo keeps “.jpg” fixed beside the name box, so a saved photo can no longer end up named “.png”. Merged 22 Oct.

_No screenshots were published on this PR._

---

### [#102](https://github.com/carlos-emr/mycarlos/pull/102) Allow moving filed documents to another person

- [ ] Reviewed by Ben

A document already filed under one person can move to another person’s records, from its details (Move to → Move) or by dragging. Merged 22 Oct.

_No screenshots were published on this PR._

---

### [#79](https://github.com/carlos-emr/mycarlos/pull/79) feat(vault): retain documents with hiding, encrypted history and set-aside vaults — #71

- [ ] Reviewed by Ben

Delete becomes Hide: hidden documents go to a Hidden list with Restore, damaged ones are hidden instead of removed, and Security gets “What myCarlos keeps”. Merged 22 Oct.

**[comment](https://github.com/carlos-emr/mycarlos/pull/79#issuecomment-6228084350)** — 17 Oct, pinned to d42807a: before = main 3529ae1, after = cd05630; light, 100% and 200% text.

**Before and after: hide instead of delete** (#71 part A; FAKE data only; light, at 100% and 200% text size). Dark mode comes with #60.

| | Before (main, 3529ae1) | After (cd05630) |
|---|---|---|
| Library, 100% | ![before, library, 100%](https://github.com/carlos-emr/mycarlos/blob/d42807a66b5fd8837c7ed6f20be9dccd3429f1b1/docs/pr-screenshots/71a-hide-documents/before-100-1-library.png?raw=true) | ![after, library, 100%](https://github.com/carlos-emr/mycarlos/blob/d42807a66b5fd8837c7ed6f20be9dccd3429f1b1/docs/pr-screenshots/71a-hide-documents/after-100-1-library.png?raw=true) |
| Library, 200% | ![before, library, 200%](https://github.com/carlos-emr/mycarlos/blob/d42807a66b5fd8837c7ed6f20be9dccd3429f1b1/docs/pr-screenshots/71a-hide-documents/before-200-1-library.png?raw=true) | ![after, library, 200%](https://github.com/carlos-emr/mycarlos/blob/d42807a66b5fd8837c7ed6f20be9dccd3429f1b1/docs/pr-screenshots/71a-hide-documents/after-200-1-library.png?raw=true) |
| The Hidden list, 100% | (none) | ![after, hidden, 100%](https://github.com/carlos-emr/mycarlos/blob/d42807a66b5fd8837c7ed6f20be9dccd3429f1b1/docs/pr-screenshots/71a-hide-documents/after-100-2-hidden.png?raw=true) |
| The Hidden list, 200% | (none) | ![after, hidden, 200%](https://github.com/carlos-emr/mycarlos/blob/d42807a66b5fd8837c7ed6f20be9dccd3429f1b1/docs/pr-screenshots/71a-hide-documents/after-200-2-hidden.png?raw=true) |
| Document details, 100% | ![before, details, 100%](https://github.com/carlos-emr/mycarlos/blob/d42807a66b5fd8837c7ed6f20be9dccd3429f1b1/docs/pr-screenshots/71a-hide-documents/before-100-3-details.png?raw=true) | ![after, details, 100%](https://github.com/carlos-emr/mycarlos/blob/d42807a66b5fd8837c7ed6f20be9dccd3429f1b1/docs/pr-screenshots/71a-hide-documents/after-100-3-details.png?raw=true) |
| Document details, 200% | ![before, details, 200%](https://github.com/carlos-emr/mycarlos/blob/d42807a66b5fd8837c7ed6f20be9dccd3429f1b1/docs/pr-screenshots/71a-hide-documents/before-200-3-details.png?raw=true) | ![after, details, 200%](https://github.com/carlos-emr/mycarlos/blob/d42807a66b5fd8837c7ed6f20be9dccd3429f1b1/docs/pr-screenshots/71a-hide-documents/after-200-3-details.png?raw=true) |
| Damaged documents, 100% | ![before, damaged, 100%](https://github.com/carlos-emr/mycarlos/blob/d42807a66b5fd8837c7ed6f20be9dccd3429f1b1/docs/pr-screenshots/71a-hide-documents/before-100-4-damaged.png?raw=true) | ![after, damaged, 100%](https://github.com/carlos-emr/mycarlos/blob/d42807a66b5fd8837c7ed6f20be9dccd3429f1b1/docs/pr-screenshots/71a-hide-documents/after-100-4-damaged.png?raw=true) |
| Damaged documents, 200% | ![before, damaged, 200%](https://github.com/carlos-emr/mycarlos/blob/d42807a66b5fd8837c7ed6f20be9dccd3429f1b1/docs/pr-screenshots/71a-hide-documents/before-200-4-damaged.png?raw=true) | ![after, damaged, 200%](https://github.com/carlos-emr/mycarlos/blob/d42807a66b5fd8837c7ed6f20be9dccd3429f1b1/docs/pr-screenshots/71a-hide-documents/after-200-4-damaged.png?raw=true) |
| Security: "What myCarlos keeps", 100% | (none) | ![after, security, 100%](https://github.com/carlos-emr/mycarlos/blob/d42807a66b5fd8837c7ed6f20be9dccd3429f1b1/docs/pr-screenshots/71a-hide-documents/after-100-5-security.png?raw=true) |
| Security: "What myCarlos keeps", 200% | (none) | ![after, security, 200%](https://github.com/carlos-emr/mycarlos/blob/d42807a66b5fd8837c7ed6f20be9dccd3429f1b1/docs/pr-screenshots/71a-hide-documents/after-200-5-security.png?raw=true) |

**[comment](https://github.com/carlos-emr/mycarlos/pull/79#issuecomment-6332426403)** — 22 Oct update for Ben’s visual review, pinned to eb2d4bd: after only, at app source 4c30d85; the 390 px views are a browser window, not a phone.

**desktop 1 library**

![desktop 1 library](https://raw.githubusercontent.com/carlos-emr/mycarlos/eb2d4bd69982d5e07431caea84090604607762f4/docs/pr-screenshots/pr-79-20261021-r2/79-desktop-1-library.png)

**desktop 2 details**

![desktop 2 details](https://raw.githubusercontent.com/carlos-emr/mycarlos/eb2d4bd69982d5e07431caea84090604607762f4/docs/pr-screenshots/pr-79-20261021-r2/79-desktop-2-details.png)

**desktop 3 hidden**

![desktop 3 hidden](https://raw.githubusercontent.com/carlos-emr/mycarlos/eb2d4bd69982d5e07431caea84090604607762f4/docs/pr-screenshots/pr-79-20261021-r2/79-desktop-3-hidden.png)

**phone 1 library**

![phone 1 library](https://raw.githubusercontent.com/carlos-emr/mycarlos/eb2d4bd69982d5e07431caea84090604607762f4/docs/pr-screenshots/pr-79-20261021-r2/79-phone-1-library.png)

**phone 2 details**

![phone 2 details](https://raw.githubusercontent.com/carlos-emr/mycarlos/eb2d4bd69982d5e07431caea84090604607762f4/docs/pr-screenshots/pr-79-20261021-r2/79-phone-2-details.png)

**phone 3 hidden**

![phone 3 hidden](https://raw.githubusercontent.com/carlos-emr/mycarlos/eb2d4bd69982d5e07431caea84090604607762f4/docs/pr-screenshots/pr-79-20261021-r2/79-phone-3-hidden.png)


---

### [#81](https://github.com/carlos-emr/mycarlos/pull/81) feat(vault): an encrypted, hash-chained history of what happens in the vault (manifest format 3) — #71 part B

- [ ] Reviewed by Ben

An encrypted history of what happens in the vault; Security’s “What myCarlos keeps” notice now describes it. Merged 22 Oct into [#79](https://github.com/carlos-emr/mycarlos/pull/79)’s branch (`feat/hide-documents`); reached main with [#79](https://github.com/carlos-emr/mycarlos/pull/79) the same day.

**[comment](https://github.com/carlos-emr/mycarlos/pull/81#issuecomment-6228932439)** — 17 Oct, pinned to a81c394: Security, “What myCarlos keeps”; before = #79 alone, after = this PR; 100% and 200% text.

| Before (PR A) | After |
|---|---|
| ![before, 100%](https://github.com/carlos-emr/mycarlos/blob/a81c3947db38e042427bd8fc6b72cf1072890328/docs/pr-screenshots/71b-history/before-100-security.png?raw=true) | ![after, 100%](https://github.com/carlos-emr/mycarlos/blob/a81c3947db38e042427bd8fc6b72cf1072890328/docs/pr-screenshots/71b-history/after-100-security.png?raw=true) |
| ![before, 200%](https://github.com/carlos-emr/mycarlos/blob/a81c3947db38e042427bd8fc6b72cf1072890328/docs/pr-screenshots/71b-history/before-200-security.png?raw=true) | ![after, 200%](https://github.com/carlos-emr/mycarlos/blob/a81c3947db38e042427bd8fc6b72cf1072890328/docs/pr-screenshots/71b-history/after-200-security.png?raw=true) |

**[comment](https://github.com/carlos-emr/mycarlos/pull/81#issuecomment-6332430890)** — 22 Oct update for Ben’s visual review, pinned to 938fcda: after only, at app source 60c2b7a.

**desktop what is kept**

![desktop what is kept](https://raw.githubusercontent.com/carlos-emr/mycarlos/938fcda87187cdcd40a0532d7ca1866d14f7aab9/docs/pr-screenshots/pr-81-20261021-r2/81-desktop-what-is-kept.png)

**phone what is kept**

![phone what is kept](https://raw.githubusercontent.com/carlos-emr/mycarlos/938fcda87187cdcd40a0532d7ca1866d14f7aab9/docs/pr-screenshots/pr-81-20261021-r2/81-phone-what-is-kept.png)


---

### [#82](https://github.com/carlos-emr/mycarlos/pull/82) feat(vault): set vaults aside instead of erasing them — #71 part C

- [ ] Reviewed by Ben

Starting again or restoring over a vault now sets the old vault aside, still encrypted, instead of erasing it. Since Ben’s D89 it is offered only under “Forgot your passphrase?” on the unlock screen, not in Security. Merged 22 Oct into [#81](https://github.com/carlos-emr/mycarlos/pull/81)’s branch (`feat/hide-documents-history`); reached main with [#79](https://github.com/carlos-emr/mycarlos/pull/79) the same day.

**[comment](https://github.com/carlos-emr/mycarlos/pull/82#issuecomment-6273661606)** — 19 Oct, pinned to 06bdf4d: the end of Security, before and after its “Set this vault aside” section was removed (D89).

| | Before | After |
|---|---|---|
| Phone (390px) | ![](https://raw.githubusercontent.com/carlos-emr/mycarlos/06bdf4d3b32abc552bea5c16d0697200e846d8ab/docs/pr-screenshots/71c-no-reset-in-security/before-phone-security-end.png) | ![](https://raw.githubusercontent.com/carlos-emr/mycarlos/06bdf4d3b32abc552bea5c16d0697200e846d8ab/docs/pr-screenshots/71c-no-reset-in-security/after-phone-security-end.png) |
| Computer (900px) | ![](https://raw.githubusercontent.com/carlos-emr/mycarlos/06bdf4d3b32abc552bea5c16d0697200e846d8ab/docs/pr-screenshots/71c-no-reset-in-security/before-desktop-security-end.png) | ![](https://raw.githubusercontent.com/carlos-emr/mycarlos/06bdf4d3b32abc552bea5c16d0697200e846d8ab/docs/pr-screenshots/71c-no-reset-in-security/after-desktop-security-end.png) |

**[comment](https://github.com/carlos-emr/mycarlos/pull/82#issuecomment-6332435541)** — 22 Oct update for Ben’s visual review, pinned to d82ae65: after only, at app source 2033b92.

**desktop 1 security end**

![desktop 1 security end](https://raw.githubusercontent.com/carlos-emr/mycarlos/d82ae6523e7a07a0cb07db74528cbecc063b4e2f/docs/pr-screenshots/pr-82-20261021-r2/82-desktop-1-security-end.png)

**desktop 2 unlock forgot**

![desktop 2 unlock forgot](https://raw.githubusercontent.com/carlos-emr/mycarlos/d82ae6523e7a07a0cb07db74528cbecc063b4e2f/docs/pr-screenshots/pr-82-20261021-r2/82-desktop-2-unlock-forgot.png)

**phone 1 security end**

![phone 1 security end](https://raw.githubusercontent.com/carlos-emr/mycarlos/d82ae6523e7a07a0cb07db74528cbecc063b4e2f/docs/pr-screenshots/pr-82-20261021-r2/82-phone-1-security-end.png)

**phone 2 unlock forgot**

![phone 2 unlock forgot](https://raw.githubusercontent.com/carlos-emr/mycarlos/d82ae6523e7a07a0cb07db74528cbecc063b4e2f/docs/pr-screenshots/pr-82-20261021-r2/82-phone-2-unlock-forgot.png)

[The first set](https://github.com/carlos-emr/mycarlos/pull/82#issuecomment-6229403540) (17 Oct, 18 images) is not repeated here: it shows Security’s “starting again” section that D89 removed, and Restore over a different vault.

---

### [#62](https://github.com/carlos-emr/mycarlos/pull/62) feat(share): unlock a password-protected PDF once, at import

- [ ] Reviewed by Ben

A password-locked PDF can be unlocked once from its details (Unlock…): myCarlos keeps the locked original and adds an unlocked copy. It never keeps the password. Merged 22 Oct.

**[PR description](https://github.com/carlos-emr/mycarlos/pull/62)** — Pinned to 36c1d80. No shot shows a password or a recovery key.

| 1. A locked PDF's details | 2. Unlock asks for the password | 3. A wrong password |
|---|---|---|
| ![](https://raw.githubusercontent.com/carlos-emr/mycarlos/36c1d8033b5d9fd1ff520279cacb94d490693c94/docs/pr-screenshots/62-folder/after-desktop-100-1-details-locked.png) | ![](https://raw.githubusercontent.com/carlos-emr/mycarlos/36c1d8033b5d9fd1ff520279cacb94d490693c94/docs/pr-screenshots/62-folder/after-desktop-100-2-password-prompt.png) | ![](https://raw.githubusercontent.com/carlos-emr/mycarlos/36c1d8033b5d9fd1ff520279cacb94d490693c94/docs/pr-screenshots/62-folder/after-desktop-100-3-wrong-password.png) |

| 4. Unlocked: the copy's details | 5. The library: the copy and the locked original | Phone: marked, no Unlock |
|---|---|---|
| ![](https://raw.githubusercontent.com/carlos-emr/mycarlos/36c1d8033b5d9fd1ff520279cacb94d490693c94/docs/pr-screenshots/62-folder/after-desktop-100-4-unlocked-copy.png) | ![](https://raw.githubusercontent.com/carlos-emr/mycarlos/36c1d8033b5d9fd1ff520279cacb94d490693c94/docs/pr-screenshots/62-folder/after-desktop-100-5-library-after.png) | ![](https://raw.githubusercontent.com/carlos-emr/mycarlos/36c1d8033b5d9fd1ff520279cacb94d490693c94/docs/pr-screenshots/62-folder/after-phone-100-1-details-locked.png) |

[The 20 Oct comment](https://github.com/carlos-emr/mycarlos/pull/62#issuecomment-6302628213) repeats the same six images.

---

### [#64](https://github.com/carlos-emr/mycarlos/pull/64) feat(reader): read a stored PDF inside myCarlos (#48, first step)

- [ ] Reviewed by Ben

Read: a stored PDF opens inside myCarlos, one page at a time, with Smaller, Larger and Fit width, a “Text on this page” panel, and a request for the document password when the PDF is locked. Merged 22 Oct into [#62](https://github.com/carlos-emr/mycarlos/pull/62)’s branch (`feat/unlock-encrypted-pdf`); reached main with [#62](https://github.com/carlos-emr/mycarlos/pull/62) the same day.

**[PR description](https://github.com/carlos-emr/mycarlos/pull/64)** — Pinned to cfc0a0d: pages drawn by the real PDF helper; the last two are the real Linux app.

| Page at Fit width | Text panel open | Document password | Page 2 at 125 % |
|---|---|---|---|
| ![1-page](https://raw.githubusercontent.com/carlos-emr/mycarlos/cfc0a0d810564f6391e4031762341256376ee304/docs/pr-screenshots/48/1-page.png) | ![2-page-text](https://raw.githubusercontent.com/carlos-emr/mycarlos/cfc0a0d810564f6391e4031762341256376ee304/docs/pr-screenshots/48/2-page-text.png) | ![3-document-password](https://raw.githubusercontent.com/carlos-emr/mycarlos/cfc0a0d810564f6391e4031762341256376ee304/docs/pr-screenshots/48/3-document-password.png) | ![4-locked-page-2-zoomed](https://raw.githubusercontent.com/carlos-emr/mycarlos/cfc0a0d810564f6391e4031762341256376ee304/docs/pr-screenshots/48/4-locked-page-2-zoomed.png) |

| Phone | Real Linux app: page 1 | Real Linux app: page 2 with text |
|---|---|---|
| ![phone-1-page](https://raw.githubusercontent.com/carlos-emr/mycarlos/cfc0a0d810564f6391e4031762341256376ee304/docs/pr-screenshots/48/phone-1-page.png) | ![linux-desktop-reader-page-1](https://raw.githubusercontent.com/carlos-emr/mycarlos/cfc0a0d810564f6391e4031762341256376ee304/docs/pr-screenshots/48/linux-desktop-reader-page-1.png) | ![linux-desktop-reader-page-2-text](https://raw.githubusercontent.com/carlos-emr/mycarlos/cfc0a0d810564f6391e4031762341256376ee304/docs/pr-screenshots/48/linux-desktop-reader-page-2-text.png) |


---

### [#58](https://github.com/carlos-emr/mycarlos/pull/58) feat(library): search the open folder and every folder below it

- [ ] Reviewed by Ben

Library search covers the open folder and every folder below it, and each result shows its folder path. Merged 22 Oct.

**[PR description](https://github.com/carlos-emr/mycarlos/pull/58)** — Pinned to f4bce41.

| | Before | After |
|---|---|---|
| Top level, "blood": 1 result before; all 5, each with its path, after | ![before](https://raw.githubusercontent.com/carlos-emr/mycarlos/f4bce418181ddeaf5b06f4914b91b28dd6ec4f6a/docs/pr-screenshots/57/before-1-top-level-blood.png) | ![after](https://raw.githubusercontent.com/carlos-emr/mycarlos/f4bce418181ddeaf5b06f4914b91b28dd6ec4f6a/docs/pr-screenshots/57/after-1-top-level-blood.png) |
| In "FAKE Lab results", "blood test": the copy two levels down is now found | ![before](https://raw.githubusercontent.com/carlos-emr/mycarlos/f4bce418181ddeaf5b06f4914b91b28dd6ec4f6a/docs/pr-screenshots/57/before-2-lab-results-blood-test.png) | ![after](https://raw.githubusercontent.com/carlos-emr/mycarlos/f4bce418181ddeaf5b06f4914b91b28dd6ec4f6a/docs/pr-screenshots/57/after-2-lab-results-blood-test.png) |
| Top level, "june": folders at any depth | ![before](https://raw.githubusercontent.com/carlos-emr/mycarlos/f4bce418181ddeaf5b06f4914b91b28dd6ec4f6a/docs/pr-screenshots/57/before-3-top-level-june-folders.png) | ![after](https://raw.githubusercontent.com/carlos-emr/mycarlos/f4bce418181ddeaf5b06f4914b91b28dd6ec4f6a/docs/pr-screenshots/57/after-3-top-level-june-folders.png) |
| No search: the new placeholder | ![before](https://raw.githubusercontent.com/carlos-emr/mycarlos/f4bce418181ddeaf5b06f4914b91b28dd6ec4f6a/docs/pr-screenshots/57/before-4-lab-results-no-search.png) | ![after](https://raw.githubusercontent.com/carlos-emr/mycarlos/f4bce418181ddeaf5b06f4914b91b28dd6ec4f6a/docs/pr-screenshots/57/after-4-lab-results-no-search.png) |
| Phone width (after only) | — | ![after](https://raw.githubusercontent.com/carlos-emr/mycarlos/f4bce418181ddeaf5b06f4914b91b28dd6ec4f6a/docs/pr-screenshots/57/after-5-phone-top-level-blood.png) |
| Grid view (after only) | — | ![after](https://raw.githubusercontent.com/carlos-emr/mycarlos/f4bce418181ddeaf5b06f4914b91b28dd6ec4f6a/docs/pr-screenshots/57/after-6-grid-lab-results-blood-test.png) |


---

### [#65](https://github.com/carlos-emr/mycarlos/pull/65) feat(i18n): translate Security, recovery key setup and more screens (#46 part 2)

- [ ] Reviewed by Ben

Security, recovery key setup, the printed recovery kit, the app’s notices, the lock warning, Preferences and the photo viewer now appear in all five languages. Merged 22 Oct.

_No screenshots were published on this PR. Its comments have back-translation tables for the new wording._

---

### [#61](https://github.com/carlos-emr/mycarlos/pull/61) feat(share): receive files shared with myCarlos while it is open (#49, part 1)

- [ ] Reviewed by Ben

Files shared with myCarlos from other apps arrive in a “Shared with me” folder with an “N new” count, and move from there to a person. Each person is a top-level folder. Merged 22 Oct.

**[comment](https://github.com/carlos-emr/mycarlos/pull/61#issuecomment-6323488407)** — 21 Oct folder layout (Ben, 21 Oct), pinned to fe45fe8: 1100 px desktop and 390 px phone, 100% text. The PR says these replace every earlier sidebar and phone-tab screenshot. After only.

**Several people**

- **Library:** each person over their own folders, then Shared with me.

![desktop](https://raw.githubusercontent.com/carlos-emr/mycarlos/fe45fe8a8a1bb0849e1e8d1f89081d6706d50d52/docs/pr-screenshots/61-folders/several-desktop-100-1-library.png) ![phone](https://raw.githubusercontent.com/carlos-emr/mycarlos/fe45fe8a8a1bb0849e1e8d1f89081d6706d50d52/docs/pr-screenshots/61-folders/several-phone-100-1-library.png)

- **Shared with me open:** no person is open, the brand line says "Private vault", and the footer counts the whole vault.

![desktop](https://raw.githubusercontent.com/carlos-emr/mycarlos/fe45fe8a8a1bb0849e1e8d1f89081d6706d50d52/docs/pr-screenshots/61-folders/several-desktop-100-2-shared.png) ![phone](https://raw.githubusercontent.com/carlos-emr/mycarlos/fe45fe8a8a1bb0849e1e8d1f89081d6706d50d52/docs/pr-screenshots/61-folders/several-phone-100-2-shared.png)

- **A file's details, with Move to a person**

![desktop](https://raw.githubusercontent.com/carlos-emr/mycarlos/fe45fe8a8a1bb0849e1e8d1f89081d6706d50d52/docs/pr-screenshots/61-folders/several-desktop-100-3-chosen.png) ![phone](https://raw.githubusercontent.com/carlos-emr/mycarlos/fe45fe8a8a1bb0849e1e8d1f89081d6706d50d52/docs/pr-screenshots/61-folders/several-phone-100-3-chosen.png)

- **Another person's folder, opened from the tree:** the path reads "FAKE Blake Example › FAKE School forms".

![desktop](https://raw.githubusercontent.com/carlos-emr/mycarlos/fe45fe8a8a1bb0849e1e8d1f89081d6706d50d52/docs/pr-screenshots/61-folders/several-desktop-100-4-other-person-folder.png) ![phone](https://raw.githubusercontent.com/carlos-emr/mycarlos/fe45fe8a8a1bb0849e1e8d1f89081d6706d50d52/docs/pr-screenshots/61-folders/several-phone-100-4-other-person-folder.png)

**One person:** My records over its folders, then Shared with me.

![desktop](https://raw.githubusercontent.com/carlos-emr/mycarlos/fe45fe8a8a1bb0849e1e8d1f89081d6706d50d52/docs/pr-screenshots/61-folders/one-desktop-100-1-library.png) ![phone](https://raw.githubusercontent.com/carlos-emr/mycarlos/fe45fe8a8a1bb0849e1e8d1f89081d6706d50d52/docs/pr-screenshots/61-folders/one-phone-100-1-library.png)

![desktop](https://raw.githubusercontent.com/carlos-emr/mycarlos/fe45fe8a8a1bb0849e1e8d1f89081d6706d50d52/docs/pr-screenshots/61-folders/one-desktop-100-2-shared.png) ![phone](https://raw.githubusercontent.com/carlos-emr/mycarlos/fe45fe8a8a1bb0849e1e8d1f89081d6706d50d52/docs/pr-screenshots/61-folders/one-phone-100-2-shared.png)

![desktop](https://raw.githubusercontent.com/carlos-emr/mycarlos/fe45fe8a8a1bb0849e1e8d1f89081d6706d50d52/docs/pr-screenshots/61-folders/one-desktop-100-3-chosen.png) ![phone](https://raw.githubusercontent.com/carlos-emr/mycarlos/fe45fe8a8a1bb0849e1e8d1f89081d6706d50d52/docs/pr-screenshots/61-folders/one-phone-100-3-chosen.png)

Earlier sets, replaced by the one above: [the PR description](https://github.com/carlos-emr/mycarlos/pull/61) (before = the old tab), [the 20 Oct “Shared with me as its own tab” round](https://github.com/carlos-emr/mycarlos/pull/61#issuecomment-6294008011), [the shots after the 20 Oct main merge](https://github.com/carlos-emr/mycarlos/pull/61#issuecomment-6301645693), and [the 21 Oct “Shared with me above the people” round](https://github.com/carlos-emr/mycarlos/pull/61#issuecomment-6319318267).

---

### [#59](https://github.com/carlos-emr/mycarlos/pull/59) feat(i18n): translation foundation and first screens in five languages

- [ ] Reviewed by Ben

The unlock and first-setup screens in five languages (English, French (Canada), Spanish, Polish, Portuguese (Brazil)), following the system language. Merged 20 Oct.

**[comment](https://github.com/carlos-emr/mycarlos/pull/59#issuecomment-6274711990)** — 19 Oct, pinned to 0745e1e: light, 100% text, empty forms. After only.

**The translated screens in all five languages** (FAKE data, empty forms; 100% text, light mode; the language follows the system's, here the browser locale). From 0745e1e, removed again in 56812e4.

| Language | Unlock | First setup |
|---|---|---|
| English | ![](https://raw.githubusercontent.com/carlos-emr/mycarlos/0745e1ef1c6fde581e2aba68a46bfda050ecec65/docs/pr-screenshots/46-translations/en-CA-1-unlock.png) | ![](https://raw.githubusercontent.com/carlos-emr/mycarlos/0745e1ef1c6fde581e2aba68a46bfda050ecec65/docs/pr-screenshots/46-translations/en-CA-2-setup.png) |
| Français (Canada) | ![](https://raw.githubusercontent.com/carlos-emr/mycarlos/0745e1ef1c6fde581e2aba68a46bfda050ecec65/docs/pr-screenshots/46-translations/fr-CA-1-unlock.png) | ![](https://raw.githubusercontent.com/carlos-emr/mycarlos/0745e1ef1c6fde581e2aba68a46bfda050ecec65/docs/pr-screenshots/46-translations/fr-CA-2-setup.png) |
| Español | ![](https://raw.githubusercontent.com/carlos-emr/mycarlos/0745e1ef1c6fde581e2aba68a46bfda050ecec65/docs/pr-screenshots/46-translations/es-1-unlock.png) | ![](https://raw.githubusercontent.com/carlos-emr/mycarlos/0745e1ef1c6fde581e2aba68a46bfda050ecec65/docs/pr-screenshots/46-translations/es-2-setup.png) |
| Polski | ![](https://raw.githubusercontent.com/carlos-emr/mycarlos/0745e1ef1c6fde581e2aba68a46bfda050ecec65/docs/pr-screenshots/46-translations/pl-1-unlock.png) | ![](https://raw.githubusercontent.com/carlos-emr/mycarlos/0745e1ef1c6fde581e2aba68a46bfda050ecec65/docs/pr-screenshots/46-translations/pl-2-setup.png) |
| Português (Brasil) | ![](https://raw.githubusercontent.com/carlos-emr/mycarlos/0745e1ef1c6fde581e2aba68a46bfda050ecec65/docs/pr-screenshots/46-translations/pt-BR-1-unlock.png) | ![](https://raw.githubusercontent.com/carlos-emr/mycarlos/0745e1ef1c6fde581e2aba68a46bfda050ecec65/docs/pr-screenshots/46-translations/pt-BR-2-setup.png) |


---

### [#93](https://github.com/carlos-emr/mycarlos/pull/93) fix(camera): save photos over either IPC path, and no stale message in the camera window

- [ ] Reviewed by Ben

Use photo saves again on Windows (it failed with “Something you typed wasn’t accepted”), the camera window no longer shows an old library message, and a lost photo says “The photo did not reach the vault…”. Merged 20 Oct.

_No screenshots were published on this PR._

---

### [#75](https://github.com/carlos-emr/mycarlos/pull/75) feat(a11y): easier controls in the app: a Move button, words on buttons, fewer dropdowns, 44px targets

- [ ] Reviewed by Ben

Words on buttons, a Move button in details, patient buttons and radio buttons instead of dropdowns, − and + for the lock delay, 44 px targets, and reworked phone spacing. Merged 20 Oct.

**[comment](https://github.com/carlos-emr/mycarlos/pull/75#issuecomment-6226418243)** — 16 Oct, pinned to 86c6848: before = main 3529ae1, after = 8fce650; light, 100% and 200% text.

**Before and after at 100% and 200% text size, light** (#67; FAKE data only). Dark mode comes with #60.

| | Before (main, 3529ae1) | After (8fce650) |
|---|---|---|
| Library, 100% | ![before, library, 100%](https://github.com/carlos-emr/mycarlos/blob/86c68481595044703d883adb445be3e8cbc0a24c/docs/pr-screenshots/67-easier-controls/before-100-1-library.png?raw=true) | ![after, library, 100%](https://github.com/carlos-emr/mycarlos/blob/86c68481595044703d883adb445be3e8cbc0a24c/docs/pr-screenshots/67-easier-controls/after-100-1-library.png?raw=true) |
| Library, 200% | ![before, library, 200%](https://github.com/carlos-emr/mycarlos/blob/86c68481595044703d883adb445be3e8cbc0a24c/docs/pr-screenshots/67-easier-controls/before-200-1-library.png?raw=true) | ![after, library, 200%](https://github.com/carlos-emr/mycarlos/blob/86c68481595044703d883adb445be3e8cbc0a24c/docs/pr-screenshots/67-easier-controls/after-200-1-library.png?raw=true) |
| Document details, 100% | ![before, details, 100%](https://github.com/carlos-emr/mycarlos/blob/86c68481595044703d883adb445be3e8cbc0a24c/docs/pr-screenshots/67-easier-controls/before-100-2-details.png?raw=true) | ![after, details, 100%](https://github.com/carlos-emr/mycarlos/blob/86c68481595044703d883adb445be3e8cbc0a24c/docs/pr-screenshots/67-easier-controls/after-100-2-details.png?raw=true) |
| Document details, 200% | ![before, details, 200%](https://github.com/carlos-emr/mycarlos/blob/86c68481595044703d883adb445be3e8cbc0a24c/docs/pr-screenshots/67-easier-controls/before-200-2-details.png?raw=true) | ![after, details, 200%](https://github.com/carlos-emr/mycarlos/blob/86c68481595044703d883adb445be3e8cbc0a24c/docs/pr-screenshots/67-easier-controls/after-200-2-details.png?raw=true) |
| Security: Lock automatically, 100% | ![before, auto-lock, 100%](https://github.com/carlos-emr/mycarlos/blob/86c68481595044703d883adb445be3e8cbc0a24c/docs/pr-screenshots/67-easier-controls/before-100-3-auto-lock.png?raw=true) | ![after, auto-lock, 100%](https://github.com/carlos-emr/mycarlos/blob/86c68481595044703d883adb445be3e8cbc0a24c/docs/pr-screenshots/67-easier-controls/after-100-3-auto-lock.png?raw=true) |
| Security: Lock automatically, 200% | ![before, auto-lock, 200%](https://github.com/carlos-emr/mycarlos/blob/86c68481595044703d883adb445be3e8cbc0a24c/docs/pr-screenshots/67-easier-controls/before-200-3-auto-lock.png?raw=true) | ![after, auto-lock, 200%](https://github.com/carlos-emr/mycarlos/blob/86c68481595044703d883adb445be3e8cbc0a24c/docs/pr-screenshots/67-easier-controls/after-200-3-auto-lock.png?raw=true) |
| Phone width (390px), 100% | ![before, phone](https://github.com/carlos-emr/mycarlos/blob/86c68481595044703d883adb445be3e8cbc0a24c/docs/pr-screenshots/67-easier-controls/before-100-4-phone-library.png?raw=true) | ![after, phone](https://github.com/carlos-emr/mycarlos/blob/86c68481595044703d883adb445be3e8cbc0a24c/docs/pr-screenshots/67-easier-controls/after-100-4-phone-library.png?raw=true) |

**[comment](https://github.com/carlos-emr/mycarlos/pull/75#issuecomment-6274184268)** — 19 Oct review round, pinned to 44e0664: Move keeps focus in the dialog, and the chosen tab shows by more than colour; before = main.

| | Before (main) | After |
|---|---|---|
| Library, 100% | ![](https://raw.githubusercontent.com/carlos-emr/mycarlos/44e06642a84053cbfe472913c2f48ae3be702b89/docs/pr-screenshots/67-easier-controls-r2/before-100-1-library.png) | ![](https://raw.githubusercontent.com/carlos-emr/mycarlos/44e06642a84053cbfe472913c2f48ae3be702b89/docs/pr-screenshots/67-easier-controls-r2/after-100-1-library.png) |
| Details, 100% | ![](https://raw.githubusercontent.com/carlos-emr/mycarlos/44e06642a84053cbfe472913c2f48ae3be702b89/docs/pr-screenshots/67-easier-controls-r2/before-100-2-details.png) | ![](https://raw.githubusercontent.com/carlos-emr/mycarlos/44e06642a84053cbfe472913c2f48ae3be702b89/docs/pr-screenshots/67-easier-controls-r2/after-100-2-details.png) |
| Library, 200% text | ![](https://raw.githubusercontent.com/carlos-emr/mycarlos/44e06642a84053cbfe472913c2f48ae3be702b89/docs/pr-screenshots/67-easier-controls-r2/before-200-1-library.png) | ![](https://raw.githubusercontent.com/carlos-emr/mycarlos/44e06642a84053cbfe472913c2f48ae3be702b89/docs/pr-screenshots/67-easier-controls-r2/after-200-1-library.png) |
| Details, 200% text | ![](https://raw.githubusercontent.com/carlos-emr/mycarlos/44e06642a84053cbfe472913c2f48ae3be702b89/docs/pr-screenshots/67-easier-controls-r2/before-200-2-details.png) | ![](https://raw.githubusercontent.com/carlos-emr/mycarlos/44e06642a84053cbfe472913c2f48ae3be702b89/docs/pr-screenshots/67-easier-controls-r2/after-200-2-details.png) |
| Phone | ![](https://raw.githubusercontent.com/carlos-emr/mycarlos/44e06642a84053cbfe472913c2f48ae3be702b89/docs/pr-screenshots/67-easier-controls-r2/before-100-3-phone-library.png) | ![](https://raw.githubusercontent.com/carlos-emr/mycarlos/44e06642a84053cbfe472913c2f48ae3be702b89/docs/pr-screenshots/67-easier-controls-r2/after-100-3-phone-library.png) |

**[comment](https://github.com/carlos-emr/mycarlos/pull/75#issuecomment-6275608338)** — 19 Oct, Ben’s review round, pinned to f560a3d: phone spacing; before = 92cab20, after = e108287.

| | Before | After |
|---|---|---|
| Library, 390px, 100% | ![](https://raw.githubusercontent.com/carlos-emr/mycarlos/f560a3d8cb503d20a520b0480d84416b804be3c1/docs/pr-screenshots/67-phone-spacing/before-390-100-1-library.png) | ![](https://raw.githubusercontent.com/carlos-emr/mycarlos/f560a3d8cb503d20a520b0480d84416b804be3c1/docs/pr-screenshots/67-phone-spacing/after-390-100-1-library.png) |
| Library, 390px, 200% | ![](https://raw.githubusercontent.com/carlos-emr/mycarlos/f560a3d8cb503d20a520b0480d84416b804be3c1/docs/pr-screenshots/67-phone-spacing/before-390-200-1-library.png) | ![](https://raw.githubusercontent.com/carlos-emr/mycarlos/f560a3d8cb503d20a520b0480d84416b804be3c1/docs/pr-screenshots/67-phone-spacing/after-390-200-1-library.png) |
| Library, 320px, 100% | ![](https://raw.githubusercontent.com/carlos-emr/mycarlos/f560a3d8cb503d20a520b0480d84416b804be3c1/docs/pr-screenshots/67-phone-spacing/before-320-100-1-library.png) | ![](https://raw.githubusercontent.com/carlos-emr/mycarlos/f560a3d8cb503d20a520b0480d84416b804be3c1/docs/pr-screenshots/67-phone-spacing/after-320-100-1-library.png) |
| Library, 320px, 200% | ![](https://raw.githubusercontent.com/carlos-emr/mycarlos/f560a3d8cb503d20a520b0480d84416b804be3c1/docs/pr-screenshots/67-phone-spacing/before-320-200-1-library.png) | ![](https://raw.githubusercontent.com/carlos-emr/mycarlos/f560a3d8cb503d20a520b0480d84416b804be3c1/docs/pr-screenshots/67-phone-spacing/after-320-200-1-library.png) |
| Security, 390px, 100% | ![](https://raw.githubusercontent.com/carlos-emr/mycarlos/f560a3d8cb503d20a520b0480d84416b804be3c1/docs/pr-screenshots/67-phone-spacing/before-390-100-2-security.png) | ![](https://raw.githubusercontent.com/carlos-emr/mycarlos/f560a3d8cb503d20a520b0480d84416b804be3c1/docs/pr-screenshots/67-phone-spacing/after-390-100-2-security.png) |
| Security, 390px, 200% | ![](https://raw.githubusercontent.com/carlos-emr/mycarlos/f560a3d8cb503d20a520b0480d84416b804be3c1/docs/pr-screenshots/67-phone-spacing/before-390-200-2-security.png) | ![](https://raw.githubusercontent.com/carlos-emr/mycarlos/f560a3d8cb503d20a520b0480d84416b804be3c1/docs/pr-screenshots/67-phone-spacing/after-390-200-2-security.png) |
| Security, 320px, 100% | ![](https://raw.githubusercontent.com/carlos-emr/mycarlos/f560a3d8cb503d20a520b0480d84416b804be3c1/docs/pr-screenshots/67-phone-spacing/before-320-100-2-security.png) | ![](https://raw.githubusercontent.com/carlos-emr/mycarlos/f560a3d8cb503d20a520b0480d84416b804be3c1/docs/pr-screenshots/67-phone-spacing/after-320-100-2-security.png) |
| Security, 320px, 200% | ![](https://raw.githubusercontent.com/carlos-emr/mycarlos/f560a3d8cb503d20a520b0480d84416b804be3c1/docs/pr-screenshots/67-phone-spacing/before-320-200-2-security.png) | ![](https://raw.githubusercontent.com/carlos-emr/mycarlos/f560a3d8cb503d20a520b0480d84416b804be3c1/docs/pr-screenshots/67-phone-spacing/after-320-200-2-security.png) |

Not repeated here: [the 19 Oct CI follow-up](https://github.com/carlos-emr/mycarlos/pull/75#issuecomment-6273012228) (8 images; names wrap instead of being cut short at phone widths, and the section tabs fit at 320 px).

---

### [#77](https://github.com/carlos-emr/mycarlos/pull/77) feat(a11y): warn 30 seconds before the automatic lock, and say why it locked

- [ ] Reviewed by Ben

A 30-second warning before the automatic lock (counting down, with Keep open), and the unlock screen says why the vault locked. Merged 20 Oct.

**[comment](https://github.com/carlos-emr/mycarlos/pull/77#issuecomment-6227594166)** — 17 Oct, pinned to dbf395f: before = main 3529ae1, after = a68185e; light.

**Before and after: the warning before the automatic lock, and the reason on the unlock screen** (#68; FAKE data only; light). Dark mode comes with #60.

| | Before (main, 3529ae1) | After (a68185e) |
|---|---|---|
| Warning, 100% | (none: the vault just locked) | ![after, warning, 100%](https://github.com/carlos-emr/mycarlos/blob/dbf395f5aa5bdefce4f1f8b37d07661f548dc5e8/docs/pr-screenshots/68-auto-lock-warning/after-100-1-warning.png?raw=true) |
| Warning, 200% | (none) | ![after, warning, 200%](https://github.com/carlos-emr/mycarlos/blob/dbf395f5aa5bdefce4f1f8b37d07661f548dc5e8/docs/pr-screenshots/68-auto-lock-warning/after-200-1-warning.png?raw=true) |
| Warning, 400% | (none) | ![after, warning, 400%](https://github.com/carlos-emr/mycarlos/blob/dbf395f5aa5bdefce4f1f8b37d07661f548dc5e8/docs/pr-screenshots/68-auto-lock-warning/after-400-1-warning.png?raw=true) |
| Unlock after the automatic lock, 100% | ![before, unlock, 100%](https://github.com/carlos-emr/mycarlos/blob/dbf395f5aa5bdefce4f1f8b37d07661f548dc5e8/docs/pr-screenshots/68-auto-lock-warning/before-100-2-unlock-idle.png?raw=true) | ![after, unlock, 100%](https://github.com/carlos-emr/mycarlos/blob/dbf395f5aa5bdefce4f1f8b37d07661f548dc5e8/docs/pr-screenshots/68-auto-lock-warning/after-100-2-unlock-idle.png?raw=true) |
| Unlock after the automatic lock, 200% | ![before, unlock, 200%](https://github.com/carlos-emr/mycarlos/blob/dbf395f5aa5bdefce4f1f8b37d07661f548dc5e8/docs/pr-screenshots/68-auto-lock-warning/before-200-2-unlock-idle.png?raw=true) | ![after, unlock, 200%](https://github.com/carlos-emr/mycarlos/blob/dbf395f5aa5bdefce4f1f8b37d07661f548dc5e8/docs/pr-screenshots/68-auto-lock-warning/after-200-2-unlock-idle.png?raw=true) |
| Unlock after hiding myCarlos, 100% | ![before, hidden, 100%](https://github.com/carlos-emr/mycarlos/blob/dbf395f5aa5bdefce4f1f8b37d07661f548dc5e8/docs/pr-screenshots/68-auto-lock-warning/before-100-3-unlock-hidden.png?raw=true) | ![after, hidden, 100%](https://github.com/carlos-emr/mycarlos/blob/dbf395f5aa5bdefce4f1f8b37d07661f548dc5e8/docs/pr-screenshots/68-auto-lock-warning/after-100-3-unlock-hidden.png?raw=true) |

Not repeated here: [Ben’s 20 Oct review round](https://github.com/carlos-emr/mycarlos/pull/77#issuecomment-6292748833) (12 images: the warning now counts down from 30, shown as it opens and 18 seconds later).

---

### [#87](https://github.com/carlos-emr/mycarlos/pull/87) fix(a11y): first setup fits its window at 200% default text (part of #84)

- [ ] Reviewed by Ben

At twice the default text size, first setup and Restore from a backup fit a phone window instead of being cut off. Merged 20 Oct.

**[PR description](https://github.com/carlos-emr/mycarlos/pull/87)** — Pinned to c6991fa: phone at 200% default text; before = main, after = this PR.

| | Before | After |
|---|---|---|
| First setup | ![](https://raw.githubusercontent.com/carlos-emr/mycarlos/c6991fa48509f9bf2eddd77f144df3088bed747c/docs/pr-screenshots/84-setup-200/before-1-setup.png) | ![](https://raw.githubusercontent.com/carlos-emr/mycarlos/c6991fa48509f9bf2eddd77f144df3088bed747c/docs/pr-screenshots/84-setup-200/after-1-setup.png) |
| Restore from a backup, agreement | ![](https://raw.githubusercontent.com/carlos-emr/mycarlos/c6991fa48509f9bf2eddd77f144df3088bed747c/docs/pr-screenshots/84-setup-200/before-2-restore-agreement.png) | ![](https://raw.githubusercontent.com/carlos-emr/mycarlos/c6991fa48509f9bf2eddd77f144df3088bed747c/docs/pr-screenshots/84-setup-200/after-2-restore-agreement.png) |


---

### [#83](https://github.com/carlos-emr/mycarlos/pull/83) feat(camera): take a photo with the computer's camera, straight into the vault

- [ ] Reviewed by Ben

Take a photo with the computer’s camera, saved straight into the vault, and a photo view with zoom and drag to move. Merged 20 Oct.

**[comment](https://github.com/carlos-emr/mycarlos/pull/83#issuecomment-6235051796)** — 17 Oct, pinned to 9e932eb: before = main 3529ae1, after = f2ede96; Windows layout, Chromium’s fake camera.

**Before and after: taking a photo, saving it and viewing it** (#73; FAKE data only, Chromium's fake camera, Windows layout).

| | Before (main, 3529ae1) | After (f2ede96) |
|---|---|---|
| Library toolbar | ![before, toolbar](https://github.com/carlos-emr/mycarlos/blob/9e932eb2b877c3be12c5f09fb637fab27958454c/docs/pr-screenshots/73-camera-photo/01-before-toolbar.png?raw=true) | ![after, toolbar with Take a photo](https://github.com/carlos-emr/mycarlos/blob/9e932eb2b877c3be12c5f09fb637fab27958454c/docs/pr-screenshots/73-camera-photo/02-after-toolbar.png?raw=true) |
| Library | ![before, library](https://github.com/carlos-emr/mycarlos/blob/9e932eb2b877c3be12c5f09fb637fab27958454c/docs/pr-screenshots/73-camera-photo/01-before-library.png?raw=true) | ![after, library](https://github.com/carlos-emr/mycarlos/blob/9e932eb2b877c3be12c5f09fb637fab27958454c/docs/pr-screenshots/73-camera-photo/02-after-library.png?raw=true) |

| Step | After (f2ede96) |
|---|---|
| 1. The first time: why the camera is used, before it is asked for | ![explainer](https://github.com/carlos-emr/mycarlos/blob/9e932eb2b877c3be12c5f09fb637fab27958454c/docs/pr-screenshots/73-camera-photo/03-explainer.png?raw=true) |
| 2. The live camera, with Take photo focused | ![live camera](https://github.com/carlos-emr/mycarlos/blob/9e932eb2b877c3be12c5f09fb637fab27958454c/docs/pr-screenshots/73-camera-photo/04-live.png?raw=true) |
| 3. The still photo (the camera is off), with Retake and Use photo | ![still photo](https://github.com/carlos-emr/mycarlos/blob/9e932eb2b877c3be12c5f09fb637fab27958454c/docs/pr-screenshots/73-camera-photo/05-preview.png?raw=true) |
| 4. Saved: the photo's details, in the open folder, with View photo and Rename | ![saved details](https://github.com/carlos-emr/mycarlos/blob/9e932eb2b877c3be12c5f09fb637fab27958454c/docs/pr-screenshots/73-camera-photo/06-saved-details.png?raw=true) |
| 5. The photo view, fitted to the window | ![photo view](https://github.com/carlos-emr/mycarlos/blob/9e932eb2b877c3be12c5f09fb637fab27958454c/docs/pr-screenshots/73-camera-photo/07-photo-view.png?raw=true) |
| 6. Zoomed in twice (200%) | ![photo view zoomed](https://github.com/carlos-emr/mycarlos/blob/9e932eb2b877c3be12c5f09fb637fab27958454c/docs/pr-screenshots/73-camera-photo/08-photo-view-zoomed.png?raw=true) |
| 7. The camera refused: what to change in Windows Settings | ![camera refused](https://github.com/carlos-emr/mycarlos/blob/9e932eb2b877c3be12c5f09fb637fab27958454c/docs/pr-screenshots/73-camera-photo/09-refused.png?raw=true) |
| 8. A 390 px window at 200% text, the camera live | ![narrow window at 200%](https://github.com/carlos-emr/mycarlos/blob/9e932eb2b877c3be12c5f09fb637fab27958454c/docs/pr-screenshots/73-camera-photo/10-narrow-200-percent-live.png?raw=true) |

Not repeated here: [Ben’s 20 Oct review round](https://github.com/carlos-emr/mycarlos/pull/83#issuecomment-6292403573) (12 images on a FAKE numbered grid: drag to move, and zoom keeps your place).

---

### [#60](https://github.com/carlos-emr/mycarlos/pull/60) feat(a11y): dark mode (System / Light / Dark) and Windows high contrast

- [ ] Reviewed by Ben

Appearance: System, Light or Dark in Preferences, and support for Windows high contrast. Merged 20 Oct.

**[PR description](https://github.com/carlos-emr/mycarlos/pull/60)** — Pinned to afe9f81: light, dark and high contrast.

| | Light | Dark | High contrast |
|---|---|---|---|
| Library | ![desktop-light-library](https://raw.githubusercontent.com/carlos-emr/mycarlos/afe9f817b2a05cdec3cbfaf9c810fc99cca92598/docs/pr-screenshots/47/desktop-light-library.png) | ![desktop-dark-library](https://raw.githubusercontent.com/carlos-emr/mycarlos/afe9f817b2a05cdec3cbfaf9c810fc99cca92598/docs/pr-screenshots/47/desktop-dark-library.png) | ![desktop-forced-library](https://raw.githubusercontent.com/carlos-emr/mycarlos/afe9f817b2a05cdec3cbfaf9c810fc99cca92598/docs/pr-screenshots/47/desktop-forced-library.png) |
| Preferences (focus on Appearance) | ![desktop-light-preferences-focus](https://raw.githubusercontent.com/carlos-emr/mycarlos/afe9f817b2a05cdec3cbfaf9c810fc99cca92598/docs/pr-screenshots/47/desktop-light-preferences-focus.png) | ![desktop-dark-preferences-focus](https://raw.githubusercontent.com/carlos-emr/mycarlos/afe9f817b2a05cdec3cbfaf9c810fc99cca92598/docs/pr-screenshots/47/desktop-dark-preferences-focus.png) | ![desktop-forced-preferences-focus](https://raw.githubusercontent.com/carlos-emr/mycarlos/afe9f817b2a05cdec3cbfaf9c810fc99cca92598/docs/pr-screenshots/47/desktop-forced-preferences-focus.png) |
| Unlock (focus on passphrase) | ![desktop-light-locked-focus](https://raw.githubusercontent.com/carlos-emr/mycarlos/afe9f817b2a05cdec3cbfaf9c810fc99cca92598/docs/pr-screenshots/47/desktop-light-locked-focus.png) | ![desktop-dark-locked-focus](https://raw.githubusercontent.com/carlos-emr/mycarlos/afe9f817b2a05cdec3cbfaf9c810fc99cca92598/docs/pr-screenshots/47/desktop-dark-locked-focus.png) | ![desktop-forced-locked-focus](https://raw.githubusercontent.com/carlos-emr/mycarlos/afe9f817b2a05cdec3cbfaf9c810fc99cca92598/docs/pr-screenshots/47/desktop-forced-locked-focus.png) |
| Rename dialog | ![desktop-light-rename-dialog-focus](https://raw.githubusercontent.com/carlos-emr/mycarlos/afe9f817b2a05cdec3cbfaf9c810fc99cca92598/docs/pr-screenshots/47/desktop-light-rename-dialog-focus.png) | ![desktop-dark-rename-dialog-focus](https://raw.githubusercontent.com/carlos-emr/mycarlos/afe9f817b2a05cdec3cbfaf9c810fc99cca92598/docs/pr-screenshots/47/desktop-dark-rename-dialog-focus.png) | ![desktop-forced-rename-dialog-focus](https://raw.githubusercontent.com/carlos-emr/mycarlos/afe9f817b2a05cdec3cbfaf9c810fc99cca92598/docs/pr-screenshots/47/desktop-forced-rename-dialog-focus.png) |

High contrast, light palette, with the read-only warning and a selected row:

![desktop-forced-warning-selected](https://raw.githubusercontent.com/carlos-emr/mycarlos/afe9f817b2a05cdec3cbfaf9c810fc99cca92598/docs/pr-screenshots/47/desktop-forced-warning-selected.png)

| Phone, dark: library | Preferences | Unlock | Rename |
|---|---|---|---|
| ![phone-dark-library](https://raw.githubusercontent.com/carlos-emr/mycarlos/afe9f817b2a05cdec3cbfaf9c810fc99cca92598/docs/pr-screenshots/47/phone-dark-library.png) | ![phone-dark-preferences-focus](https://raw.githubusercontent.com/carlos-emr/mycarlos/afe9f817b2a05cdec3cbfaf9c810fc99cca92598/docs/pr-screenshots/47/phone-dark-preferences-focus.png) | ![phone-dark-locked-focus](https://raw.githubusercontent.com/carlos-emr/mycarlos/afe9f817b2a05cdec3cbfaf9c810fc99cca92598/docs/pr-screenshots/47/phone-dark-locked-focus.png) | ![phone-dark-rename-dialog-focus](https://raw.githubusercontent.com/carlos-emr/mycarlos/afe9f817b2a05cdec3cbfaf9c810fc99cca92598/docs/pr-screenshots/47/phone-dark-rename-dialog-focus.png) |

**[comment](https://github.com/carlos-emr/mycarlos/pull/60#issuecomment-6277658985)** — 19 Oct, Ben’s review round, pinned to c15e0fb: dark mode on Preferences and Security, and high contrast with its dark palette.

| | 100% | 200% |
|---|---|---|
| Computer, Preferences, dark | ![](https://raw.githubusercontent.com/carlos-emr/mycarlos/c15e0fba68c6494e595d145670ed11021185d05e/docs/pr-screenshots/47-dark-settings/desktop-dark-100-preferences.png) | ![](https://raw.githubusercontent.com/carlos-emr/mycarlos/c15e0fba68c6494e595d145670ed11021185d05e/docs/pr-screenshots/47-dark-settings/desktop-dark-200-preferences.png) |
| Computer, Security, dark | ![](https://raw.githubusercontent.com/carlos-emr/mycarlos/c15e0fba68c6494e595d145670ed11021185d05e/docs/pr-screenshots/47-dark-settings/desktop-dark-100-security.png) | ![](https://raw.githubusercontent.com/carlos-emr/mycarlos/c15e0fba68c6494e595d145670ed11021185d05e/docs/pr-screenshots/47-dark-settings/desktop-dark-200-security.png) |
| Phone, Preferences, dark | ![](https://raw.githubusercontent.com/carlos-emr/mycarlos/c15e0fba68c6494e595d145670ed11021185d05e/docs/pr-screenshots/47-dark-settings/phone-dark-100-preferences.png) | ![](https://raw.githubusercontent.com/carlos-emr/mycarlos/c15e0fba68c6494e595d145670ed11021185d05e/docs/pr-screenshots/47-dark-settings/phone-dark-200-preferences.png) |
| Phone, Security, dark | ![](https://raw.githubusercontent.com/carlos-emr/mycarlos/c15e0fba68c6494e595d145670ed11021185d05e/docs/pr-screenshots/47-dark-settings/phone-dark-100-security.png) | ![](https://raw.githubusercontent.com/carlos-emr/mycarlos/c15e0fba68c6494e595d145670ed11021185d05e/docs/pr-screenshots/47-dark-settings/phone-dark-200-security.png) |

High contrast, dark palette:

| | Preferences (focus on Appearance) | "Changes are paused" notice and a selected row |
|---|---|---|
| Computer | ![](https://raw.githubusercontent.com/carlos-emr/mycarlos/c15e0fba68c6494e595d145670ed11021185d05e/docs/pr-screenshots/47-dark-settings/desktop-forced-dark-preferences-focus.png) | ![](https://raw.githubusercontent.com/carlos-emr/mycarlos/c15e0fba68c6494e595d145670ed11021185d05e/docs/pr-screenshots/47-dark-settings/desktop-forced-dark-warning-selected.png) |
| Phone | ![](https://raw.githubusercontent.com/carlos-emr/mycarlos/c15e0fba68c6494e595d145670ed11021185d05e/docs/pr-screenshots/47-dark-settings/phone-forced-dark-preferences-focus.png) | ![](https://raw.githubusercontent.com/carlos-emr/mycarlos/c15e0fba68c6494e595d145670ed11021185d05e/docs/pr-screenshots/47-dark-settings/phone-forced-dark-warning-selected.png) |

Not repeated here: [the 16 Oct round](https://github.com/carlos-emr/mycarlos/pull/60#issuecomment-6224996187) (4 images; Appearance as three radio buttons instead of a dropdown) and [the 19 Oct review round](https://github.com/carlos-emr/mycarlos/pull/60#issuecomment-6274649224) (8 images; the search and Rename boxes’ edges reach 3:1).

---

## To add after merge

Ben approved merging #126 (merged 28 Oct, now above), then [#104](https://github.com/carlos-emr/mycarlos/pull/104), then [#124](https://github.com/carlos-emr/mycarlos/pull/124). Once each is merged, move it up with its screenshots.

### [#104](https://github.com/carlos-emr/mycarlos/pull/104) Add encrypted profile identity details and explicit PDF suggestions

- [ ] Reviewed by Ben

Profile forms in Security ask for the full name as on clinic documents and a birth date (or “I don’t know”); a PDF in Shared with me can suggest who it belongs to, filed only when Move is pressed.

Screenshots: [27 Oct comment: the profile form before and after, wide and narrow, at enlarged text](https://github.com/carlos-emr/mycarlos/pull/104#issuecomment-6433076715).

### [#124](https://github.com/carlos-emr/mycarlos/pull/124) Add gated clinic approval and durable document pickup

- [ ] Reviewed by Ben

Linking a clinic with first-device approval, and picking up documents from the portal; off unless the portal-linking build option is turned on.

**Screenshots made for this review** (28 Oct, pinned to 0cfd122; #124 published none). The built app with a FAKE native side and FAKE data, not a real clinic, portal or device. Before = main 891a963. After = #124 (31c2246) merged onto that main locally, since #124 does not include #126 yet; its one screen-code conflict (`src/vault.ts`) kept both sides. “200% text” is the browser’s default text size at 32 px.

| | Before: main | After: #124 |
|---|---|---|
| Security | ![before, Security](https://raw.githubusercontent.com/carlos-emr/mycarlos/0cfd12201a3613326bf0c045661e2b3dde6bd82f/docs/ui-tests/pr-124/before-en-1-security.png) | ![after, Security with Clinic documents](https://raw.githubusercontent.com/carlos-emr/mycarlos/0cfd12201a3613326bf0c045661e2b3dde6bd82f/docs/ui-tests/pr-124/after-en-1-security.png) |
| Library (after: once Check for new documents ran) | ![before, library](https://raw.githubusercontent.com/carlos-emr/mycarlos/0cfd12201a3613326bf0c045661e2b3dde6bd82f/docs/ui-tests/pr-124/before-en-2-library.png) | ![after, verified clinic document beside a manual import](https://raw.githubusercontent.com/carlos-emr/mycarlos/0cfd12201a3613326bf0c045661e2b3dde6bd82f/docs/ui-tests/pr-124/after-en-4-library-checked.png) |
| Phone, 360 px, 200% text: library | ![before, phone library](https://raw.githubusercontent.com/carlos-emr/mycarlos/0cfd12201a3613326bf0c045661e2b3dde6bd82f/docs/ui-tests/pr-124/before-en-360-200-library.png) | ![after, phone library after a check](https://raw.githubusercontent.com/carlos-emr/mycarlos/0cfd12201a3613326bf0c045661e2b3dde6bd82f/docs/ui-tests/pr-124/after-en-360-200-library-checked.png) |

| After: Clinic documents | |
|---|---|
| 1. No link yet: the link form | ![link form](https://raw.githubusercontent.com/carlos-emr/mycarlos/0cfd12201a3613326bf0c045661e2b3dde6bd82f/docs/ui-tests/pr-124/after-en-2-link-form.png) |
| 2. Linked; approval request saved | ![approval request saved](https://raw.githubusercontent.com/carlos-emr/mycarlos/0cfd12201a3613326bf0c045661e2b3dde6bd82f/docs/ui-tests/pr-124/after-en-3-awaiting-approval.png) |
| 3. The clinic approved this device | ![approved](https://raw.githubusercontent.com/carlos-emr/mycarlos/0cfd12201a3613326bf0c045661e2b3dde6bd82f/docs/ui-tests/pr-124/after-en-6-approved.png) |
| The verified document’s details | ![verified document details](https://raw.githubusercontent.com/carlos-emr/mycarlos/0cfd12201a3613326bf0c045661e2b3dde6bd82f/docs/ui-tests/pr-124/after-en-5-details.png) |
| French: approval request saved | ![French, approval request saved](https://raw.githubusercontent.com/carlos-emr/mycarlos/0cfd12201a3613326bf0c045661e2b3dde6bd82f/docs/ui-tests/pr-124/after-fr-3-awaiting-approval.png) |
| Phone, 360 px, 200% text: approval request saved | ![phone, approval request saved](https://raw.githubusercontent.com/carlos-emr/mycarlos/0cfd12201a3613326bf0c045661e2b3dde6bd82f/docs/ui-tests/pr-124/after-en-360-200-awaiting-approval.png) |

---

## Left out: no visible change

- #127, #122: dependency updates.
- #101: signed-PDF checks during import; imports stay unverified, so nothing changes on screen.
- #100, #99: docs.
- #98, #94, #78: tests.
- #96: keeps a photo under 4 MB; its description says nothing on screen changes.
- #89: a colour moved into a theme variable; nothing looks different.
- #85: sandbox for the PDF helper; no screen files changed (merged into #64’s branch).
- #80: local name remover; no screen yet, nothing in the app calls it.
