# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

SUB/WAVE, cut down to one operator's station: **one container**, one
`docker-compose.yml`, built locally and uploaded to a UGREEN NAS. An AI DJ
picks tracks and reads scripts between them.

This is a fork. Large parts of the upstream project have been deliberately
removed — see "What is gone" below before assuming a feature exists.

## Layout

| Path | What |
| --- | --- |
| `controller/src/**` | Express + ESM Node. The AI DJ: picking, speech, scheduling, library |
| `liquidsoap/radio.liq` | the mixer: queue → auto playlist → autocue crossfade → dead-air guard → ducking → limiter → outputs |
| `web/**` | Next.js 15 App Router + Tailwind. Listener player (swappable skins) + admin console |
| `docker/Dockerfile.aio` | the only image — everything above plus icecast2, Piper, Kokoro, the analyzer, Caddy |
| `docker/aio/supervisor.sh` | boots and supervises all five processes inside that container |
| `docker/aio/Caddyfile` | the loopback edge on :80 |
| `build-x86.sh` / `build-arm.sh` | build the image, save a tarball to the Desktop |

Scoped notes, which are the real engineering memory — read the matching one
before changing that area:

- [`controller/CLAUDE.md`](controller/CLAUDE.md) — module by module
- [`liquidsoap/CLAUDE.md`](liquidsoap/CLAUDE.md) — pipeline order and every radio.liq rule
- [`web/CLAUDE.md`](web/CLAUDE.md) — routes, skin contract, API defaults

## Commands

```bash
npm run lint     # controller + web: eslint && tsc --noEmit  — the merge gate
npm test         # controller only; scripts/*.test.ts, auto-discovered
npm run gen:schemas
```

`npm test` pins `--test-concurrency=1` — the files share a temp state dir, the
library DB and env vars. Dropping a `*.test.ts` into `controller/scripts/` is
the whole registration step; `npm test -- <substring>` filters.

Four tests fail on macOS for environment reasons, not code: `aio-log-link`,
`analyzer-python`, `state-bootstrap`, and one case in `state-tree`. They drive
Linux shell scripts and a Python venv.

Building and running is in `build-x86.sh` / `build-arm.sh`. There is no dev
compose and no hot reload: production images `COPY` source at build time, so
every change means a rebuild.

## Architecture

Four cooperating processes inside one container, with **file-based IPC**
through `/var/sub-wave`. There is no socket or RPC between the controller and
Liquidsoap. This is the load-bearing fact about how the system works.

**Controller → Liquidsoap** (Liquidsoap polls; the controller only writes):

| File | Poll | Purpose |
| --- | --- | --- |
| `next.txt` | 1.0s | one annotated track URI, drained into `request.queue.push` |
| `jingle-now.txt` | 0.5s | one jingle URI, drained at the next safe boundary |
| `say.txt` | 0.5s | WAV path → `voice_queue`, **heavy-ducked** (`ducking.voice`, default 0.22) |
| `intro.txt` | 0.5s | between-track links → `intro_queue`, **light-ducked** (`ducking.intro`, default 0.30) |
| `auto.m3u` | watch | fallback playlist, rewritten every `AUTO_QUEUE_REFRESH_MINUTES` |
| `liquidsoap_*.txt` | startup | ducking, per-codec enable/bitrate, HLS — **read once**, changes need a mixer restart |

**Liquidsoap → Controller** — marker files written from `on_metadata` hooks:
`now-playing.json`, `jingle-playing.json`, `bed-playing.json`,
`pause-talk-*.json`, `voice-playing.json`, `music-starved.json`. Each exists
because the controller cannot otherwise observe that moment; the reasons are in
[`liquidsoap/CLAUDE.md`](liquidsoap/CLAUDE.md).

**Controller → Web**: HTTP. `useStationFeed` polls `/now-playing` + `/state`
every 5s.

## Streams

**HLS is the default transport** — `output.file.hls` writes AAC segments into
`state/hls/`, and Caddy serves that directory as static files at
`/hls/live.m3u8`. That is a MASTER playlist over four fixed rungs (320, 256,
192, 128 kbps); the client measures its own download rate per segment and steps
between them. The ladder is deliberately not configurable — adaptive bitrate is
the feature, and one rung is not a ladder. 4s × 5 segments ≈ 20s behind the
live edge, deliberately close to `stream.bufferSeconds` so both transports are
in step.

**Icecast stays up alongside it and is load-bearing beyond compatibility.**
`/stream.mp3` is the universal floor (Sonos, hardware radios, car receivers).
Do not treat it as legacy. `/stream.aac` is always served too — it has no off switch, and
`load()` forces `stream.aacEnabled` true.

**The listener count has TWO LEGS and one number.** Icecast contributes sockets;
HLS contributes listeners who hold no socket at all, counted from the edge's
playlist access log. `broadcast/listeners.ts` owns the Icecast leg and the
combination; `broadcast/hls-listeners.ts` owns the HLS leg. Everything downstream —
`llm.pauseWhenEmpty`, the DJ gates, `presentListeners()` and therefore every
Last.fm scrobble, the sparkline, the admin audience table — reads the combined
figure. An HLS listener leaves exactly one trace: a playing client re-fetches
the MEDIA playlist about once per segment, so `docker/aio/Caddyfile` routes
`*.m3u8` (never segments) into `hls-access.log` and the controller reads its
tail. The two legs are combined by **two functions with opposite failure
directions, which must never be unified**: `combineCounts` (fail CLOSED — an
unreadable leg contributes nothing, two unknowns stay unknown) feeds the
presence check and every display, `combineGatedCounts` (fail OPEN — ANY
unreadable leg makes the figure unknown) feeds `djCallsAllowed` and the analysis
quiet gate. HLS switched off reports a measured 0, not unknown.

The **stream idle gate is still gone** — the admin card and the monitor both. It
froze the programme mid-track after N empty minutes, nothing can clear a stored
`stream.idleWhenEmpty: true` any more, and a gate that stops the programme on a
count is a worse trade than one that only stops LLM spend. `radio.liq` keeps the
gate and its telnet commands (`idle_on`/`idle_off`); nothing asks for them.

The web player still requests `/stream.mp3`, not HLS. Chrome and Firefox need
hls.js for the HLS URL; Safari and iOS can play it natively.

## Invariants

These are expensive to rediscover. The upstream `docs/internals/` files that
explained them at length are gone, so what matters is here.

### Structure

- **One writer per file.** `queue.drainToLiquidsoap()` is the only writer of
  `next.txt`; `queue.playJingle()` of `jingle-now.txt`; `queue.announce()` of
  scheduled `say.txt`/`intro.txt`; `queue.onSpoken()` is the only place post-air
  bookkeeping happens. Poll intervals bound perceived latency.
- **A pushed track is "handed over", never "playable".** `item.sent` only means
  the URI reached `next.txt`. Liquidsoap silently drops what it cannot resolve.
  Never infer resolution from `dj_queue.queue()` membership.
- **Policy lives in its own module, never inlined at the call site.**
  `voice-policy`, `clock-policy`, `dj-budget`, `banter-policy`,
  `talk-scheduler`, `handover-policy`, `drain-policy`, `skip-policy`,
  `util/request-guard`, `artist-guard`, `blocklist-rules`, `silence-trim`,
  `vocal-runway`, `listener-country`. Each exists because the same decision is
  reached from several call sites and drifted when duplicated. Adding a second
  copy of one of these checks is the bug.
- **A gate's failure direction is a deliberate design choice — never "unify"
  two of them.** `POST /listener-auth` fails OPEN, `POST /station-auth` fails
  CLOSED, the listener-count gates fail OPEN while `presentListeners()` fails
  CLOSED. Same for validation posture: `validate*Strict` throws, `normalize*`
  repairs-or-drops.
- **A validated shape is defined once** in `controller/src/schemas/<feature>.ts`
  and mirrored to `web/lib/schemas.generated.ts` by `npm run gen:schemas` (CI
  diffs it). Files under `src/schemas/` may import **only zod** — the mirror is
  one flat concatenation compiled in the browser build. Never hand-edit it.
- **State bootstrap is never fatal.** A station that refuses to boot over a
  permission convenience is strictly worse than one on a degraded mount.

### Timing

- **Every timestamp the controller publishes is stamped at the live edge**, but
  every listener sits `stream.bufferSeconds` behind it. Listener-facing surfaces
  add the offset; operator surfaces keep live edge. `<burst-size>` is a **byte**
  count, computed per mount — never collapse it to one figure.
- **A talk slot is a window, not an instant.** Every row in the talk table opens
  a window and fires the first clear minute inside it; a held row **postpones,
  never cancels**.
- **Every scheduled spoken segment is a row in one slot table, driven by one
  per-minute cron** (`broadcast/talk-scheduler.ts`, `scheduler.talkTick`). One
  talker per minute is a rule in that planner, not a property of four cron
  strings. Adding a second talk cron is the bug. `slot` rows yield only to a
  FIRING row; `fill` rows stand down for any slot row that wants the minute.
- **A rendered segment is placed, not trimmed.** The lever at a boundary is
  WHICH boundary, not how many words.
- **A spoken clock is a forecast, not a reading.** A link is written when the
  pick is made and airs when the pick starts.
- **A dead-air guard that waits before firing is a guard that doesn't fire.**
  Fire immediately, ramp the level.
- **Degrading must be silent and immediate, not a timeout.** Unmeasured values
  are reported `estimated: true` with timestamps **absent, not zeroed**.

### Audio

All of `radio.liq`'s rules, with the measured numbers, are in
[`liquidsoap/CLAUDE.md`](liquidsoap/CLAUDE.md). The three most easily broken:

- **The handover is autocue's, and only autocue's.** Liquidsoap measures every
  song at resolution and the stdlib `crossfade` reads that. Never stamp
  `liq_cross_duration`, `liq_amplify`, `liq_cue_in`/`liq_cue_out` or `liq_fade_*`
  on a song: any cue/fade override switches autocue off for that track. The one
  deliberate exception is a show-boundary cut. Everything that is not a song
  (voice, sfx, pause-talk silence) carries `liq_disable_autocue`.
- **Tempo, key, vocals and moods are for SELECTION only.** The analysis decides
  which track comes next, never how the seam sounds.
- **Stick with `smooth_add` for ducking.** An RMS sidechain follower drove
  `music_bus` to silence. `p` is the fraction of music LEFT UP, so smaller is
  deeper.

### Library and picker

- **Write `genres`, never `genre`** — the scalar column is GENERATED from
  `genres[0]`. `subsonic.songGenres()` is the single ingest normaliser.
- **Judge era by `show-filter.resolveEraYear`, never raw `year`** — a reissue's
  own release date is untrusted. Pass `yearUntrusted`, never raw
  `isCompilation`.
- **Measure dead air against an ABSOLUTE floor, never a relative one.**
  `music/silence-trim.ts` owns the controller's ESTIMATE of it and the onset
  shift; every timestamp the analyzer measured from byte zero resolves through
  it. Nothing it computes reaches the mixer — autocue trims on air.
- **Library coverage never counts on the read path.** `coverage.get()` only
  reports the last count. The walk belongs to `refresh()`.
- **Use `getAnnotatedUri` for anything going to Liquidsoap** — raw URLs lose
  metadata and `on_metadata` needs `subsonic_id`.
- **The tagger's own `moods`/`energy` must never enter the embed text.** Phases
  run enrich → embed → seed → propagate; feeding them back is circular.
- **Bump `TAGGER_CONTRACT_VERSION`** when you change what the tagger prompt asks
  for. Forget it and Re-decide re-tags nothing.
- **CLAP cosines are not comparable across moods** — calibrate per mood.
- **Enforce variety at the point of choice, not in the discovery tools.**
- **The track-length CAP and the FLOOR are both SELECTION filters and nothing
  else**, applied as one window by `music/track-window.ts` on every pick path
  and on `auto.m3u`. A track on air is never cut short for its length. A
  never-starve filter must never return its input array, and it relaxes BOTH
  ends together.
- **The blocklist is absolute** — no never-starve anywhere. Every name tier keys
  through ONE fold (`recency.nameKey`). Never key a tier through a local
  normaliser.
- **LLM calls go through the `llm/sdk.js` primitives**; per-provider quirks live
  only in `llm/internal/provider/capabilities.ts`. The default provider is a
  homelab Ollama box — reliable but slow, so **don't add aggressive retry**.
- **TTS callers go through `tts.speak(text, {kind})`**, never an engine module.

### Product behaviour

- **The station must keep making sound.** Music never stops for a budget, a
  muted voice switch or an LLM outage.
- **Manual operator triggers are exempt from every automatic gate.**
- **`requestedBy` says which EXEMPTIONS a track gets, never who is waiting.**
  Three air-path behaviours key off its truthiness (bed reason, show-boundary
  cut, the seam a pause-talk break would take); a studio push sets `'studio'`
  to earn all three.
- **Absent or malformed settings must coerce to the pre-existing behaviour**, so
  an upgrade is byte-identical.
- **Operator curation outranks listener signal.**

## What is gone

Do not reintroduce these, and do not assume their code still exists:

- **MCP server** and the `mcp-subwave` package
- **Webhooks** — and `voice-events.ts`, which existed only to fire them
- **Library Observatory** and the UMAP sound-map projection
- **Listener requests** — `POST /request`, the request agent, the request log,
  the request guard, the player's request UI, `settings.requests`
- **Imaging UI** — jingles, SFX, beds and the voice-clone library still have
  controller routes and air-path plumbing, but no admin page. `jingleRatio`
  defaults to 0 and `sfx.enabled` to false.
- **Shows admin pages** — the Shows feature itself is intact and wired through
  the picker, context, session and scheduler. Only the editor and schedule board
  are gone; the shared modules under `web/components/admin/shows/` remain
  because Dash, block rules, skills and playlists read them.
- **TTS engines** other than Piper and Kokoro — no Chatterbox, PocketTTS, cloud
  or remote
- **LLM providers** other than Ollama, OpenAI-compatible, OpenRouter, Anthropic,
  OpenAI, Google
- **ListenBrainz scrobbling** — Last.fm and Navidrome remain
- **The split-container stack**, the CLI, the Expo app, the marketing web pages,
  multi-station (the switcher, `/admin/stations` and the `/stations` route —
  only the boot-time read of the active station remains), the tts-heavy sidecar
- **The DJ Brain settings section** and the "Extended Sleeve Notes" placeholder
- **Skins** other than Classic, Drift and Platter (Unit SW-9, Subamp, TTY are
  gone), and the Blueprint, Recon, Cyberpunk and Flare themes
- **Show-only admin controls** — Show changes, Pause-and-talk, Show boundaries
  and the dash Takeover card. The settings and air paths behind them remain,
  as with the Shows feature itself; only the controls are gone
- **The first-run wizard** (`/onboarding`). Navidrome, the LLM and the voice
  are set in Settings; `needsSetup` only drives the boot banner and the
  Navidrome banner now. `POST /onboarding/generate-jingles` survives for the
  Doctor panel
- **Admin controls for** the TTS fallback voice, the Public API switch and
  listener-country geography (their settings keep their stored values), and
  every "Read this in the manual" link — there is no manual route
- **Every transition of our own** — the crossfade setting, the DJ transition
  effects (sweep/washout/blend/dissolve/chop/loop), pair-aware drain, stem
  blends and the stem cache, the loudness card and the dead-air-trim setting.
  autocue does the handover, the trim and the levelling; the drain is eager
