# Design Note: 010.6 QR Login Token — Reference-ID Exchange Flow

**Status:** **Implemented** (human-approved HITL change; see below).  
**HITL:** Any change to how sessions/tokens are stored requires human review per `AGENTS.md`; this change was explicitly approved by the repository owner before implementation.

## Context

`POST /admin/api/users/:userId/login-token` issues a one-time login token used to
render a QR code. Today the endpoint returns the **raw token** in the JSON body
(and embeds it in `qr_url`), so the secret traverses the admin response, browser
DevTools, proxy/CDN access logs, and browser history. Mitigations already landed
(audit 010.6): `Cache-Control: no-store`, token stored **hashed** in KV with TTL,
single-use delete on first redemption, issuance recorded in `admin_audit_log`.

The proposed change replaces raw-token issuance with a short-lived reference ID
exchanged server-side. This is a larger admin-UI change and touches token
storage, so it is recorded as a design note only.

## Proposed exchange flow

1. **Admin issues a reference ID.** `POST /admin/api/users/:userId/login-token`
   generates the real login token internally, stores it in KV under
   `login_token:<sha256(token)>` (as today), and instead of returning the token
   returns a short-lived, opaque `reference_id` (e.g. `qr_ref:<random>`). The
   reference is stored in KV mapping `qr_ref:<ref>` → `login_token:<sha256(token)>`
   with a very short TTL (target ~60 s, configurable 1–60 min bound on the token
   itself unchanged). Response carries `reference_id`, `qr_url` (now encoding the
   reference, not the token), `expires_at`, `user_id`, `homeserver`. **No raw
   token in the response body.**
2. **QR encodes the reference.** The admin UI renders
   `${host}/login/qr/${reference_id}`. Scanning it hits a server route that
   resolves the reference to the underlying token record.
3. **Client exchanges reference for session token server-side.** The redemption
   path (`m.login.token` in `/_matrix/client/v3/login`, and the QR check route)
   accepts either a raw token (legacy) or a `reference_id`. When a reference is
   presented, the server looks up `qr_ref:<ref>`, fetches the associated
   `login_token:<hash>` record, performs the same expiry/verifier checks, mints
   the Matrix access token, and **deletes both the reference and the login-token
   record** (single-use). The raw login token never leaves the server.
4. **Reference is single-use and short-TTL.** Reference KV entry uses
   `expirationTtl` of the reference lifetime (≤ token TTL) and is deleted on
   first successful exchange; a second presentation returns `M_FORBIDDEN`.

## Migration implications

- **KV schema:** new key namespace `qr_ref:<id>` → `{ token_hash, created_at, expires_at }`.
  Additive only; no change to the existing `login_token:<hash>` record shape.
- **Existing tokens:** issued tokens remain valid until their TTL; they are still
  addressable by raw token hash for legacy redemption. No data migration required.
- **Backward compat:** redemption must accept both raw tokens and reference IDs
  during a transition window. Distinguish by format/prefix (`qr_ref_` prefix or
  a `reference_id` field) rather than by length guessing. Remove raw-token
  acceptance only after all clients/UIs have moved to references (separate
  HITL-gated change).
- **No D1 schema changes** are required; this is KV-only. (Any future decision
  to persist references in D1 for auditability would be a migration and HITL.)

## Security implications

- **Replay:** reference is single-use and short-TTL, same as the token. A
  captured reference is replayable only within its TTL and only once; the
  underlying token is never exposed, so replay yields at most one session, which
  the attacker could already obtain by redeeming the raw token today.
- **Proxy/CDN caching:** reference in URL is still a bearer-ish capability, so
  `Cache-Control: no-store` must remain on both issuance and redemption
  responses; the reference is lower-value than the raw token but still
  single-use. CDN access logs would log the reference (not the token), reducing
  blast radius if logs leak.
- **Audit trail:** issuance already logged (`user.login-token.create`). Add
  `user.login-token.redeem` entries recording reference id (not token), user,
  device, and outcome. Reference → token-hash mapping must not be logged.
- **Residual risk:** the admin UI still needs the reference to build the QR;
  anyone with admin session can issue. The reference itself is a capability
  until redeemed; treat as secret in transit (HTTPS only, no-store).

## Why human review required

- `AGENTS.md` HITL: **any change affecting how sessions, tokens, or passwords
  are stored**. This changes the issuance contract and the redemption path in
  `src/api/login.ts` and `src/api/admin.ts`, and introduces a new KV namespace
  and exchange endpoint.
- **Auth middleware?** possibly — redemption happens on the unauthenticated
  `m.login.token` path; ensure no auth regression and that rate limiting covers
  the new exchange endpoint (coordinate with 007).
- **Federation?** no — login tokens are local-only; no federation surface.
- **Migration?** no D1 migration in the minimal version, but KV key contract
  change and backward-compat removal later would need review.
- **Admin UI change** is non-trivial: QR rendering, copy/share flows, and
  expiry display all change. Needs design + QA sign-off.

## Status

- **Implemented** after explicit human approval. What landed:
  - `POST /admin/api/users/:userId/login-token` now returns `reference_id`
    (`qr_ref_…`) plus a `qr_url` carrying that reference; **no raw token** in
    the response body. The raw token remains stored hashed in KV with its TTL.
  - New KV key `qr_ref:<reference_id>` → `{token_hash, user_id, created_at,
    expires_at}` with a 60-second TTL (≤ token TTL).
  - `m.login.token` accepts either the legacy raw `token` or a reference
    (via `token` or `reference_id`). Successful redemption burns **both**
    keys; a wrong verifier burns neither. Stale/expired references are cleaned
    up on access; replay returns `M_FORBIDDEN`.
  - QR landing and check routes (legacy + namespaced) resolve references
    without consuming them and label the landing page as a reference, not a
    raw token.
  - `Cache-Control: no-store` retained on issuance/landing/check responses;
    issuance is audited with the reference ID, and successful reference
    redemptions write `user.login-token.redeem` (reference ID only, never the
    token or its hash).
  - Admin UI shows the 60-second link lifetime alongside the token lifetime.
- **Backward compatibility:** legacy raw-token redemption and the
  `POST /_matrix/client/v1/login/get_token` flow are unchanged. Removing raw
  token acceptance would be a separate HITL decision.
- Coverage: `test/qr-login-reference-id.test.ts` plus updated admin-route tests
  for the new response contract.
