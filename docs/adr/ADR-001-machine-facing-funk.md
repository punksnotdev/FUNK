# ADR-001: FUNK is machine-facing; consumers own human identity

## Status

Accepted — 2026-05-26

## Context

FUNK was scaffolded with an `apps/auth` service that handled invitation tokens, sessions, and human identity for tenants. That treated user identity as part of FUNK's infrastructure responsibility.

Run the litmus test on the design:

> Would a second, unrelated movement platform built on FUNK want FUNK's specific invitation-token + session implementation, unchanged?

Almost certainly not. Auth is intensely product-shaped — invite flows, RBAC, profiles, password policies, identity providers all vary per consumer. FUNK trying to be the auth layer for arbitrary movement platforms is the kind of premature reuse that delivers nothing for any concrete consumer.

Consumers will typically bring their own auth stack (a CMS with built-in auth, a third-party identity provider, or a custom implementation). Stacking FUNK auth on top of that means two auth systems fighting for "source of truth."

## Decision

FUNK is **machine-facing only**. It exposes service-to-service HTTPS APIs. Consumers own all human identity.

Concretely:

- **`apps/auth` is trimmed** to a minimal *credential-issuer service*: mints, lists, and revokes long-lived service credentials (bearer tokens). All user/session/invitation-token logic is removed.
- **Each consumer holds one service credential**, passed in `Authorization: Bearer <token>` to every FUNK API call (storage, radio).
- **The consumer's own auth/domain layer owns all human identity** — admins, hosts, contributors, listeners-with-accounts (if any). FUNK has no concept of human users.
- **Listener-side anonymity is preserved at the HLS origin.** Listening is anonymous-open; nginx logs no user-agents and emits no tracking headers. This is FUNK-enforceable because the HLS layer is FUNK's.

## Consequences

**Easier**

- One source of truth for human identity (the consumer).
- Smaller FUNK surface; fewer moving parts; simpler mental model.
- Consumers don't have to fight FUNK's auth model — they bring their own.

**Harder**

- The anti-surveillance commitment for *editorial/identified* users moves to the consumer as editorial policy. FUNK documents the recommendation but can't enforce it.
- Existing `apps/auth` invitation/session code, and docs that describe it (README, PROVISIONING, LOCAL_DEV), must be updated.

**Given up**

- The idea that FUNK could be a drop-in auth backend for movement platforms. It was never a fit; this is honest scope-narrowing, not a regression.

## Implementation notes

- **Delete:** invitation/session logic in `apps/auth/src/tokens.ts` and `apps/auth/src/index.ts`; user/session tables in `apps/auth/src/db.ts`.
- **Keep / add:** a `credentials` table (`id`, `hashed_secret`, `label`, `created_at`, `revoked_at`) and endpoints `POST /credentials`, `GET /credentials`, `DELETE /credentials/:id`. Bearer-token middleware shared by `storage` and `radio` services.
- **Bootstrap:** one `ADMIN_BOOTSTRAP_TOKEN` env var minted at install time to issue the first consumer credential, then revoked.
- **`PROVISIONING.md` step 8** changes from "mint first contributor invitation" to "mint first service credential for the consumer."
