# Tuwunel Issue Registry

> **Audit snapshot (2026-04-13):** This registry documents findings from an April 2026 codebase audit. Per-issue file/line references are suspects — the tree has moved; treat line numbers as historical pointers, not current navigation.

Comprehensive issue documentation from that audit. Each issue document contains a detailed problem narrative, per-finding breakdowns with file/line references, step-by-step remediation plans, and ideal resolution criteria.

**Last updated:** 2026-11-16 (re-audit of the 005/007/010 remainders against the current tree; all ten issues now closed)

---

## Resolution Status

All **64 original findings** have landed on `main`. The 2026-11-16 re-audit read the current tree for every finding previously listed as residual (005.6, 005.10, 007.3, 007.6, 010.6) and found each already fixed — see the re-audit section below for file-level evidence. Earlier items remain as recorded by the landed-PR pass.

| Status | Count |
|--------|-------|
| Done (issue closed by landed work) | 10 issues (001–010) |

---

## Issue Index

| # | Title | Severity | Findings | Resolved (landed) | Status |
|---|-------|----------|----------|-------------------|--------|
| [001](./001-federation-authentication-and-signing.md) | Federation Auth & Outbound Signing | **Critical** | 6 | 6 | **Done** |
| [002](./002-authentication-session-security.md) | Authentication & Session Security | **Critical/High** | 8 | 8 | **Done** |
| [003](./003-media-upload-download-security.md) | Media Upload & Download Security | **High** | 5 | 5 | **Done** |
| [004](./004-database-integrity-and-transaction-safety.md) | Database Integrity & Transaction Safety | **Critical/High** | 6 | 6 | **Done** (PR #8) |
| [005](./005-durable-object-lifecycle-memory-management.md) | Durable Object Lifecycle & Memory | **High** | 10 | 10 | **Done** — re-audit 2026-11-16: 005.6 send failures already isolated, 005.10 outbound workflow fetches all timed |
| [006](./006-federation-event-validation-state-resolution.md) | Federation Event Validation | **High** | 8 | 8 | **Done** (PR #9) |
| [007](./007-rate-limiting-dos-protection.md) | Rate Limiting & DoS Protection | **High** | 7 | 7 | **Done** — re-audit 2026-11-16: 007.3 D1-backed reset limit, 007.6 5-minute TTL + SSRF/delegation validation |
| [008](./008-rtc-webrtc-authentication-gap.md) | RTC/WebRTC Auth Gap | **Critical** | 3 | 3 | **Done** |
| [009](./009-room-operations-race-conditions.md) | Room Operations Race Conditions | **High** | 5 | 5 | **Done** — PR #10 + `migrations/018_room_memberships_unique.sql` |
| [010](./010-error-handling-information-leakage.md) | Error Handling & Information Leakage | **Medium** | 6 | 6 | **Done** — re-audit 2026-11-16: 010.6 no-store + hashed KV + single-use + audit trail |

---

## What Was Fixed

### Commit 1: Initial security fixes (8 files)
- **008**: All 3 findings — requireAuth() on LiveKit, OpenID verification, CORS
- **003**: All 5 findings — MIME whitelist, body size, filename sanitization, security headers, NaN parsing
- **002**: Items 1, 4, 5, 7 — AppService namespace validation, PBKDF2 bounds, timing-safe comparison, CSP note
- **005**: Item 3 — RateLimit alarm scheduling
- **007**: Item 7 — Pagination parameter bounds
- **010**: Item 2 — Cache invalidation error logging

### Commit 2: Federation signing and body buffering (4 files)
- **001**: Items 1, 2, 4 — Outbound signing on workflows/DOs, body buffering in auth middleware, optional auth fix
- **005**: Items 4, 5 — FederationDO queue bounds (10k cap), response body validation, max retry cap (32), fetch timeouts

### Commit 3: Database integrity (2 files)
- **004**: Items 1, 3 — Stream ordering atomic UPDATE, data integrity migration with indexes and unique constraints

### Commit 4: Federation event validation (1 file)
- **006**: Items 1, 2, 3, 7, 4 — PDU signature logic fix, backfill/missing-events membership checks, auth chain cap, invite sender validation

### Commit 5: Durable Object reliability (3 files)
- **005**: Items 2, 8, 9 — SyncDO bounded scans, connection state expiry, PushDO JWT TTL reduction, push fetch timeout

### Commit 6: Password and brute force protection (5 files)
- **002**: Items 2, 3, 6 — Password strength validation, per-account lockout after 5 failures, OIDC encryption key required for new secrets
- **007**: Item 4 — Sliding sync subscription cap (100 per request)

### Commit 7: SSRF and error sanitization (2 files)
- **006**: Item 8 — IPv6 multicast, site-local, documentation prefix ranges added to SSRF blocklist
- **010**: Item 1 — Raw error details removed from admin API OIDC responses, logged server-side instead

### Commit 8: Stale-key rejection, join template validation, content hash enforcement (4 files)
- **001**: Item 5 — Federation key staleness threshold (default 7 days past `valid_until`); fallback to D1 cache and `verifyRemoteSignature` both reject keys past the threshold
- **006**: Item 5 — `make_join` template from remote validated for room_id, sender, state_key, type, content.membership, non-empty auth_events / prev_events with valid IDs, supported room version, and positive depth before signing
- **006**: Item 6 — `hashes.sha256` required for room versions ≥ 3; legacy room versions (1-2) still accepted without hash but logged

### PR #8: Database integrity remainder
- **004**: Remaining atomicity / row-size / N+1 / index items

### PR #9: Federation validation remainder
- **001** / **006**: Stale-key, join-template, and content-hash follow-through (see commit 8)

### PR #10: Room operation race conditions (issue 009 — all 5)
- **009.1** Join race — D1 batch + unique `room_memberships(room_id, user_id)` (also `migrations/018_room_memberships_unique.sql`, renumbered from a conflicting `017_*` name)
- **009.2** / **009.3** State write interleaving / TOCTOU — idempotent store + optimistic concurrency (`M_CONFLICT`)
- **009.4** Cache invalidation logging + generation bump
- **009.5** Account data upsert / version awareness

### PR #11: DO bounds, rate-limit IP trust, admin audit
- **005.1** SyncDO resolver map keyed by waiter id
- **005.7** RoomDO in-memory caps
- **007.1** Prefer `CF-Connecting-IP`; `X-Forwarded-For` only when `TRUST_FORWARDED_FOR=true`
- **010.5** `admin_audit_log` (migration 019) + `src/services/admin-audit.ts`

---

## Re-audit (2026-11-16)

The findings previously listed as residual were read against the current tree (post federation-v12 work). All are already fixed; the August status table under-claimed what had landed.

- **005.6** (broadcast failures) — `src/durable-objects/call-room.ts`: `send()` wraps `ws.send()` in try/catch, so one dead socket cannot abort the `broadcast()` loop. The reported failure mode is impossible in the current code.
- **005.10** (workflow fetch timeouts) — every outbound workflow fetch carries `AbortSignal.timeout()`: `FederationCatchupWorkflow.ts` (10 s version probe, 30 s catchup), `PushNotificationWorkflow.ts` (10 s push). `RoomJoinWorkflow.ts`'s only fetch is an internal Durable Object stub, which has no remote-hang exposure.
- **007.3** (identity reset limiting) — `src/api/oidc-auth.ts`: D1-backed per-user cap of 3 cross-signing resets per hour (`IDENTITY_RESET_LIMIT`), reading the `device_key_changes` audit rows the handler writes; the shared RateLimit DO cannot hold hourly windows, hence D1.
- **007.6** (well-known amplification) — `src/services/server-discovery.ts`: edge `cacheTtl` reduced to 300 s, SSRF validation on both the well-known URL and the delegated target. The 5-minute cache also bounds lookup frequency per domain.
- **010.6** (QR login token exposure) — `src/api/admin.ts`: `Cache-Control: no-store`, token stored hashed in KV with TTL, issuance recorded in the admin audit log; `src/api/login.ts` deletes the token on first use (single-use). Returning the raw token at issuance is inherent to rendering the QR in the admin UI.

## Optional hardening (not open audit findings)

Ideas from the issue docs that go beyond the reported findings, for future consideration:

- **007.6**: extend the well-known TTL only after a delegation proves stable across lookups; probe that the delegated target answers as a Matrix server before trusting it.
- **005.6**: evict participants whose sends keep failing (failures are already isolated and logged).
- **010.6**: replace the raw-token issuance response with a short-lived reference ID exchanged server-side (larger admin-UI change; current mitigations already cover proxy/CDN caching and replay).
