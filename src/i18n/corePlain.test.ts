import { afterEach, describe, expect, it } from "vitest";
import { LOCALES } from "./types";
import {
  formatPhotoName,
  formatVideoName,
  getLocale,
  getLocaleOverride,
  resolveLocale,
  setLocaleOverride,
  t,
  tPlain,
  translatePlain,
} from "./core";

// What the language helpers promise the rest of the app: text for people is isolated against
// mixed-direction names, text that is stored or sent as data is not, a chosen language is kept
// apart from the system's, and the system's language is read from whatever the device offers.

const ISOLATES = /[⁨⁩]/;

afterEach(() => {
  setLocaleOverride(null);
  Reflect.deleteProperty(navigator, "languages");
  Reflect.deleteProperty(navigator, "language");
});

function system(languages: string[], language = "") {
  Object.defineProperty(navigator, "languages", {
    configurable: true,
    get: () => languages,
  });
  Object.defineProperty(navigator, "language", {
    configurable: true,
    get: () => language,
  });
}

describe("text for people and text that is data", () => {
  it("isolates an inserted name for a reader, and the plain forms do not, in every language", () => {
    for (const locale of LOCALES) {
      setLocaleOverride(locale);
      const shown = t("library.select", { name: "FAKE Name.pdf" });
      const plain = tPlain("library.select", { name: "FAKE Name.pdf" });
      expect(shown).toMatch(ISOLATES);
      expect(plain).not.toMatch(ISOLATES);
      // The same words otherwise.
      expect(shown.replace(/[⁨⁩]/g, "")).toBe(plain);
      expect(
        translatePlain(locale, "library.select", { name: "FAKE Name.pdf" }),
      ).toBe(plain);
    }
  });

  it("the plain text of another language is that language's, whatever the app is set to", () => {
    setLocaleOverride("en");
    const french = translatePlain("fr", "library.select", { name: "FAKE.pdf" });
    expect(french).toContain("FAKE.pdf");
    expect(french).not.toBe(tPlain("library.select", { name: "FAKE.pdf" }));
  });

  it("a generated photo name and video name hold the date and time they were given, are named for their kind, and carry no invisible mark", () => {
    for (const locale of LOCALES) {
      const photo = formatPhotoName(locale, "17 Oct 2026", "3.05 PM");
      const video = formatVideoName(locale, "17 Oct 2026", "3.05 PM");
      for (const name of [photo, video]) {
        expect(name, locale).not.toMatch(ISOLATES);
        expect(name, locale).toContain("17 Oct 2026");
        expect(name, locale).toContain("3.05 PM");
      }
      expect(photo, locale).toMatch(/\.jpg$/);
      expect(video, locale).toMatch(/\.mp4$/);
      expect(photo, locale).not.toBe(video);
    }
  });
});

describe("the language in use", () => {
  it("is the system's until one is chosen, and the choice is reported apart from it", () => {
    system(["fr-CA", "en"]);
    expect(getLocaleOverride()).toBeNull();
    expect(getLocale()).toBe("fr");
    setLocaleOverride("pl");
    expect(getLocaleOverride()).toBe("pl");
    expect(getLocale()).toBe("pl");
    setLocaleOverride(null);
    expect(getLocaleOverride()).toBeNull();
    expect(getLocale()).toBe("fr");
  });

  it("ignores a language that is not shipped, keeping what was chosen", () => {
    setLocaleOverride("es");
    setLocaleOverride("xx" as never);
    expect(getLocaleOverride()).toBe("es");
  });

  it("tells a screen reader which language the page is in, and follows a change", () => {
    setLocaleOverride("pt-BR");
    expect(document.documentElement.lang).toBe("pt-BR");
    setLocaleOverride("zh-TW");
    expect(document.documentElement.lang).toBe("zh-TW");
  });

  it("with no list of languages falls back to the one language the device names, and to English with none", () => {
    system([], "es-MX");
    expect(getLocale()).toBe("es");
    system([], "");
    expect(getLocale()).toBe("en");
  });

  it("matches Chinese by script or region, a shipped language by its first part, and English for anything else", () => {
    expect(resolveLocale(["zh-Hant-HK"])).toBe("zh-TW");
    expect(resolveLocale(["zh-Hans-SG"])).toBe("zh-CN");
    expect(resolveLocale(["zh-HK"])).toBe("zh-TW");
    expect(resolveLocale(["zh-MO"])).toBe("zh-TW");
    expect(resolveLocale(["zh-SG"])).toBe("zh-CN");
    expect(resolveLocale(["pt-PT"])).toBe("pt-BR");
    expect(resolveLocale(["de-DE", "pl-PL"])).toBe("pl");
    expect(resolveLocale(["de-DE", "ja"])).toBe("en");
    expect(resolveLocale([])).toBe("en");
  });
});
