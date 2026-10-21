import { fireEvent, render, screen, within } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import type { VaultBridge, VaultSnapshot } from "../vault";
import type { ClinicDelivery, ClinicLink } from "./clinicLinks";
import type { FoundName } from "./personMatch";
import { ClinicDeliveryDialog } from "./ClinicDeliveryDialog";
import { ClinicLinksSetting } from "./ClinicLinksSetting";
import { PersonSuggestion } from "./PersonSuggestion";
import { VaultLibrary } from "./VaultLibrary";

// Prototype: file shared documents to the right person. FAKE data only.
const people = [
  { id: "p1", displayName: "FAKE Mom", createdAtMs: 1 },
  { id: "p2", displayName: "FAKE Jamie Example", createdAtMs: 2 },
];
const clinic = {
  clinicId: "c1",
  clinicName: "FAKE Lakeside Family Clinic",
  provider: "Dr. FAKE Rivera",
  patientName: "FAKE Mary Smith",
  patientBirthDate: "1958-03-12",
};
const first: ClinicDelivery = {
  id: "d1",
  ...clinic,
  title: "FAKE Blood test results",
  kind: "Lab result",
  serviceDate: "2026-10-14",
};
const second: ClinicDelivery = {
  ...first,
  id: "d2",
  title: "FAKE Follow-up visit note",
};

describe("the first document from a clinic (prototype)", () => {
  function ask() {
    const onFile = vi.fn();
    const onLater = vi.fn();
    render(
      <ClinicDeliveryDialog
        delivery={first}
        people={people}
        busy={false}
        onFile={onFile}
        onLater={onLater}
      />,
    );
    return {
      dialog: screen.getByRole("dialog", { name: "FAKE Blood test results" }),
      onFile,
      onLater,
    };
  }

  it("names the clinic's patient with their birth date, and files nothing until a choice", async () => {
    const { dialog, onFile } = ask();
    expect(dialog).toHaveTextContent(
      "This came from FAKE Lakeside Family Clinic for FAKE Mary Smith, born 12 Mar 1958.",
    );
    const fileIt = within(dialog).getByRole("button", { name: "File it" });
    expect(fileIt).toBeDisabled();
    expect(
      within(dialog)
        .getAllByRole("radio")
        .map((radio) => radio.closest("label")?.textContent),
    ).toEqual(["FAKE Mom", "FAKE Jamie Example", "Shared with me"]);
    for (const radio of within(dialog).getAllByRole("radio"))
      expect(radio).not.toBeChecked();
    expect(onFile).not.toHaveBeenCalled();
  });

  it("files under the person, remembering only when Always is ticked", async () => {
    const { dialog, onFile } = ask();
    await userEvent.click(
      within(dialog).getByRole("radio", { name: "FAKE Mom" }),
    );
    await userEvent.click(
      within(dialog).getByRole("checkbox", {
        name: "Always file this clinic's documents for FAKE Mary Smith here.",
      }),
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "File it" }),
    );
    expect(onFile).toHaveBeenCalledWith("p1", true);
  });

  it("puts it in Shared with me without a link", async () => {
    const { dialog, onFile } = ask();
    const always = within(dialog).getByRole("checkbox");
    await userEvent.click(
      within(dialog).getByRole("radio", { name: "FAKE Mom" }),
    );
    await userEvent.click(always);
    await userEvent.click(
      within(dialog).getByRole("radio", { name: "Shared with me" }),
    );
    expect(always).toBeDisabled();
    expect(always).not.toBeChecked();
    await userEvent.click(
      within(dialog).getByRole("button", { name: "File it" }),
    );
    expect(onFile).toHaveBeenCalledWith(null, false);
  });

  it("leaves it for later with Later or Escape", async () => {
    const { dialog, onLater } = ask();
    await userEvent.keyboard("{Escape}");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Later" }),
    );
    expect(onLater).toHaveBeenCalledTimes(2);
  });
});

describe("the clinic links list (prototype)", () => {
  const link: ClinicLink = { ...clinic, profileId: "p1" };

  it("says when there are none", () => {
    render(
      <ClinicLinksSetting
        links={[]}
        people={people}
        busy={false}
        onChange={vi.fn()}
        onForget={vi.fn()}
      />,
    );
    expect(screen.getByText(/^No clinic links yet\./)).toBeVisible();
  });

  it("shows where a clinic's patient goes, and changes or forgets it", async () => {
    const onChange = vi.fn();
    const onForget = vi.fn();
    render(
      <ClinicLinksSetting
        links={[link]}
        people={people}
        busy={false}
        onChange={onChange}
        onForget={onForget}
      />,
    );
    expect(screen.getByRole("listitem")).toHaveTextContent(
      "FAKE Lakeside Family Clinic · for FAKE Mary Smith → FAKE Mom",
    );
    await userEvent.click(
      screen.getByRole("button", {
        name: "Change person for FAKE Lakeside Family Clinic, FAKE Mary Smith",
      }),
    );
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "File under" }),
      "FAKE Jamie Example",
    );
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onChange).toHaveBeenCalledWith(link, "p2");
    await userEvent.click(
      screen.getByRole("button", {
        name: "Forget FAKE Lakeside Family Clinic, FAKE Mary Smith",
      }),
    );
    expect(onForget).toHaveBeenCalledWith(link);
  });
});

describe("the person a shared document looks like it is for (prototype)", () => {
  it("offers a move and a no, each naming the document", async () => {
    const onMove = vi.fn();
    const onDismiss = vi.fn();
    render(
      <PersonSuggestion
        person={people[1]}
        documentName="FAKE Referral letter.pdf"
        busy={false}
        onMove={onMove}
        onDismiss={onDismiss}
      />,
    );
    const group = screen.getByRole("group", {
      name: "Suggested person for FAKE Referral letter.pdf",
    });
    expect(group).toHaveTextContent(
      "Looks like this is for FAKE Jamie Example (the name on the document matches). Move it to FAKE Jamie Example's records?",
    );
    await userEvent.click(
      within(group).getByRole("button", {
        name: "Move FAKE Referral letter.pdf to FAKE Jamie Example's records",
      }),
    );
    await userEvent.click(
      within(group).getByRole("button", {
        name: "Not this person: FAKE Referral letter.pdf",
      }),
    );
    expect(onMove).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

describe("the library with the prototype (FAKE bridge)", () => {
  const shared = (id: string, name: string) => ({
    id,
    profileId: "shared",
    folderIds: [],
    displayName: name,
    sourceLabel: "Shared from another app — unverified",
    mediaType: "application/pdf",
    plaintextSize: 1000,
    importedAtMs: Date.UTC(2026, 9, 14),
    available: true,
  });
  const vault: VaultSnapshot = {
    profiles: [
      ...people,
      { id: "shared", displayName: "Shared with me", createdAtMs: 3 },
    ],
    folders: [],
    records: [
      shared("s1", "FAKE Referral letter.pdf"),
      shared("s2", "FAKE Pharmacy receipt.pdf"),
      shared("s3", "FAKE Twin letter.pdf"),
    ],
    recovery: null,
    sharedProfileId: "shared",
  };

  function renderLibrary(extra: Partial<VaultBridge>) {
    const bridge = {
      snapshot: vi.fn().mockResolvedValue(vault),
      moveToPerson: vi
        .fn()
        .mockResolvedValue({ moved: ["s1"], alreadyThere: [] }),
      ...extra,
    } as unknown as VaultBridge;
    const setNotice = vi.fn();
    render(
      <VaultLibrary
        bridge={bridge}
        snapshot={vault}
        busy={false}
        notice=""
        setNotice={setNotice}
        run={async (operation) => operation()}
        refresh={async () => vault}
        onLock={vi.fn().mockResolvedValue(undefined)}
        autoLockMinutes={5}
        onAutoLockMinutes={vi.fn()}
      />,
    );
    return { bridge, setNotice };
  }

  it("asks about a clinic's first document, then files the next under the remembered person", async () => {
    let waiting = [first];
    const fileClinicDelivery = vi.fn(async (id: string) => {
      waiting = waiting.filter((delivery) => delivery.id !== id);
      if (id === "d1") waiting.push(second);
    });
    const { setNotice } = renderLibrary({
      clinicDeliveries: async () => waiting,
      fileClinicDelivery,
    });
    const dialog = await screen.findByRole("dialog", {
      name: "FAKE Blood test results",
    });
    await userEvent.click(
      within(dialog).getByRole("radio", { name: "FAKE Mom" }),
    );
    await userEvent.click(within(dialog).getByRole("checkbox"));
    await userEvent.click(
      within(dialog).getByRole("button", { name: "File it" }),
    );
    await vi.waitFor(() =>
      expect(setNotice).toHaveBeenCalledWith(
        "1 document from FAKE Lakeside Family Clinic was filed under FAKE Mom.",
      ),
    );
    expect(fileClinicDelivery.mock.calls).toEqual([
      ["d1", "p1"],
      ["d2", "p1"],
    ]);
    expect(screen.queryByRole("dialog")).toBeNull();
    // The link is listed in Security.
    fireEvent.click(screen.getAllByRole("button", { name: "Security" })[0]);
    expect(
      screen.getByRole("region", { name: /Clinic links/ }),
    ).toHaveTextContent(
      "FAKE Lakeside Family Clinic · for FAKE Mary Smith → FAKE Mom",
    );
  });

  it("asks again for the next one when the first went to Shared with me", async () => {
    let waiting = [first];
    const fileClinicDelivery = vi.fn(async (id: string) => {
      waiting = waiting.filter((delivery) => delivery.id !== id);
      if (id === "d1") waiting.push(second);
    });
    renderLibrary({
      clinicDeliveries: async () => waiting,
      fileClinicDelivery,
    });
    const dialog = await screen.findByRole("dialog", {
      name: "FAKE Blood test results",
    });
    await userEvent.click(
      within(dialog).getByRole("radio", { name: "Shared with me" }),
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "File it" }),
    );
    expect(fileClinicDelivery).toHaveBeenCalledWith("d1", null);
    window.dispatchEvent(new Event("focus"));
    expect(
      await screen.findByRole("dialog", { name: "FAKE Follow-up visit note" }),
    ).toBeVisible();
    expect(fileClinicDelivery).toHaveBeenCalledTimes(1);
  });

  it("suggests the one person a shared document's name matches, and only moves on Move", async () => {
    const found: Record<string, FoundName | null> = {
      s1: { name: "EXAMPLE, FAKE JAMIE" },
      s2: { name: "FAKE Robin Sample" },
    };
    const { bridge } = renderLibrary({
      nameFoundIn: async (id: string) => found[id] ?? null,
    });
    fireEvent.click(
      screen.getAllByRole("button", { name: /^Shared with me/ })[0],
    );
    const suggestion = await screen.findByRole("group", {
      name: "Suggested person for FAKE Referral letter.pdf",
    });
    expect(
      screen.queryByRole("group", {
        name: "Suggested person for FAKE Pharmacy receipt.pdf",
      }),
    ).toBeNull();
    expect(bridge.moveToPerson).not.toHaveBeenCalled();
    await userEvent.click(
      within(suggestion).getByRole("button", { name: /^Move / }),
    );
    expect(bridge.moveToPerson).toHaveBeenCalledWith(["s1"], "p2", []);
  });

  it("hides a suggestion after Not this person, in the list and the details", async () => {
    renderLibrary({
      nameFoundIn: async (id: string) =>
        id === "s1" ? { name: "FAKE Jamie Example" } : null,
    });
    fireEvent.click(
      screen.getAllByRole("button", { name: /^Shared with me/ })[0],
    );
    await userEvent.click(
      screen.getByRole("button", {
        name: "Details for FAKE Referral letter.pdf",
      }),
    );
    const details = screen.getByRole("dialog", {
      name: "FAKE Referral letter.pdf",
    });
    await userEvent.click(
      await within(details).findByRole("button", {
        name: "Not this person: FAKE Referral letter.pdf",
      }),
    );
    expect(
      within(details).queryByRole("group", { name: /^Suggested person/ }),
    ).toBeNull();
    await userEvent.click(
      within(details).getByRole("button", { name: "Close document details" }),
    );
    expect(
      screen.queryByRole("group", { name: /^Suggested person/ }),
    ).toBeNull();
  });

  it("offers nothing when the bridge cannot read names or has no deliveries", async () => {
    renderLibrary({
      nameFoundIn: () => Promise.reject(new Error("FAKE unknown command")),
      clinicDeliveries: () => Promise.reject(new Error("FAKE unknown command")),
    });
    fireEvent.click(
      screen.getAllByRole("button", { name: /^Shared with me/ })[0],
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      screen.queryByRole("group", { name: /^Suggested person/ }),
    ).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
