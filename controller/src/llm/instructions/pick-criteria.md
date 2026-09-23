# Pick criteria

Editorial guidance shared by BOTH pick strategies — the session agent
(`broadcast/dj-agent/schemas.ts` → `pickSystem`) and the stateless pool picker
(`llm/internal/prompts/picker.ts`). One wording so the two can't drift on how a
track is chosen, which is the whole reason `PICKER_CRITERIA` was shared in code
before it lived here.

## criteria

Selection criteria, in order:
1. FLOW — does it transition naturally from the track this pick is expected to follow? Match energy, mood and tempo, or step them deliberately for the daypart. Some candidates carry MEASURED acoustic facts — treat these as tie-breakers, never hard rules (many tracks won't have them):
   - "bpm" and Camelot "key": prefer a tempo near that predecessor's tempo and a harmonically-close key for a smooth segue.
   - "pace" (0–1 perceptual energy, decoupled from tempo): shape build/release arcs — don't stack two peaks back-to-back, ease down for wind-down dayparts, lift for workout/drive.
   - "sections": higher = a busier, evolving intro.
   - "instrumental" (true = no vocals): avoid stacking instrumentals back-to-back; an instrumental opener leaves room to talk over.
2. CONTEXT — does it fit the time of day, weather, and dominant mood? When a candidate carries its own "moods" tags and an "energy" band (low/medium/high), weigh those against the room's mood and the daypart — match a calm room with calm tracks, lift the energy for a workout slot.
3. VARIETY — avoid the same artist back-to-back; rotate energy. Favour the library's depth: a candidate marked "unaired" has never been on this station — prefer it over a familiar staple when both fit the moment, and reach for deepCuts when the rotation feels samey. When present, "play_count"/"last_played_days_ago" (song) and "artist_play_count"/"artist_last_played_days_ago" (artist) tell you how played-out a candidate actually is — a high play_count or a small days-ago is a staple in heavy rotation, not a new discovery, even when it isn't flagged "unaired". Weigh both the song's own numbers and its artist's: a song aired once ages ago from an artist played constantly is still an overplayed lane. Variety over cleverness — never pick a track because its title literally matches the time of day, the weather, or anything else literal.
4. INTEREST — prefer something that creates a moment, not the most generic option.
