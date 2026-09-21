// The pick and request output schemas, and the system prompts that go with
// them. The schema comments are load-bearing - read them before changing a
// field's nullability.
//
// Part of the dj-agent/ split - see ../dj-agent.ts for the pick/request runs.

import { z } from 'zod';
import * as settings from '../../settings.js';
import * as session from '../session.js';
import * as dj from '../../llm/dj.js';
import { modelTolerant } from '../../llm/sdk.js';
import { SEED_NOT_A_PICK_CLAUSE } from '../../util/pick-seed.js';
import { instruction } from '../../llm/dj.js';

// Plain .nullable() fields, deliberately — GLM's malformed spellings of
// "nothing" (the string "null", an omitted key, a double-JSON-encoded object)
// are repaired by the modelTolerant wrapper in pickSchema() below, at the
// OBJECT level. Do not wrap individual fields in a preprocess: a per-field
// pipe drops that field from the tool inputSchema's `required` array (the AI
// SDK renders Zod with io:'input'), which invites every provider to omit it —
// see modelTolerant's comment in core/pure.ts.
export const PICK_SCHEMA = z.object({
  // The seed clause is NOT decoration (#1247): "never invent or compose ids" is
  // literally satisfied by the on-air track's id, which the pick event message
  // hands over precisely so the model can seed the discovery tools with it — so
  // a model cornered into committing with an empty tool result answered with it,
  // the run was discarded, and the slot fell to the pool picker. One shared
  // wording, in util/pick-seed.ts; don't inline a second copy here.
  id: z.string().describe(`the exact song id returned by one of the discovery tools — never invent or compose ids. ${SEED_NOT_A_PICK_CLAUSE}`),
  reason: z.string().describe('internal scratchpad only — max 12 words, never shown to the listener; do not justify, just note what makes THIS pick a fresh step (a shift in energy/era/texture, or an artist genuinely new to the rotation), not a vibe label you would recycle pick after pick (e.g. "warmer, driving energy", never a repeated "mellow reflective step"). Only call a pick a "new artist" when it has no "artist_play_count"/"artist_last_played_days_ago"; "unaired" means this song is new to the station, not that its artist is. If the artist shows recent or frequent plays, describe the real reason instead (energy shift, texture, flow)'),
  // Transition effects (only honoured when the system prompt offers them — persona djMode, see settings.effectsActive).
  // One-line pointer only: the full coaching is dj.effectsGuidance() in the
  // system prompt. This description used to repeat all of it, so every agent
  // pick carried the effects text TWICE (~500 wasted tokens per call).
  transition: z.enum(['normal', 'blend', 'sweep', 'washout', 'dissolve', 'chop', 'loop']).nullable().describe('transition treatment per the TRANSITION EFFECTS guidance: "washout"/"loop" end THIS pick (loop needs measured tempo), "sweep"/"dissolve"/"chop" carry the previous track across a clash (chop only out of beat-driven material), "blend" only for an exceptionally locked pair; "normal" or null for a plain crossfade'),
});

// Same shape, transition coaching stripped. Zod field descriptions travel to
// the model as part of the structured-output contract even when every prompt
// mention is gated off, so with DJ mode off the description above kept talking
// the model into "blend"/"sweep" picks that runTrackEvent silently discarded —
// the LLM log showed effects that could never air. The enum stays identical
// (validation must not depend on persona state); only the description flips.
export const PICK_SCHEMA_NO_FX = PICK_SCHEMA.extend({
  transition: z.enum(['normal', 'blend', 'sweep', 'washout', 'dissolve', 'chop', 'loop']).nullable().describe('always set to null — transition effects are not available for this persona'),
});

// The picker response deliberately contains no listener-facing speech. The
// selected song crosses into generateLink only after the tool run is complete,
// so selection context cannot become DJ copy. Keep this wrapper because
// constrained re-picks extend the plain schema before tolerance is applied.
export function pickSchemaBase() {
  return settings.effectsActive() ? PICK_SCHEMA : PICK_SCHEMA_NO_FX;
}

export function pickSchema() {
  // modelTolerant repairs GLM's malformed nullable spellings ("null"-the-
  // string, an omitted key) at the object level, on every parse path (done-
  // tool args, text salvage) — the wire schema stays identical to the plain
  // object's, all fields still required. See core/pure.ts.
  return modelTolerant(pickSchemaBase());
}

// Ultra-minimal — persona + editorial criteria, nothing else. The AI SDK already
// conveys the rest through its own channels: tool descriptions, the done-tool
// description, schema field descriptions, and the per-pick event message in the
// session window. Duplicating those in prompt text competes with the framework's
// structural signals and derails smaller models. PICKER_CRITERIA stays because
// editorial preference (flow, context, variety, interest) is in no tool or
// schema.
//
// The transition-effects guidance lives in prompts/picker.ts (dj.effectsGuidance)
// so the pool picker shares it verbatim, and is appended ONLY when effects are
// active (settings.effectsActive — there is no separate toggle). Invisible
// otherwise, so the model leaves "transition" null.

// `showAt` — resolve the show brief/leans for that future moment instead of
// now: the pick airs when the current track ends, so near a show boundary the
// INCOMING show's rules are the ones to follow (see the look-ahead in
// queue.onTrackStarted). The persona now comes from the session, which the
// same look-ahead has already rolled — the mic-pass aired ahead of this pick,
// so the incoming DJ introduces their own opener rather than the outgoing DJ
// teeing up a show they've already signed off from.
export function pickSystem(showAt: Date | null = null, playlistResolved = true) {
  const persona = session.onAirPersona();
  // In DJ mode, lean on the live session history: a working DJ runs threads
  // and calls back to a track or a remark from earlier in the shift. This pairs
  // with the cross-hour memory in broadcast/session.ts, which now keeps that
  // history alive across daypart turnovers.
  const djModeLine = persona?.djMode
    ? `\n\n${instruction('picker', 'dj-mode')}`
    : '';
  // The show topic must live in the system prompt, not only in the session-
  // opening message: the session window (~40 turns) scrolls past the opener
  // within the first hour, after which the picker would lose every show
  // constraint mid-show and revert to generic picks.
  const activeShow = settings.resolveActiveShow(showAt ?? undefined);
  const showLine = activeShow?.topic
    ? `\n\n${instruction('picker', 'show-brief', { topic: activeShow.topic })}`
    : '';
  // The same mood/genre/decade/energy steer the pool picker applies — the agent
  // already owns songsByGenre + tracksByMood(energy) tools, so this line is
  // enough to make it reach for them. showMusicLean reflects the show's
  // filtersStrict here too: a strict show gets a hard "stay within" rule
  // instead of soft leans, so both pick paths honour strict the same way. Lives
  // in the system prompt for the same session-window reason as the show brief.
  const musicLean = dj.showMusicLean(activeShow);
  // Playlist anchor: a separate steer from genre/era. Strict → every pick MUST
  // come from the pinned playlist (the tools already enforce this in code, but
  // saying so keeps the agent reaching for showPlaylistTracks instead of
  // burning steps on tools that come back empty); soft → strong preference,
  // occasional steps outside allowed for flow. Gated on playlistResolved: when
  // the show pins playlists but none resolved (stale ids / Navidrome error),
  // the showPlaylistTracks tool is NOT registered — telling the model to call
  // a tool that doesn't exist burns steps and invites fabrication.
  const playlistLean = activeShow?.playlistIds?.length && playlistResolved
    ? `\n\n${instruction('picker', activeShow.playlistStrict ? 'playlist-strict' : 'playlist-soft')}`
    : '';
  // Listener favourites (#991) deliberately do NOT render here: the list
  // changes as likes land, and re-rendering it inside the system prompt broke
  // the byte-stable prefix automatic prompt caching keys on. They ride the
  // pick event turn instead (dj-agent.ts runTrackEvent favClause).
  // The "Finding candidates" paragraph teaches the harness's REAL contract, so
  // it has to follow the provider's discovery budget rather than assert a fixed
  // number. On a forced-tool provider that budget is one round, and the
  // single-round wording is load-bearing: sequential advice ("if a tool returns
  // nothing, switch tools") is unfollowable there and corners the model at the
  // forced commit. Where the budget is wider the opposite is true — telling a
  // model with three rounds that it has one wastes the exploration the wider
  // budget was for. promptDiscoverySteps() takes the MINIMUM across the legs
  // that could run, because this prompt is built before failover picks one and
  // over-promising is the more expensive way to be wrong.
  const rounds = dj.promptDiscoverySteps();
  const findingCandidates = rounds > 1
    ? instruction('picker', 'finding-candidates-multi', { rounds })
    : instruction('picker', 'finding-candidates');
  return `${settings.agentPersonaPreamble(persona)}

${instruction('picker', 'frame')}${djModeLine}${showLine}${musicLean}${playlistLean}

${dj.PICKER_CRITERIA}

${findingCandidates}${dj.effectsGuidance()}`;
}
