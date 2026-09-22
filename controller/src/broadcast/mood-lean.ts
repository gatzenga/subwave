// The room's mood, as a clause on the pick EVENT turn.
//
// Two separate faults, one clause.
//
// REACH — context.ts resolves a dominantMood every pick, but on the agent path
// it only ever reached the model at a daypart TURNOVER: session.ts writes one
// scenario line and the block then runs for hours. By the tenth pick that line
// is ambience at the top of a window holding forty of the model's own prior
// picks, so the chain follows whatever is playing rather than the hour. The
// clause therefore rides the event turn, the same place and for the same
// reason the listener-favourites clause does — the freshest instruction in the
// window is the one the model follows.
//
// EXPRESSION — the obvious fix, naming the mood and pointing at tracksByMood,
// is bounded by how many tracks carry the TAG, and the tagger is asked how a
// track FEELS, so a vocabulary entry that names a time of day rather than a
// feeling ("morning", "evening", "night") is one an LLM almost never returns.
// A station can therefore hold 15,000 tracks and 30 tagged `morning`, and a
// steer that hard-points at that shelf rotates it to death before noon.
//
// So the clause carries the mood's CLAP prompt — the operator-editable sound
// description in settings.moods[].clapPrompt — and points at searchBySound,
// which embeds that text through CLAP's text tower and matches it against the
// stored audio vectors. Same technique the audio-mood scorer uses, and the
// prompts are already written in its register ("high-energy, upbeat, powerful
// music with a strong driving beat"). The shelf stops being the tagged subset
// and becomes every analysed track, so the steer can bite without repeating.
//
// It is still not a LOCK: that exists separately and stays narrow (a STRICT
// show with pinned moods gets a code-enforced moodLock in pickViaAgent), and
// this clause stands down entirely for such a show rather than arguing with it.

/**
 * @param mood         the resolved dominantMood, or null/blank for none
 * @param soundPrompt  that mood's CLAP sound description (settings.moodPromptFor)
 * @param showPinsMoods  the active show names its own moods — operator intent
 *                       already steers, and a strict show turns it into a lock
 * @param canSearchBySound  the searchBySound tool is registered for this run
 *                          (audio vectors exist AND the analysis backend can
 *                          embed text). Pointing at a tool the run does not
 *                          carry spends the model's single discovery round on
 *                          a call that cannot resolve.
 */
export function moodLeanClause(
  mood: string | null | undefined,
  soundPrompt: string | null | undefined,
  showPinsMoods: boolean,
  canSearchBySound: boolean,
): string {
  const name = String(mood || '').trim();
  if (!name) return '';
  if (showPinsMoods) return '';

  // Falls back to the bare mood word, which is what moodPromptFor itself
  // returns for a mood whose description an operator has cleared. A one-word
  // CLAP query is weak but not wrong, and it still beats saying nothing.
  const sound = String(soundPrompt || '').trim() || name;

  const open = ` The hour's mood is "${name}" — what plays now should feel like: ${sound}.`;
  return canSearchBySound
    ? `${open} Call searchBySound with that description in your discovery round and weigh what it returns above the rest;`
      + ` it matches the actual audio, so it reaches tracks no mood tag covers.`
      + ` Judge every other candidate against the same feel, and step outside it only when nothing can follow this track.`
    : `${open} Judge your candidates against that feel, and step outside it only when nothing can follow this track.`;
}
