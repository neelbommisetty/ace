# Category Capsule: System Design — Frontend (`design-fe`)

## Identity

This category tests **frontend-systems architecture**: how a candidate
distributes state across server, client cache, and in-memory stores; chooses
a rendering strategy and defends it; designs real-time sync, optimistic UI,
and reconciliation; plans for offline and reconnect; sets performance budgets
with numbers; and treats accessibility as an architectural concern (focus
management, live regions, parallel navigable structures) rather than a
checklist item.

A great `design-fe` question is a production subsystem a Staff frontend
engineer at a product company would actually own — the presence-and-comments
layer of a collaborative editor, a notification center with cross-tab
read-state, the client runtime of a config-driven form engine, the streaming
transcript pane of an agent interface. The prompt gives concrete numbers
(users, document sizes, latency targets, device floors) and leaves genuine
ambiguity for the candidate to resolve into **named invariants** and
**explicit consistency choices per data type**. The Staff bar is failure-mode
design: what the system does when the network drops, the write path degrades,
or two clients disagree — not what it does when everything works.

This category is NOT visual design (no pixel craft, layout aesthetics, or
motion design) and NOT backend-infrastructure design (no database engine
selection, sharding schemes, or queue topology). The candidate may assume a
competent backend and negotiate its API as a contract; the graded work is
everything from that contract to the user's screen.

## Difficulty Calibration

Suggested times: easy 25 min, medium 40 min, hard 55 min.

- **easy (25 min)**: one subsystem, one core consistency decision, one
  failure mode. Example scope: cross-tab read-state for a notification
  badge — where the source of truth lives, how tabs converge, what happens
  when one tab is offline. Staff signal at this level: the candidate states
  the invariant ("badge count never shows a notification the user has read
  in any tab") and the reconciliation rule before naming any technology.
- **medium (40 min)**: two interacting subsystems where one decision
  constrains the other — e.g. optimistic comment submission plus anchor
  mapping under concurrent document edits. Must cover: an explicit
  consistency choice per data type, a reconnect/resume story, and at least
  one quantified budget (memory, update rate, or latency). Staff signal:
  the interaction is designed, not discovered — the candidate notices that
  the optimistic-insert story and the reconnect story share a dedup
  mechanism and designs it once.
- **hard (55 min)**: a full client layer with competing budgets and failure
  modes that interact, forcing prioritization — e.g. presence + comments +
  offline editing for a 200-person document on mid-tier hardware. There is
  no design that satisfies everything; the candidate must triage (what
  degrades first and how visibly), name invariants that survive every
  failure mode, and defend at least one contested trade-off against a
  credible alternative. Hardness comes from constraint interaction under
  time pressure, never from obscure technology trivia.

## Environment & Test Contract

This is a **design exercise**, not a coding exercise:

- The candidate writes their design as prose/diagrams-in-text in a single
  `notes.md` file. There is NO solution file and NO test file.
- Generation must NOT emit `signature`, `testCode`, or `referenceSolution`
  fields — omit them entirely from the output JSON.
- The `description` must follow the design shape: `## Problem Statement`
  (realistic product context with concrete numbers — user counts, document
  sizes, latency targets, device floors), `## Requirements` (functional and
  non-functional with real targets), `## Scope` (Focus On / Out of Scope —
  explicitly fence off backend internals and visual design), and
  `## Evaluation Criteria` (weighted toward invariants, trade-offs, and
  failure modes; see the example below).
- The edge-audit feature runs as a **requirements-critique pass**, not a
  test audit: it checks that the requirements are concrete enough to grade,
  that genuine ambiguity remains for the candidate to resolve, that the
  scope forces at least one hard trade-off, and that the evaluation
  criteria reward depth over feature-listing.

## Example Evaluation Criteria

This is the quality bar for the `## Evaluation Criteria` section of a
generated question — shown here for a question about the presence-and-
comments layer of a collaborative document editor (200 concurrent editors,
300-page documents, 4-year-old mid-tier laptops as the device floor). Note
that every criterion demands a commitment (an invariant, a number, a
degradation rule), and feature-listing earns nothing:

```markdown
## Evaluation Criteria

A strong answer is judged on the following, weighted as shown:

- **Invariants & consistency choices (30%)** — Names explicit invariants and
  designs to preserve them, e.g. "a comment anchor never silently detaches:
  it either tracks its text range through concurrent edits or visibly
  degrades to a document-level comment", "a submitted comment is never lost
  and never duplicated, across retries and reconnects". States the
  consistency model per data type — presence is ephemeral and
  last-writer-wins; comments are durable with causal ordering within a
  thread — and justifies why they differ instead of applying one model to
  everything.
- **Failure-mode design (25%)** — Reconnect after a 90-second offline gap:
  what is replayed, what is discarded, and how duplicate submission is
  prevented (e.g. client-generated idempotency keys checked server-side).
  Split-brain degradation: the presence channel is healthy but the comment
  write path is failing — what the user sees, what is queued, and how the
  UI communicates reduced guarantees without lying about delivery.
- **State distribution & reconciliation (20%)** — Which state lives on the
  server, in the client cache, and in volatile memory, and why. The
  optimistic comment-insert lifecycle: pending → confirmed → rolled back,
  including how a rollback is surfaced to the user. How comment anchors are
  remapped when remote edits land while a comment draft is open.
- **Performance & scale budgets (15%)** — Presence fan-out for 200 editors:
  a stated update-rate cap (e.g. cursor updates coalesced to ≤4 Hz per
  peer) and viewport-scoped subscription so off-screen presence costs
  nothing. A memory budget for comment threads on a 300-page document: what
  is virtualized, what is evicted, and what triggers re-fetch.
- **API contract & accessibility as architecture (10%)** — The comment and
  anchor schema, the subscription contract, and pagination of resolved
  threads. Comment navigation reachable by keyboard and screen reader via a
  parallel ordered structure (not only positioned pins); presence changes
  announced without flooding the live region.

Technology name-drops earn no credit on their own: "WebSockets plus
optimistic updates plus a CRDT" scores only when each choice is paired with
the invariant it preserves and the failure it survives.
```

## Edge-Case Classes

The ambiguities and failure modes a strong design must address — question
authors should ensure the scenario makes several of these unavoidable, and
edge-audit should verify the requirements force them:

- **Conflicting concurrent edits**: two clients mutate the same logical
  entity (text range, read-state flag, config draft) within one round-trip;
  the design must name a resolution rule per data type and what the losing
  client sees.
- **Reconnect/resume after offline gaps**: a client returns after seconds
  vs minutes vs hours — what is replayed, what is refetched wholesale, how
  queued local writes are deduplicated, and where the cutoff between
  incremental catch-up and full resync lies.
- **Cache staleness vs memory budget**: what is cached, its invalidation
  trigger, its eviction policy, and the stated memory ceiling — including
  the user-visible consequence of serving stale data versus refetching.
- **Permission changes mid-session**: a user's access is revoked or
  downgraded while they have live subscriptions, open drafts, and cached
  data — how fast revocation propagates, and what happens to in-flight
  writes and locally cached content.
- **Partial API failure degradation**: one dependency degrades while
  others stay healthy (reads work, writes fail; realtime up, REST down) —
  the design needs a degradation ladder stating which capabilities shed
  first and how the UI signals reduced guarantees.
- **Slow-device / slow-network floors**: the stated worst-case hardware and
  network profile — what is virtualized, deferred, or coalesced so the
  interaction floor (e.g. input latency under 100 ms) holds at the bottom
  of the range, not just on developer machines.

## Review Dimensions

Keep these exact names (they key historical score comparisons):

- **Requirements Gathering**: 5 = turns every ambiguity into an explicit
  invariant or documented assumption, distinguishes functional from
  non-functional targets, and challenges a requirement when the numbers
  don't add up; 3 = restates the given requirements competently but
  resolves little ambiguity beyond them; 1 = jumps straight to boxes and
  arrows against unexamined requirements.
- **High-Level Architecture**: 5 = simplest structure that meets the
  requirements, with state distribution (server/cache/memory) and rendering
  strategy explicitly chosen and justified; 3 = workable architecture with
  some unexamined defaults (a store "because that's standard"); 1 =
  component-name soup with no data-flow story.
- **API Design**: 5 = contracts named precisely (schemas, subscription
  semantics, pagination, idempotency keys) and shaped by the client's
  failure modes; 3 = plausible endpoints but gaps at the hard edges
  (no dedup story, unversioned payloads); 1 = hand-waved "the API returns
  the data".
- **Data Model**: 5 = client-side entities, identity, and lifecycle
  (pending/confirmed/evicted) modeled explicitly, with cache keys and
  invalidation rules stated; 3 = reasonable shapes but fuzzy ownership —
  unclear which copy of the data is authoritative; 1 = data model absent or
  contradicts the described behavior.
- **Deep Dive / Trade-offs**: 5 = at least one contested decision argued
  against a credible alternative with named axes (latency, consistency,
  memory, complexity) and a chosen position, plus failure modes designed
  first-class; 3 = trade-offs acknowledged but resolved by assertion rather
  than reasoning; 1 = single-path design presented as inevitable, failure
  modes unaddressed.
- **Communication Clarity**: 5 = a reviewer can reconstruct the design from
  the notes alone — structured sections, invariants stated up front,
  numbers where numbers matter; 3 = the pieces are present but the reader
  must assemble them; 1 = stream of consciousness, key decisions
  discoverable only by inference.

## Signals

**If a `## Follow-ups` section is present** in `notes.md`, the candidate
answered probe questions drilling into a specific invariant or trade-off
they left underspecified the first time — weigh whether the answer commits
to something new (a stated consistency choice, a number, a named
failure-mode behavior) or just re-describes the original architecture in
different words. A candidate who meets a direct probe about, say, the
reconnect/dedup story with more component name-dropping should score lower
on Deep Dive / Trade-offs and Requirements Gathering than the initial notes
alone suggested. Most design notes have no `## Follow-ups` section — say
nothing about it when it's absent.

Positive (Staff-level):

- Invariants stated before mechanisms — "what must always hold" precedes
  "which library".
- Different consistency models chosen for different data types, with the
  difference justified (ephemeral presence vs durable comments).
- Failure modes designed in the main flow, not appended: reconnect, dedup,
  and rollback share machinery by design.
- Budgets with numbers (update rates, memory ceilings, latency floors) and
  a stated consequence when a budget is exceeded.
- A degradation ladder: which capability sheds first under partial failure
  and how the UI communicates it honestly.
- Accessibility handled structurally (focus ownership, parallel navigable
  lists, live-region discipline), not as a final bullet.

Red flags:

- Technology name-dropping without commitments — "we'll use a CRDT" with no
  account of what merges, what conflicts, or what the user sees on a loss.
- Happy-path-only designs; failure handling summarized as "show an error
  toast and retry".
- Redesigning the backend (queue topology, shard keys) instead of
  negotiating a client contract — scope evasion, and outside this category.
- One global store and one consistency model applied to every data type
  without examining whether they differ.
- Premature generality: plugin systems, micro-frontends, or event buses for
  a problem whose stated scale never demands them.
- No numbers anywhere: budgets, rates, and floors left entirely
  qualitative.

## Example Directions

- **Presence-aware commenting layer for a collaborative editor**: 200
  concurrent editors, 300-page
  documents, comment anchors that must survive concurrent edits. Hard parts:
  conflicting concurrent edits (anchor remapping vs visible degradation),
  reconnect after offline gaps (replay vs resync cutoff, duplicate-comment
  prevention), and presence fan-out under a slow-device floor (coalescing,
  viewport-scoped subscriptions).
- **Notification center with cross-tab read-state**: badge counts and
  read-state that converge across five open tabs,
  one of which was offline for an hour. Hard parts: conflicting concurrent
  edits (read-in-two-tabs races), partial API failure (mark-read writes
  failing while the feed reads fine — does the badge lie?), and cache
  staleness vs memory budget for a 10k-notification history with infinite
  scroll.
- **Config-driven form engine with versioned schemas mid-flight**: a
  40-step onboarding flow whose schema
  can be republished while thousands of users hold in-progress drafts. Hard
  parts: permission/schema changes mid-session (pin the draft's version or
  migrate it live — and what happens to answers a new version invalidates),
  reconnect/resume with locally persisted drafts, and partial validation
  failure when server-side rules degrade while client-side rules pass.
