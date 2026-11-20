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
