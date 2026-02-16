# Design a URL Shortener

**Category:** Backend Design  
**Difficulty:** Medium  
**Suggested Time:** ~40 minutes

---

## Problem

Design a URL shortening service (like bit.ly) from a **backend perspective**.

Consider the following aspects:

- **Encoding scheme** — How to generate short codes (base62, UUID, etc.)
- **Database design** — Schema for URLs, mappings, metadata
- **Read/write ratio** — Optimize for heavy read traffic
- **Caching** — Cache hot short URLs for fast redirects
- **Analytics** — Click tracking, geographic data
- **Expiration** — Optional TTL for short links
- **Horizontal scaling** — Sharding, load balancing

Walk through your design, data flow, and trade-offs. Use the `notes.md` file to capture your solution.
