// How long the mixer's handover between two items takes — as far as the
// CONTROLLER can know, which is not very far.
//
// The real value is decided per track in radio.liq by autocue, measured from
// the audio at resolution time, and the controller never sees it. Until the
// handover became autocue's this was a station setting (the crossfade) that
// every one of the readers below could simply look up. What they get now is a
// bound, and each reader picks the bound that fails in its safe direction.
//
// Where these come from, so nobody re-derives them:
//   * autocue never overlaps two tracks by more than
//     `settings.autocue.internal.max_overlap` — 6.0s on Liquidsoap 2.4.5.
//   * An item autocue does not measure (a show-boundary cut, a bed, the
//     pause-talk silence) falls back to radio.liq's explicit
//     `crossfade(duration=5., fade_in=3., fade_out=3.)`.

// Upper bound on any handover. For readers that must not COLLIDE with the
// seam — holding speech until a jingle has cleared, budgeting the silence a
// pause-talk break speaks into. Over-estimating costs a little extra silence or
// a later link, which is the recoverable direction.
export const MIXER_SEAM_MAX_SEC = 6;

// A typical handover. For readers that PLACE something relative to the seam,
// where over-estimating is audible: the DJ link over a bed is held for the
// predecessor's exit, and holding it for the full bound would put seconds of
// bare bed on air after every track that stops dead (autocue's most common
// answer for a cold ending is no overlap at all). The fallback fade length.
export const MIXER_SEAM_TYPICAL_SEC = 3;
