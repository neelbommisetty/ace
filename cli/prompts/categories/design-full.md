# Category Capsule: System Design — Full Stack (`design-full`)

## Identity

This category tests whether the candidate can design an **end-to-end product
system where the interesting decisions live at the client-server boundary**:
which side owns which state, contract-first API design, real-time transport
choice (WebSocket vs SSE vs polling) justified by the product's actual needs,
offline behavior and sync, optimistic UI with server reconciliation, and
failure handling plus observability that crosses layers instead of stopping
at one.

A great `design-full` question is a product feature a real team would ship —
a collaborative pricing configurator, a live experimentation dashboard, an
editorial publishing pipeline — where no single layer is the hard part: the
hard part is the seam. The candidate must tell **one coherent data-flow
story** from user input, across the wire, into storage, and back out to every
observing client — naming the invariants that hold at each hop (what can
never be double-charged, what may be stale and for how long, who wins a
write conflict) and how the design evolves when requirements shift.

This category is NOT:
- Infra deployment detail — no Kubernetes, service meshes, sharding math, or
  capacity planning of clusters.
- A frontend-only component-architecture question (`design-fe`) or a
  backend-only storage/queue question (`design-be`) with the other half
  hand-waved. If either half could be deleted without weakening the
  question, it belongs in a different category.
- A features-list recital. A question that can be answered by drawing
  boxes labeled "CDN, LB, API, DB, cache" without a single boundary
  decision is a failed question.

## Difficulty Calibration

Suggested times: easy 30 min, medium 45 min, hard 60 min.

- **easy (30 min)**: one well-scoped feature end-to-end with a single
  boundary decision at its center — e.g. read-state sync for a notification
  center, or draft autosave for a form engine. A strong Senior produces a
  working design with a clean API; the Staff signal is naming state
  ownership explicitly (server-authoritative vs client-authoritative and
  why) and calling out one concrete failure mode across the seam unprompted.
- **medium (45 min)**: adds a live or offline dimension that forces a
  consistency story — e.g. optimistic updates with server reconciliation, or
  a real-time channel with a justified transport choice and a reconnect
  contract. Staff signal: the API is designed contract-first with named
  invariants and idempotency semantics, and the reconciliation path (what
  the client shows between send and ack, and on rejection) is designed, not
  discovered.
- **hard (60 min)**: multiple edge-case classes **interact** and the scope
  cannot be fully covered in the time — the candidate must prioritize out
  loud and defend the cut. Example scope: a money path with retries and
  optimistic UI, live concurrent editing, and a schema migration with old
  and new clients both connected. Hard means forced trade-offs with no
  obviously correct answer (freshness vs cost, optimism vs correctness,
  contract stability vs velocity) — never obscure technology trivia.

## Environment & Test Contract

This is a **design exercise**, not a coding exercise:

- The candidate writes their answer in a single `notes.md` file (Markdown:
  prose, lists, ASCII/text diagrams, example payloads).
- There is NO `signature`, NO `testCode`, and NO `referenceSolution` — omit
  all three fields entirely from generation output.
- The `description` must follow the design shape: `## Problem Statement`
  (realistic product context with concrete numbers — users, request rates,
  payload sizes, latency targets), `## Requirements` (functional and
  non-functional, with real targets like "p95 checkout submit < 800ms" or
  "changes visible to collaborators within 2s"), `## Scope` (Focus On / Out
  of Scope — explicitly fence off infra deployment detail), and
  `## Evaluation Criteria`.
- Numbers must be concrete enough to force decisions: "10k concurrent
  editors, one config edited by at most 8 people at once" changes the
  design; "lots of users" does not.
- Edge-case audit for this category is a **requirements critique**: there is
  no test file to strengthen, so the audit tightens the problem statement —
  ambiguity worth resolving, missing constraints, trade-offs the scope fails
  to force — per the design-category instructions in the audit task.

## Example Evaluation Criteria

This is the quality bar for a question's `## Evaluation Criteria` section —
note that weights concentrate on boundary decisions, the consistency story,
and cross-layer failure modes, and every criterion says what "covered"
concretely means. For a question asking the candidate to design a
collaborative pricing configurator (sales reps co-edit a quote; discounts
need approval; checkout submits the priced quote as an order):

```markdown
## Evaluation Criteria

A strong answer is weighted roughly as follows:

- **State ownership & boundary decisions (25%)** — Declares which fields are
  server-authoritative (approved discount, computed tax, final price) vs
  client-editable (line items, quantities), and where price computation
  runs. A design that computes the displayed price only on the client, or
  only on the server with no interim client estimate, must say what the
  user sees during the gap and why that is acceptable.
- **Consistency & reconciliation story (25%)** — Concurrent edits by 2+ reps
  on the same quote: the chosen model (per-field last-write-wins, version
  vector, or server-serialized ops) with its user-visible consequence named.
  Optimistic local edits must have an explicit rejection path: what rolls
  back, what the collaborator sees, and how the client learns the
  authoritative state (full refetch vs delta).
- **API contract & idempotency (20%)** — Contract-first endpoints or
  messages with example payloads. Checkout submit must be idempotent
  (client-generated idempotency key, server dedup window, and the response
  to a retry of an already-completed submit). Quote-edit messages must be
  safe to redeliver after reconnect.
- **Real-time transport choice (15%)** — WebSocket vs SSE vs polling chosen
  from the product need (8 co-editors, sub-2s propagation) — not from
  fashion. Must include the degradation path: reconnect with resume cursor,
  missed-event catch-up, and what the UI shows while degraded.
- **Cross-layer failure modes & observability (15%)** — At least: submit
  timeout after the server committed (retry must not double-order), auth
  expiry mid-editing-session (buffered edits must not be lost), and one
  named metric or trace per failure that tells on-call which layer failed.

An answer that covers every box shallowly scores below one that nails state
ownership, the reconciliation story, and idempotent submit, and explicitly
defers the rest.
```

## Edge-Case Classes

- **Split-brain client/server state**: client believes X, server believes Y
  — after an offline window, a dropped ack, or an optimistic update the
  server rejected. Which side wins, how divergence is detected (versions,
  ETags, sequence numbers), and what the user sees during repair.
- **Retries crossing layers (double-submit money paths)**: a timeout at any
  hop (browser, gateway, service) with a commit after it — retry semantics
  need idempotency keys end-to-end, a dedup window, and a defined response
  for "already done". Applies to checkout, publish, and approval actions.
- **Migration with old and new clients live**: a schema or contract change
  while last week's bundle is still open in someone's tab — versioned
  contracts, tolerant readers, dual-write/dual-read windows, and the
  forced-upgrade escape hatch.
- **Real-time transport degradation**: reconnect storms, proxies that kill
  idle connections, event delivery after a gap — resume cursors vs full
  resync, ordering across the gap, and the UI's degraded mode (stale badge,
  read-only, silent catch-up).
- **Auth expiry mid-flow**: token expires between "user starts a multi-step
  flow" and "user submits" — refresh without losing buffered input, replay
  of the pending action after re-auth, and which actions must NOT be
  replayed automatically.
- **Partial rollout / feature-flag divergence**: half the clients run the
  new flow while the server serves both — flag evaluated on which side,
  payloads both variants can parse, and metrics segmented so the rollout
  can actually be judged.

## Review Dimensions

Keep these exact names (they key historical score comparisons):

- **Requirements Gathering**: 5 = turns the ambiguous ask into explicit
  invariants and acceptance criteria, states assumptions with numbers, and
  cuts scope out loud; 3 = restates the given requirements competently but
  resolves little ambiguity beyond them; 1 = jumps to boxes and arrows
  without pinning down what must be true.
- **High-Level Architecture**: 5 = simplest structure that meets the
  requirements, one coherent input→storage→fan-out data-flow story, every
  component earning its place; 3 = workable architecture with some
  unjustified components or a fuzzy spot at the client-server seam;
  1 = generic boxes with no data flow or an overbuilt design nothing in the
  requirements demands.
- **API Design**: 5 = contract-first with example payloads, idempotency and
  error semantics defined, versioning/evolution path named; 3 = plausible
  endpoints but retry behavior, error shapes, or pagination left implicit;
  1 = vague "REST/WebSocket" hand-waving with no concrete contract.
- **Data Model**: 5 = entities, ownership, and lifecycle defined on both
  sides of the wire — including what the client caches and how invalidation
  works; 3 = sound server schema but the client-side model and sync shape
  are an afterthought; 1 = no real model, or one that cannot support the
  stated requirements.
- **Deep Dive / Trade-offs**: 5 = goes deep on the hardest seam, names the
  axes (consistency, latency, cost, complexity), takes a position, and
  states what evidence would reverse it; 3 = mentions alternatives but
  picks without defending, or depth in a comfortable area while dodging the
  hard one; 1 = single-option thinking presented as inevitable.
- **Communication Clarity**: 5 = a reviewer reconstructs the whole design
  from notes.md alone — ordered sections, diagrams where prose would
  strain, invariants highlighted; 3 = understandable with effort, some
  orphaned detail or buried decisions; 1 = stream of consciousness a
  colleague could not act on.

## Signals

Positive (Staff-level):
- States who owns each piece of state before drawing any component — and
  the design visibly follows from that decision.
- Designs the API as a contract: idempotency keys on mutating money paths,
  explicit error semantics, a stated evolution path for the next version.
- Justifies the real-time transport from product numbers (propagation
  target, concurrency, payload size) and includes the reconnect/degradation
  contract in the same breath.
- Treats failure paths as requirements: the timeout-after-commit case, the
  rejected optimistic update, and the mid-flow auth expiry each have a
  designed user-visible outcome.
- Names observability per failure mode — which metric or trace distinguishes
  "client bug" from "server bug" from "network" — without being asked.
- Prioritizes explicitly under time pressure: "I'm going deep on the
  checkout idempotency story and time-boxing presence, because money."

Red flags:
- Boxes-and-arrows theater: components with no data flow between them, or
  "Kafka/Redis/microservices" appearing before any requirement demands them.
- Optimistic UI with no rollback story, or real-time chosen ("we'll use
  WebSockets") with no reconnect, ordering, or catch-up contract.
- Retry added anywhere on a money path without idempotency — or the word
  "idempotent" used without saying where the key is generated and checked.
- The client treated as a dumb terminal (every keystroke a round-trip) or
  the server as a dumb store (business rules living only in the bundle).
- Migration and rollout ignored: the design assumes all clients update
  atomically with the server.
- Perfectly even, shallow coverage of every topic — no prioritization is
  itself a No-Hire signal at this level.

## Example Directions

- **Idempotent checkout with an optimistic cart**: design
  the full path from "add to cart" through priced review to order
  submission for a storefront where cart edits feel instant but pricing,
  inventory, and payment authorization are server-authoritative. Hard
  because retries crossing layers (double-submit on a paid order), split
  brain between the optimistic cart and server-priced truth, and auth
  expiry mid-checkout all interact on a money path.
- **Live experimentation platform**: flag delivery to
  web clients, exposure logging, and the metrics feedback loop that renders
  a live results dashboard. Hard because of partial rollout by construction
  (flag values diverging across clients mid-session), transport degradation
  on the dashboard's live channel, and the consistency question of exposure
  events vs metric aggregates — plus migration when a flag's variants
  change while sessions are live.
- **Editorial pipeline with preview environments**:
  writers draft and co-review articles, stakeholders view shareable
  previews that track the draft live, and publish pushes to a cached public
  site. Hard because of split-brain between draft state and preview
  snapshots, migration with old and new schema content live at once,
  idempotent publish (retrying must not double-invalidate or re-notify),
  and permission/auth expiry on long-lived preview links.
