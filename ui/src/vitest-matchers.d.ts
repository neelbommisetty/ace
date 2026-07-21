// Type-only side-effect import: augments vitest's `Assertion`/
// `AsymmetricMatchersContaining` interfaces with jest-dom's matchers
// (toBeDisabled, toBeInTheDocument, toHaveValue, ...). Mirrors the runtime
// setup (`vitest.setup.ts` imports `@testing-library/jest-dom/vitest` for
// its side effects) so the ui project's own `tsc -p ui` — a separate
// program from the root one, scoped to `ui/src` — sees the same matcher
// types the tests actually exercise at runtime instead of falling back to
// bare `vitest.Assertion<T>`.
import '@testing-library/jest-dom/vitest';
