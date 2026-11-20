# Federation delivery handoff (2026-11-19/20)

Context: user's homeserver `codebam.ca` (Worker `matrix-worker-codebam`). Goal: fix
"matrix.org accepts our PDUs (200) but never displays them" (GNU/Linux room
`!iDwfRnmIeZCSTKVEim:halogen.city`) and make remote joins/delivery reliable.
User also asked for a second instance at `dev.codebam.ca` to debug federation
with both workers tailable, and for mock-Synapse tests (done).

## Commits / deploys (all pushed to origin/main)
- `86d519a` omit explicit `event_id` on wire PDUs (room v3+; Synapse rejects it).
- `875086b` room-version-aware redaction/signing (v1-10: create keeps only
  `creator`, power_levels drops `invite`); derive-on-serve in `src/services/event-wire.ts`.
- `25bee50` augment auth_events with types Synapse selects (join_rules for joins,
  sender membership) at creation + serve; never self-reference.
- `85b7628`/`63cfbcc` derived IDs must depend only on DAG history (state-at-depth),
  not current state; alias pre-augmentation wire IDs.
- `8d6e82a` /sync accepts `org.matrix.msc4222.use_state_after` (Element's param name).
- `dfc2719` **prod deploy ca886c09**: /state auth_chain no longer spreads raw D1 rows
  (leaked `event_type` + `unsigned:null` → content-hash mismatch → residents reject);
  derivation extended to ALL v3-v10 rooms (cap 1000 events, best-effort fallback);
  `src/services/federation-verify.ts` (Synapse receive-side rules port) gated by
  `FEDERATION_STRICT_AUTH` (dev only); mock peer tests
  `test/federation-synapse-peer.test.ts` + `test/helpers/synapse-peer.ts` (4 green).
- `944b9ec` `wrangler.dev.jsonc` (dev instance config).
Full suite green: 342 files / ~45.4k tests; `npm run typecheck` clean.

## Dev instance (live)
- Worker `matrix-worker-codebam-dev`, deploy `6c37fd8e`, routes `dev.codebam.ca/...`
  (DNS: proxied CNAME dev → codebam.ca, zone e9425b9e15a26285f43260ab993914a3).
- D1 `matrix-db-codebam-dev` fd00b766-e98a-4818-9b5b-d69fc7a1323f (schema.sql executed
  directly + numbered migrations applied individually; `schema.sql` row inserted into
  d1_migrations because it sorts last but must run first).
- KV/R2 ids in wrangler.dev.jsonc. Vars: SERVER_NAME=dev.codebam.ca,
  FEDERATION_STRICT_AUTH=true, compat flag `global_fetch_strictly_public`
  (worker-internal fetch dispatch to same-zone codebam.ca returned HTTP 530).
- Signing key bootstrapped by curling `/_matrix/key/v2/server` once (auto-generates).
- Dev user: `@fedtest:dev.codebam.ca` / password `fed-test-password-123`
  (registration token row in dev D1, uses_remaining 5).
- Local DNS negative-caches dev.codebam.ca: use `curl --resolve dev.codebam.ca:443:172.64.80.1`
  (or DoH-verified IP) until cache expires.

## OPEN: prod↔dev delivery still not working
Repro script `/tmp/fed-repro2.py` (public_chat room v10, prod temp token minted via
D1 insert into access_tokens with sha256-urlsafe-b64 hash, deleted at end; dev login;
dev join; prod send; poison prod join auth_events via D1 UPDATE; delete dev's copy;
prod send again; prod leave+rejoin heal; prod send). Latest run room
`!5FwUGJC8NBX23JRtbMdtKIr9:codebam.ca`: dev join 200 but dev sync timeline empty and
`processed_pdus` rejections empty → PDUs never reach dev / never accepted.
Earlier causes fixed: missing dev signing key ("Server signing key not configured"),
HTTP 530 key fetch (compat flag). Next: inspect tails (still running background shells
`bg_533f4b39` prod → /tmp/tail-prod.jsonl, `bg_1f1e535a` dev → /tmp/tail-dev.jsonl;
parse with json.JSONDecoder raw_decode loop, logs[].message is a list; URLs redacted —
match on log messages). Check whether dev's RoomJoinWorkflow actually completes
send_join to prod now, and whether prod's FederationDO alarm delivers /send to dev
(getJoinedRemoteServers requires dev membership=join on PROD).
Other /tmp artifacts: fed-repro.py (older variant), fedsign.ts (self-signed federation
GET; middleware verifies uri = RAW pathname+search; node v26 runs .ts natively),
synenv (pip venv with matrix-synapse; run with LD_LIBRARY_PATH=$(nix eval --raw
nixpkgs#zlib.out)/lib) for offline Synapse verification of served PDUs.

## GNU/Linux live heal (not yet user-verified)
Prod fixes are deployed. Heal path for already-poisoned rooms: user leaves and
re-joins the room from codebam.ca (new join event carries correct auth selection),
then sends; matrix.org should display. Ask user to test; alternatively dev repro above
validates the same mechanism once prod↔dev delivery works.

## Gotchas
- Client "NetworkError"/"Joining..." masks server-side federation rejection; diagnose
  via tails + offline Synapse checks, not client text. Element web had a client-side
  "Joining..." hang even after server accepted (FluffyChat accept worked).
- Canonical JSON maps undefined→null: never emit absent keys as undefined in PDUs.
- Reference-hash IDs need `$` prefix (computeWireEventId adds it; bare hash is wrong).
- Commit trailer only `Assisted-by: Hy4 Flash`; git commit foreground ~600s timeout.
- wrangler deploy: run from repo dir, confirm "Current Version ID", probe live.