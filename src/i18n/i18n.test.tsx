import { describe, expect, it, afterEach } from "vitest";
import {
  fireEvent,
  getDefaultNormalizer,
  render,
  screen,
  within,
} from "@testing-library/react";
import {
  CATALOGUES,
  LOCALES,
  formatDate,
  formatNumber,
  getLocale,
  interpolate,
  matchLocale,
  resolveLocale,
  setLocaleOverride,
  t,
  translate,
  type Locale,
  type Message,
} from "./index";
import { en } from "./locales/en";
import { CreateVault, VaultAuthFrame, UnlockVault } from "../native/VaultAuth";
import { MIN_PASSPHRASE_CHARS } from "../native/PassphraseChecklist";

const placeholders = (text: string) =>
  [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
const forms = (message: Message): [string, string][] =>
  typeof message === "string"
    ? [["", message]]
    : Object.entries(message).map(([k, v]) => [k, v as string]);

afterEach(() => setLocaleOverride(null));

describe("catalogue", () => {
  const keys = Object.keys(en);
  for (const locale of LOCALES) {
    describe(locale, () => {
      const catalogue = CATALOGUES[locale] as Record<string, Message>;
      it("has every key and no extras", () => {
        expect(Object.keys(catalogue).sort()).toEqual([...keys].sort());
      });
      it("has real text for every key, not empty or the key itself", () => {
        for (const key of keys) {
          for (const [, text] of forms(catalogue[key])) {
            expect(text.trim(), key).not.toBe("");
            expect(text, key).not.toBe(key);
          }
        }
      });
      it("uses the same placeholders as English", () => {
        for (const key of keys) {
          const source: Message = en[key as keyof typeof en];
          const message = catalogue[key];
          // A lexical singular can say “A file” while its plural shows
          // {count}. Compare the corresponding English form; categories
          // English lacks (few/many) inherit its other-form contract.
          expect(typeof message === "string", key).toBe(
            typeof source === "string",
          );
          for (const [form, text] of forms(message)) {
            const sourceText =
              typeof source === "string"
                ? source
                : (source[form as keyof typeof source] ?? source.other);
            expect(placeholders(text), `${key} ${form}`).toEqual(
              placeholders(sourceText),
            );
          }
        }
      });
      it("covers every plural category of the language", () => {
        const needed = new Intl.PluralRules(locale).resolvedOptions()
          .pluralCategories;
        for (const key of keys) {
          const message = catalogue[key];
          if (typeof message === "string") continue;
          for (const category of needed) {
            expect(message[category], `${key} ${category}`).toBeTruthy();
          }
        }
      });
      it("does not carry markup", () => {
        for (const key of keys) {
          for (const [, text] of forms(catalogue[key])) {
            expect(text, key).not.toMatch(/[<>]/);
          }
        }
      });
    });
  }
});

describe("choosing the language", () => {
  it("follows the system language and falls back to English", () => {
    expect(resolveLocale(["fr-CA", "en"])).toBe("fr");
    expect(resolveLocale(["es-MX"])).toBe("es");
    expect(resolveLocale(["pl-PL"])).toBe("pl");
    expect(resolveLocale(["pt-BR"])).toBe("pt-BR");
    expect(resolveLocale(["pt-PT"])).toBe("pt-BR");
    expect(resolveLocale(["PT_br"])).toBe("pt-BR");
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
  it("falls back to English for a missing key and shows an unknown key", () => {
    const original = CATALOGUES.fr["create.submit"];
    delete (CATALOGUES.fr as Record<string, Message>)["create.submit"];
    try {
      expect(translate("fr", "create.submit")).toBe("Create vault");
    } finally {
      (CATALOGUES.fr as Record<string, Message>)["create.submit"] = original;
    }
    expect(translate("fr", "nope" as never)).toBe("nope");
  });
  it("fills placeholders once and never reads values as placeholders", () => {
    expect(interpolate("Hi {name} {x}", { name: "{x}" }, "en")).toBe(
      "Hi {x} {x}",
    );
    expect(interpolate("Hi {gone}", {}, "en")).toBe("Hi {gone}");
    expect(interpolate("{a}", { a: "<b>x</b>" }, "en")).toBe("<b>x</b>");
    expect(interpolate("{a}", { a: "$&" }, "en")).toBe("$&");
  });
  it("chooses English plural forms", () => {
    expect(translate("en", "unlock.autoLock", { count: 1 })).toContain(
      "1 minute of",
    );
    expect(translate("en", "unlock.autoLock", { count: 5 })).toContain(
      "5 minutes of",
    );
  });
  it("chooses Polish plural forms: one, few, many, fractions", () => {
    const p = (count: number) =>
      translate("pl", "restore.checked", { count, consequence: "." });
    expect(p(1)).toContain("1 dokument.");
    expect(p(2)).toContain("2 dokumenty");
    expect(p(4)).toContain("4 dokumenty");
    expect(p(5)).toContain("5 dokumentów");
    expect(p(12)).toContain("12 dokumentów");
    expect(p(22)).toContain("22 dokumenty");
    expect(p(25)).toContain("25 dokumentów");
    expect(p(0)).toContain("0 dokumentów");
    expect(p(1.5)).toContain("dokumentu");
    const m = (count: number) => translate("pl", "unlock.autoLock", { count });
    expect(m(1)).toContain("po 1 minucie");
    expect(m(3)).toContain("po 3 minutach");
    expect(m(15)).toContain("po 15 minutach");
  });
  it("chooses French plural forms (0 and 1 are singular)", () => {
    expect(translate("fr", "unlock.autoLock", { count: 1 })).toContain(
      "1 minute d’",
    );
    expect(translate("fr", "unlock.autoLock", { count: 0 })).toContain(
      "0 minute d’",
    );
    expect(translate("fr", "unlock.autoLock", { count: 15 })).toContain(
      "15 minutes d’",
    );
  });
  it("formats numbers and dates with Intl for the language", () => {
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
    expect(formatDate(day, opts)).toBe("15 de octubre de 2026");
    expect(t("create.submit")).toBe("Crear bóveda");
  });
  it("formats a big count in the language's own grouping", () => {
    expect(
      translate("en", "restore.checked", { count: 1234, consequence: "" }),
    ).toContain("1,234 documents");
  });
});

describe("a rendered screen in each language", () => {
  const expected: Record<Locale, { heading: string; button: string }> = {
    en: { heading: "Unlock your vault", button: "Unlock" },
    fr: { heading: "Déverrouiller votre coffre-fort", button: "Déverrouiller" },
    es: { heading: "Desbloquee su bóveda", button: "Desbloquear" },
    pl: { heading: "Odblokuj sejf", button: "Odblokuj" },
    "pt-BR": { heading: "Desbloqueie seu cofre", button: "Desbloquear" },
  };
  for (const locale of LOCALES) {
    it(`shows the unlock screen in ${locale}`, () => {
      setLocaleOverride(locale);
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
          name: expected[locale].heading,
        }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: expected[locale].button }),
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
    expect(translate("en", "unlock.waiting.one", { folder })).toBe(
      "One shared file is waiting. Unlock and it goes into Shared with me. If myCarlos closes first, it is not kept: share it again.",
    );
    expect(translate("en", "unlock.waiting", { count: 2, folder })).toBe(
      "2 shared files are waiting. Unlock and they go into Shared with me. If myCarlos closes first, they are not kept: share them again.",
    );
    expect(translate("en", "create.profile.sharedTaken", { folder })).toBe(
      "Shared with me is where shared files go. Choose another name.",
    );
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
