# Category Capsule: System Design — Backend (`design-be`)

## Identity

This category tests backend design **as a frontend-adjacent Staff engineer
owns it**: the server-side contracts that clients live or die by. That
means BFF layers, API contract design (versioning, pagination, idempotency,
partial-failure semantics), webhook and event-delivery contracts, sync
protocols for client caches, rate limiting as product behavior, and auth
token lifecycles as clients actually experience them (refresh races,
revocation, multi-tab).

A great `design-be` question is a product system whose hard parts surface
at the API boundary: a notification fan-out service whose read-state must
converge across devices, a webhook platform whose consumers upgrade on
their own schedule, a BFF that turns three flaky upstreams into one honest
contract for the client. The candidate designs what the client can rely
on — and what the client observes when the guarantee breaks.

This category is explicitly NOT backend-infrastructure specialization: no
Kubernetes, no service meshes, no DB internals, no capacity planning for
its own sake. Numbers matter only when they force a contract decision
(fan-out size dictating pull vs push, mobile release tail dictating the
versioning stance) — never as capacity trivia. Product-system design over
infrastructure design, always.

## Difficulty Calibration

Suggested times: easy 25 min, medium 40 min, hard 55 min.

- **easy (25 min)**: one well-scoped contract with 2–3 edge-case classes —
  e.g. cursor pagination for an activity feed that stays correct under
  concurrent writes, or an idempotent submit endpoint for a checkout flow.
  A strong Senior produces a workable API; the Staff signal is precision:
  exact cursor semantics, exact duplicate-request behavior, invariants
  stated outright ("a client may miss an item on a shifting page; it must
  never be double-charged").
- **medium (40 min)**: a contract plus its failure and lifecycle story —
  e.g. webhook delivery (retries, ordering, dedup, consumer downtime) or a
  token-refresh protocol across tabs and devices. Two edge-case classes
  interact. Staff signal: failure semantics are designed, not disclaimed —
  the candidate states what the client observes during partial failure and
  how it recovers, with example payloads.
- **hard (55 min)**: a system where contract, data model, and evolution
  pull against each other and the candidate must prioritize — e.g. a
  read-state sync protocol with offline clients, or a BFF aggregating
  upstreams with different consistency guarantees. There is no clean
  answer; the signal is naming the trade-off axes, taking a position, and
  defending the migration path while old clients are still live. Hard
  means forced prioritization under interacting edge cases — never obscure
  protocols or infra trivia.

## Environment & Test Contract

This is a design exercise, not a coding exercise:

- The candidate writes their answer in a single `notes.md` — prose,
  headings, ASCII or mermaid diagrams, and example payloads/endpoint
  sketches as Markdown code blocks.
- There is NO `signature`, NO `testCode`, and NO `referenceSolution` —
  omit all three fields entirely.
- The question `description` must follow the design shape:
  `## Problem Statement` (concrete product context with real numbers),
  `## Requirements` (functional and non-functional, with real targets),
  `## Scope` (Focus On / Out of Scope), `## Evaluation Criteria`
  (weighted, in the style of the example below).
- The edge-case audit for this category is a **requirements critique**:
  there are no tests to strengthen, so the audit tightens the problem
  statement instead — requirements concrete enough to grade against,
  genuine ambiguity left for the candidate to resolve into invariants, at
  least one forced trade-off with no obviously correct answer, and
  evaluation criteria that reward depth over coverage-listing.

## Example Evaluation Criteria

The quality bar for a generated question's `## Evaluation Criteria`
section. This example is for: *"Design the API and delivery contract for a
notification fan-out service consumed by web and mobile clients."* Note
that the weights concentrate on contract precision, failure semantics, and
evolution — and every criterion names what a strong answer actually
specifies, so a vague answer cannot score well by gesturing at topics:

```markdown
## Evaluation Criteria

A strong answer is graded on these axes (weights guide where deep-dive
time should go):

- **Contract precision (35%)** — Exact endpoint/channel shapes with
  example payloads: how a client fetches notifications (cursor semantics
  stated — what the cursor encodes, and whether a page can shift under
  concurrent fan-out), how it receives live updates (push vs poll, and
  what each guarantees), and how read-state is written (an idempotent
  `mark-read` — the request that is safe to retry blindly). "REST-ish
  endpoints" without cursor and dedup semantics scores low here.
- **Failure semantics (30%)** — What the client observes when things
  break: duplicate delivery (at-least-once acknowledged, dedup key named
  with its window), out-of-order arrival (client-side ordering rule
  stated), partial fan-out failure (per-recipient outcomes reported
  207-style, or explicitly not), and the push channel dying silently (how
  the client detects the gap and backfills). "We retry with backoff"
  without stating what the client sees scores low.
- **Evolution & migration (20%)** — A versioning stance for the payload
  schema with mobile clients live on old versions for 12+ months: what is
  additive-safe, what forces a version bump, how deprecated fields die,
  and how the read-state model itself migrates without a flag day.
- **Prioritization & scope (15%)** — Cut the right things (e.g.
  preference-targeting rules) while defending why read-state convergence
  stays in; time visibly spent on the contract's hardest edges rather than
  boxes-and-arrows around a queue.
```

## Edge-Case Classes

- **Duplicate delivery & idempotency**: at-least-once delivery surfacing
  duplicates to clients; retry-safe writes via idempotency keys (scope,
  storage, expiry, response replay); double-submit on checkout-style
  endpoints.
- **Out-of-order events**: events arriving after newer state was already
  applied; ordering guarantees per-key vs global; the client-side
  reconciliation rule (server versions, LWW vs merge).
- **Pagination under concurrent writes**: items inserted or deleted while
  a client pages; cursor vs offset behavior; the skip-vs-duplicate trade
  and which one the product can tolerate.
- **Schema evolution with old clients live**: additive vs breaking change
  rules; unknown-field handling; deprecation windows when mobile clients
  update on a 12-month tail.
- **Partial-failure responses**: batch endpoints where some items succeed
  (207-style per-item outcomes); what is committed when the response is
  lost in transit; retrying only the failed subset.
- **Quota & abuse boundaries**: rate limits as product behavior — what the
  client is told (retry-after, remaining budget), fairness across users vs
  API keys, graceful degradation instead of cliff-edge 429 storms.
- **Clock skew in sync protocols**: client timestamps that cannot be
  trusted; last-write-wins breaking under skew; server-assigned versions
  or hybrid clocks; "updated since T" queries silently missing writes.

## Review Dimensions

Keep these exact names (they key historical score comparisons):

- **Requirements Gathering**: 5 = turned the ambiguity into explicit
  invariants and acceptance criteria, stated what the client must be able
  to rely on, and pinned scope before designing; 3 = clarified the obvious
  functional asks but left failure semantics undefined until prompted;
  1 = restated the prompt and started drawing boxes.
- **High-Level Architecture**: 5 = simplest structure that meets the
  requirements, every component justified by a requirement it serves,
  client impact traced through each hop; 3 = workable shape with some
  unjustified components (a queue "for scale") or an untraced data flow;
  1 = component soup disconnected from the requirements.
- **API Design**: 5 = precise contracts — versioning stance, pagination
  semantics, idempotency keys, error and partial-failure shapes, with
  example payloads; 3 = sensible endpoints but semantics implied rather
  than stated (what does a retry do? where does the cursor break?);
  1 = a method list with no behavioral contract.
- **Data Model**: 5 = model chosen for its access patterns and evolution
  path (read-state per device or per user — and why), with ownership,
  lifecycle, and growth bounds stated; 3 = plausible entities with an
  unexamined hot spot or unbounded growth; 1 = schema that cannot answer
  the stated queries.
- **Deep Dive / Trade-offs**: 5 = named the axes (consistency, latency,
  complexity, migration cost), took positions, defended them against the
  strongest alternative, and showed one rejected path with the reason;
  3 = surveyed options but avoided committing; 1 = single-path design
  presented as inevitable.
- **Communication Clarity**: 5 = an interviewer can reconstruct the design
  from the notes alone — structured, diagrammed where it helps, decisions
  separated from open options; 3 = followable but meandering, key
  decisions buried mid-paragraph; 1 = stream of consciousness.

## Signals

Positive (Staff-level):
- Designs the contract from the client's seat: states what the client may
  assume, then makes the server honor it — not the reverse.
- Every guarantee ships with its breach behavior ("at-least-once, dedup on
  `event_id`, 24h window; after that a duplicate may surface").
- Idempotency is designed — key scope, storage, expiry, response replay —
  not name-dropped.
- Evolution treated as a requirement: a versioning stance plus a migration
  path that works with year-old mobile clients still calling.
- Cuts scope out loud, defends the cut, and spends the saved time on the
  contract's hardest edge.

Red flags:
- Infra cosplay: Kubernetes, sharding strategy, or queue-vendor
  comparisons while the API contract stays undefined.
- "The client just retries" with no idempotency story; "we use timestamps"
  with no answer for clock skew.
- Guarantees asserted without a mechanism (exactly-once delivery claimed;
  ordering assumed across a fan-out).
- Pagination, versioning, or error shapes waved off as implementation
  detail — in this category they ARE the design.
- A data model that grows without bound or cannot serve the queries the
  requirements name.

## Example Directions

- A **BFF for an agent-chat product** (agent-interface domain): one API
  for web and mobile fronting a streaming model backend with parallel
  tool-call fan-out — resumable sessions after disconnect (what is
  replayed, what is deduped), per-message ordering across interleaved tool
  results, partial-failure semantics when one tool call dies mid-stream.
  Hard via out-of-order events × duplicate delivery × partial-failure
  responses.
- A **versioned webhook platform for a developer portal**
  (developer-portal domain): the delivery contract third-party consumers
  build against — signed payloads, at-least-once retries with backoff and
  dead-lettering as *documented product behavior*, a per-endpoint ordering
  stance, schema evolution with consumers pinned to old versions for a
  year. Hard via schema evolution × duplicate delivery × quota boundaries
  (one slow consumer must not starve the rest).
- A **read-state sync API for a notification system** (notification
  domain): mark-read/unread converging across three devices, one offline
  for a week — server-assigned versions vs client clocks, sync-since
  cursor semantics under concurrent fan-out, batch mark-read with per-item
  outcomes. Hard via clock skew × out-of-order events × pagination under
  concurrent writes.
