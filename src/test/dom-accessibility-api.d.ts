// dom-accessibility-api 0.5.16 ships these declarations but its ESM exports
// omit the types entry. Expose the two test-only APIs used by humanText.
declare module "dom-accessibility-api" {
  export function computeAccessibleName(root: Element): string;
  export function computeAccessibleDescription(root: Element): string;
}
