import { humanText } from "../test/humanText";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  OpenSourceNotices,
  SOURCE_ADDRESS,
  type NoticesData,
} from "./OpenSourceNotices";
import { PreferencesSettings } from "./PreferencesSettings";

// FAKE libraries and licence texts: nothing here is the real notices file.
const data: NoticesData = {
  ownLicence: "FAKE GNU AFFERO GENERAL PUBLIC LICENSE text",
  notices: {
    schema: 1,
    components: [
      {
        ecosystem: "npm",
        name: "fake-react",
        version: "19.0.0",
        license: "MIT",
        texts: [{ id: "aaa", name: "LICENSE" }],
      },
      {
        ecosystem: "cargo",
        name: "fake-serde",
        version: "1.0.200",
        license: "MIT OR Apache-2.0",
        texts: [
          { id: "bbb", name: "LICENSE-APACHE" },
          { id: "aaa", name: "LICENSE-MIT" },
        ],
      },
      {
        ecosystem: "bundled",
        name: "fake-llama",
        version: "1",
        license: "BSD-3-Clause",
        source: "https://example.invalid/fake-llama",
        texts: [{ id: "ccc", name: "LICENSE" }],
      },
      {
        ecosystem: "cargo",
        name: "fake-free",
        version: "2.0.0",
        license: "CC0-1.0",
        texts: [],
      },
    ],
    texts: {
      aaa: "FAKE MIT text, Copyright the fake authors",
      bbb: "FAKE Apache License text",
      ccc: "FAKE BSD text",
    },
  },
};

const renderNotices = (load = () => Promise.resolve(data)) => {
  const onBack = vi.fn();
  render(<OpenSourceNotices onBack={onBack} load={load} />);
  return { onBack };
};

describe("Open-source notices", () => {
  it("names myCarlos's licence, offers the source and links back, with the heading focused", async () => {
    const user = userEvent.setup();
    const { onBack } = renderNotices();
    const heading = screen.getByRole("heading", {
      level: 1,
      name: humanText("Open-source notices"),
    });
    expect(heading).toHaveFocus();
    expect(
      screen.getByText(
        humanText(/GNU Affero General Public License, version 3/),
      ),
    ).toBeVisible();
    expect(
      screen.getByRole("heading", { name: humanText("Get the source code") }),
    ).toBeVisible();
    // Shown as text to type, not a link: the app opens no web addresses of its own.
    expect(screen.getByText(SOURCE_ADDRESS)).toBeVisible();
    expect(screen.queryByRole("link")).toBeNull();
    await user.click(
      screen.getByRole("button", { name: humanText(/Back to Preferences/) }),
    );
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("copies the source address, and says when it cannot", async () => {
    const user = userEvent.setup();
    renderNotices();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    await user.click(
      screen.getByRole("button", { name: humanText("Copy the address") }),
    );
    expect(writeText).toHaveBeenCalledWith(SOURCE_ADDRESS);
    expect(await screen.findByText(humanText("Address copied."))).toBeVisible();
    writeText.mockRejectedValue(new Error("FAKE denied"));
    await user.click(
      screen.getByRole("button", { name: humanText("Copy the address") }),
    );
    expect(
      await screen.findByText(humanText(/Select the whole address/)),
    ).toBeVisible();
  });

  it("shows the full text of myCarlos's own licence when asked", async () => {
    const user = userEvent.setup();
    renderNotices();
    expect(screen.queryByText(/FAKE GNU AFFERO/)).toBeNull();
    await user.click(screen.getByText(humanText("Show the full licence text")));
    expect(
      await screen.findByText(/FAKE GNU AFFERO GENERAL PUBLIC LICENSE text/),
    ).toBeVisible();
  });

  it("lists every library with its version and licence, and says how many", async () => {
    renderNotices();
    expect(
      await screen.findByText(humanText("4 libraries and tools")),
    ).toBeVisible();
    const list = screen.getByRole("list");
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(4);
    expect(items[0]).toHaveTextContent(/fake-react\s*19\.0\.0\s*MIT/);
    expect(items[1]).toHaveTextContent(
      /fake-serde\s*1\.0\.200\s*MIT OR Apache-2\.0/,
    );
    expect(items[2]).toHaveTextContent(/fake-llama\s*1\s*BSD-3-Clause/);
    expect(items[3]).toHaveTextContent(/fake-free\s*2\.0\.0\s*CC0-1\.0/);
  });

  it("shows a library's licence texts only when its entry is opened", async () => {
    const user = userEvent.setup();
    renderNotices();
    await screen.findByText(humanText("4 libraries and tools"));
    expect(screen.queryByText(/FAKE Apache License text/)).toBeNull();
    await user.click(screen.getByText(/^fake-serde/));
    expect(await screen.findByText("FAKE Apache License text")).toBeVisible();
    // The text that two files share is stored once and shown under each name.
    expect(
      screen.getAllByText("FAKE MIT text, Copyright the fake authors"),
    ).toHaveLength(1);
    expect(
      screen.getByRole("heading", { name: "LICENSE-APACHE" }),
    ).toBeVisible();
    expect(screen.getByRole("heading", { name: "LICENSE-MIT" })).toBeVisible();
    expect(
      within(
        screen.getByText(/^fake-serde/).closest("li") as HTMLElement,
      ).getByText(humanText("Rust library")),
    ).toBeVisible();
  });

  it("says where a bundled tool comes from, and when a licence asks for no text", async () => {
    const user = userEvent.setup();
    renderNotices();
    await screen.findByText(humanText("4 libraries and tools"));
    await user.click(screen.getByText(/^fake-llama/));
    expect(
      await screen.findByText(
        /Bundled with myCarlos · https:\/\/example\.invalid\/fake-llama/,
      ),
    ).toBeVisible();
    await user.click(screen.getByText(/^fake-free/));
    expect(
      await screen.findByText(
        humanText(/does not ask for a text to be included/),
      ),
    ).toBeVisible();
  });

  it("searches by name, version or licence and says how many match", async () => {
    const user = userEvent.setup();
    renderNotices();
    const search = await screen.findByRole("searchbox", {
      name: humanText("Search the libraries by name or licence"),
    });
    await user.type(search, "apache");
    expect(
      await screen.findByText(humanText("1 of 4 libraries and tools")),
    ).toBeVisible();
    expect(
      within(screen.getByRole("list")).getAllByRole("listitem"),
    ).toHaveLength(1);
    await user.clear(search);
    await user.type(search, "1.0.200");
    expect(
      await screen.findByText(humanText("1 of 4 libraries and tools")),
    ).toBeVisible();
    await user.clear(search);
    await user.type(search, "cc0");
    expect(
      await screen.findByText(humanText("1 of 4 libraries and tools")),
    ).toBeVisible();
    await user.clear(search);
    await user.type(search, "no such library");
    expect(
      await screen.findByText(humanText("No library matches your search.")),
    ).toBeVisible();
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("says so, and keeps the page, when the notices cannot be loaded", async () => {
    renderNotices(() => Promise.reject(new Error("FAKE load failure")));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /The notices could not be loaded/,
    );
    expect(screen.getByRole("heading", { level: 1 })).toBeVisible();
    expect(screen.queryByRole("searchbox")).toBeNull();
  });

  it("says it is loading while the notices are on their way", async () => {
    let finish: (value: NoticesData) => void = () => {};
    renderNotices(
      () =>
        new Promise<NoticesData>((resolve) => {
          finish = resolve;
        }),
    );
    expect(
      screen
        .getAllByRole("status")
        .some((status) =>
          /Loading the notices…/.test(status.textContent ?? ""),
        ),
    ).toBe(true);
    finish(data);
    await waitFor(() => expect(screen.getByRole("searchbox")).toBeVisible());
  });
});

describe("About, in Preferences", () => {
  it("opens the notices from a button, and shows nothing about them where they cannot open", async () => {
    const user = userEvent.setup();
    const onOpenNotices = vi.fn();
    const { unmount } = render(
      <PreferencesSettings onOpenNotices={onOpenNotices} />,
    );
    expect(
      screen.getByRole("heading", { name: humanText("About myCarlos") }),
    ).toBeVisible();
    await user.click(
      screen.getByRole("button", { name: humanText("Open-source notices") }),
    );
    expect(onOpenNotices).toHaveBeenCalledTimes(1);
    unmount();
    render(<PreferencesSettings />);
    expect(
      screen.queryByRole("heading", { name: humanText("About myCarlos") }),
    ).toBeNull();
  });
});
