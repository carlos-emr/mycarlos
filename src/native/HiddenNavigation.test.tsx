import { useState } from "react";
import { act, render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LOCALES, setLocaleOverride, translate } from "../i18n";
import type { VaultBridge, VaultRecord, VaultSnapshot } from "../vault";
import { VaultLibrary } from "./VaultLibrary";

const hiddenRecord = (id: string, profileId: string): VaultRecord => ({
  id,
  profileId,
  displayName: `FAKE ${id} {name}.pdf`,
  folderIds: [],
  sourceLabel: "Manual import — unverified",
  sourceKind: "manual",
  mediaType: "application/pdf",
  plaintextSize: 2048,
  importedAtMs: 1,
  available: true,
  hidden: { atMs: 2, reason: "patient" },
});

function library(options: { busy?: boolean; readOnly?: boolean } = {}) {
  let current: VaultSnapshot = {
    profiles: [
      { id: "avery", displayName: "FAKE Avery", createdAtMs: 1 },
      { id: "jamie", displayName: "FAKE Jamie", createdAtMs: 1 },
      { id: "shared", displayName: "Shared with me", createdAtMs: 1 },
    ],
    sharedProfileId: "shared",
    folders: [],
    records: [
      hiddenRecord("avery-hidden", "avery"),
      hiddenRecord("jamie-hidden", "jamie"),
      hiddenRecord("shared-hidden", "shared"),
    ],
    recovery: options.readOnly ? "lostObjects" : null,
    recoveryKeySetAtMs: 1,
  };
  const bridge = {
    native: true,
    unhideRecord: vi.fn().mockImplementation(async (id: string) => {
      current = {
        ...current,
        records: current.records.map((record) =>
          record.id === id ? { ...record, hidden: null } : record,
        ),
      };
    }),
  } as unknown as VaultBridge;
  function Harness() {
    const [snapshot, setSnapshot] = useState(current);
    return (
      <VaultLibrary
        bridge={bridge}
        snapshot={snapshot}
        busy={Boolean(options.busy)}
        notice=""
        setNotice={vi.fn()}
        run={async (operation) => operation()}
        refresh={async () => {
          setSnapshot(current);
          return current;
        }}
        onLock={vi.fn()}
        autoLockMinutes={5}
        onAutoLockMinutes={vi.fn()}
      />
    );
  }
  render(<Harness />);
  return bridge;
}

afterEach(async () => {
  await page.viewport(1100, 760);
});

describe("Hidden inside Security", () => {
  for (const locale of LOCALES) {
    for (const phone of [false, true]) {
      it(`keeps the Security path, Shared scope, back and restore in ${locale} (phone: ${phone})`, async () => {
        await page.viewport(phone ? 320 : 1100, phone ? 640 : 760);
        setLocaleOverride(locale);
        const user = userEvent.setup();
        const bridge = library();
        const hidden = translate(locale, "interface.HiddenDocuments.hidden");
        const security = translate(locale, "security.title");
        const section = screen.getByRole("navigation", {
          name: translate(
            locale,
            phone ? "interface.VaultLibrary.section" : "sidebar.label",
          ),
        });
        // Neither the desktop sidebar nor the phone tabs expose Hidden.
        expect(
          within(section).queryByRole("button", {
            name: new RegExp(`^${hidden}`),
          }),
        ).toBeNull();
        expect(
          screen.queryByRole("button", { name: new RegExp(`^${hidden}`) }),
        ).toBeNull();
        if (phone) {
          await user.click(
            screen.getByRole("button", {
              name: translate(locale, "interface.LibrarySidebar.sharedWithMe"),
            }),
          );
        } else {
          await user.click(
            within(section).getByRole("button", {
              name: translate(locale, "interface.LibrarySidebar.sharedWithMe"),
            }),
          );
        }
        await user.click(
          within(section).getByRole("button", { name: security }),
        );
        const entry = screen.getByRole("button", {
          name: new RegExp(`^${hidden} 1`),
        });
        const explanation = entry.closest("section")!;
        expect(explanation).toHaveTextContent(
          translate(
            locale,
            "interface.SecuritySettings.myCarlosNeverDeletesADocumentHidingOne",
          ),
        );
        expect(entry).toHaveTextContent(
          translate(locale, "interface.LibrarySidebar.sharedWithMe"),
        );
        if ((locale === "fr" && phone) || (locale === "en" && !phone)) {
          entry.scrollIntoView({ block: "center" });
          await page.screenshot({
            path: `../../test-results/component-tests/hidden-security-${locale}-${phone ? 320 : 1100}.png`,
          });
        }
        const entryBox = entry.getBoundingClientRect();
        expect(entryBox.left).toBeGreaterThanOrEqual(-1);
        expect(entryBox.right).toBeLessThanOrEqual(phone ? 321 : 1101);
        expect(entry.scrollWidth).toBeLessThanOrEqual(entry.clientWidth + 1);
        await user.click(entry);
        expect(screen.getByRole("heading", { name: hidden })).toBeVisible();
        expect(
          screen.getByRole("article", {
            name: translate(locale, "interface.hidden.record", {
              name: "FAKE shared-hidden {name}.pdf",
            }),
          }),
        ).toBeVisible();
        expect(screen.queryByText("FAKE avery-hidden {name}.pdf")).toBeNull();
        expect(screen.queryByText("FAKE jamie-hidden {name}.pdf")).toBeNull();
        expect(
          within(section).getByRole("button", { name: security }),
        ).toHaveAttribute("aria-current", "page");
        const back = screen.getByRole("button", {
          name: translate(locale, "hidden.backToSecurity"),
        });
        if ((locale === "fr" && phone) || (locale === "en" && !phone)) {
          back.scrollIntoView({ block: "start" });
          await page.screenshot({
            path: `../../test-results/component-tests/hidden-list-${locale}-${phone ? 320 : 1100}.png`,
          });
        }
        expect(back.getBoundingClientRect().right).toBeLessThanOrEqual(
          phone ? 321 : 1101,
        );
        await user.click(back);
        expect(screen.getByRole("heading", { name: security })).toBeVisible();
        await user.click(
          screen.getByRole("button", { name: new RegExp(`^${hidden} 1`) }),
        );
        await user.click(
          screen.getByRole("button", {
            name: translate(locale, "interface.hidden.restore", {
              name: "FAKE shared-hidden {name}.pdf",
            }),
          }),
        );
        await waitFor(() =>
          expect(bridge.unhideRecord).toHaveBeenCalledExactlyOnceWith(
            "shared-hidden",
          ),
        );
        await waitFor(() =>
          expect(
            screen.queryByText("FAKE shared-hidden {name}.pdf"),
          ).toBeNull(),
        );
        await user.click(
          screen.getByRole("button", {
            name: translate(locale, "hidden.backToSecurity"),
          }),
        );
        expect(
          screen.getByRole("button", { name: new RegExp(`^${hidden} 0`) }),
        ).toBeEnabled();
      });
    }
  }

  it("updates the open Hidden view and back path when the language changes", async () => {
    setLocaleOverride("en");
    const user = userEvent.setup();
    const bridge = library();
    await user.click(screen.getByRole("button", { name: "Security" }));
    await user.click(screen.getByRole("button", { name: /^Hidden 1/ }));
    const row = screen.getByRole("article", {
      name: "FAKE avery-hidden {name}.pdf, hidden",
    });
    act(() => setLocaleOverride("pl"));
    expect(
      screen.getByRole("article", {
        name: translate("pl", "interface.hidden.record", {
          name: "FAKE avery-hidden {name}.pdf",
        }),
      }),
    ).toBe(row);
    expect(screen.getByRole("heading", { name: "Ukryte" })).toBeVisible();
    await user.click(
      screen.getByRole("button", { name: "Powrót do zabezpieczeń" }),
    );
    const entry = screen.getByRole("button", { name: /^Ukryte 1/ });
    expect(entry).toHaveTextContent("FAKE Avery");
    expect(bridge.unhideRecord).not.toHaveBeenCalled();
  });

  it.each(["busy", "readOnly"] as const)(
    "keeps Hidden accessible while %s and refuses restore",
    async (state) => {
      setLocaleOverride("en");
      const user = userEvent.setup();
      const bridge = library({ [state]: true });
      await user.click(screen.getByRole("button", { name: "Security" }));
      await user.click(screen.getByRole("button", { name: /^Hidden 1/ }));
      const restore = screen.getByRole("button", {
        name: "Restore FAKE avery-hidden {name}.pdf",
      });
      expect(restore).toBeDisabled();
      await user.click(restore);
      expect(bridge.unhideRecord).not.toHaveBeenCalled();
      expect(
        screen.getByRole("button", { name: "Back to Security" }),
      ).toBeEnabled();
    },
  );
});
