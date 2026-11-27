# myCarlos Privacy Notice Draft

**Unpublished English draft for the publisher and legal review.** This evaluation build is for made-up information only. Do not use real patient information until the required release and privacy approvals are complete. Translations (the app has seven languages, and French is needed for Quebec) and the in-app link to this notice must wait for approval of the English text.

How to read the brackets: **[PUBLISHER: …]** is a fact only the publisher can supply. **[CONFIRM: …]** is a statement that depends on what the final release contains and must be checked before publishing. **[LEGAL REVIEW: …]** needs a lawyer. Nothing in brackets is an answer yet.

**Features described here that are still in review and not on `main` yet** (each such section starts with an [IN REVIEW] mark; keep or remove it as the release decides): people and hiding (#411), handover packages (#360 stack), earlier names in the import preview (#413), removing or stopping a clinic link (#419 and #160), an iPhone backup exclusion (#428), automatic document checks that no longer need notices and that run on every computer (#473), and notices on a Mac (in review). **Planned, not built:** a periodic check on Android and the Android portal connection, a "New" marker on documents a clinic has just sent, and notices on Linux. Each such passage is marked [PLANNED]; keep or remove it as the release decides. **Cloud AI (#72) is not in `main` at all**; this build does not contain it.

Version and effective date: **[PUBLISHER: VERSION AND EFFECTIVE DATE]**

Software publisher (the legal entity, its address, email and phone): **[PUBLISHER: LEGAL NAME, ADDRESS, EMAIL AND PHONE]**

Privacy contact, and the person in charge of protecting personal information (Quebec's Law 25 asks for this person's title and contact details to be published): **[PUBLISHER: PRIVACY OFFICER'S TITLE, EMAIL AND PHONE]**

Contact for a suspected security or privacy incident: **[PUBLISHER: INCIDENT CONTACT AND HOW QUICKLY IT IS ANSWERED]**

Clinic or portal operator, if you connect one: **[CLINIC OR PORTAL OPERATOR: NAME AND PRIVACY NOTICE LINK]**

## In short

- myCarlos keeps your health documents in an **encrypted vault on your device**. The publisher has no account system, no server for your documents and no way to read your vault or reset your passphrase.
- **Nothing leaves your device unless you choose it:** linking a clinic portal, downloading an AI model, saving or sharing a copy, or (only in a future build that includes it) sending a prepared text to a cloud AI service with your own key. The tables below say exactly what each one sends.
- myCarlos has **no advertising, no analytics and no crash-reporting service**.
- If you lose your passphrase and your recovery key, **nobody can open your vault**. If you lose your device without a **myCarlos encrypted backup**, you lose your vault: the vault is kept out of your device's own backups wherever the platform allows it.
- Hiding something does not delete it, and the app has no button that deletes a document or its history. The last section says how to remove everything.
- myCarlos is for adults. It can hold records of other people you care for. It is **not a medical device and gives no medical advice**.

## Your records on your device

myCarlos is a patient-run local application. You control your device and vault and choose which records to add, which connections to use, and where to save copies. This control does not extend to records held by a connected portal, clinic, support provider or another service you choose.

The vault can contain document names and contents, photos, **videos with their sound**, folders, information about the people whose records you manage (names, birth dates, earlier names), saved AI answers, clinic links and their delivery records, and an encrypted history of what was done. You choose which files to add and which people to keep records for. A video you add (an MP4 or MOV) is checked on your device, and the place, and the device's name and model, it carries are removed first; the times saved in its headers, and the names of its video and sound formats, stay. Nothing is sent anywhere. A backup includes your videos unless you choose to leave them out. Make sure you are entitled to manage someone else's information.

The app unlocks the vault with your passphrase or recovery key. Keep those secrets private and keep your recovery kit somewhere safe. The publisher does not provide a password-reset service. Losing both ways to unlock the vault can mean losing access to your records.

Encryption protects stored contents, but it does not conceal everything. Someone with access to the vault files or a backup may still see that a vault exists, file sizes and dates, and some recovery and encryption settings. Information is readable while you use the unlocked app. Device security, screen access and the applications you share files with also matter.

## What leaves your device

| When | What is sent, and to whom | Who learns what |
| --- | --- | --- |
| Nothing is turned on (the default) | Nothing. | No one. |
| You link a clinic portal | Public keys made on your device for that one clinic (a fresh pair for each link, never an advertising or hardware identifier), your device's name, requests to check for documents, delivery receipts. Checks happen when you ask, automatically each time you unlock, and while the clinic screen is open. | The clinic's portal: your device's public keys and identifiers, the times of the checks, your internet address, and delivery and receipt information. It may keep records after you stop checking or remove a link. |
| You turn on document notices | A device-made destination number for each linked clinic, and (on platforms that have one) a wake-up token from the system's notice service. [CONFIRM: WHICH PLATFORMS AND SERVICES THIS RELEASE USES. Today Windows has its own notice and no push service is linked.] | The portal learns the destination number; it never receives your name or a document title in the notice, and the token only says "check". |
| You keep myCarlos running in the background with notices on, and the vault is locked (Windows today; needs the device's own key store) | A small question to each linked clinic portal, about every 5 minutes (a little earlier or later each time, never closer than 2 minutes, and slower, up to an hour, after a failure): "is anything waiting for this device?". It is signed with a separate **notice key** made for that clinic, which cannot open your vault, your documents or your clinic link. The answer is only "waiting" or "not". | The portal learns that the question comes from your linked device, because the key was registered for that link, along with the times, how often it asks, and your internet address (so roughly where and when your computer is on). Nothing about a document leaves your device, and the question carries no name or title. The on-screen notice is one fixed sentence ("A new document is waiting. Unlock myCarlos to see it.") with no clinic, name or title. The first time you turn this on, the device registers the key's public half with the portal while the vault is unlocked. Turning the notices off, unlinking, or removing the clinic wipes the key from your device and tells the portal it is finished if the portal can be reached. |
| Automatic document checks while the vault is unlocked [IN REVIEW: #473, not in main] | The same document check you can start by hand, started by the app on its own, only if you have turned on automatic checks. They no longer need notices to be on, and they run on Windows, Mac and Linux. | The portal learns the times of the checks, as it does for a check you start yourself. |
| [PLANNED, not built] An Android phone checks in the background | A periodic check like the one above, every 15 minutes at the soonest and usually about hourly (Android decides), only if you turn it on. It needs the Android portal connection, which is off today. | The same as the row above: the portal sees when and how often the phone is awake and online, and its internet address. Nothing goes to Google or any other third party. |
| You download an AI model | A web request for one named model file. | The download site and its delivery hosts (today Hugging Face and its content network) see your internet address, the time and which file. |
| You save, share or export a copy | The copy goes where you put it. | Whoever can reach that place. myCarlos cannot retrieve or erase it. |
| You use a cloud AI service (**not in this build; only if a future build adds it**) | A text you prepared with identifying details removed, after a preview and a confirmation for each document, using your own account key. | Your provider, under your agreement with them. See "AI features". |
| You contact the publisher for support | Whatever you send. | The publisher and its mail provider. Do not send documents or screenshots. [PUBLISHER: SUPPORT CHANNEL] |

## What stays on the device outside the vault

The device keeps some app settings outside the encrypted vault: language, appearance, text size, how long the app waits before it locks, which camera and microphone you chose for a recording (the device's own identifiers, not names or recordings), and details of a backup you selected, such as its file name. For the backup reminder it also keeps, in a small file inside the vault's own folder, three calendar days (the day you last saved a backup, the day you last saved one that left your videos out, and the day a "Not now" ends); no times, names, places or counts. That file is not part of any backup myCarlos makes and is set aside with the vault when you start again; restoring a backup restarts the reminder from the day you restore (the restored vault counts as one that was backed up). On Windows builds with document notices, the device also keeps notice settings and a limited record of notice outcomes that uses hashed references to arrivals rather than document titles. Notice keys are wrapped with a key held in the device's own secure key store, not inside the vault: one small file beside the vault (never in a myCarlos backup) holds, for each clinic you let your device ask in the background, the clinic's portal address, an identifier of the link and the vault, and the notice key; its size does not say how many clinics. The key can only ask "is anything waiting?" and is wiped when you turn the notices off or remove the link. Windows keeps its own per-app notice setting for myCarlos, outside the app, once the app has shown its first notice. [PLANNED] The "New" marker on a document a clinic has just sent would keep, in a small file beside the vault, a time and a short list of document identifiers you have opened; no names, no clinic and no document content, and nothing in the vault changes. On an Android phone a periodic check would keep the same notice-key file in the app's private storage, protected by a key in Android's key store that cannot be exported. **[CONFIRM: THE FINAL RELEASE'S DEVICE STORAGE AND OPERATING SYSTEM BACKUP BEHAVIOUR BY PLATFORM.]**

## Photos, video, camera and microphone

myCarlos turns the camera on only when you choose to take a photo or record a video, and the microphone only when you choose to record video with sound. Nothing is shown or recorded before that choice, and the photo dialog never asks for sound. A photo is cleaned of location and camera details before it is stored. A picture you add from a file is cleaned the same way: myCarlos removes its place, time and camera details from its own encrypted copy (from a JPEG it keeps only which way up the picture is, and its colours as a new colour profile that it writes itself; from a PNG, only the picture and its colour settings (a Display P3 or sRGB profile becomes a plain marker that it writes itself)) and never changes the file you chose, which keeps them wherever it is. A recording is stored encrypted as it is made, so an interrupted recording can be recovered; a recording that is still in progress is **not** in a backup until it ends. The phone or computer shows its own permission question first, and you can refuse.

## Backups

You can save an encrypted **myCarlos backup**. It contains the vault as it is: hidden documents, the history, the clinic links with their private keys, and any cloud-AI key you added. Anyone who has the backup file and the secret that opens it can read it. Changing a passphrase or recovery key does not change older backups or vaults already set aside. A backup can **leave your videos out** to be smaller; the app says so, and a backup without videos is not treated as a full backup by the reminder.

**What the device's own backups do:**

- **Android:** the app switches off Android's cloud backup and device-to-device transfer for itself, and the build checks that. Whether a phone maker's own transfer tool respects this has not been tested on every phone. [CONFIRM]
- **iPhone and iPad:** [IN REVIEW: #428, not in main] [PUBLISHER: DECISION PENDING. The vault is currently in the app's data folder, which normal iPhone backups (including iCloud) carry, encrypted. The plan is to keep the vault out of iCloud and device backups; when that is built, say so here and say that a lost phone is then not restored from a device backup.]
- **Windows, macOS and Linux:** the vault is in your user's local application data folder, which your own computer backups (for example File History or Time Machine) may include, encrypted. The app does not exclude it. If your computer is lost, replaced or reset, and your own backups do not include myCarlos's folder, you need your myCarlos backup.

**Backup reminder.** The app shows a quiet note, which you can put off for 14 days, when your vault has documents and you have not saved a full backup, the last one is 30 days old, or 20 or more documents were added since it.

## People, family and hiding

[IN REVIEW: hiding a person is #411, handover is the #360 stack; the keeping of several people and "Shared with me" is in main.]

You can keep records for **more than one person** (for example yourself and someone you care for). People in one vault are not private from each other: anyone who unlocks the vault can open every person's records. Documents a clinic sends for a person who does not match any profile wait in "Shared with me" until you move them. A letter about a child can name the parent or guardian.

**Hiding a person is tidiness, not secrecy.** A hidden person's records are left out of lists, the AI helper and notices, and the history collapses entries about them into a count ("N entries about a hidden person") until they are restored, but nothing is deleted or re-encrypted, and anyone who knows the passphrase can restore them. The Hidden people list shows each hidden person's name, the day hidden and their document count. A new clinic document for a hidden person is filed in "Shared with me" with the clinic named and the person not.

**Handing a person's records to another vault.** You can export one person's records as a **handover package**, protected by its own key or a passphrase you type, and import such a package into another vault. A package is a copy outside the vault's protection: anyone who holds the file and its key can read it, and it shows how many documents it holds and how large they are. [IN REVIEW: #413, not in main] Before an import, the app shows the names the file lists for the person, including earlier names, because **an imported person's earlier names are also used to file future clinic documents** under that person. You can choose not to import. A malicious file could name a person so that a later clinic document with the same name and birth date is filed under them; you would see the document in that person's list.

**Children.** myCarlos is for adults. It can hold a child's records for a parent or guardian. It is not designed for use by a child. [LEGAL REVIEW: CHILDREN'S PRIVACY, PARENTAL CONSENT AND ANY PLAN FOR A CHILD'S OWN VAULT.]

## Files shared into myCarlos

When you open or share a PDF into myCarlos from another app, the app first holds it as a pending item. It is **not** written to the vault until you unlock and confirm it. The file stays where it came from, in the other app or location, unencrypted; myCarlos cannot remove it. Choose what you share, and remember that a file saved to a synced folder may be copied elsewhere.

## Reading documents, readable copies and screenshots

Reading a document shows it on your screen. On Android, a stored PDF is read in a separate native view that has no web bridge. **myCarlos allows screenshots and does not hide its window in the recent-apps picture**, so what is on the screen can appear in a screenshot, a screen recording or the app switcher. A readable export, exported text or a recovery kit is outside the vault's protection: other people, applications, synced folders or cloud services may receive copies depending on where you save or share it, and myCarlos cannot retrieve or erase them.

## AI features

**On your device (computers).** On Windows (and Linux, which is for testing), Summary and Explain use an AI model that runs on your computer, in a separate, restricted process. It does not upload the document to any service. Saved answers are kept encrypted with the document; a newer answer for the same document, tool and language replaces the older one in view, and the older one stays hidden in the vault. An answer can be wrong: check it against the original and ask your care team about medical decisions. Each summary sentence shows the words it came from. **Phones do not have the AI helper in this release.** [CONFIRM: PLATFORMS OF THE FINAL RELEASE]

**Downloading a model.** If you choose to download a model, the app contacts the download host and its permitted delivery hosts over HTTPS, and only for that file. They receive your internet address and request information, including which file and when. The files currently come from Hugging Face and its delivery network (`huggingface.co` and its content hosts). Each file is checked against a fixed fingerprint before it is used. [CONFIRM: HOSTS, THEIR PRIVACY NOTICE LINKS AND ANY RELEASE CHANGES.] This download is separate from processing your document on your device.

**Saving text with identifying details removed.** You can save text with identifying details removed, to use elsewhere. Removal can miss names, dates and other identifying details, including some you did not notice. Review the whole preview and remove more where needed. Saving the file does not send it anywhere. If you later give it to an AI service, that service handles it under its own terms and privacy notice.

**Cloud AI.** [IN REVIEW: #72, not in `main`] **This build does not contain a cloud AI feature, and sends no document or text to any AI service.** If a future release adds one, this notice will change first. The design under review is: off by default and behind a build switch; you add **your own account key** from your provider, kept only in the vault (so it is in every backup, and in older backups after you remove it) and never shown again; for each document you see a preview of the exact text, with identifying details removed, and a confirmation that names the provider, the model and the cost, before anything is sent; the text goes over HTTPS to one provider address fixed in the app; nothing is sent in the background; and the history records the time, provider, model and document, never the text, the answer or the key. What a provider keeps, and whether it uses the text, is governed by your account with them. The provider would be outside Canada. [LEGAL REVIEW: TRANSFERS OUTSIDE CANADA AND OUTSIDE QUEBEC.]

## Clinic portals

If this build supports it and you choose to link a clinic portal, myCarlos connects to that portal to link your device, check for documents, download copies and send delivery receipts. The portal can associate your device with your portal account. **[CONFIRM: THE PORTAL CLIENT IS OFF ON ANDROID TODAY AND PRODUCTION CLINIC KEYS ARE NOT YET INSTALLED; SAY WHICH PLATFORMS THIS RELEASE ENABLES.]**

**Asking while the vault is locked (Windows today).** If you turn on notices and keep myCarlos running in the background, a separate notice key asks each linked portal, about every five minutes, whether anything is waiting. The portal can tell which of your linked devices is asking, because the key is registered for that link, and it sees the timing, how often the questions come, and your internet address. The question carries no document, name or clinic detail, and the answer is only yes or no. This needs the device's own key store to keep the notice key safe: on a computer without one (some Linux desktops) no notice key is made and nothing is asked, so there are no tray notices there. You can stop this at any time by turning notices off, which wipes the key on your device and tells the portal it is finished if the portal can be reached. [IN REVIEW: #473] The automatic checks you allow while the vault is unlocked are separate and no longer need notices. [PLANNED] Notices on a Mac are in review; Linux would show no operating-system notice. A periodic check on an Android phone, and the Android portal connection it needs, are planned and not in this build.

Clinic delivery packages are encrypted for the receiving device. myCarlos checks them before adding accepted documents to the vault. This does not make all portal records private from the portal operator: accounts and delivery details are handled separately, and the clinic and portal notice explains those uses. The clinic decides what to send.

**[IN REVIEW: #419 and #160, not in main] Removing a link, and stopping.** When a clinic has not delivered any document to you, you can remove its link: its keys and waiting items on your device are deleted. A clinic that has delivered documents cannot be removed, because the keys are needed to prove the documents came from that clinic; you can instead **stop checking** it, after which myCarlos does not contact it or use its notices, and the clinic's card moves under earlier attempts. A link is also refused removal while notices are on for it. Removing or stopping is local: **the clinic may still list your device until it removes it.** Earlier backups still hold the keys. Documents already saved stay in your vault, and the clinic's own records are not erased. If a clinic's portal reports that it removed your device, myCarlos remembers that and does not ask again.

## Keeping, hiding, erasing

Hiding a document does not delete it. It stays encrypted in the vault and in later backups. The vault keeps an encrypted history of actions, which can include names, earlier names and saved file locations. **The app has no button that deletes a single document or the history.** A few things can be removed: a downloaded AI model, the clinic's refused-delivery records ("Try again" forgets them), and [IN REVIEW: #419] a clinic link that never delivered a document.

The reset in the app is called **"Set vault aside"**: it, and restoring a backup, **set the old vault aside** rather than erasing it. Anyone who can reach it and has its old unlocking secret may still open it. To remove a vault set aside and free its space: on a computer, close myCarlos and delete the vault folder shown in the app; **on a phone, the only way is to clear myCarlos's data in the phone's settings or uninstall it, which removes every vault on the phone.** Copies you saved elsewhere, backups, and records held by a clinic are not erased by any of these steps.

There is no automatic expiry of your vault records. The clinic's retention rules are separate. [PUBLISHER: ANY RETENTION OR "ERASE EVERYTHING" CHANGE IN THE RELEASE.]

## Security and its limits

Your vault is protected with strong, standard encryption keyed from your passphrase or recovery key. The vault, its backups and the app's design have **not had an independent security review yet.** myCarlos does not claim to be certified, "HIPAA compliant" or free from risk. A lost or guessed passphrase, a compromised device, someone watching your screen, or malware on your device can defeat protections that the app cannot control.

## If something goes wrong

To report a suspected security or privacy incident, contact **[PUBLISHER: INCIDENT CONTACT]**. Do not send patient files, vaults, passwords or screenshots. If the publisher learns of an incident that may harm you, it will tell you and the authorities where the law requires it. [LEGAL REVIEW: BREACH NOTIFICATION DUTIES UNDER PIPEDA, QUEBEC LAW 25, PROVINCIAL LAW AND, IF OFFERED THERE, US AND EU LAW; THE INCIDENT REGISTER.] The publisher holds very little: no vault, no passphrase, no documents. What it may hold is support correspondence and website logs.

## Your choices, rights and questions

You can review records in the app, save copies, manage supported clinic connections, and remove the app. To correct a clinic's source record, ask the clinic; documents in myCarlos are copies. To ask about access, correction, deletion, withdrawing consent, representatives or to make a complaint, contact **[CLINIC OR PORTAL PRIVACY CONTACT]** for information they hold and **[PUBLISHER PRIVACY CONTACT]** for information the publisher receives. You may also complain to the Office of the Privacy Commissioner of Canada, or the commissioner of your province (in Quebec, the Commission d'accès à l'information). [LEGAL REVIEW: RIGHTS, THE REQUEST AND COMPLAINT PROCESS, THE RELEVANT AUTHORITIES FOR EACH PLACE THE APP IS OFFERED.]

The publisher supplies the software. A connected portal may be run by any organization or person; read the notice for the specific service you connect. [PUBLISHER: THE ACTUAL ORGANIZATIONS, THEIR RESPONSIBILITIES, HOSTING AND SUPPORT PROVIDERS, AND ANY SUPPORT DATA COLLECTION.] [LEGAL REVIEW: WHETHER ANY PROVINCIAL HEALTH PRIVACY LAW TREATS THE PUBLISHER OR A PORTAL OPERATOR AS AN AGENT OR SERVICE PROVIDER.]

## Language, changes and where to find this notice

This notice is available in English [PUBLISHER: AND FRENCH AND THE OTHER LANGUAGES THE APP OFFERS, WITH LEGAL REVIEW OF THE TRANSLATIONS]. The app links to the published notice at **[PUBLISHER: URL]**, and the stores link to the same text. When the notice changes, the version and date above change, and a short list of what changed is kept here: **[PUBLISHER: CHANGE HISTORY]**.

This draft does not establish a legal basis, a compliance certification, or approval to use real health information.
