import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLocaleOverride, translate } from "../i18n";
import type {
  PatientProfile,
  ProfileExportSummary,
  ProfileImportOutcome,
  ProfileImportPreview,
} from "../vault";
import { humanText, visibleText } from "../test/humanText";
import { ProfileExportDialog, ProfileImportDialog } from "./ProfileHandover";

// Handing one person's records to another device and adding a person from such a file (#360):
// what each step asks, what it sends, what a failure does to the key and the pick, and what the
// patient is told. FAKE data only.

afterEach(() => {
  cleanup();
  setLocaleOverride(null);
  vi.restoreAllMocks();
});

const en = (
  key: Parameters<typeof translate>[1],
  params?: Parameters<typeof translate>[2],
) => visibleText(translate("en", key, params));

const failure = (code: string, message = `FAKE ${code}`) =>
  Object.assign(new Error(message), { code });

const KEY = "AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG";
const summary: ProfileExportSummary = {
  documents: 3,
  hidden: 1,
  folders: 2,
  aiAnswers: 0,
  withClinicEvidence: 1,
  leftOutDamaged: 1,
  evidenceLeftOut: 2,
  historyEntries: 5,
  plaintextBytes: 2048,
};
const people: PatientProfile[] = [
  { id: "p1", displayName: "FAKE Avery", createdAtMs: 1 },
  { id: "p2", displayName: "FAKE Blake", createdAtMs: 2 },
];

function exportBridge(extra: Record<string, unknown> = {}) {
  return {
    prepareProfileExport: vi
      .fn()
      .mockResolvedValue({ exportId: "e1", generatedKey: KEY, summary }),
    pickProfileExportDestination: vi.fn().mockResolvedValue("pick-1"),
    saveProfileExportToPicked: vi
      .fn()
      .mockResolvedValue({ name: "FAKE.handover", bytes: 4096, summary }),
    ...extra,
  };
}

function renderExport(
  bridge = exportBridge(),
  props: Partial<Parameters<typeof ProfileExportDialog>[0]> = {},
) {
  const onClose = vi.fn();
  const onLocked = vi.fn();
  const onUnfinished = vi.fn();
  render(
    <ProfileExportDialog
      bridge={bridge}
      people={people}
      onClose={onClose}
      onLocked={onLocked}
      onUnfinished={onUnfinished}
      {...props}
    />,
  );
  return { bridge, onClose, onLocked, onUnfinished };
}

const button = (name: string) =>
  screen.getByRole("button", { name: humanText(name) });

/** Through the first step with a generated key, to the step that shows it. */
async function toKeyStep(user: ReturnType<typeof userEvent.setup>) {
  await user.click(button(en("handover.export.continue")));
  await screen.findByRole("heading", { name: en("handover.export.keyTitle") });
}

describe("handing a person's records over", () => {
  it("asks for the person, the history and how the file is locked, and sends what was chosen", async () => {
    const user = userEvent.setup();
    const { bridge } = renderExport();
    expect(
      screen.getByRole("heading", { name: en("handover.export.title") }),
    ).toHaveFocus();
    await user.selectOptions(
      screen.getByRole("combobox", { name: en("handover.export.person") }),
      "p2",
    );
    await user.click(
      screen.getByRole("checkbox", { name: en("handover.export.history") }),
    );
    await toKeyStep(user);
    expect(bridge.prepareProfileExport).toHaveBeenCalledExactlyOnceWith({
      profileId: "p2",
      includeHistory: false,
    });
  });

  it("shows a generated key in its groups, keeps Continue off until it is written down, and tells onUnfinished", async () => {
    const user = userEvent.setup();
    const { onUnfinished } = renderExport();
    await toKeyStep(user);
    expect(onUnfinished).toHaveBeenLastCalledWith(true);
    const groups = screen.getByRole("list", {
      name: en("handover.export.keyLabel"),
    });
    expect(within(groups).getAllByRole("listitem")).toHaveLength(7);
    expect(groups.textContent).toContain("AAAA");
    expect(groups.textContent).toContain("GGGG");
    const next = button(en("handover.export.continue"));
    expect(next).toBeDisabled();
    await user.click(
      screen.getByRole("checkbox", { name: en("handover.export.keySaved") }),
    );
    expect(next).toBeEnabled();
    await user.click(next);
    await screen.findByRole("heading", {
      name: en("handover.export.saveTitle"),
    });
    // The key is not on the save step.
    expect(document.body.textContent).not.toContain("AAAA");
  });

  it("with a passphrase of the patient's own: needs one, sends it, and has no key step", async () => {
    const user = userEvent.setup();
    const bridge = exportBridge({
      prepareProfileExport: vi
        .fn()
        .mockResolvedValue({ exportId: "e2", generatedKey: null, summary }),
    });
    const { onUnfinished } = renderExport(bridge);
    await user.click(
      screen.getByRole("radio", {
        name: en("handover.export.keyKind.passphrase"),
      }),
    );
    const next = button(en("handover.export.continue"));
    expect(next).toBeDisabled();
    await user.type(
      screen.getByLabelText(new RegExp(`^${en("handover.export.passphrase")}`)),
      "FAKE-passphrase-1",
    );
    await user.click(next);
    await screen.findByRole("heading", {
      name: en("handover.export.saveTitle"),
    });
    expect(bridge.prepareProfileExport).toHaveBeenCalledWith({
      profileId: "p1",
      includeHistory: true,
      passphrase: "FAKE-passphrase-1",
    });
    // No key is on screen, so nothing is "unfinished".
    expect(onUnfinished).not.toHaveBeenCalledWith(true);
  });

  it("says what went wrong when the preparation fails: the weak-passphrase words, or the vault's own message", async () => {
    for (const [code, said] of [
      ["weak_passphrase", en("handover.export.error.weak")],
      ["some_unlisted_code", "FAKE unlisted failure"],
    ] as const) {
      const user = userEvent.setup();
      const bridge = exportBridge({
        prepareProfileExport: vi
          .fn()
          .mockRejectedValue(failure(code, "FAKE unlisted failure")),
      });
      renderExport(bridge);
      await user.click(button(en("handover.export.continue")));
      expect(
        visibleText((await screen.findByRole("alert")).textContent ?? ""),
      ).toContain(said);
      // Still on the first step, the button usable again.
      expect(button(en("handover.export.continue"))).toBeEnabled();
      cleanup();
    }
  });

  it("tells the library when the vault turned out to be locked, without a message of its own", async () => {
    const user = userEvent.setup();
    const bridge = exportBridge({
      prepareProfileExport: vi.fn().mockRejectedValue(failure("locked")),
    });
    const { onLocked } = renderExport(bridge);
    await user.click(button(en("handover.export.continue")));
    await waitFor(() => expect(onLocked).toHaveBeenCalledOnce());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("asks before leaving while the key is shown: Escape and Cancel ask, an outside click does nothing, and leaving says the handover is finished", async () => {
    const user = userEvent.setup();
    const { onClose, onUnfinished } = renderExport();
    await toKeyStep(user);
    await user.keyboard("{Escape}");
    const ask = await screen.findByRole("alertdialog", {
      name: en("handover.export.leave.title"),
    });
    // Not leaving: back to the key.
    await user.click(within(ask).getByRole("button", { name: "Cancel" }));
    expect(onClose).not.toHaveBeenCalled();
    // A click outside the dialog does not close it while the key is shown.
    fireEvent.mouseDown(document.querySelector(".dialog-backdrop")!);
    expect(onClose).not.toHaveBeenCalled();
    await user.click(button("Cancel"));
    const again = await screen.findByRole("alertdialog", {
      name: en("handover.export.leave.title"),
    });
    await user.click(
      within(again).getByRole("button", {
        name: en("handover.export.leave.confirm"),
      }),
    );
    expect(onClose).toHaveBeenCalledOnce();
    expect(onUnfinished).toHaveBeenLastCalledWith(false);
  });

  it("copies the key and says so, says when it cannot, and takes the key off the clipboard when the dialog ends", async () => {
    const user = userEvent.setup();
    const written: string[] = [];
    vi.spyOn(navigator.clipboard, "writeText").mockImplementation(
      async (text) => {
        written.push(text);
      },
    );
    vi.spyOn(navigator.clipboard, "readText").mockResolvedValue(KEY);
    renderExport();
    await toKeyStep(user);
    await user.click(button(en("handover.export.copy")));
    expect(await screen.findByText(en("handover.export.copied"))).toBeVisible();
    expect(written).toEqual([KEY]);
    // Leaving the dialog clears the clipboard, as the key is still what it holds.
    cleanup();
    await waitFor(() => expect(written).toEqual([KEY, ""]));
  });

  it("does not clear a clipboard that holds something else, and says when the copy failed", async () => {
    const user = userEvent.setup();
    const write = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockRejectedValue(new Error("FAKE no clipboard"));
    renderExport();
    await toKeyStep(user);
    await user.click(button(en("handover.export.copy")));
    expect(
      await screen.findByText(en("handover.export.copyFailed")),
    ).toBeVisible();
    write.mockClear();
    // Something else was copied since: it is left alone.
    write.mockResolvedValue();
    vi.spyOn(navigator.clipboard, "readText").mockResolvedValue("FAKE other");
    cleanup();
    await Promise.resolve();
    expect(write).not.toHaveBeenCalled();
  });

  it("on a phone there is no Copy, and the patient is told why", async () => {
    const user = userEvent.setup();
    renderExport(exportBridge(), { canCopy: false });
    await toKeyStep(user);
    expect(
      screen.queryByRole("button", { name: en("handover.export.copy") }),
    ).toBeNull();
    expect(
      screen.getByText(humanText(en("handover.export.leavingWarning"))),
    ).toBeVisible();
  });

  async function toSaveStep(
    user: ReturnType<typeof userEvent.setup>,
    bridge = exportBridge(),
    props: Partial<Parameters<typeof ProfileExportDialog>[0]> = {},
  ) {
    const rendered = renderExport(bridge, props);
    await toKeyStep(user);
    await user.click(
      screen.getByRole("checkbox", { name: en("handover.export.keySaved") }),
    );
    await user.click(button(en("handover.export.continue")));
    await screen.findByRole("heading", {
      name: en("handover.export.saveTitle"),
    });
    return rendered;
  }

  it("saves to the chosen place, reports what the file holds, and the key is gone", async () => {
    const user = userEvent.setup();
    const { bridge, onUnfinished } = await toSaveStep(user);
    await user.click(button(en("handover.export.chooseWhere")));
    await screen.findByRole("heading", {
      name: en("handover.export.doneTitle"),
    });
    expect(bridge.pickProfileExportDestination).toHaveBeenCalledWith(
      "e1",
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    );
    expect(bridge.saveProfileExportToPicked).toHaveBeenCalledExactlyOnceWith(
      "pick-1",
    );
    expect(onUnfinished).toHaveBeenLastCalledWith(false);
    expect(
      screen.getByText(
        humanText(en("handover.export.done", { count: 3, name: "FAKE Avery" })),
      ),
    ).toBeVisible();
    // What was left out is said, by count, with no document named.
    expect(
      screen.getByText(humanText(en("handover.export.leftOut", { count: 1 }))),
    ).toBeVisible();
    expect(
      screen.getByText(
        humanText(en("handover.export.evidenceLeftOut", { count: 2 })),
      ),
    ).toBeVisible();
    expect(document.body.textContent).not.toContain("AAAA");
  });

  it("when no place is chosen nothing is saved and the dialog stays on the save step", async () => {
    const user = userEvent.setup();
    const bridge = exportBridge({
      pickProfileExportDestination: vi.fn().mockResolvedValue(null),
    });
    await toSaveStep(user, bridge);
    await user.click(button(en("handover.export.chooseWhere")));
    expect(
      await screen.findByText(en("handover.export.noLocation")),
    ).toBeVisible();
    expect(bridge.saveProfileExportToPicked).not.toHaveBeenCalled();
    expect(
      screen.getByRole("heading", { name: en("handover.export.saveTitle") }),
    ).toBeVisible();
  });

  it("when the preparation is gone, or the save fails, it goes back to the start for a new key, with the reason", async () => {
    for (const broken of ["pick", "save"] as const) {
      const user = userEvent.setup();
      const bridge = exportBridge(
        broken === "pick"
          ? {
              pickProfileExportDestination: vi
                .fn()
                .mockRejectedValue(failure("fake_expired", "FAKE expired")),
            }
          : {
              saveProfileExportToPicked: vi
                .fn()
                .mockRejectedValue(failure("fake_storage", "FAKE no room")),
            },
      );
      await toSaveStep(user, bridge);
      await user.click(button(en("handover.export.chooseWhere")));
      expect(
        await screen.findByRole("heading", {
          name: en("handover.export.title"),
        }),
      ).toBeVisible();
      expect((await screen.findByRole("alert")).textContent).toContain(
        broken === "pick" ? "FAKE expired" : "FAKE no room",
      );
      // The key that was shown is not kept.
      expect(document.body.textContent).not.toContain("AAAA");
      cleanup();
    }
  });

  it("a lock while choosing the place tells the library and does not throw the key away", async () => {
    const user = userEvent.setup();
    const bridge = exportBridge({
      pickProfileExportDestination: vi
        .fn()
        .mockRejectedValue(failure("locked")),
    });
    const { onLocked } = await toSaveStep(user, bridge);
    await user.click(button(en("handover.export.chooseWhere")));
    await waitFor(() => expect(onLocked).toHaveBeenCalledOnce());
    expect(
      screen.getByRole("heading", { name: en("handover.export.saveTitle") }),
    ).toBeVisible();
  });

  it("offers to hide the person at the end, off unless chosen, and hides only when it was", async () => {
    for (const choose of [false, true]) {
      const user = userEvent.setup();
      const onHidePerson = vi.fn();
      const { onClose } = await toSaveStep(user, exportBridge(), {
        onHidePerson,
      });
      await user.click(button(en("handover.export.chooseWhere")));
      await screen.findByRole("heading", {
        name: en("handover.export.doneTitle"),
      });
      const offer = screen.getByRole("checkbox", {
        name: humanText(
          en("handover.export.hideOffer", { name: "FAKE Avery" }),
        ),
      });
      expect(offer).not.toBeChecked();
      if (choose) await user.click(offer);
      await user.click(button(en("handover.close")));
      expect(onClose).toHaveBeenCalledOnce();
      expect(onHidePerson).toHaveBeenCalledTimes(choose ? 1 : 0);
      if (choose) expect(onHidePerson).toHaveBeenCalledWith("p1");
      cleanup();
    }
  });

  it("with only one person the offer is not a checkbox that cannot work: it says why", async () => {
    const user = userEvent.setup();
    const onHidePerson = vi.fn();
    await toSaveStep(user, exportBridge(), {
      onHidePerson,
      people: [people[0]],
    });
    await user.click(button(en("handover.export.chooseWhere")));
    await screen.findByRole("heading", {
      name: en("handover.export.doneTitle"),
    });
    expect(
      screen.queryByRole("checkbox", { name: /Hide .*FAKE Avery/ }),
    ).toBeNull();
    expect(
      screen.getByText(humanText(en("hiddenPeople.lastPerson"))),
    ).toBeVisible();
  });
});

const preview = (
  extra: Partial<ProfileImportPreview> = {},
): ProfileImportPreview => ({
  exportedAtMs: Date.UTC(2026, 9, 7, 12),
  displayName: "FAKE Casey",
  fullName: "FAKE Casey Person",
  birthDate: "2001-02-03",
  documents: 4,
  hidden: 0,
  folders: 1,
  aiAnswers: 2,
  withClinicEvidence: 1,
  historyEntries: 9,
  plaintextBytes: 4096,
  alreadyHere: null,
  ...extra,
});

const outcome = (
  extra: Partial<ProfileImportOutcome> = {},
): ProfileImportOutcome => ({
  status: "imported",
  profileId: "new-profile",
  documents: 4,
  folders: 1,
  hidden: 0,
  aiAnswers: 2,
  aiAnswersDropped: 0,
  evidenceKept: 1,
  evidenceDropped: 0,
  historyEntries: 9,
  receiptCode: "ABCD-EFGH",
  alreadyHere: null,
  ...extra,
});

function importBridge(extra: Record<string, unknown> = {}) {
  return {
    pickProfileImportSource: vi.fn().mockResolvedValue("pick-9"),
    profileImportKeyKind: vi.fn().mockResolvedValue("key"),
    inspectProfileImport: vi.fn().mockResolvedValue(preview()),
    importProfile: vi.fn().mockResolvedValue(outcome()),
    ...extra,
  };
}

function renderImport(bridge = importBridge()) {
  const onClose = vi.fn();
  const onLocked = vi.fn();
  const onImported = vi.fn();
  render(
    <ProfileImportDialog
      bridge={bridge}
      onClose={onClose}
      onLocked={onLocked}
      onImported={onImported}
    />,
  );
  return { bridge, onClose, onLocked, onImported };
}

async function toKeyInput(user: ReturnType<typeof userEvent.setup>) {
  await user.click(button(en("handover.import.choose")));
  await screen.findByRole("heading", { name: en("handover.import.keyTitle") });
}

async function toPreview(
  user: ReturnType<typeof userEvent.setup>,
  bridge = importBridge(),
) {
  const rendered = renderImport(bridge);
  await toKeyInput(user);
  await user.type(
    screen.getByLabelText(en("handover.import.key")),
    "AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG",
  );
  await user.click(button(en("handover.import.open")));
  await screen.findByRole("heading", {
    name: en("handover.import.previewTitle"),
  });
  return rendered;
}

describe("adding a person from a handover file", () => {
  it("says so when no file is chosen, and changes nothing", async () => {
    const user = userEvent.setup();
    const bridge = importBridge({
      pickProfileImportSource: vi.fn().mockResolvedValue(null),
    });
    renderImport(bridge);
    await user.click(button(en("handover.import.choose")));
    expect(await screen.findByText(en("handover.import.noFile"))).toBeVisible();
    expect(bridge.profileImportKeyKind).not.toHaveBeenCalled();
  });

  it("asks for the kind of secret the file is locked with, and sends it with the pick", async () => {
    for (const kind of ["key", "passphrase"] as const) {
      const user = userEvent.setup();
      const bridge = importBridge({
        profileImportKeyKind: vi.fn().mockResolvedValue(kind),
      });
      renderImport(bridge);
      await toKeyInput(user);
      const label = en(
        kind === "key" ? "handover.import.key" : "handover.import.passphrase",
      );
      const input = screen.getByLabelText(
        kind === "key" ? label : new RegExp(`^${label}`),
      ) as HTMLInputElement;
      expect(input.type).toBe(kind === "key" ? "text" : "password");
      // Nothing can be sent without one.
      expect(button(en("handover.import.open"))).toBeDisabled();
      await user.type(input, "FAKE secret");
      await user.click(button(en("handover.import.open")));
      await screen.findByRole("heading", {
        name: en("handover.import.previewTitle"),
      });
      expect(bridge.inspectProfileImport).toHaveBeenCalledExactlyOnceWith({
        pickId: "pick-9",
        ...(kind === "key"
          ? { key: "FAKE secret" }
          : { passphrase: "FAKE secret" }),
      });
      cleanup();
    }
  });

  it.each([
    ["package_key_typo", "handover.import.error.typo"],
    ["package_key_is_recovery_key", "handover.import.error.recovery"],
    ["wrong_passphrase", "handover.import.error.wrong"],
    ["vault_newer_format", "handover.import.error.newer"],
    ["invalid", "handover.import.error.damaged"],
  ] as const)(
    "a failure to open with %s says its own words",
    async (code, key) => {
      const user = userEvent.setup();
      const bridge = importBridge({
        inspectProfileImport: vi.fn().mockRejectedValue(failure(code)),
      });
      renderImport(bridge);
      await toKeyInput(user);
      await user.type(screen.getByLabelText(en("handover.import.key")), "FAKE");
      await user.click(button(en("handover.import.open")));
      expect((await screen.findByRole("alert")).textContent).toContain(en(key));
      // The key step stays, for another try.
      expect(
        screen.getByRole("heading", { name: en("handover.import.keyTitle") }),
      ).toBeVisible();
    },
  );

  it("any other failure shows the vault's message, and a lock goes to the library", async () => {
    const user = userEvent.setup();
    const bridge = importBridge({
      inspectProfileImport: vi
        .fn()
        .mockRejectedValueOnce(failure("fake_storage", "FAKE disk problem"))
        .mockRejectedValueOnce(failure("locked")),
    });
    const { onLocked } = renderImport(bridge);
    await toKeyInput(user);
    await user.type(screen.getByLabelText(en("handover.import.key")), "FAKE");
    await user.click(button(en("handover.import.open")));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "FAKE disk problem",
    );
    await user.click(button(en("handover.import.open")));
    await waitFor(() => expect(onLocked).toHaveBeenCalledOnce());
  });

  it("previews what the file says without naming a document, and adds the person under the name given", async () => {
    const user = userEvent.setup();
    const { bridge, onImported } = await toPreview(user);
    expect(
      screen.getByText(
        humanText(
          new RegExp(en("handover.import.says", { name: "FAKE Casey" })),
        ),
      ),
    ).toBeVisible();
    expect(screen.getByText(humanText(/2001-02-03/))).toBeVisible();
    expect(
      screen.getByText(humanText(en("handover.import.evidenceNote"))),
    ).toBeVisible();
    // The name can be changed; unchanged, nothing is sent for it.
    const name = screen.getByLabelText(en("handover.import.nameLabel"));
    await user.click(button(en("handover.import.add")));
    await screen.findByRole("heading", {
      name: en("handover.import.doneTitle"),
    });
    expect(bridge.importProfile).toHaveBeenCalledExactlyOnceWith({
      pickId: "pick-9",
      key: "AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG",
      displayName: undefined,
      allowDuplicate: false,
    });
    expect(onImported).toHaveBeenCalledExactlyOnceWith("new-profile");
    expect(name).not.toBeInTheDocument();
  });

  it("a changed name is sent, an empty one cannot be, and the name is limited to 120 letters", async () => {
    const user = userEvent.setup();
    const { bridge } = await toPreview(user);
    const name = screen.getByLabelText(
      en("handover.import.nameLabel"),
    ) as HTMLInputElement;
    expect(name.maxLength).toBe(120);
    await user.clear(name);
    expect(button(en("handover.import.add"))).toBeDisabled();
    await user.type(name, "FAKE Renamed");
    await user.click(button(en("handover.import.add")));
    await screen.findByRole("heading", {
      name: en("handover.import.doneTitle"),
    });
    expect(bridge.importProfile).toHaveBeenCalledWith(
      expect.objectContaining({ displayName: "FAKE Renamed" }),
    );
  });

  it("holds the file back when the same file or the same documents are already here, until the patient says add it anyway", async () => {
    for (const by of ["package", "content"] as const) {
      const user = userEvent.setup();
      const bridge = importBridge({
        inspectProfileImport: vi.fn().mockResolvedValue(
          preview({
            alreadyHere: { profileId: "p1", by, matchingDocuments: 3 },
          }),
        ),
      });
      await toPreview(user, bridge);
      expect(
        screen.getByText(
          humanText(
            by === "package"
              ? en("handover.import.duplicate.package")
              : en("handover.import.duplicate.content", { count: 3 }),
          ),
        ),
      ).toBeVisible();
      const add = button(en("handover.import.add"));
      expect(add).toBeDisabled();
      await user.click(
        screen.getByRole("checkbox", {
          name: en("handover.import.duplicate.anyway"),
        }),
      );
      expect(add).toBeEnabled();
      await user.click(add);
      await screen.findByRole("heading", {
        name: en("handover.import.doneTitle"),
      });
      expect(bridge.importProfile).toHaveBeenCalledWith(
        expect.objectContaining({ allowDuplicate: true }),
      );
      cleanup();
    }
  });

  it("lists the names the person had before, when the file says them", async () => {
    const user = userEvent.setup();
    await toPreview(
      user,
      importBridge({
        inspectProfileImport: vi
          .fn()
          .mockResolvedValue(
            preview({ previousFullNames: ["FAKE Old One", "FAKE Old Two"] }),
          ),
      }),
    );
    expect(
      screen.getByText(
        humanText(
          en("handover.import.previousNames", {
            names: "FAKE Old One, FAKE Old Two",
          }),
        ),
      ),
    ).toBeVisible();
  });

  it("a failed add spends the pick: back to choosing the file, the key gone, the reason shown", async () => {
    const user = userEvent.setup();
    const bridge = importBridge({
      importProfile: vi
        .fn()
        .mockRejectedValue(failure("fake_storage", "FAKE no room")),
    });
    await toPreview(user, bridge);
    await user.click(button(en("handover.import.add")));
    expect(
      await screen.findByRole("heading", { name: en("handover.import.title") }),
    ).toBeVisible();
    expect((await screen.findByRole("alert")).textContent).toContain(
      "FAKE no room",
    );
    // A new try starts from the file and asks for the key again.
    await user.click(button(en("handover.import.choose")));
    const input = (await screen.findByLabelText(
      en("handover.import.key"),
    )) as HTMLInputElement;
    expect(input.value).toBe("");
  });

  it("reports what arrived: the answers, the clinic evidence, what was dropped, and the receipt code", async () => {
    const user = userEvent.setup();
    const bridge = importBridge({
      importProfile: vi
        .fn()
        .mockResolvedValue(
          outcome({ aiAnswersDropped: 1, evidenceDropped: 2 }),
        ),
    });
    await toPreview(user, bridge);
    await user.click(button(en("handover.import.add")));
    await screen.findByRole("heading", {
      name: en("handover.import.doneTitle"),
    });
    expect(
      screen.getByText(
        humanText(en("handover.import.done", { count: 4, name: "FAKE Casey" })),
      ),
    ).toBeVisible();
    expect(
      screen.getByText(
        humanText(en("handover.import.doneAnswers", { count: 2 })),
      ),
    ).toBeVisible();
    expect(
      screen.getByText(humanText(en("handover.import.doneEvidence"))),
    ).toBeVisible();
    expect(
      screen.getByText(
        humanText(en("handover.import.doneDropped", { count: 3 })),
      ),
    ).toBeVisible();
    // The receipt code is shown, and spelled out for a screen reader.
    const code = screen.getByText("ABCD-EFGH");
    expect(code).toBeVisible();
    expect(code.getAttribute("aria-hidden")).toBe("true");
    expect(code.nextElementSibling?.textContent ?? "").not.toBe("");
  });

  it("when the person is already here nothing was written, and the library is not told of a new one", async () => {
    const user = userEvent.setup();
    const bridge = importBridge({
      importProfile: vi.fn().mockResolvedValue(
        outcome({
          status: "alreadyHere",
          profileId: null,
          receiptCode: null,
          evidenceKept: 0,
          aiAnswers: 0,
        }),
      ),
    });
    const { onImported } = await toPreview(user, bridge);
    await user.click(button(en("handover.import.add")));
    expect(
      await screen.findByText(en("handover.import.nothingNew")),
    ).toBeVisible();
    expect(onImported).not.toHaveBeenCalled();
    expect(screen.queryByText("ABCD-EFGH")).toBeNull();
  });

  it("an outside click closes it between steps, but not while work is under way", async () => {
    const user = userEvent.setup();
    let release: (value: string | null) => void = () => undefined;
    const bridge = importBridge({
      pickProfileImportSource: vi.fn(
        () => new Promise<string | null>((resolve) => (release = resolve)),
      ),
    });
    const { onClose } = renderImport(bridge);
    await user.click(button(en("handover.import.choose")));
    // Picking: the dialog is locked.
    fireEvent.mouseDown(document.querySelector(".dialog-backdrop")!);
    expect(onClose).not.toHaveBeenCalled();
    release(null);
    await screen.findByText(en("handover.import.noFile"));
    fireEvent.mouseDown(document.querySelector(".dialog-backdrop")!);
    expect(onClose).toHaveBeenCalledOnce();
  });
});
