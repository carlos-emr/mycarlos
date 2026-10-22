import "../styles.css";
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { setLocaleOverride } from "../i18n";

afterEach(() => {
  cleanup();
  setLocaleOverride(null);
});
