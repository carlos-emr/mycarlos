import { expect, type Locator, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

// Shared by keyboard-walk.spec.ts and screen-reader-smoke.spec.ts (#70 step
// 3): a fake native side for the vault screens, a Tab walk, and a record of
// what a screen reader would be told.

/** WCAG 2.0, 2.1 and 2.2 A and AA, as in smoke.spec.ts. */
export const WCAG_TAGS = [
  "wcag2a",
  "wcag2aa",
  "wcag21a",
  "wcag21aa",
  "wcag22aa",
];

export type VaultStart = "absent" | "locked" | "unlocked";

export interface FakeVaultOptions {
  /** The vault has a recovery key; without one, unlocking may offer one. */
  recoveryKey?: boolean;
}

/**
 * The Tauri bridge, faked as large-text-accessibility.spec.ts does: a vault
 * with one patient, one folder and two documents. Creating, unlocking,
 * locking, importing and moving change it as the native side would. What the
 * commands really do is tested in Rust; a command the fake does not know is
 * kept in `__unexpectedIpc` and fails.
 */
export async function fakeVault(
  page: Page,
  start: VaultStart,
  options: FakeVaultOptions = {},
) {
  await page.addInitScript(
    ({ start, recoveryKey }) => {
      let status = start;
      const snapshot = {
        profiles: [
          { id: "profile", displayName: "FAKE Patient", createdAtMs: 1 },
        ],
        folders: [
          {
            id: "folder",
            profileId: "profile",
            parentId: null as string | null,
            name: "FAKE Results",
            createdAtMs: Date.UTC(2026, 9, 1, 12),
          },
          {
            id: "letters",
            profileId: "profile",
            parentId: null as string | null,
            name: "FAKE Letters",
            createdAtMs: Date.UTC(2026, 9, 1, 13),
          },
        ],
        records: [
          {
            id: "record",
            profileId: "profile",
            folderIds: ["folder"],
            displayName: "FAKE Bloodwork.pdf",
            sourceLabel: "Manual import — unverified",
            mediaType: "application/pdf",
            plaintextSize: 2048,
            importedAtMs: Date.UTC(2026, 9, 2, 12),
            available: true,
          },
          {
            id: "letter",
            profileId: "profile",
            folderIds: [] as string[],
            displayName: "FAKE Letter.pdf",
            sourceLabel: "Manual import — unverified",
            mediaType: "application/pdf",
            plaintextSize: 1024,
            importedAtMs: Date.UTC(2026, 9, 3, 12),
            available: true,
          },
        ],
        recovery: null,
        recoveryKeySetAtMs: recoveryKey ? 1 : null,
        recoveryKeyLabel: recoveryKey ? "FAKE-KEY1" : null,
      };
      type Request = {
        request?: {
          recordId?: string;
          recordIds?: string[];
          folderIds?: string[];
          folderId?: string;
          parentId?: string | null;
          name?: string;
        };
      };
      const unexpected: string[] = [];
      const calls: string[] = [];
      Reflect.set(window, "__unexpectedIpc", unexpected);
      Reflect.set(window, "__ipcCalls", calls);
      Reflect.set(window, "__TAURI_INTERNALS__", {
        metadata: {
          currentWindow: { label: "main" },
          currentWebview: { label: "main", windowLabel: "main" },
        },
        invoke: async (command: string, args?: Request) => {
          calls.push(command);
          const request = args?.request ?? {};
          switch (command) {
            case "runtime_info":
              return { platform: "windows" };
            case "vault_status":
              return status;
            // These accessibility journeys have no files waiting to be shared.
            // The app still polls the intake while locked and after unlocking.
            case "received_list":
              return { files: [], notice: { dropped: 0, refusedShares: 0 } };
            // These fixture PDFs open without a document password.
            case "vault_is_locked_pdf":
              return false;
            case "vault_snapshot":
              return structuredClone(snapshot);
            case "vault_passphrase_rules":
              return { longEnough: true, notAName: true, hardToGuess: true };
            case "vault_create":
            case "vault_unlock":
              status = "unlocked";
              return structuredClone(snapshot);
            case "vault_lock":
              status = "locked";
              return;
            case "vault_recovery_key_begin":
              return "FAKE-AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG";
            case "vault_recovery_key_label":
              return snapshot.recoveryKeyLabel;
            case "vault_recovery_key_cancel":
              return;
            case "vault_assign_folders":
            case "vault_assign_folders_batch":
              for (const record of snapshot.records)
                if (
                  record.id === request.recordId ||
                  request.recordIds?.includes(record.id)
                )
                  record.folderIds = [...(request.folderIds ?? [])];
              return;
            case "vault_create_folder": {
              const id = `folder-${snapshot.folders.length + 1}`;
              snapshot.folders.push({
                id,
                profileId: "profile",
                parentId: request.parentId ?? null,
                name: request.name ?? "",
                createdAtMs: Date.UTC(2026, 9, 5, 12),
              });
              return id;
            }
            case "vault_update_folder":
              for (const folder of snapshot.folders)
                if (folder.id === request.folderId)
                  folder.parentId = request.parentId ?? null;
              return;
            case "vault_import_pick":
              return "FAKE-pick";
            case "vault_import_picked":
              snapshot.records.push({
                id: "scan",
                profileId: "profile",
                folderIds: [...(request.folderIds ?? [])],
                displayName: "FAKE Scan.pdf",
                sourceLabel: "Manual import — unverified",
                mediaType: "application/pdf",
                plaintextSize: 4096,
                importedAtMs: Date.UTC(2026, 9, 4, 12),
                available: true,
              });
              return { imported: ["scan"], skippedDuplicates: [] };
            case "vault_touch":
            case "vault_set_auto_lock":
            case "plugin:window|set_theme":
            case "plugin:webview|set_webview_zoom":
              return;
          }
          // Kept as well as thrown: a screen showing an error could still pass.
          unexpected.push(command);
          throw new Error(`Unexpected IPC command: ${command}`);
        },
      });
    },
    { start, recoveryKey: options.recoveryKey ?? true },
  );
}

/** The bridge commands a page asked for that the fake does not answer: none. */
export async function expectOnlyFakedCommands(page: Page) {
  expect(
    await page.evaluate(() => Reflect.get(window, "__unexpectedIpc")),
    "bridge commands the fake does not answer",
  ).toEqual([]);
}

// ---------------------------------------------------------------------------
// What a screen reader is told

/**
 * Records what live regions would read out, from the first script on.
 *
 * A polite live region (role=status, aria-live=polite) is read out when its
 * text changes while it is on the page; one put on the page with its text
 * already in it is usually not. An alert is read out either way. So a change
 * counts as announced when its region was on the page before the change, or
 * is an alert; the rest is kept apart as `__unannounced`. A screen reader
 * also needs the region in its tree a moment before (ANNOUNCE_DELAY_MS in
 * src/native/announce.ts); this does not time that.
 */
export async function recordAnnouncements(page: Page) {
  await page.addInitScript(() => {
    const LIVE =
      '[aria-live]:not([aria-live="off"]), [role="status"], [role="alert"], [role="log"]';
    const announced: string[] = [];
    const unannounced: string[] = [];
    Reflect.set(window, "__announced", announced);
    Reflect.set(window, "__unannounced", unannounced);
    const known = new WeakSet<Element>();
    const silent = (region: Element) =>
      Boolean(region.closest('[aria-hidden="true"], [inert], [hidden]')) ||
      !region.checkVisibility({ visibilityProperty: true });
    const learn = () => {
      for (const region of document.querySelectorAll(LIVE)) known.add(region);
    };
    new MutationObserver((records) => {
      const changed = new Set<Element>();
      for (const record of records) {
        const element =
          record.target instanceof Element
            ? record.target
            : record.target.parentElement;
        const region = element?.closest(LIVE);
        if (region) changed.add(region);
        for (const added of record.addedNodes)
          if (added instanceof Element) {
            if (added.matches(LIVE)) changed.add(added);
            for (const inner of added.querySelectorAll(LIVE))
              changed.add(inner);
          }
      }
      for (const region of changed) {
        if (!region.isConnected || silent(region)) continue;
        const text = (region.textContent ?? "").trim().replace(/\s+/g, " ");
        if (!text) continue;
        const alert =
          region.getAttribute("role") === "alert" ||
          region.getAttribute("aria-live") === "assertive";
        (known.has(region) || alert ? announced : unannounced).push(text);
      }
      learn();
    }).observe(document, {
      subtree: true,
      childList: true,
      characterData: true,
    });
    document.addEventListener("DOMContentLoaded", learn);
  });
}

/** Waits until a live region has read out `text` (a part of it is enough). */
export async function expectAnnounced(page: Page, text: string) {
  await expect
    .poll(
      () => page.evaluate(() => Reflect.get(window, "__announced") as string[]),
      { message: `"${text}" is read out by a live region` },
    )
    .toContainEqual(expect.stringContaining(text));
}

// ---------------------------------------------------------------------------
// Screen-reader smoke: axe, names, headings

export async function expectNoAxeViolations(page: Page, where: string) {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  expect(
    results.violations.map((violation) => ({
      id: violation.id,
      nodes: violation.nodes.map((node) => node.target.join(" ")),
    })),
    `${where}: axe`,
  ).toEqual([]);
}

/** Roles a screen reader announces as something to press, type in or pick. */
const CONTROL_ROLES = [
  "button",
  "link",
  "textbox",
  "searchbox",
  "checkbox",
  "radio",
  "combobox",
  "listbox",
  "switch",
  "slider",
  "spinbutton",
  "tab",
  "menuitem",
  "option",
];

/**
 * Every control in the accessibility tree has a name, read from Playwright's
 * aria snapshot (Chromium's own tree, not axe's reading of the DOM).
 */
export async function expectEveryControlNamed(scope: Locator, where: string) {
  const tree = await scope.ariaSnapshot();
  const unnamed = tree
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => {
      const match = /^- (\w+)(.*)$/.exec(line);
      if (!match || !CONTROL_ROLES.includes(match[1])) return false;
      return !/^ "[^"]*\S[^"]*"/.test(match[2]);
    });
  expect(unnamed, `${where}: controls without a name`).toEqual([]);
}

/**
 * Headings, as a screen reader lists them: the screen starts with one level 1
 * heading and goes down at most one level at a time. In a dialog, the first
 * heading may be at any level, as long as it then goes down in order.
 */
export async function expectHeadingsInOrder(
  scope: Locator,
  where: string,
  dialog = false,
) {
  const tree = await scope.ariaSnapshot();
  const headings = Array.from(
    tree.matchAll(/- heading "([^"]*)" \[level=(\d)\]/g),
    (match) => ({ name: match[1], level: Number(match[2]) }),
  );
  expect(headings.length, `${where}: has a heading`).toBeGreaterThan(0);
  if (!dialog) {
    expect(
      headings.filter((heading) => heading.level === 1).map((h) => h.name),
      `${where}: one level 1 heading`,
    ).toHaveLength(1);
    expect(headings[0].level, `${where}: starts at level 1`).toBe(1);
  }
  const skips = headings
    .slice(1)
    .filter((heading, index) => heading.level > headings[index].level + 1)
    .map((heading) => `${heading.name} (level ${heading.level})`);
  expect(skips, `${where}: headings that skip a level`).toEqual([]);
}

/** axe, names and headings for one screen or dialog. */
export async function screenReaderSmoke(
  page: Page,
  where: string,
  dialog?: Locator,
) {
  await expectNoAxeViolations(page, where);
  const scope = dialog ?? page.locator("body");
  await expectEveryControlNamed(scope, where);
  await expectHeadingsInOrder(scope, where, Boolean(dialog));
}

// ---------------------------------------------------------------------------
// Keyboard only

export interface Stop {
  label: string;
}

/**
 * Tabs from the top of `scope` (the page, or an open dialog) until focus comes
 * round to the first stop again, then Shift+Tabs back round. Checks that:
 * - Tab reaches every control a mouse could use, in page order;
 * - every stop is on screen, not hidden behind something (2.4.11), and shows
 *   that it has focus (2.4.7): the pixels around it change when it loses
 *   focus;
 * - Tab and Shift+Tab both go all the way round (no trap, 2.1.2).
 */
export async function walk(page: Page, where: string, scope = "body") {
  const { stops, problems } = await tabRound(page, scope);
  expect(problems, `${where}: keyboard walk`).toEqual([]);
  return stops;
}

/** The walk itself: the stops' names, and what is wrong (see walk()). */
export async function tabRound(page: Page, scope = "body") {
  const limit = 150;
  // Tab goes on from the last place focus was, so the walk starts from a
  // marker at the top of the page that Tab itself never stops at.
  await page.evaluate(() => {
    Reflect.set(window, "__walkStops", []);
    const start = document.createElement("span");
    start.tabIndex = -1;
    start.dataset.walkStart = "";
    document.body.prepend(start);
    start.focus();
  });
  const problems: string[] = [];
  let closed = false;
  for (let i = 0; i < limit && !closed; i++) {
    await page.keyboard.press("Tab");
    const stop = await page.evaluate(stopHere, scope);
    if (stop.kind === "none") continue;
    if (stop.kind === "date-part") continue;
    if (stop.kind === "first") {
      closed = true;
      break;
    }
    if (stop.kind === "again") {
      problems.push(`focus came back to ${stop.label} before going round`);
      break;
    }
    problems.push(
      ...stop.problems.map((problem) => `${stop.label} ${problem}`),
    );
    if (!(await focusShown(page)))
      problems.push(`${stop.label} does not show that it has focus`);
  }
  if (!closed) problems.push(`Tab did not come round in ${limit} presses`);

  const missed = await page.evaluate((scope) => {
    const stops = Reflect.get(window, "__walkStops") as Element[];
    return controlsIn(scope)
      .filter((control) => !stops.includes(control))
      .map(describe);

    function controlsIn(scope: string) {
      const root = document.querySelector(scope)!;
      const all = Array.from(
        root.querySelectorAll<HTMLElement>(
          'button, a[href], input, select, textarea, summary, [tabindex], [contenteditable="true"]',
        ),
      ).filter(
        (element) =>
          // A native control counts even with tabindex=-1, unless a widget
          // that moves focus with the arrow keys holds it.
          (element.tabIndex >= 0 ||
            (element.matches(
              "button, a[href], input, select, textarea, summary",
            ) &&
              !element.closest(
                '[role="toolbar"], [role="radiogroup"], [role="listbox"], [role="menu"], [role="menubar"], [role="tablist"], [role="grid"], [role="tree"]',
              ))) &&
          !element.matches(":disabled") &&
          !element.closest('[inert], [aria-hidden="true"], [hidden]') &&
          element.checkVisibility({ visibilityProperty: true }) &&
          !(element instanceof HTMLInputElement && element.type === "hidden") &&
          // Inside a closed <details>, only its summary can be reached.
          !element.closest("details:not([open]) > :not(summary)"),
      );
      // A radio group is one Tab stop: its checked member, or any member.
      return all.filter((element) => {
        if (!(element instanceof HTMLInputElement) || element.type !== "radio")
          return true;
        const group = all.filter(
          (other) =>
            other instanceof HTMLInputElement &&
            other.type === "radio" &&
            other.name === element.name &&
            other.form === element.form,
        ) as HTMLInputElement[];
        const checked = group.find((radio) => radio.checked);
        if (checked) return checked === element;
        return !group.some((radio) => stops.includes(radio))
          ? group[0] === element
          : stops.includes(element);
      });
    }
    function describe(element: Element) {
      const name = (
        element.getAttribute("aria-label") ??
        element.textContent ??
        ""
      )
        .trim()
        .replace(/\s+/g, " ")
        .slice(0, 50);
      return `${element.tagName.toLowerCase()} "${name}"`;
    }
  }, scope);
  for (const control of missed) problems.push(`Tab never reaches ${control}`);
  // A positive tabindex puts its element ahead of the page's own order.
  for (const control of await page.evaluate(
    (scope) =>
      Array.from(
        document
          .querySelector(scope)!
          .querySelectorAll<HTMLElement>("[tabindex]"),
      )
        .filter((element) => element.tabIndex > 0)
        .map(
          (element) =>
            `${element.tagName.toLowerCase()} "${(element.getAttribute("aria-label") ?? element.textContent ?? "").trim().slice(0, 50)}"`,
        ),
    scope,
  ))
    problems.push(`${control} has a positive tabindex, out of page order`);

  // Back round with Shift+Tab: the same stops, in reverse.
  const stopCount = await page.evaluate(
    () => (Reflect.get(window, "__walkStops") as Element[]).length,
  );
  if (closed && stopCount > 1) {
    const backwards: number[] = [];
    let backwardsClosed = false;
    for (let i = 0; i < limit; i++) {
      await page.keyboard.press("Shift+Tab");
      const index = await page.evaluate(() =>
        (Reflect.get(window, "__walkStops") as Element[]).indexOf(
          document.activeElement as Element,
        ),
      );
      if (index === 0) {
        backwardsClosed = true;
        break;
      }
      if (index > 0) {
        const datePart = await page.evaluate(() => {
          const element = document.activeElement;
          return element instanceof HTMLInputElement && element.type === "date";
        });
        if (!datePart || backwards[backwards.length - 1] !== index)
          backwards.push(index);
      }
    }
    if (!backwardsClosed)
      problems.push(`Shift+Tab did not come round in ${limit} presses`);
    const expected = Array.from(
      { length: stopCount - 1 },
      (_, i) => stopCount - 1 - i,
    );
    if (JSON.stringify(backwards) !== JSON.stringify(expected))
      problems.push(
        `Shift+Tab goes ${JSON.stringify(backwards)}, not the Tab order backwards ${JSON.stringify(expected)}`,
      );
  }

  await page.evaluate(() =>
    document.querySelector("[data-walk-start]")?.remove(),
  );
  const stops = await page.evaluate(() =>
    (Reflect.get(window, "__walkStops") as Element[]).map((element) =>
      (element.getAttribute("aria-label") ?? element.textContent ?? "")
        .trim()
        .replace(/\s+/g, " ")
        .slice(0, 50),
    ),
  );
  return { stops, problems };
}

type StopResult =
  | { kind: "none" }
  | { kind: "date-part" }
  | { kind: "first" }
  | { kind: "again"; label: string }
  | { kind: "stop"; label: string; problems: string[] };

/** Runs in the page: where focus is now, and what is wrong with it there. */
function stopHere(scope: string): StopResult {
  const stops = Reflect.get(window, "__walkStops") as Element[];
  const element = document.activeElement as HTMLElement | null;
  if (
    !element ||
    element === document.body ||
    element.hasAttribute("data-walk-start")
  )
    return { kind: "none" };
  const previous = stops[stops.length - 1];
  // Chromium exposes the date's month/day/year and picker as one DOM input.
  // Only consecutive internal steps may repeat; a trapped date still fails.
  if (
    previous === element &&
    element instanceof HTMLInputElement &&
    element.type === "date"
  ) {
    const parts = Number(Reflect.get(window, "__walkDateParts") ?? 0) + 1;
    Reflect.set(window, "__walkDateParts", parts);
    if (parts <= 3) return { kind: "date-part" };
    return { kind: "again", label: 'input type="date"' };
  }
  if (stops[0] === element) return { kind: "first" };
  const label = `${element.tagName.toLowerCase()} "${(
    element.getAttribute("aria-label") ??
    element.textContent ??
    ""
  )
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 50)}"`;
  if (stops.includes(element)) return { kind: "again", label };
  const problems: string[] = [];
  const root = document.querySelector(scope);
  if (root && !root.contains(element))
    problems.push(`is outside ${scope} while it is open`);
  Reflect.set(window, "__walkDateParts", 0);
  if (
    previous &&
    !(
      previous.compareDocumentPosition(element) &
      Node.DOCUMENT_POSITION_FOLLOWING
    )
  )
    problems.push("comes before the previous stop in the page");
  const box = element.getBoundingClientRect();
  if (
    box.width < 1 ||
    box.height < 1 ||
    !element.checkVisibility({ visibilityProperty: true })
  )
    problems.push("is not shown");
  else {
    // Some of it is in view, and on top there: not behind a header or a panel.
    const left = Math.max(box.left, 0);
    const right = Math.min(box.right, window.innerWidth);
    const top = Math.max(box.top, 0);
    const bottom = Math.min(box.bottom, window.innerHeight);
    if (right <= left || bottom <= top) problems.push("is out of view");
    else {
      const hit = document.elementFromPoint(
        (left + right) / 2,
        (top + bottom) / 2,
      );
      if (
        !hit ||
        !(element.contains(hit) || hit.contains(element) || hit === element)
      )
        problems.push(
          `is hidden behind ${hit ? `${hit.tagName.toLowerCase()}.${hit.className}` : "nothing"}`,
        );
    }
  }
  stops.push(element);
  return { kind: "stop", label, problems };
}

/**
 * Whether the focused element shows its focus: the pixels in and around it
 * differ with and without focus. "Around it" takes in a wrapper that fits
 * closely, such as the search box's label, whose ring is drawn with
 * :focus-within. Focus goes back to the element after.
 */
async function focusShown(page: Page): Promise<boolean> {
  const box = await page.evaluate(() => {
    const element = document.activeElement!;
    const rect = element.getBoundingClientRect();
    let { left, top, right, bottom } = rect;
    let outer = element.parentElement;
    for (let depth = 0; outer && depth < 3; depth++) {
      const wrap = outer.getBoundingClientRect();
      if (wrap.width > rect.width + 64 || wrap.height > rect.height + 64) break;
      left = Math.min(left, wrap.left);
      top = Math.min(top, wrap.top);
      right = Math.max(right, wrap.right);
      bottom = Math.max(bottom, wrap.bottom);
      outer = outer.parentElement;
    }
    return { x: left, y: top, width: right - left, height: bottom - top };
  });
  const viewport = page.viewportSize()!;
  const pad = 8;
  const x = Math.max(0, Math.floor(box.x - pad));
  const y = Math.max(0, Math.floor(box.y - pad));
  const clip = {
    x,
    y,
    width: Math.min(viewport.width, Math.ceil(box.x + box.width + pad)) - x,
    height: Math.min(viewport.height, Math.ceil(box.y + box.height + pad)) - y,
  };
  if (clip.width <= 0 || clip.height <= 0) return false;
  const pair = async () => {
    const focused = await page.screenshot({ clip, animations: "disabled" });
    await page.evaluate(() => {
      const element = document.activeElement as HTMLElement;
      Reflect.set(window, "__walkBlurred", element);
      element.blur();
    });
    const plain = await page.screenshot({ clip, animations: "disabled" });
    await page.evaluate(() =>
      (Reflect.get(window, "__walkBlurred") as HTMLElement).focus(),
    );
    return !focused.equals(plain);
  };
  if (await pair()) return true;
  // The same pixels both times can be a page that had not drawn the change
  // yet, on a busy machine. Look again after a moment of real time: waiting
  // for animation frames would hang under page.clock, which fakes them.
  await new Promise((resolve) => setTimeout(resolve, 200));
  return pair();
}

/**
 * Opened from the keyboard, a dialog takes focus and keeps it (the walk), and
 * Escape closes it and gives focus back to what opened it. A confirmation is
 * an alertdialog.
 */
export async function dialogByKeyboard(
  page: Page,
  opener: Locator,
  name: string | RegExp,
  role: "dialog" | "alertdialog" = "dialog",
) {
  await opener.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole(role, { name });
  await expect(dialog).toBeVisible();
  await expect
    .poll(
      () =>
        dialog.evaluate((element) => element.contains(document.activeElement)),
      { message: `${name}: focus moves into the dialog` },
    )
    .toBe(true);
  await walk(page, String(name), `[role=${role}]`);
  await screenReaderSmoke(page, String(name), dialog);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(opener, `${name}: focus goes back to its opener`).toBeFocused();
}
