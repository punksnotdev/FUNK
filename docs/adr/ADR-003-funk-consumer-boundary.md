# ADR-003: FUNK/consumer boundary — harvest, don't predict

## Status

Accepted — 2026-05-26

## Context

FUNK is intended as reusable, tenant-first infrastructure for movement platforms. The first concrete consumer is greenfield; future consumers are hypothetical.

The standing risk: **premature abstraction.** Designing FUNK's reusable surface against an imagined second consumer that doesn't exist tends to produce abstractions that fit neither real-world use case.

The standing temptation: putting domain concerns in FUNK because "we'll need them later." Radio-show modeling, episode states, contributor RBAC, library schemas — all product surface that varies per platform.

## Decision

The governing discipline is **harvest, don't predict.**

- **Build domain features in the consumer first.** Concretely, in whatever domain layer the consumer uses, with the editorial schema that consumer actually wants.
- **Extract to FUNK only on rule-of-three** — when a second (ideally third) consumer needs the same capability with the same shape.
- **One exception:** wrap genuinely external messy systems immediately. We considered LibreTime an instance of this, then decided to remove it entirely (ADR-002), so this exception is currently dormant.

### Litmus test for "does X belong in FUNK?"

> Would a second, unrelated consumer built on FUNK want X — *unchanged*?

- Capabilities (storage, credentials, radio orchestration): yes → **FUNK**.
- Domain models (Show, Episode, Library, glossaries, community rules): no → **consumer**.
- UX (admin screens, listener pages, schedule calendar): no → **consumer**.

### Dividing rule for the radio API

> **The consumer owns the domain CRUD; FUNK exposes apply + control verbs over the running broadcast.**

`PUT /v1/radio/schedule` accepts a window. No CRUD on shows/episodes in FUNK.

### Repo relationship

A consumer is a **separate repo**, sibling to FUNK. The contract is FUNK's HTTPS APIs and the icecast mountpoint — nothing else. No shared database, filesystem, or code imports.

### Multi-tenant machinery

FUNK keeps the `TENANT_ID=default` env stub as its sole concession to "multi-tenant eventually." No further multi-tenant code until a real second consumer exists.

## Consequences

**Easier**

- A consumer moves fast: every domain decision is local to its repo, no FUNK PR needed.
- FUNK stays small and honest: it ships what current consumers need, no speculative surface.
- Future consumers see a real, working example to learn from when deciding what's worth harvesting.

**Harder**

- Some code in a consumer will look like it "should" live in FUNK. Accept it — promote only after rule-of-three.
- When consumer #2 arrives, harvesting is real work (refactor, generalize, ship contracts). That's the right time to pay that cost — not earlier, against a phantom.

**Given up**

- The illusion that FUNK can be a complete movement-platform-in-a-box. It's an *infrastructure layer*; complete platforms are consumers.
