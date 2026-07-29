# Infinite News Feed

**Category:** System Design — Frontend
**Difficulty:** medium
**Suggested Time:** ~40 minutes

---

## Problem Statement

You own the web client for a social news feed. Roughly 4 million daily active
users open it on mixed hardware — a third of sessions are on low-end Android
over patchy 4G. A session averages 6 minutes and 120 scrolled posts, and posts
carry images, short autoplaying video, and live counters (likes, replies) that
update while the post is on screen.

Design the frontend: how the feed is fetched, rendered, kept fast as it grows,
kept honest as items change under the user, and kept usable when the network
misbehaves.

Write your design in `notes.md`.

## Requirements

**Functional**

- Infinite scroll with no visible stall at the join between pages.
- New posts published while the user is reading are surfaced without yanking
  the scroll position — a "12 new posts" affordance, not an auto-insert.
- Like/reply counters update optimistically and reconcile with the server.
- Returning to the feed from a post detail view restores the exact scroll
  offset and the already-loaded pages.
- Images and video load lazily; only the post in view may autoplay.

**Non-functional**

- Largest Contentful Paint under 2.5 s at p75 on the low-end Android profile.
- Interaction to Next Paint under 200 ms at p75, including while a page of
  posts is being appended.
- Steady-state memory that does not grow without bound across a 6-minute,
  120-post session.
- The feed remains readable and scrollable when the network drops mid-session.

## Scope

**Focus on**

- Data fetching and pagination strategy, and why you chose it.
- The client-side cache: what is keyed by what, how a post that appears in
  several places stays consistent, and when entries are evicted.
- Rendering strategy for a list that grows to hundreds of items.
- Optimistic updates and their rollback/reconciliation path.
- Scroll restoration and its interaction with the cache.
- Failure and degraded-network behaviour.

**Out of scope**

- Backend storage, ranking, and the feed-generation pipeline.
- Authentication and session management.
- Visual design, spacing, and the specific component library.
- Native mobile apps.

## Evaluation Criteria

A strong answer:

- Picks cursor-based pagination over offset and can say precisely what breaks
  with offsets when items are inserted at the head mid-session.
- Separates the normalised entity cache (posts, authors, counters) from the
  ordered feed pages that reference it, and explains what that separation buys
  when the same post appears in two feeds.
- Chooses a concrete rendering strategy for long lists — windowing with
  measured or estimated item heights — and confronts the hard part: variable
  heights, images that resize after load, and how the scroll anchor survives
  both.
- Names a bounded memory policy: which pages are evicted, what is retained so
  a scroll back up does not flash empty, and how that interacts with
  restoration.
- Treats optimistic updates as a state machine with a rollback path, and says
  what happens when two optimistic mutations on the same counter overlap.
- Gives the "new posts" affordance a real mechanism (polling versus a live
  channel) with a stated trade-off, and explains why insertion is deferred.
- Discusses degraded-network behaviour concretely: retry with backoff, what is
  served from cache, and what the user sees while it is happening.
- Calls out the measurement plan — which metrics, collected where, and what
  regression would trigger a rollback.
