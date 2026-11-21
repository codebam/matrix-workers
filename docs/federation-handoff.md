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
- Setup on prod (COMPLETE + user-verified 2026-11-20): management room
  `!K8i7iW7ofA1apMUCfUnuBGyh:codebam.ca` (alias now **#codebam_live:codebam.ca**,
  re-pointed by the user through Element's UI after the trailing-slash route
  fix `f3d7724e` — aliases re-point via create-new + delete-old, the room ID
  is unaffected), `@adminbot:codebam.ca`
  joined via invite auto-accept and answering `!admin` commands live, and
  Telegram bridge `tgb_GBf2vdDXHDUDF-5Y` (`@tgbot:codebam.ca` <-> the room,
  supergroup chat) live in both directions (user-verified). Each bot is a
  SEPARATE Matrix user needing its own invite to private rooms — the setup
  script `scripts/telegram-bridge-setup.sh` (local, gitignored by the *.sh
  policy) now sends the invite itself before registering. En-route fix:
  negative/supergroup chat ids were rejected by an over-strict validation
  regex (`c0f3ae9`, deployed `c7d7c378`).
- Telegram gotchas learned (both hit live): group bots default to PRIVACY
  MODE (only mentions/commands reach the webhook — BotFather /setprivacy →
  Disable), and Telegram's per-membership routing does not refresh after the
  setting change until the membership is renewed — toggling the bot's group
  ADMIN status on/off (the user's fix) or remove+re-add does it. Diagnostic
  playbook: getMe (can_read_all_group_messages), getWebhookInfo
  (pending_update_count/last_error_message), getChatMember, then a synthetic
  webhook update using the bridge's stored secret to prove our side.

## Admin dashboard additions (2026-11-20, session 6)
Shipped in `c88c574` (prod `3ceecd7d`), all built on existing routes unless
noted:
- **Audit page** over `admin_audit_log` (actor/action/target filters, paging).
- **Registration tokens** card in Settings: mint (token shown once), list,
  revoke — previously curl/`!admin` only.
- **Telegram per-bridge Check** button → new
  `GET /admin/api/telegram/bridges/:id/webhook-info` (server-side
  `getWebhookInfo` with the stored token: URL, pending backlog, last error,
  health badge, privacy-mode refresh hint).
- **Federation Key Self-Check** button surfacing the existing
  tester-equivalent `/admin/api/federation/key-check`.
- **Room federation tools** in the room detail modal: Backfill State (existing
  route) and Probe Delivery via new
  `GET /admin/api/rooms/:id/federation-probe?server=X`, which signed-GETs our
  newest locally-authored event from the remote and reports held/not-held —
  the manual diagnostic from the delivery debugging as a button.

## Join authorization on federation (2026-11-20, session 6)
A matrix.org friend following https://matrix.to/#/#codebam_live:codebam.ca got
Element's vague "Something went wrong". The room was invite-only (created as
the private admin room; the user later switched it to public). Our side had
two real gaps: `make_join` served a join template to **anyone**, including
uninvited users of invite-only rooms, and `send_join` never ran the auth
rules — origin-vs-sender was the only gate, after which the handler
countersigned and stored whatever arrived and answered with the room's full
state.

Fixed in `3c8e9fe` (prod `4bd4d9fb`):
- `make_join` refuses banned users and uninvited users of invite/knock rooms
  with 403 `M_FORBIDDEN` (so the client shows the real reason), and refuses
  requests for users of another server (authenticated origin must equal the
  joining user's domain). Rooms with no synced state keep the old behavior.
- `send_join` (v1 and v2) runs `checkEventAuth` against current room state
  before countersigning/persisting, and returns 403 when persistence rejects
  the event instead of serving state with a 200 (malformed bodies, origin
  mismatch).
- Live-verified with self-signed federation requests: invite-only/uninvited →
  403 "You are not invited to this room"; public room → 200 template;
  cross-server make_join → 403; uninvited send_join → 403 "Not authorized to
  join"; malformed send_join → 403.
- Test-only note: the membership API fake now models `server_keys` (returns
  null → unsigned persist) and the 14-column `events` INSERT; `getRoomState`
  is mocked as an array in the federation API route suite.

## Telegram image bridging (2026-11-20, session 6)
Shipped in `7d13cb0` (prod `4a29e2d1`). Images now cross the bridge in both
directions; text relaying is unchanged.

- **Telegram → Matrix**: photos (largest of Telegram's size ladder),
  image-typed documents and static webp stickers are downloaded via getFile
  (bot download cap 20MB), stored in the media repo exactly like an upload
  (R2 + D1 row owned by the bridge bot), and posted as `m.image` / `m.sticker`
  events referencing `mxc://<server>/<id>` — servable to federated users via
  the public media download. Animated .tgs / webm stickers, voice, audio and
  video keep the placeholder text; ANY download/store failure also falls back
  to that placeholder so the room still hears about the image.
- **Matrix → Telegram**: `m.image`, `m.sticker` and image-typed `m.file` are
  resolved from the media repo (local R2 directly; other servers via the
  signed MSC3916 federation download path with its R2 cache) and uploaded as
  `sendPhoto` (multipart FormData) with a sender-prefixed caption. SVG and
  payloads over Telegram's 10MB photo cap go as `sendDocument`; unresolvable
  media falls back to a text notice (`[image] <body>`) instead of silence.
  `relayMatrixToTelegram` now takes the full message content, not just body
  text. Loop prevention is unchanged (bot senders skipped).
- Live-verified Matrix → Telegram: uploaded a 64×64 PNG through
  `/_matrix/media/v3/upload`, posted `m.image` into the ops room as
  @codebam, tail showed the send with zero bridge errors (a rejected
  sendPhoto would log). Test event
  `$XRFsdxvSyVowY5tAMuX1S4maDdDrv4_Ay4Wz9e0xvEs`, media
  `mxc://codebam.ca/MHVrgMcso964ks1-vqNX_FhzjRRfTGuK`.
- Live-verified Telegram → Matrix (both directions USER-VERIFIED
  2026-11-20): a photo sent in the bridged Telegram chat appeared in the
  Matrix room as an m.image posted by @tgbot; tail showed a single clean
  webhook POST with zero bridge errors.
- 12 new tests in `test/bots-integrations.test.ts` (both directions,
  stickers, size caps, fallbacks, loop prevention); suite 345 files /
  45,451 tests.

## Telegram formatting bridge (2026-11-20, session 6)
Shipped in `8716976` (prod `1edb2e92`). Bold/italic/underline/strike/spoiler/
code/pre/links now survive both directions. Pure converter module:
`src/services/telegram-format.ts` (34 tests: `test/telegram-format.test.ts`
+ 6 integration cases in bots-integrations).

- **Matrix → Telegram**: `formatted_body` (org.matrix.custom.html) converts
  to Telegram's `parse_mode=HTML` subset via a strict tokenizer — only
  b/i/u/s/code/pre/a survive; every text node and attribute value is
  unescaped then re-escaped; unsupported tags and href schemes (only
  http/https/tg) drop their tag but keep their text; unbalanced tags
  auto-close; Matrix `<pre><code class="language-x">` flattens to `<pre>`.
  If Telegram's strict parser still rejects the result, the message retries
  once as plain text — formatting can never drop a relay. Plain text keeps
  going out WITHOUT parse_mode (no injection surface).
- **Telegram → Matrix**: message entities (offset/length in UTF-16 code
  units — exactly how JS indexes strings, so emoji are safe) convert into a
  freshly escaped `formatted_body` with the `[TG] name:` prefix escaped too.
  Supported: bold, italic, underline, strikethrough, spoiler (→
  `<span data-mx-spoiler>`), code, pre+language, text_link, text_mention,
  mention, url. Nothing from the Telegram side passes through unescaped.
- Literal markdown typed in the Telegram box is NOT parsed — Telegram
  delivers it as plain text (that is Telegram behavior, not a bridge gap);
  only its structured entities (BIU menu, link attachment, bots) convert.
- Live-verified Matrix → Telegram: posted the user's exact case
  (`**Bold [link](<https://google.com>)**` → `<strong>Bold
  <a href="https://google.com">link</a></strong>`) into the ops room; tail
  clean, no fallback needed. Test event
  `$33X4OG_lZTB-AfM8IQ7Anggncqocp246B1BG5Cr2Hgo`.
- Live-verified Telegram → Matrix (both directions USER-VERIFIED
  2026-11-20): Telegram-formatted text (entities) arrived in the room with
  real bold/links rendered by Element.

## Room history: state snapshots and replays out of the timeline (2026-11-20, session 7)
Trigger: previewing #users:nixos.org showed "hundreds of join messages and
no conversation". Three separate causes, all fixed:

1. **The alias moved.** #users:nixos.org no longer resolves to the old
   !hzgkCxLtCOTmFXGauj:nixos.org room (the fossil our preview served —
   1959 member events, zero messages). It now resolves live (via
   /query/directory, since we hold no local alias row) to the community's
   current room **!6oudZq5zJjAyrxL2uY:0upti.me ("Nix / NixOS")**. The old
   room lingers only in old sessions' history.
2. **State snapshots were timeline material** (76ab116 + 3eb0a38, prod
   6628034d): joining a large remote room stored its full current state
   (thousands of member joins) with real stream positions, so paginated
   history and peeks served the join wall. Snapshots now store at NEGATIVE
   stream positions — events.stream_ordering carries a UNIQUE index
   (migration 016), so each snapshot negates its own allocation; every
   timeline query filters `stream_ordering > 0` (getRoomEvents,
   getRoomTimeline, sliding-sync initial window). room_state,
   room_memberships, auth checks and federation serving are unaffected —
   only timeline visibility changes. The RoomJoinWorkflow's send_join
   state echo + full-state backfill + the admin Backfill State route mark
   stateOnly; the timeline backfill (real history) does not.
3. **Conduwuit replays historical events via ordinary /send transactions**
   (fadd14d, prod 81d1bf40): a newly joined server receives ~2000 old
   member events (timestamps from 2025!) at the NEWEST stream positions,
   burying fresh conversation. Replay guard in the PDU loop: an
   m.room.member event arriving out of chronology (older than the newest
   event we hold) stores at a negated position. Late-retried legitimate
   events lose only their timeline line — state still updates.

**One-off prod cleanups** (user-approved; original orderings backed up to
/tmp/opencode/backup-*.json — reversible by re-negating WHERE
stream_ordering < 0 within the recorded ranges):
- new room: negated 2500 snapshot rows (<window start), then 1952 replayed
  member events + 24 replayed state events (ts < join ts)
- GNU/Linux room: 49 + 22 rows; old fossil: 1974 rows (between join and
  leave), leaving only join/leave visible
Final live state of !6oudZq…:0upti.me — /messages backward page is
20 messages + join/reaction/redactions; /sync initial timeline 18 real
messages; room name resolves ("Nix / NixOS").

**Temp peek user**: @fedpeek5626:codebam.ca (admin-created, password in
session history only) is joined to the new room to keep our server
resident (live traffic + working previews) — REMOVE IT (leave room,
deactivate) once the real account joins. Note: the user's earlier "join"
of the new room never reached this server (no local join event) — if they
joined via the preview, it was on another account/server.

## Conduwuit interop + nixos room follow-ups (2026-11-20, session 7 cont.)
- **Parameterized key endpoint was unsigned** (`b749624`, prod `cf1a32ad`):
  GET /_matrix/key/v2/server/:keyId returned an unsigned key document.
  Conduwuit-family servers fetch THIS form (they hold the key id from the
  Authorization header) and strictly require self-signed key responses —
  every federation call from matrix.0upti.me failed with "Unable to acquire
  your signing key". Synapse uses the unparameterized form (already signed),
  which is why only Conduwuit peers 401'd and joins silently succeeded via
  fallback servers. The response is now signed with the v2 key (legacy v1
  rows stay unsigned); our key doc's signature verified independently
  (canonical JSON + Ed25519, node). After the fix 0upti.me still 401s once —
  consistent with a negative key-cache on their side; expect self-healing.
  Outbound requests to 0upti.me should recover without action; joins already
  fall back to other residents.
- **room_summary resolves remote aliases live** (`0a942ab`, prod `b50d2f3c`):
  the MSC3266 summary endpoint used to only check the local alias table, so
  preview cards fed an alias 404'd. Remote aliases now go through the same
  federation /query/directory path the join flow uses. Verified live: the
  alias summary for #users:nixos.org serves "Nix / NixOS" with the real
  topic and member count.
- **The room toggles its join rules constantly** (anti-spam automation):
  public at 16:53, restricted by ~17:45, 13 join_rules events in the replay
  window. TODAY it is often RESTRICTED with an EMPTY allow list — new joins
  are refused by the residents themselves (M_FORBIDDEN from make_join), a
  room-side lockdown, not a bug. Retry later; ask in
  #moderation:nixos.org. Admin "Backfill State" anchors at the newest event
  authored by the chosen server — pick the server that authored the newest
  local event for the freshest state; anchor choice matters (a 16:42 anchor
  served pre-flip state).
- Live state refreshes ran twice (25 state events + ~9.6k members each,
  stored as invisible snapshots); room_state now matches the residents.

## Newly-joined rooms unnamed in running sessions (2026-11-20, session 7 end)
After joining Nix / NixOS and Jovian Experiments, both clients rendered the
rooms without names/avatars. Root cause (classic /sync): the join's state
snapshot is stored outside the timeline (negative stream positions — the
session-7 snapshot fix), so an INCREMENTAL sync relayed the user's join
event but never the room state; a running session saw "Unnamed Room" until
a full re-sync. Fix (`d52ae1a`, prod `85544662`): when the incremental
window contains the user's own join event, the room's state block carries
the full current state. Sliding sync was verified CORRECT already (live
probe with an Element-X-style request returned both rooms with name +
required_state) — stale Element X names are client session cache; restart
the app.

Adjacent fix: the admin Backfill State membership batch wrote ~4.9k
room_memberships rows with event_id='' (v3+ state PDUs carry no event_id).
The local user's own row was among them — and performSendEvent reads that
event id to build auth_events, so their messages would have carried '' as
an auth reference. The batch now derives wire IDs; the local rows were
repaired in-place (real join event ids).

Cleanup: the temp peek user @fedpeek5626 left the room and was
deactivated; @codebam:codebam.ca is the (repaired) resident member keeping
our server in Nix / NixOS.

## Fresh-login breakage: missing lazy loading + per-member queries (2026-11-20, session 8)
After "clear cache and reload", Element Web rendered all rooms but one as
"Empty room / Join the discussion". Two latent bugs, both exposed by the
user's first fresh initial sync in weeks:

- **lazy_load_members (MSC2732) was unimplemented** (`e99b98b`, prod
  `59e7c564`): Element Web requests it by default; we ignored it, so the
  initial sync shipped every member of every room (~770KB / ~2,200
  membership events for five rooms) — fresh logins on big-room accounts
  choked and half-rendered. With the filter, state carries only the user's
  own membership + timeline senders' (verified live: 74KB, names intact;
  clients fetch the rest via /members on demand).
- **/members ran one D1 query per member** (`b7583c5`, prod `4bc24e95`):
  4,000 members = 4,000 subrequests in one invocation → 500 (verified live
  on the nixos room). Lazy-loading clients hit this endpoint for every
  rendered room. Now a single room_state join with membership /
  not_membership filters applied in place (verified: 200, 1,320 joined
  members, ~475KB, <1s).

**Remedy for affected clients**: fresh login (or clear cache again) — the
initial sync is now 10× smaller and the member fetch works. Element X was
unaffected (sliding sync serves required_state efficiently).

Server-state verification baseline for this account (useful for future
debugging): initial /sync serves 5 joined rooms with own membership + names
(GNU/Linux, codebam_live/linux_chat ops room, Nix / NixOS, Jovian
Experiments, one small local room); sliding sync probe identical.

## Element Web "Empty room" + hung verification — full chain (2026-11-20, session 8 cont.)
Three stacked bugs, all found by replaying the client's EXACT requests:
- **MSC4222 state_after was misplaced** (2168d5b/932171b, prod 8f4fd5b8): our
  sync deleted the room's `state` section and emitted a room-LEVEL
  `state_after` key that is not in the schema. Element Web sends
  org.matrix.msc4222.use_state_after=true on EVERY sync, so it received
  stateless rooms and rendered them as "Empty room / Join the discussion"
  on every fresh login. Probes WITHOUT the flag looked perfect — the
  debugging trap that hid this for a whole session. state_after now rides
  under timeline.state_after (spec placement), lazy-filtered, and the
  classic state section survives. Verified live with the exact client
  request shape: all 5 rooms with own membership + names + state_after
  correctly placed.
- **Device/presence EDU fanout stalled key uploads** (79ba2fa, prod
  12552084): every POST /keys/upload queued m.device_list_update to every
  server sharing ANY room with the user, one sequential DO call each —
  joining a 4,000-member public channel added ~1,000 destinations, so
  uploads ran for minutes, clients aborted at 30s and retried forever, and
  the OTK branch (after the fanout) never executed. Live-observed: 8
  uploads, zero OTKs, SAS request/ready/accept then cancel with zero
  /keys/claim (no device could open an Olm session to the new login).
  Device-list EDUs now go ONLY to servers sharing an ENCRYPTED room (new
  getServersInEncryptedRoomsWithUser), parallel, capped at 100; presence
  fanout (all shared-room servers is spec-correct) is parallel + capped
  with per-destination warn. After deploy: the user's web device
  spontaneously completed its upload — 51 OTKs stored.
- Sequence for debugging E2EE/SAS hangs: check D1 one_time_keys for the
  device (sync counts read D1; claim reads KV otk:<user>:<device>), then
  tail for keys/upload completions ("--> ... 200" lines) — requests that
  arrive but never complete are client-canceled long-running invocations.

## FluffyChat Web sign-in crash (2026-11-20, session 9)
"TypeError: null: type 'minified:W6' is not a subtype of type String" at
fluffychat.im/web sign-in. Reproduced by driving the app in a browser with
HAR capture; console showed "Starting Matrix Native OIDC Flow..." then the
crash, right after POST /oauth/register returned 201.

Root cause (read from matrix-dart-sdk's msc_2966 registration parser):
OidcClientInformation.fromJson hard-casts json['client_uri'] to String. Our
registration response dropped the metadata URIs the client sent
(client_uri, logo_uri, tos_uri, policy_uri) — RFC 7591 §3.2.1 says the
response echoes registered metadata. Fixed in ee1e1b0 (prod d5e94d7d);
the response now echoes every metadata field we accept.

Adjacent OIDC completeness fixes shipped in the same session
(45092fd + ee1e1b0):
- auth_metadata now carries the full OIDC discovery field set
  (jwks_uri, subject_types_supported, id_token_signing_alg_values_supported
  = ES256, userinfo/introspection endpoints, claims).
- /oauth/token mints signed id_tokens (ES256, ECDSA P-256) for
  authorization_code exchanges with openid scope: iss/sub/aud/exp/iat/nonce
  + profile claims per granted scopes. Key is generated on first use and
  stored in server_keys as key_version 3 (a prod key was pre-seeded so the
  JWKS is live before the first token exchange).
- /.well-known/jwks.json served an EMPTY key set (self-described
  placeholder); it now publishes the ES256 public key (kty EC, P-256).
- Discovery/auth metadata advertise ONLY ES256 (previously claimed RS256 we
  cannot sign — strict clients could pick an algorithm we can't produce).
- id_token minting is best-effort: key failures log and the token exchange
  proceeds without the id_token.

Verification: browser-driven FluffyChat flow now reaches our
/oauth/authorize login form (username/password page). The remaining step —
submitting credentials and completing the code+PKCE exchange — needs the
user's password; if the dart SDK rejects the id_token at the final step,
check kid against the JWKS and the nonce pass-through first.

## Spec v1.18/v1.19 conformance wave (2026-11-20, session 10)

Brought the server from spec v1.17 to v1.19 conformance, plus the
v1.18/v1.19 deltas the earlier sessions had not yet covered. Full suite
green after the wave: 45,545/45,545 (349 files). Nothing deployed —
review before merge, per AGENTS.md.

- **Invite blocking (MSC4380)**: `m.invite_permission_config` gains the
  stable `default_action: "block"` toggle (glob rules keep precedence);
  errcode flattened to spec `M_INVITE_BLOCKED` on client invite,
  createRoom invite list, state-based invites and federation v1/v2
  invite; sync/sliding-sync now withhold invites on 'block' too, not
  just 'ignore', so invites that predate the toggle vanish.
- **Account lock/suspend (MSC4323)**: `GET/PUT
  /_matrix/client/v1/admin/{lock,suspend}/{userId}` with spec gate
  ordering (admin before lookup, 400 non-local, 404 unknown/deactivated,
  403 self/other-admin); requireAuth enforces `M_USER_LOCKED` 401
  soft_logout (logout exempt, sessions kept) and `M_USER_SUSPENDED` 403
  on the forbidden action set; suspended users may only redact their own
  events (refined inside performRedaction). `m.account_moderation`
  capability added for admins; /_synapse/admin user detail surfaces real
  lock/suspend state. Migration **025_account_moderation.sql** adds
  users.locked/suspended — HITL: ALTER TABLE, review before deploy.
- **Auto-forget on leave (MSC4267)**: `m.forget_forced_upon_leave`
  advertised enabled; /leave, kick, ban, unban and federation-inbound
  leave/ban for LOCAL users delete the membership row (guarded: only
  fresh, non-replayed events, local targets only).
- **Server ACLs**: new `src/services/server-acl.ts` (deny→allow order,
  port stripping, MSC4436 case-insensitivity, IP literals
  default-allowed). Enforced on inbound transactions (before DAG auth,
  recorded in processed_pdus), make_join templates, send_join
  authorization, federation invites, and the local send/state/redact
  cores (self-denial). Outbound destination filtering deliberately NOT
  done yet — follow-up if wanted.
- **Redactions via /send (MSC4169)**: m.room.redaction through
  PUT /rooms/:id/send routes into the shared performRedaction core
  (extracted from the /redact route; both entry points tested).
- **Reporting (MSC4277)**: score param gone (column kept, fixed -100);
  unknown/vanished subjects still 200 and stored, logged server-side.
- **Mutual rooms (MSC2666)**: stable `GET /_matrix/client/v1/mutual_rooms`
  with `count`/`joined`/`next_batch` cursor batching; unknown target is
  an empty 200, not 404.
- **`unsigned.replaces_state`** (spec v1.19): populated on state events
  via the state-write core (rides the existing `unsigned` column through
  every serializer).
- `/versions` now advertises v1.18/v1.19.

**HITL review list before merge/deploy** (per AGENTS.md):
`src/middleware/auth.ts` (locked/suspended enforcement + moderation state
in the token lookup), `src/services/database.ts` (getUserByTokenHash
joins users for locked/suspended — one query, no extra round trip),
`migrations/025_account_moderation.sql` (ALTER TABLE users).

**Deliberately left for a next session**: policy servers (MSC4284) —
new client+federation module, reference implementation is the
Foundation's policyserv; the biggest untouched v1.18 feature. Also
noted: outbound federation destination filtering by ACL.

## Follow-up wave: ACL destinations, redaction serving, policy servers (2026-11-20, session 11)

The three follow-ups recorded at the end of session 10, landed and
verified. Full suite green after the wave: 45,569/45,569 (351 files).

- **Outbound ACL destination filtering**: getJoinedRemoteServers now
  drops servers denied by the room's m.room.server_acl before any
  fanout — send/state/leave/kick/ban/unban/invite destinations all
  compute through it. (The one exception: invite fanout's explicit
  target-domain append happens before the filter in some paths —
  acceptable: invites are one-server pings, not room traffic.)
- **Serve-side redaction (closes the redacted_because follow-up)**:
  migration **027_redacted_content.sql** adds events.redacted_content.
  applyEventRedaction (new src/services/event-redaction.ts) computes
  the pruned client view per the room-version keep rules
  (computeRedactedContent in room-versions.ts), sets
  unsigned.redacted_because, and is applied BOTH locally
  (performRedaction) and on federation-inbound redactions (v11+ reads
  content.redacts, older versions the top-level field). Client-facing
  reads prefer redacted_content: legacy /sync, sliding sync (timeline,
  required_state, state_after), getEventsSince/getRoomEvents (so
  /messages), /context, /rooms/:id/event. The original `content` column
  is untouched — federation hashes/signatures stay valid over it.
  Known remainder: stripped-state invites and relation/thread listings
  still read raw content; redaction events themselves are not yet
  federated outbound from performRedaction (pre-existing).
- **Policy servers (MSC4284, spec v1.18) — the big module**:
  - src/services/policy-server.ts: config parsing (m.room.policy with
    `via` + `public_keys.ed25519`, empty state key only), the joined-
    member consent gate for `via`, signature verify/attach (always
    `ed25519:policy_server`), and the ask (POST /_matrix/policy/v1/sign
    via federationPost, 10s cap).
  - Send-side: performSendEvent and prepareAndStoreLocalEvent (so ALL
    local event shapes: messages, state, memberships, redactions) ask
    AFTER wire-ID derivation so the PS signs the final form; refusals
    fail the client request verbatim (index.ts onError now maps
    MatrixApiError → its status/errcode); returned signatures are
    verified against the room's pinned key before use; prepareOutboundPdu
    now MERGES foreign signatures so the countersignature rides the wire
    and stored form everywhere.
  - Receive-side: transaction PDUs in policy rooms validate the PS
    signature (spec check #7); missing/invalid ones are re-requested
    from the PS (key rotation redemption, persisted), and still-bad
    events are SOFT-FAILED: stored for DAG integrity, never notified to
    clients.
  - Policy server role: POST /_matrix/policy/v1/sign served under
    federation auth (permissive policy: known room + caller allowed by
    the room ACL; per-room rules can layer in without contract change);
    GET /.well-known/matrix/policy_server publishes the dedicated
    key (server_keys key_version 4, deliberately NOT the federation
    signing key).

Deploy order for this wave: migration 027 first, then wrangler deploy.

Live verification of the wave (prod, version f2875b21): redacted events
now serve `{}` content with unsigned.redacted_because over /event;
/.well-known/matrix/policy_server bootstraps and publishes the policy
key (server_keys key_version 4). Full self-hosted policy loop verified:
m.room.policy (via=codebam.ca + published key) → sends are
countersigned under `ed25519:policy_server` → wiping the content
disables it and sends flow unsigned again.

**Trap found live**: a Cloudflare route-worker cannot fetch its own
URL (edge self-invocation protection) — the first policy ask to
ourselves died before reaching the worker (no /sign in the tail).
Fixed by resolving asks where `via` is SERVER_NAME in-process (same
key, same policy as the /sign endpoint). If other servers ever become
policy servers for our rooms, the network path handles them.

**Observation, not a bug**: local-only rooms (v10 here, no remote
members) skip wire prep entirely — no hashes/federation signatures on
their events; only the policy countersignature appears. Signatures
materialize when there is someone to federate with.

## The 15-item gap ledger, closed (2026-11-21, session 12)

All fifteen items from the session-11 gap ledger, in dependency order.
Full suite after: 45,596/45,596 (355 files).

- **#1 PS asks outside the client cores**: RoomJoinWorkflow asks the
  room's policy server before send_join when the room's state is already
  known to us (re-joins); refusals fail the join instead of three doomed
  attempts. Fresh first-joins cannot know the remote room's policy state
  before sending — the resident's send_join rejection is the failure
  signal there, by protocol design.
- **#2 PS validation on non-transaction receive paths**: inbound joins
  (send_join v1+v2) and invites (v1+v2) refuse membership events without
  a valid PS countersignature (refused rather than soft-failed — a
  soft-failed join would corrupt membership views; a fresh signature is
  requested first for key rotation).
- **#3 ACL read guards**: backfill, state, state_ids, event,
  get_missing_events and hierarchy now refuse servers denied by the room's
  ACL; the v2 invite handler gained the ACL check the v1 one already had.
- **#4 local redaction events federate outbound**: performRedaction now
  queues the redaction PDU to the (ACL-filtered) destinations through the
  standard wire pipeline, so remote servers apply our redactions.
- **#5 backfilled redactions prune**: storeRemoteStateEvent (the state
  and timeline backfill choke point) applies inbound redactions from
  backfill responses, mirroring the live transaction path. (Noted in
  passing: FederationCatchupWorkflow's get_missing_events leg fetches but
  never stores — a pre-existing no-op stub, harmless.)
- **#6 remaining raw-content surfaces**: stripped invite state (legacy
  /sync and sliding sync) and the relations/threads listings now serve
  the pruned copy.
- **#7 moderation policy lists (the module)**:
  src/services/moderation-policy.ts parses m.policy.rule.{user,room,
  server} m.ban rules; enforcement at the invite/join/PDU gates per the
  spec's simple-implementation suggestions (banned users'/servers'
  invites refused, banned servers' PDUs refused ACL-style, banned rooms
  unjoinable, no outbound invites to banned entities). Subscriptions via
  POST/GET/DELETE /admin/api/policy-lists: a dedicated
  @moderation:<server> system user (unknowable random password) joins
  the policy room — local rooms directly, remote rooms via the join
  workflow (invite-only lists need an invite for the subscriber first).
  Migration **028_policy_lists.sql**. Rules cached 5min in CACHE,
  invalidated on subscription changes.
- **#8 M_USER_LIMIT_EXCEEDED** added to the error-code table (no emitter
  until quotas exist).
- **#9 /sign rate-limited**: new federationOriginRateLimit (per-calling-
  server buckets via the RateLimit DO; degrades open without the
  binding), 120/min on /_matrix/policy/v1/sign.
- **#10** — (was the permissive-PS policy note; unchanged, documented.)
- **#11 fed v1 send_join/send_leave**: kept deliberately for older
  peers, now with a comment saying so (spec removed them in v1.18).
- **#12 admin surfaces lock/suspend**: /admin/api/users and the user
  detail include locked/suspended; the dashboard status badge renders
  Locked/Suspended/Deactivated/Active.
- **#13 free-rider conformance round-trips**: image packs (user + room
  scope), m.recent_emoji, m.key_backup account data, and the MSC4268
  to-device transport leg (an m.room_key_bundle stores with its type and
  content intact) — test/spec-free-riders.test.ts.
- **#14 pipeline**: MSC4437 (whole-profile replace, FCP) implemented at
  the unstable prefix with replace semantics + tests; MSC4492 verified
  ALREADY conformant (tokens are plain stream positions —
  direction-reuse test added); MSC4582 (m.room_versions capability
  required) already satisfied. NOT implemented, recorded as the watch
  list: MSC4480 sticky events, MSC4075 MatrixRTC invites, MSC4388 secure
  OOB QR, MSC4576 LiveKit data gating, MSC4583/4584 — each needs its
  proposal studied properly; none are stable.
- **#15 real-crypto integration tests**:
  test/federation-real-crypto.test.ts drives requireFederationAuth with
  a REAL generated Ed25519 key and genuine X-Matrix headers through the
  real key-resolution chain (KV-served remote keys, no module mocks),
  then asserts the ACL read guards decide (403 denied / 200 allowed /
  401 tampered).

Watch list for v1.20: the six unimplemented pipeline MSCs above, plus
the catchup-workflow get_missing_events stub.

## Session 13: the protocol-conformance wave (2026-11-21, `24f9e8e`)

The gap analysis found four holes, each with a one-line cause: restricted
rooms broken in both directions (make_join emitted neither
`join_authorised_via_users_server` nor its auth event, and the inbound /
local-client join paths skipped allow-list + resident-server checks);
the EDU loop one-directional (inbound `m.typing`/`m.receipt` cases empty,
no outbound fan-out for either type); knocks invisible to clients (`/sync`
served no knock section and sliding sync neither listed knocked rooms nor
computed `knock_state`); pagination params missing (`/messages` lacked
`to` + `filter`, `/context` `before`/`after`, `/members` `at`, hierarchy
could not start from a cursor).

Five parallel hy4-flash subagents implemented the four groups; the lead
integrated and fixed 7 stale leftover assertions (residual knock rooms
stay listed per MSC4186) plus the knock-guidance 403 message punctuation.

- **Restricted rooms** (MSC3083/MSC3787, room v8+/v10+): fail-closed
  allow-list evaluation in src/services/restricted-joins.ts; make_join
  embeds `join_authorised_via_users_server` + its auth event
  (src/api/federation.ts), RoomJoinWorkflow preserves the template's
  authorisation content, authorizeInboundJoin enforces the resident-server
  rule, both local client join routes evaluate allow lists, and new
  POST /_matrix/federation/v1/refresh_room/:roomId is federation-auth +
  ACL-guarded with async state resync.
- **Ephemeral EDUs, bidirectional**: outbound m.typing/m.receipt fan-out
  in src/services/federation-edus.ts to ACL-filtered joined-member
  servers (m.read only, never m.read.private) via the Federation-DO
  send-edu path presence uses; the inbound cases now deliver to the
  Room DO so remote typing/read receipts display locally. No echo loop,
  best-effort per EDU.
- **Knock sync**: /sync serves the knock section; sliding sync includes
  knocked rooms with knock_state (spec stripped-state list + the user's
  own knock member event, redaction-pruned content); long-poll change
  detection includes knocks.
- **Pagination conformance**: /messages gains to + filter (types/not_types
  wildcards, rooms, senders, contains_url; invalid JSON = M_BAD_JSON);
  /context gains before/after; /members gains at (point-in-time via
  stream_ordering, no migration); hierarchy from cursor works on both
  client and federation routes.
- **Known minor deviations (left open)**: inbound receipts store local ts
  rather than forwarding the remote ts; m.signing_key_update remains a
  no-op stub.

Full suite after: 45,653/45,653 (360 files).

### Deploy state
- prod: **deployed `24f9e8e`** — Current Version ID
  `060d544d-a7fe-4895-bbe0-b9b974f93c0e`.
- dev (`wrangler.dev.jsonc`): **deployed at the same commit** — Current
  Version ID `963def86-d69a-4a95-b04b-1db5926d8d9b`.

Pair verification (2026-11-21, dev migrations approved and applied):
the new `refresh_room` route answers 401 M_UNAUTHORIZED on both
codebam.ca and dev.codebam.ca (the old code 404s it). Dev's D1 had
drifted four migrations behind prod (025-028: account_moderation,
redacted_because, redacted_content, policy_lists), which 500'd every
authenticated dev client path on `no such column: u.locked`; with the
user's approval they were applied and the pair agent then ran the
full restricted-room round-trip, ALL GREEN:

- Resident `@fedtest:dev.codebam.ca` created a public allow room
  (`!R-0y_Ii…:dev.codebam.ca`) and two v10 rooms, `restricted` and
  `knock_restricted`, whose allow lists name the allow room via dev.
- **Restricted**: the joiner got the fail-closed 403 ("You are not a
  member of any room allowed by this room's join rule") BEFORE joining
  the allow room; after joining it, the restricted join returned 200
  and the resident's member state reads `membership=join` with
  `join_authorised_via_users_server=@fedtest:dev.codebam.ca`; the
  joiner's /sync lists both rooms.
- **knock_restricted**: same flow, with the knock-guidance 403 message
  before the allow-room join, then a 200 join carrying the authorising
  user.
- Worker tail during the run: zero errors.

Caveats: the two joiner accounts hold randomly generated, unretained
passwords — inspect the rooms via @fedtest in Element instead. Ops
notes: the /tmp fed-repro scripts insert PROD tokens directly into D1
— not safe to run as-is; and trust live probes over this doc's older
top-level Deploy state section, which records historical version IDs
only.
