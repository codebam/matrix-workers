# Federation delivery handoff (2026-11-19/20, session 2)

Context: continuing from `29a74df`. Federation delivery is FIXED and
user-verified (see "GNU/Linux live status"); sessions 2-4 closed four stacked
root causes. Session 5 (2026-11-20) shipped the next feature set: native bots
(see docs below).

## What this session found and fixed (all pushed to origin/main)

### 1. prod→dev federation was dead: same-zone fetch 522 (fixed, live)
Prod's key fetch of `dev.codebam.ca` returned **HTTP 522** (same-zone
worker-internal routing), so every dev→prod make_join 401'd with "Cannot fetch
signing keys from dev.codebam.ca". Mirror image of the dev-side 530 the previous
session fixed with `global_fetch_strictly_public` — but no prod change needed:
dev's well-known now delegates federation to its **workers.dev domain**
(`FEDERATION_WELL_KNOWN_M_SERVER`, commit `e34f69c`, dev deploys `4b2e45f7` /
`8c371499`). Off-zone hosts behave like ordinary origins; prod discovers dev
via well-known and everything flows. Live-verified: join handshake completes,
transactions deliver, dev accepts messages and /sync shows them.

### 2. Phantom wire IDs: version-blind `computeWireEventId` (fixed, live)
Reference hashes use the room version's redaction rules — **v1–10 redacts
`m.room.create` (keep only `creator`) and `m.room.power_levels` (drop `invite`)
differently from v11+**. Four call sites derived IDs without the version, so v10
rooms' create/PL landed under v11-rule **phantom IDs** no peer ever references.
This is very plausibly the ORIGINAL "matrix.org 200s but never displays" bug:
prod's copy of the GNU/Linux room (joined via `storeRemoteStateEvent`) holds
phantom create/PL, and any message auth-referencing them is rejected. Pinned by
recomputing both hashes from the live /state response: v10-rule == prod's stored
ID, v11-rule == the joining server's phantom ID, for exactly create+PL (member/
message redaction coincides, which is why joins looked fine).

Fixed in `97d9422`: `RoomJoinWorkflow.storeRemoteStateEvent` + `createJoinEvent`
(now take the negotiated room version), inbound /send (room lookup moved above
ID derivation; signature redaction now version-aware), admin backfill. Plus a
stability fix in `deriveRoomWireEvents`: auth augmentation no longer re-derives
slots the event already references (the depth cutoff skipped same-depth
membership transitions, so leave+rejoin got a stale pre-leave membership
appended — different derived ID → dangling refs).

Live validation (prod old code → dev new code): clean-room join + send
**DELIVERED** — dev accepted (`processed_pdus accepted=1`) and dev's timeline
shows both messages. Repro: `/tmp/fed-repro3.py` (waits for the join to land on
prod before sending — see "known minor gap" below).

### 3. Local member/state events never federated (fixed, needs prod deploy)
Only the message path queued federation PDUs. Join/leave/kick/ban/unban/state
PUTs (incl. profile member updates) were stored but never delivered, so the
"leave + re-join" heal cannot work: the resident never receives the rejoin and
rejects post-heal messages ("missing auth event type m.room.member"). Fixed in
`9ebd7f5` via `federateLocalStateEventToRemotes` (same wire translation as the
message path, destinations captured before membership rows mutate, kick/ban
include the target's server; member invites via the state path route through
the dedicated invite flow). Peer-suite regression covers leave→rejoin→message.

## GNU/Linux live status (CLOSED, user-verified 2026-11-20)
"yay I fixed it" (23:58:44, `$nB3HRvWq…`) **displayed in the room**, and a
signed /event probe confirms matrix.org holds it with auth refs exactly
matching the re-synced real IDs. The original "200 but never displays" bug —
the four stacked root causes (auth_chain raw-row leak, version-blind wire
IDs incl. the v1-10 origin/prev_state redaction, remote-room re-derivation
phantom IDs, missing member/state fanout) — is closed.

## Post-join timeline backfill (VALIDATED live, 2026-11-20)
fed-repro5 on the prod<->dev pair: dev joined a room whose messages
predated the join and its /sync timeline showed both — deliverable only via
the new `/backfill` workflow step. The fetch is READ-ONLY: rejoining a room
costs one visible member event and nothing else; there is no spam risk from
the history fetch. (User deferred rejoining #gaming:nixos.org.)

## Deploy state
- dev (`wrangler.dev.jsonc`): **fully current** — `81480314` (all fixes).
- prod: **deployed `cf229fc6`** (user-approved) — everything through `a54dbe8`:
  `e34f69c` (well-known delegation), `97d9422` (version-aware wire IDs +
  augmentation stability), `9ebd7f5` (member/state fanout), `c6cf603` (join
  fallback servers), `eda805c` (remote rooms serve as-stored), `a54dbe8`
  (spec v1-10 redaction keeps origin/prev_state + post-join timeline
  backfill).
- The fed-repro2 poison variant cannot heal while the poison remains in the
  stored DAG (leave/rejoin auth-reference the poisoned creator join; real
  Synapse backfills missing auth via /event fetches, dev's strict port does
  not). In-process mock peer tests remain the poison coverage.

## Session 4 (2026-11-20): the deepest root cause + the heal, no-leave
1. **v1-10 redaction keeps `origin` and `prev_state`** (spec; dropped only in
   v11). Our keep-list omitted them, so EVERY pre-2023 Synapse event (they
   carry `origin`) derived a phantom ID. Proven by brute-forcing keep-set
   variants against matrix.org's held copy of the GNU/Linux v9 create: the
   real ID reproduces only with origin+prev_state kept. Fixture-pinned.
2. **Remote-created rooms serve as-stored** (`eda805c`): re-deriving their
   events can never reproduce residents' IDs (we don't store `origin`), so
   every re-derived reference was phantom. Now gated on provable local
   authorship of the create.
3. **The GNU/Linux room was healed WITHOUT the user leaving** (user's
   request): a fresh join was minted server-side against matrix.org
   (`make_join` → v9-signed `send_join` → accepted `$IcgDoT4y…`), then the
   room state re-synced from matrix.org's `/state` serve under REAL IDs
   (`/tmp/resync-room.py`, sanity-gated against the ids matrix.org's own
   join template referenced). Prod's slots now: create `$vg_GNDV…`,
   join_rules `$4Jl6Tts…`, power_levels `$g-tExIy…` (the CURRENT 2022-08 PL,
   previously stale), member(@codebam) `$IcgDoT4y…`. matrix.org's resolved
   membership: `join`. Next user message should display.
   Caveats: the pre-fix phantom rows from the first admin backfill attempt
   remain as inert rows and poisoned that route's anchor selection (it picks
   the newest matrix.org-authored row); `halogen.city` federation is broken
   (302 → dewrito.net 404) — joins now fall back to the inviter/participating
   servers (`c6cf603`).
4. **Post-join timeline backfill** (`a54dbe8`): joining `#gaming:nixos.org`
   synced members but no history because the join flow stores only state.
   New workflow step fetches federation `/backfill` (limit 50, anchored at
   the join) and stores oldest-first; a re-join of that room pulls history.

## Known minor gaps (documented, not blocking)
- **Join/send race:** the client /join returns 200 while RoomJoinWorkflow
  completes make_join/send_join (~3-4s later). Messages a resident sends in
  that window never fan out (dev wasn't a destination yet). Synapse blocks
  until the handshake completes. Repro scripts now wait; a product fix would
  make /join await the workflow or re-sweep recent events on send_join.
- Repro artifacts: several `fed repro`/`fed clean repro` rooms on prod, plus
  dev test rooms with pre-fix phantom state — harmless; fresh repros mint new
  rooms.
- Stale tails from earlier sessions were killed; fresh tails ran during this
  session into `/tmp/tail-prod2.jsonl` / `/tmp/tail-dev2.jsonl` (now stopped).
- Scripts: `/tmp/fed-repro3.py` (clean-room delivery), `/tmp/fed-repro2.py`
  (poison+heal — the poison's live meaning changed: serve-time derivation
  re-derives poisoned stored auth, so the rejection now comes from ID churn
  and the in-process mock tests are the true poison coverage),
  `/tmp/fedsign3.ts` (self-signed federation GET to any destination),
  `/tmp/refhash-check.mjs` (offline v10/v11 refhash comparison),
  `/tmp/parse-tails.py` (wrangler JSON tail parser).

## Native bots + Telegram bridge (2026-11-20, session 5)
Shipped in `02c99ce` (prod `c715c6a4`, dev `3da7aa2e`, migrations 023/024
applied to both, additive-only).

- **Bots**: users with NO password (cannot log in). Admin API
  `POST /admin/api/bots {localpart, kind, room_id?}` creates + server-side
  joins; invites auto-accept.
- **Admin console** (`!admin`, server-admin senders only, replies m.notice):
  help/status, token mint/list/revoke, user list/create/deactivate
  CONFIRM/reset-password, federation status, room kick/ban/unban (performed AS
  THE BOT — the room's power levels govern), notice, telegram list.
- **Telegram bridge** (webhook-only, no polling): BotFather token supplied
  ONLY via `POST /admin/api/telegram/bridges {bot_localpart, room_id,
  chat_id, tg_token}` (auto-creates the bot user, joins it, calls setWebhook
  with a secret; rolls back on Telegram rejection). Updates land as
  `[TG] Name (@user): text`; Matrix→TG relays local AND federated sends with
  display-name prefixes; loop prevention is structural (all integrations
  skip bot senders; consumed commands are never relayed).
- Loop-prevention/hook architecture: single hook
  `src/services/room-integrations.ts` from `performSendEvent` ('local') and
  inbound /send ('federated'); all cross-module room imports are dynamic (no
  static import cycles).
- Live-validated on dev: create+join, !admin status/token mint, webhook
  403/200, TG→Matrix in-room relay, Matrix→TG attempt.
- Setup on prod: login as @codebam for an admin token; create a local
  management room; `POST /admin/api/bots {localpart:"adminbot", room_id}`;
  type `!admin help`. Telegram: BotFather /newbot, message the bot once,
  chat id via @userinfobot (private chats) or the group's id, then
  `POST /admin/api/telegram/bridges`.
