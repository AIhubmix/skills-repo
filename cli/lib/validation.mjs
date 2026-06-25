// Identifier rule (skill id / category / tag / agent / related):
//   first char: ASCII letter
//   rest: ASCII letters, digits, '_' or '-'
// Permissive enough for kebab-case, camelCase, PascalCase, snake_case.
export const SLUG_RE = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

export function assertSlug(label, value) {
  if (typeof value !== "string" || !SLUG_RE.test(value)) {
    throw new Error(`${label} must match ${SLUG_RE}: ${String(value)}`);
  }
}

export function splitPath(p) {
  return String(p).replaceAll("\\", "/").split("/").filter(Boolean);
}

