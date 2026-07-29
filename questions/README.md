# Starter pack

The hand-authored questions in this directory ship inside the published npm
package (`package.json` → `"files"`), and `ace init` copies them into a fresh
workspace so the very first `ace ui` lands on a Library you can actually
practise in — no API key, no LLM call, no paid generation.

An existing workspace can adopt them at any time from the Library empty state
("Add starter questions"), which calls `POST /api/starter-pack`.

## What lives here

One directory per question, laid out exactly like a generated question:

```
questions/<category>/<slug>/
  README.md         # problem statement — also the metadata the reconciler reads
  <solution file>   # the candidate's starter stub (compiles, throws)
  <test file>       # the suite the room runs
  .reference.md     # hidden model solution, surfaced only after a review
```

Design categories carry `notes.md` instead of a solution/test pair.

The canonical list is `STARTER_PACK` in `cli/lib/starter-pack.ts` — copying
walks that manifest, never this directory, so a stray folder here is never
shipped into someone's workspace. `cli/lib/starter-pack.test.ts` keeps the
manifest and the on-disk tree in agreement.

## How these interact with the repo's own test suite

`vitest.config.ts` at the repo root only includes `cli/**` and `ui/**`, so
these sample suites are **not** run by `npm test` — they are meant to fail
until a user implements them, which would otherwise wedge the repo suite red.

They are, however, inside the root `tsconfig.json` `include`, so
`npx tsc --noEmit` type-checks every stub and every test file here. That is
the guard that keeps a shipped scaffold from landing in a user's workspace
with a syntax or type error.
