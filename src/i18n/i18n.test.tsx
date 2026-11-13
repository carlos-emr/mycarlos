import { describe, expect, it, afterEach } from "vitest";
import {
  fireEvent,
  getDefaultNormalizer,
  render,
  screen,
  within,
} from "@testing-library/react";
import {
  MESSAGE_KEYS,
  LOCALES,
  formatDate,
  formatDeviceName,
  formatNumber,
  hasMessageKey,
  getLocale,
  matchLocale,
  resolveLocale,
  setLocaleOverride,
  t,
  translate,
  type Locale,
} from "./index";
import { parse } from "@fluent/syntax";
import { translatePrintedKit } from "./core";
import { CATALOGUE_SOURCES, fluentBundle } from "./catalogues";
import { CreateVault, VaultAuthFrame, UnlockVault } from "../native/VaultAuth";
import { MIN_PASSPHRASE_CHARS } from "../native/PassphraseChecklist";

const visibleText = (text: string) => text.replace(/[\u2068\u2069]/g, "");

afterEach(() => setLocaleOverride(null));

describe("catalogue", () => {
  it("parses every Fluent resource and keeps generated keys mapped", () => {
    for (const locale of LOCALES) {
      const resource = parse(CATALOGUE_SOURCES[locale], {});
      expect(
        resource.body.some((entry) => entry.type === "Junk"),
        locale,
      ).toBe(false);
      const ids = resource.body
        .filter((entry) => entry.type === "Message")
        .map((entry) => entry.id.name);
      expect(ids).toHaveLength(MESSAGE_KEYS.length);
      expect(new Set(ids).size).toBe(ids.length);
      expect(translate(locale, "create.submit").trim()).not.toBe("");
      expect(translate(locale, "create.submit")).not.toBe("create-submit");
    }
    expect(hasMessageKey("create.submit")).toBe(true);
    expect(hasMessageKey("missing.message")).toBe(false);
  });
});

describe("choosing the language", () => {
  it("follows the system language and falls back to English", () => {
    expect(resolveLocale(["fr-CA", "en"])).toBe("fr");
    expect(resolveLocale(["es-MX"])).toBe("es");
    expect(resolveLocale(["pl-PL"])).toBe("pl");
    expect(resolveLocale(["pt-BR"])).toBe("pt-BR");
    expect(resolveLocale(["pt-PT"])).toBe("pt-BR");
    expect(resolveLocale(["PT_br"])).toBe("pt-BR");
    expect(resolveLocale(["zh-CN"])).toBe("zh-CN");
    expect(resolveLocale(["zh-Hans"])).toBe("zh-CN");
    expect(resolveLocale(["zh-SG"])).toBe("zh-CN");
    expect(resolveLocale(["zh-TW"])).toBe("zh-TW");
    expect(resolveLocale(["zh-Hant"])).toBe("zh-TW");
    expect(resolveLocale(["zh-Hant-HK"])).toBe("zh-TW");
    expect(resolveLocale(["de-DE", "ja"])).toBe("en");
    expect(resolveLocale(["de-DE", "fr"])).toBe("fr");
    expect(resolveLocale([])).toBe("en");
    expect(resolveLocale([""])).toBe("en");
    expect(matchLocale("xx")).toBeNull();
  });
  it("lets a later setting override the system, and be cleared", () => {
    setLocaleOverride("pl");
    expect(getLocale()).toBe("pl");
    expect(document.documentElement.lang).toBe("pl");
    setLocaleOverride("pt-BR");
    expect(document.documentElement.lang).toBe("pt-BR");
    setLocaleOverride(null);
    expect(getLocale()).toBe("en");
    expect(document.documentElement.lang).toBe("en");
  });
  it("ignores a language that is not shipped", () => {
    setLocaleOverride("de" as Locale);
    expect(getLocale()).toBe("en");
  });
});

describe("translating", () => {
  it("shows a recoverable error for an unknown key", () => {
    expect(translate("fr", "nope" as never)).toBe(
      translate("fr", "language.error.formatting"),
    );
  });
  it("treats arguments as plain text and never reads their braces as Fluent syntax", () => {
    const result = translate("en", "create.profile.sharedTaken", {
      folder: "{count} <b>$&</b>",
    });
    expect(visibleText(result)).toContain("{count} <b>$&</b>");
  });
  it("chooses English plural forms", () => {
    expect(
      visibleText(translate("en", "unlock.autoLock", { count: 1 })),
    ).toContain("1 minute of");
    expect(
      visibleText(translate("en", "unlock.autoLock", { count: 5 })),
    ).toContain("5 minutes of");
  });
  it("chooses Polish plural forms: one, few, many, fractions", () => {
    const p = (count: number) =>
      visibleText(
        translate("pl", "restore.checked", { count, consequence: "." }),
      );
    expect(p(1)).toContain("1 dokument.");
    expect(p(2)).toContain("2 dokumenty");
    expect(p(4)).toContain("4 dokumenty");
    expect(p(5)).toContain("5 dokumentów");
    expect(p(12)).toContain("12 dokumentów");
    expect(p(22)).toContain("22 dokumenty");
    expect(p(25)).toContain("25 dokumentów");
    expect(p(0)).toContain("0 dokumentów");
    expect(p(1.5)).toContain("dokumentu");
    const m = (count: number) =>
      visibleText(translate("pl", "unlock.autoLock", { count }));
    expect(m(1)).toContain("po 1 minucie");
    expect(m(3)).toContain("po 3 minutach");
    expect(m(15)).toContain("po 15 minutach");
  });
  it("chooses French plural forms (0 and 1 are singular)", () => {
    expect(
      visibleText(translate("fr", "unlock.autoLock", { count: 1 })),
    ).toContain("1 minute d’");
    expect(
      visibleText(translate("fr", "unlock.autoLock", { count: 0 })),
    ).toContain("0 minute d’");
    expect(
      visibleText(translate("fr", "unlock.autoLock", { count: 15 })),
    ).toContain("15 minutes d’");
  });
  it("formats numbers for the UI language and dates for the computer", () => {
    expect(formatNumber(1234.5, "en")).toBe("1,234.5");
    expect(formatNumber(1234.5, "de" as Locale)).toBe("1.234,5");
    expect(formatNumber(1234.5, "pl")).toBe(
      new Intl.NumberFormat("pl").format(1234.5),
    );
    const day = new Date(Date.UTC(2026, 9, 15, 12));
    const opts = { dateStyle: "long", timeZone: "UTC" } as const;
    expect(formatDate(day, opts, "en")).toBe("October 15, 2026");
    expect(formatDate(day, opts, "fr")).toBe("15 octobre 2026");
    expect(formatDate(day, opts, "pl")).toBe("15 października 2026");
    setLocaleOverride("es");
    expect(formatDate(day, opts)).toBe(
      new Intl.DateTimeFormat(undefined, opts).format(day),
    );
    expect(t("create.submit")).toBe("Crear bóveda");
  });
  it("formats a big count in the language's own grouping", () => {
    expect(
      visibleText(
        translate("en", "restore.checked", { count: 1234, consequence: "" }),
      ),
    ).toContain("1,234 documents");
  });
});

describe("a rendered screen in each language", () => {
  const expected: Partial<Record<Locale, { heading: string; button: string }>> =
    {
      en: { heading: "Unlock your vault", button: "Unlock" },
      fr: {
        heading: "Déverrouiller votre coffre-fort",
        button: "Déverrouiller",
      },
      es: { heading: "Desbloquee su bóveda", button: "Desbloquear" },
      pl: { heading: "Odblokuj sejf", button: "Odblokuj" },
      "pt-BR": { heading: "Desbloqueie seu cofre", button: "Desbloquear" },
    };
  for (const locale of LOCALES) {
    it(`shows the unlock screen in ${locale}`, () => {
      setLocaleOverride(locale);
      const copy = expected[locale] ?? {
        heading: translate(locale, "unlock.title"),
        button: translate(locale, "unlock.submit"),
      };
      const { container } = render(
        <UnlockVault
          busy={false}
          notice=""
          autoLockMinutes={5}
          onUnlock={async () => {}}
          onRecover={async () => {}}
          onReset={async () => {}}
          restoreBridge={{} as never}
          onRestored={() => {}}
        />,
      );
      expect(document.documentElement.lang).toBe(locale);
      expect(
        screen.getByRole("heading", {
          level: 1,
          name: copy.heading,
        }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: copy.button }),
      ).toBeInTheDocument();
      // The Passphrase field's accessible name and its hidden-text count are
      // in the same language (screen-reader text).
      const field = container.querySelector("input[type=password]")!;
      expect(field.getAttribute("aria-label")).toBe(
        translate(locale, "passphrase.label"),
      );
      expect(field.getAttribute("title")).toBe(
        translate(locale, "secret.count.password", { count: 0 }),
      );
      expect(field.getAttribute("title")).not.toMatch(
        locale === "en" ? /\u0000/ : /character/,
      );
      // The window's accessible name is translated too.
      expect(
        screen.getByLabelText(translate(locale, "frame.window.label")),
      ).toBeInTheDocument();
      // Under "Forgot your passphrase?": what erasing does.
      expect(
        screen.getByText(translate(locale, "unlock.noKey.body")),
      ).toBeInTheDocument();
      expect(
        screen.getByText(translate(locale, "reset.plainly")),
      ).toBeInTheDocument();
    });
    it(`shows the setup screen and its passphrase checklist in ${locale}`, () => {
      setLocaleOverride(locale);
      const { container } = render(
        <CreateVault
          busy={false}
          notice=""
          onCreate={async () => {}}
          restoreBridge={{} as never}
          onRestored={() => {}}
        />,
      );
      const say = translate.bind(null, locale);
      expect(
        screen.getByRole("heading", { level: 1, name: say("create.title") }),
      ).toBeInTheDocument();
      const form = within(container.querySelector("form")!);
      expect(
        form.getByRole("textbox", { name: say("create.profile.label") }),
      ).toBeInTheDocument();
      // Each rule, and whether it is met yet (screen-reader text), in the
      // same language.
      const checklist = within(container.querySelector("#passphrase-rules")!);
      // French keeps its no-break space before the colon.
      const asWritten = {
        normalizer: getDefaultNormalizer({ collapseWhitespace: false }),
      };
      expect(
        checklist.getByText(say("checklist.heading"), asWritten),
      ).toBeInTheDocument();
      expect(
        checklist.getAllByRole("listitem").map((rule) => rule.textContent),
      ).toEqual(
        [
          say("checklist.length", { min: MIN_PASSPHRASE_CHARS }),
          say("checklist.hardToGuess"),
          say("checklist.notAName"),
        ].map((rule) => `○${rule}${say("checklist.notYet")}`),
      );
      expect(
        checklist.getByText(say("checklist.spaces"), asWritten),
      ).toBeInTheDocument();
      // Each Show button, the second named for its own box.
      expect(
        form.getByRole("button", { name: say("passphrase.show") }),
      ).toBeInTheDocument();
      expect(
        form.getByRole("button", {
          name: `${say("passphrase.show")} ${say("passphrase.show.inConfirm")}`,
        }),
      ).toBeInTheDocument();
      // No person may take Shared with me's name (#61), as any language
      // shows it: the refusal names it in this one.
      const profileBox = form.getByRole("textbox", {
        name: say("create.profile.label"),
      });
      for (const other of LOCALES) {
        const shared = translate(
          other,
          "interface.LibrarySidebar.sharedWithMe",
        );
        for (const typed of [
          ` ${shared.toUpperCase()} `,
          shared.toLowerCase().normalize("NFD"),
        ]) {
          fireEvent.change(profileBox, { target: { value: typed } });
          expect(form.getByRole("alert").textContent, typed).toBe(
            say("create.profile.sharedTaken", {
              folder: say("interface.LibrarySidebar.sharedWithMe"),
            }),
          );
        }
      }
      // A name that only holds it is a person's.
      fireEvent.change(profileBox, {
        target: {
          value: `${say("interface.LibrarySidebar.sharedWithMe")} FAKE`,
        },
      });
      expect(form.queryByRole("alert")).toBeNull();
    });
    it(`counts the shared files waiting at unlock in ${locale} (#61)`, () => {
      setLocaleOverride(locale);
      const unlock = (waiting: number) => (
        <UnlockVault
          busy={false}
          notice=""
          autoLockMinutes={5}
          waiting={waiting}
          onUnlock={async () => {}}
          onRecover={async () => {}}
          onReset={async () => {}}
          restoreBridge={{} as never}
          onRestored={() => {}}
        />
      );
      const { container, rerender } = render(unlock(1));
      const said = () =>
        container.querySelector(".native-received-waiting")?.textContent;
      const folder = translate(locale, "interface.LibrarySidebar.sharedWithMe");
      expect(said()).toBe(translate(locale, "unlock.waiting.one", { folder }));
      for (const count of [2, 5, 22]) {
        rerender(unlock(count));
        expect(said()).toBe(
          translate(locale, "unlock.waiting", { count, folder }),
        );
      }
      rerender(unlock(0));
      expect(said()).toBeUndefined();
    });
  }
  it("keeps the English of the shared-file messages (#61)", () => {
    const folder = "Shared with me";
    expect(visibleText(translate("en", "unlock.waiting.one", { folder }))).toBe(
      "One shared file is waiting. Unlock and it goes into Shared with me. If myCarlos closes first, it is not kept: share it again.",
    );
    expect(
      visibleText(translate("en", "unlock.waiting", { count: 2, folder })),
    ).toBe(
      "2 shared files are waiting. Unlock and they go into Shared with me. If myCarlos closes first, they are not kept: share them again.",
    );
    expect(
      visibleText(translate("en", "create.profile.sharedTaken", { folder })),
    ).toBe("Shared with me is where shared files go. Choose another name.");
    // Polish counts files three ways.
    expect(
      [2, 5, 22].map(
        (count) =>
          translate("pl", "unlock.waiting", { count, folder }).split(" ")[2],
      ),
    ).toEqual(["pliki", "plików", "pliki"]);
  });
  it("translates the frame state and keeps the erase phrase fixed", () => {
    setLocaleOverride("pl");
    render(<VaultAuthFrame state="Locked">x</VaultAuthFrame>);
    expect(screen.getByText("Zablokowany")).toBeInTheDocument();
  });
  it("keeps the native erase phrase in every language", () => {
    for (const locale of LOCALES) {
      expect(
        translate(locale, "reset.type", { phrase: "RESET MYCARLOS VAULT" }),
      ).toContain("RESET MYCARLOS VAULT");
    }
  });
});

describe("Chinese script negotiation", () => {
  it.each([
    ["zh", "zh-CN"],
    ["ZH_cn", "zh-CN"],
    ["zh-Hans", "zh-CN"],
    ["zh-Hant", "zh-TW"],
    ["zh-Hans-TW", "zh-CN"],
    ["zh-Hans-HK", "zh-CN"],
    ["zh-Hant-CN", "zh-TW"],
    ["zh-HK", "zh-TW"],
    ["zh-MO", "zh-TW"],
    ["zh-SG", "zh-CN"],
    ["zh-Hans-x-hant", "zh-CN"],
    ["zh-CN-x-tw", "zh-CN"],
    ["zh-Hans-u-ca-chinese-x-hant", "zh-CN"],
    ["zh-Hant-x-hans", "zh-TW"],
    ["zh-Hant-CN-u-ca-chinese-x-hans", "zh-TW"],
    ["zh-SG-u-rg-twzzzz", "zh-CN"],
    ["zh-u-rg-twzzzz", "zh-CN"],
    ["zh-u-ca-chinese-x-tw", "zh-CN"],
    ["zh-x-tw", "zh-CN"],
    ["zh-TW-x-cn", "zh-TW"],
    ["zh-HK-u-nu-hanidec", "zh-TW"],
    ["zh-MO-x-hans", "zh-TW"],
    ["zh-CN-u-co-hant", "zh-CN"],
    ["zh-TW-u-co-hans", "zh-TW"],
    [" zh_hans_TW_x_HANT ", "zh-CN"],
  ] as const)("maps %s to %s", (tag, expected) =>
    expect(matchLocale(tag)).toBe(expected),
  );
  it("uses supported system fallback while preserving an explicit saved choice", () => {
    expect(resolveLocale(["xx", "zh-Hant-CN"])).toBe("zh-TW");
    expect(resolveLocale(["xx"])).toBe("en");
    setLocaleOverride("zh-CN");
    expect(getLocale()).toBe("zh-CN");
    expect(resolveLocale(["zh-Hant"])).toBe("zh-TW");
    expect(getLocale()).toBe("zh-CN");
  });
  it("rejects malformed Chinese tags and uses the next supported system language", () => {
    expect(matchLocale("zh--CN")).toBeNull();
    expect(resolveLocale(["zh--CN", "fr-CA"])).toBe("fr");
    expect(resolveLocale(["zh--CN"])).toBe("en");
    setLocaleOverride("zh-TW");
    expect(resolveLocale(["zh-Hans-x-hant"])).toBe("zh-CN");
    expect(getLocale()).toBe("zh-TW");
  });
  it("reports missing formatting arguments instead of exposing unresolved variables", () => {
    expect(translate("en", "passphrase.rules")).toBe(
      translate("en", "language.error.formatting"),
    );
    expect(translate("en", "missing.key" as never)).toBe(
      translate("en", "language.error.formatting"),
    );
    const hostile = "FAKE <script>{label}</script> {$min}";
    expect(
      translate("en", "interface.person.records", { name: hostile }),
    ).toContain(hostile);
  });
  it("keeps default dates independent of every UI language", () => {
    const day = new Date(Date.UTC(2026, 9, 15, 12));
    const options = { dateStyle: "long", timeZone: "UTC" } as const;
    const expected = new Intl.DateTimeFormat(undefined, options).format(day);
    for (const locale of LOCALES) {
      setLocaleOverride(locale);
      expect(formatDate(day, options)).toBe(expected);
    }
  });
});

describe("human isolation and printed kit metadata", () => {
  it("isolates hostile RTL arguments without altering their contents", () => {
    const name = "FAKE אבג <b>{name}</b>";
    for (const locale of LOCALES) {
      const result = translate(locale, "interface.person.records", { name });
      expect(result).toContain(`\u2068${name}\u2069`);
    }
  });
  it("keeps printed metadata byte-exact and separate from normal cached bundles", () => {
    for (const locale of LOCALES) {
      const params = { label: "BEAD", date: "2026-10-27" };
      const raw = () => translatePrintedKit(locale, "kit.labelPrinted", params);
      expect(raw()).not.toMatch(/[\u2066-\u2069]/u);
      expect(raw()).toContain(params.label);
      expect(raw()).toContain(params.date);
      expect(translate(locale, "kit.labelPrinted", params)).toContain(
        "\u2068BEAD\u2069",
      );
      expect(raw()).not.toMatch(/[\u2066-\u2069]/u);
    }
  });
  it("names a new device in every language, as data the portal can keep (#124 review)", () => {
    for (const locale of LOCALES) {
      const name = formatDeviceName(locale, "Windows");
      expect(name).toContain("myCarlos");
      expect(name).toContain("Windows");
      // Sent to the clinic's portal: no invisible marks, and within the
      // 64 characters the native side accepts.
      expect(name).not.toMatch(/[\u2066-\u2069]/u);
      expect(name.trim()).toBe(name);
      expect([...name].length).toBeLessThanOrEqual(64);
    }
    expect(formatDeviceName("fr", "macOS")).toBe("myCarlos sur macOS");
    expect(formatDeviceName("zh-CN", "iOS")).toBe("iOS 上的 myCarlos");
    // A formatter fault gives the app's name, not the fault text.
    expect(formatDeviceName("__proto__" as Locale, "Windows")).toBe("myCarlos");
  });
  it("returns the safe English failure for a forced invalid locale", () => {
    expect(translate("__proto__" as Locale, "create.submit")).toBe(
      translate("en", "language.error.formatting"),
    );
  });
});

describe("complete runtime resources", () => {
  it("formats every shipped message and count branch without resolver errors", () => {
    for (const locale of LOCALES) {
      const bundle = fluentBundle(locale);
      const ast = parse(CATALOGUE_SOURCES[locale], {});
      for (const entry of ast.body) {
        if (entry.type !== "Message") continue;
        const names = new Set<string>();
        const visit = (value: unknown) => {
          if (!value || typeof value !== "object") return;
          const node = value as { type?: string; id?: { name: string } };
          if (node.type === "VariableReference") names.add(node.id!.name);
          Object.values(value).forEach((child) =>
            Array.isArray(child) ? child.forEach(visit) : visit(child),
          );
        };
        visit(entry);
        for (const count of [0, 1, 2, 5, 22, 1.5, 12345]) {
          const args = Object.fromEntries(
            [...names].map((name) => [
              name,
              name === "count" ? count : `FAKE אבג <b>{${name}}</b>`,
            ]),
          );
          const errors: Error[] = [];
          const result = bundle.formatPattern(
            bundle.getMessage(entry.id.name)!.value!,
            args,
            errors,
          );
          expect(errors, `${locale}/${entry.id.name}/${count}`).toEqual([]);
          expect(result.trim(), `${locale}/${entry.id.name}/${count}`).not.toBe(
            "",
          );
        }
      }
    }
  });
});
