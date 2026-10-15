import { describe, expect, it } from "vitest";
import css from "./styles.css?raw";

const declarations = (property: string) =>
  [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].flatMap(([, selector, body]) =>
    [...body.matchAll(new RegExp(`(?:^|[;\\s])${property}:([^;}]+)`, "g"))].map(
      ([, value]) => ({ selector: selector.trim(), value: value.trim() }),
    ),
  );
const fontSizes = declarations("font-size");

describe("text sizes", () => {
  it("are plain rem values, so zoom and the root text size scale them", () => {
    expect(fontSizes.length).toBeGreaterThan(0);
    expect(
      fontSizes.filter(({ value }) => !/^\d*\.?\d+rem$/.test(value)),
    ).toEqual([]);
  });

  it("are not set through the font shorthand", () => {
    const fonts = declarations("font");
    expect(fonts.length).toBeGreaterThan(0);
    expect(fonts.filter(({ value }) => value !== "inherit")).toEqual([]);
  });

  it("use em breakpoints, so a larger default font gets the narrow layout", () => {
    const queries = css.match(/@media[^{]*/g) ?? [];
    expect(queries.length).toBeGreaterThan(0);
    expect(queries.filter((query) => /\dpx/.test(query))).toEqual([]);
  });

  it("are at least 14px at the default text size", () => {
    const decorative = new Set([".check.checked::after"]);
    expect(
      fontSizes.filter(
        ({ selector, value }) =>
          !decorative.has(selector) && parseFloat(value) * 16 < 14,
      ),
    ).toEqual([]);
  });

  // The stylesheet is already on the page: src/test/setup.ts imports it.
  it("of form controls follow the page instead of the browser's fixed size", () => {
    const controls = ["button", "input", "select", "textarea"].map((tag) =>
      document.body.appendChild(document.createElement(tag)),
    );
    try {
      document.documentElement.style.fontSize = "24px";
      expect(
        controls.map((control) => getComputedStyle(control).fontSize),
      ).toEqual(controls.map(() => getComputedStyle(document.body).fontSize));
    } finally {
      document.documentElement.style.fontSize = "";
      controls.forEach((control) => control.remove());
    }
  });

  it("of small print are at least 14px, not the browser's smaller size", () => {
    const small = document.body.appendChild(document.createElement("small"));
    try {
      expect(
        parseFloat(getComputedStyle(small).fontSize),
      ).toBeGreaterThanOrEqual(14);
    } finally {
      small.remove();
    }
  });

  it("fit the document list's Rename label in its column when enlarged", () => {
    const list = document.body.appendChild(document.createElement("div"));
    list.className = "native-filelist";
    list.style.width = "900px";
    // A wide fallback font, as some Linux desktops have in place of Roboto.
    list.style.fontFamily = "'DejaVu Sans', Verdana, sans-serif";
    list.innerHTML =
      '<div class="file-row"><span></span><span></span><span class="column"></span>' +
      '<span class="column"></span><button class="native-rename-button">Rename</button></div>';
    const rename = list.querySelector("button")!;
    rename.style.fontFamily = "inherit";
    const label = document.createRange();
    label.selectNodeContents(rename);
    try {
      for (const size of ["16px", "24px"]) {
        document.documentElement.style.fontSize = size;
        const padding = getComputedStyle(rename);
        const room =
          rename.clientWidth -
          parseFloat(padding.paddingLeft) -
          parseFloat(padding.paddingRight);
        // Centred text spills out on both sides, which scrollWidth half hides.
        expect(label.getBoundingClientRect().width).toBeLessThanOrEqual(room);
      }
    } finally {
      document.documentElement.style.fontSize = "";
      list.remove();
    }
  });

  it.each(["filelist", "filelist trash-list", "filelist native-filelist"])(
    "fit the longest date label in the date column of the %s",
    (className) => {
      const list = document.body.appendChild(document.createElement("div"));
      list.className = className;
      list.style.width = "1000px";
      list.innerHTML =
        '<div class="file-row"><span></span><span></span><span class="column"></span>' +
        '<span class="column">Renamed 2 Aug 2026</span><span></span></div>';
      const date = list.querySelectorAll(".column")[1];
      const label = document.createRange();
      label.selectNodeContents(date);
      try {
        for (const size of ["16px", "24px"]) {
          document.documentElement.style.fontSize = size;
          expect(label.getBoundingClientRect().width).toBeLessThanOrEqual(
            date.clientWidth,
          );
        }
      } finally {
        document.documentElement.style.fontSize = "";
        list.remove();
      }
    },
  );
});

describe("colours", () => {
  it("are set only through the theme variables, so each theme sets them all", () => {
    const literal =
      /#[0-9a-f]{3,8}\b|\b(?:rgb|hsl)a?\(|(?<![-\w])(?:white|black)(?![-\w])/i;
    const outside = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].flatMap(
      ([, selector, body]) =>
        body
          .split(";")
          .map((declaration) => declaration.trim())
          .filter(
            (declaration) =>
              !declaration.startsWith("--") && literal.test(declaration),
          )
          .map((declaration) => `${selector.trim()} { ${declaration} }`),
    );
    expect(outside).toEqual([]);
  });
});

describe("control boundaries", () => {
  // WCAG 1.4.11: a control's outline or track needs 3:1 against what is
  // around it, in each theme.
  const rgb = (value: string) => {
    const probe = document.body.appendChild(document.createElement("i"));
    probe.style.color = value;
    const channels = getComputedStyle(probe)
      .color.match(/[\d.]+/g)!
      .slice(0, 3)
      .map(Number);
    probe.remove();
    return channels;
  };
  const luminance = (channels: number[]) =>
    channels
      .map((value) => value / 255)
      .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
      .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
  const ratio = (front: string, back: string) => {
    const [a, b] = [luminance(rgb(front)), luminance(rgb(back))];
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  };

  it.each(["light", "dark"])("stand out from the page in %s", (theme) => {
    document.documentElement.dataset.theme = theme;
    try {
      const weak = ["--control-line", "--toggle-off", "--focus"].flatMap(
        (control) =>
          ["--paper", "--canvas", "--canvas-2"]
            .map((page) => ({
              control,
              page,
              ratio: ratio(`var(${control})`, `var(${page})`),
            }))
            .filter(({ ratio }) => ratio < 3),
      );
      expect(weak).toEqual([]);
    } finally {
      delete document.documentElement.dataset.theme;
    }
  });
});
