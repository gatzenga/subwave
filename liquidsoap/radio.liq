# SUB/WAVE — Liquidsoap broadcast script
# Plays track URIs the controller drops into next.txt, crossfades them, ducks
# the DJ voice over them, and falls back to an autonomous playlist.

settings.log.level := 3
settings.log.file := true
settings.log.file.path := "/var/log/liquidsoap/radio.log"

# AUTOCUE — the transition, measured from the audio instead of guessed from the
# metadata. Liquidsoap analyses every resolved file and attaches where it really
# starts and stops making sound, its fades, and `start_next`: the moment the
# next track should begin. A track that ends on a hard beat hands over with NO
# overlap; one that rings out hands over inside its own decay. That single
# measurement replaces what four of our own systems used to argue about, and it
# is the reason a hip-hop pair with a cold stop and a cold start no longer
# collides for several seconds.
#
# Loudness comes from the same pass: autocue's default amplify_behavior is
# "override", so the gain it measures is the one `amplify(override=
# "liq_amplify")` applies further down. One measurement, one owner.
#
# What autocue must NOT touch is anything that is not a song. It registers on
# EVERY decoded file, so the DJ's voice clips and the pause-talk silence would
# be trimmed and loudness-normalised too — the voice would jump to the music's
# -14 LUFS target, and a silence file can be cued down to nothing. Those carry
# `liq_disable_autocue` (see no_autocue below and broadcast/queue.ts).
enable_autocue_metadata()

# Telnet server — the controller's only channel into the mixer (restart, skip,
# stream/idle gates). Container-private network only; not exposed to the host.
settings.server.telnet := true
settings.server.telnet.bind_addr := "0.0.0.0"
settings.server.telnet.port := 1234

# Active station's state dir, exported as SUBWAVE_STATE_DIR by the container
# entrypoint (docker/broadcast-entrypoint.sh / the AIO supervisor).
state_dir = environment.get(default="/var/sub-wave", "SUBWAVE_STATE_DIR")

# Scratch dirs for the atomic marker writes below (#1240). Without a temp_dir on
# the state fs, file.write(atomic=true) stages under $TMPDIR (container overlay)
# while the state dir is a bind mount, so the rename is cross-device and the
# stdlib silently degrades to a NON-atomic copy. ONE DIR PER WRITER: the stdlib
# always names the temp file `atomic.write` inside the dir it is given.
# Returns null on failure (file.mkdir does NOT raise) so a bad temp_dir restores
# the old $TMPDIR behaviour instead of raising inside on_metadata.
def ensure_tmp_dir(p) =
  file.mkdir(parents=true, p)
  probe = path.concat(p, "probe")
  try
    file.write(data="x", probe)
    file.remove(probe)
    p
  catch err do
    log(
      label="subwave",
      "temp dir #{p} unusable (#{err}); atomic marker writes fall back to $TMPDIR"
    )
    null
  end
end

np_tmp_dir = ensure_tmp_dir("#{state_dir}/tmp/now-playing")
jingle_tmp_dir = ensure_tmp_dir("#{state_dir}/tmp/jingle")
# Second dir for the SAME marker file: jingle-playing.json has two writers (the
# rotate's on_metadata and jingle_now_queue's hook) whose feeds can overlap
# inside one crossfade, and a shared dir would tear the write.
jingle_now_tmp_dir = ensure_tmp_dir("#{state_dir}/tmp/jingle-now")
bed_tmp_dir = ensure_tmp_dir("#{state_dir}/tmp/bed")
pause_talk_tmp_dir = ensure_tmp_dir("#{state_dir}/tmp/pause-talk")
pause_voice_accept_tmp_dir = ensure_tmp_dir("#{state_dir}/tmp/pause-voice-accept")
pause_voice_start_tmp_dir = ensure_tmp_dir("#{state_dir}/tmp/pause-voice-start")
starve_tmp_dir = ensure_tmp_dir("#{state_dir}/tmp/starve")
# One per voice channel, not one for both: they write the SAME marker file, so a
# shared dir tears when a heavy-duck segment and a talk-over link land together.
voice_tmp_dir = ensure_tmp_dir("#{state_dir}/tmp/voice")
intro_tmp_dir = ensure_tmp_dir("#{state_dir}/tmp/intro")

# MUSIC STARVE GUARD (#1300 bug 7) — the latch only; its tick is registered far
# below, after idle_mode exists. Declared here because the jingles gate reads it
# from a thunk (same lazy-thunk pattern as bed_on_air).
music_starved = ref(false)

# Live safety gates shared by on-demand jingles and the automatic rotate.
# Declared before the queue sources; on_meta and voice_marker update them.
#
# True from a bed's first metadata until the next real song's (both set in
# on_meta). The rotate counts every music-chain track and a bed IS a track, so
# without this gate a stinger lands BETWEEN the bed and the song it ramps into.
bed_on_air = ref(false)

# A pause-talk break is a silent item on the music timeline followed by speech
# on voice_queue. Keep jingles unavailable across BOTH halves; voice_until then
# carries the gate from the first spoken sample through its tail.
pause_talk_on_air = ref(false)

# Voice-on-air DEADLINE for the jingle gates, keeping the rotate from handing a
# stinger to the music chain while a DJ clip is on air (#997 covered only the
# other direction). Must stay a deadline, not a boolean:
# source.is_ready(voice_queue) latches true forever after the first push on a
# request.queue (measured: still true 24s after a 6.4s clip finished, queue
# empty), which would starve the rotate permanently.
voice_until = ref(0.)

# True from a manual (on-demand) jingle's first metadata until the next
# music-chain track resets it in on_meta. Keeps the automatic rotate from
# stacking a stinger on top of an announcement an operator fired by hand.
jingle_now_on_air = ref(false)

# RUNTIME SETTINGS — one text file per value, written by the controller via
# settings.update() and read ONCE at startup: a change needs a mixer restart.
# Missing/garbage keeps the default, so an upgrade is byte-identical.

jingle_ratio = ref(30)
# smooth_add's `p` on the two ducking layers (see the DUCKING block below).
duck_voice = ref(0.22)
duck_intro = ref(0.30)
archive_enabled = ref(false)
archive_bitrate = ref(128)
opus_enabled = ref(false)
opus_bitrate = ref(96)
flac_enabled = ref(false)
aac_enabled = ref(false)
aac_bitrate = ref(192)
# HLS — the DEFAULT listener-facing stream. Unlike the icecast mounts this is a
# directory of segments plus a rolling playlist, served as static files by the
# edge. Enabled by default: every listener path (browser, app, Sonos via the
# mp3 mount) keeps working either way, and HLS is what survives a flaky
# connection without the client having to reconnect to a live socket.
hls_enabled = ref(true)
# segment_duration x segments is the listener's distance from the live edge.
# 4 x 5 = 20s, which is deliberately close to the 22s icecast burst the rest of
# the timing model is calibrated against (stream.bufferSeconds), so a listener
# hears the same thing at the same moment on either transport.
hls_segment_duration = ref(4)
hls_segments = ref(5)
stream_bitrate = ref(192)
ogg_icy_metadata = ref(true)
station_name = ref("SUB/WAVE")

if file.exists("#{state_dir}/liquidsoap_jingle_ratio.txt") then
  raw = string.trim(file.contents("#{state_dir}/liquidsoap_jingle_ratio.txt"))
  v = int_of_string(default=30, raw)
  # 0 is a valid value: jingles OFF (#997).
  if v >= 0 then jingle_ratio := v end
end

# Duck depths. `p` is the fraction of the music LEFT UP under a voice channel:
# range [0, 1], smaller is deeper, 1.0 no duck, 0.0 a full mute under the voice.
# Out-of-range is refused, not clamped — the controller already bounds it on save
# and load, so a bad file here is a hand-edit.
if file.exists("#{state_dir}/liquidsoap_duck_voice.txt") then
  raw = string.trim(file.contents("#{state_dir}/liquidsoap_duck_voice.txt"))
  v = float_of_string(default=0.22, raw)
  if v >= 0.0 and v <= 1.0 then duck_voice := v end
end

if file.exists("#{state_dir}/liquidsoap_duck_intro.txt") then
  raw = string.trim(file.contents("#{state_dir}/liquidsoap_duck_intro.txt"))
  v = float_of_string(default=0.30, raw)
  if v >= 0.0 and v <= 1.0 then duck_intro := v end
end

if file.exists("#{state_dir}/liquidsoap_archive_enabled.txt") then
  raw = string.trim(file.contents("#{state_dir}/liquidsoap_archive_enabled.txt"))
  archive_enabled := (raw == "true")
end

if file.exists("#{state_dir}/liquidsoap_archive_bitrate.txt") then
  raw = string.trim(file.contents("#{state_dir}/liquidsoap_archive_bitrate.txt"))
  v = int_of_string(default=128, raw)
  if v > 0 then archive_bitrate := v end
end

if file.exists("#{state_dir}/liquidsoap_stream_bitrate.txt") then
  raw = string.trim(file.contents("#{state_dir}/liquidsoap_stream_bitrate.txt"))
  v = int_of_string(default=192, raw)
  if v > 0 then stream_bitrate := v end
end

# Opt IN to the Ogg-Opus mount (costs a continuous encoder + a 44.1->48k
# resample). Only Blink clients ever select it (web/hooks/usePlayer.ts).
if file.exists("#{state_dir}/liquidsoap_opus_enabled.txt") then
  raw = string.trim(file.contents("#{state_dir}/liquidsoap_opus_enabled.txt"))
  opus_enabled := (raw == "true")
end

if file.exists("#{state_dir}/liquidsoap_opus_bitrate.txt") then
  raw = string.trim(file.contents("#{state_dir}/liquidsoap_opus_bitrate.txt"))
  v = int_of_string(default=96, raw)
  if v > 0 then opus_bitrate := v end
end

# Opt IN to the AAC-LC mount — for external players that decode AAC but not
# Opus. No resample.
if file.exists("#{state_dir}/liquidsoap_aac_enabled.txt") then
  raw = string.trim(file.contents("#{state_dir}/liquidsoap_aac_enabled.txt"))
  aac_enabled := (raw == "true")
end

if file.exists("#{state_dir}/liquidsoap_aac_bitrate.txt") then
  raw = string.trim(file.contents("#{state_dir}/liquidsoap_aac_bitrate.txt"))
  v = int_of_string(default=192, raw)
  if v > 0 then aac_bitrate := v end
end

# HLS. Opt OUT rather than in: absent file leaves it on.
if file.exists("#{state_dir}/liquidsoap_hls_enabled.txt") then
  raw = string.trim(file.contents("#{state_dir}/liquidsoap_hls_enabled.txt"))
  hls_enabled := not (raw == "false")
end

if file.exists("#{state_dir}/liquidsoap_hls_segment_duration.txt") then
  raw = string.trim(file.contents("#{state_dir}/liquidsoap_hls_segment_duration.txt"))
  v = int_of_string(default=4, raw)
  if v > 0 then hls_segment_duration := v end
end

if file.exists("#{state_dir}/liquidsoap_hls_segments.txt") then
  raw = string.trim(file.contents("#{state_dir}/liquidsoap_hls_segments.txt"))
  v = int_of_string(default=5, raw)
  if v > 0 then hls_segments := v end
end

# Opt IN to the Ogg-FLAC mount — a lossless capture of the PROCESSED bus at the
# source 44.1 kHz. ~800-900 kbps, hence off by default; external players only.
if file.exists("#{state_dir}/liquidsoap_flac_enabled.txt") then
  raw = string.trim(file.contents("#{state_dir}/liquidsoap_flac_enabled.txt"))
  flac_enabled := (raw == "true")
end

# ICY (out-of-band) per-track titles on BOTH Ogg mounts. ON by default — only an
# explicit "false" disables. See make_stream_outputs() for the client trade-off.
if file.exists("#{state_dir}/liquidsoap_ogg_icy_metadata.txt") then
  raw = string.trim(file.contents("#{state_dir}/liquidsoap_ogg_icy_metadata.txt"))
  ogg_icy_metadata := (raw != "false")
end

if file.exists("#{state_dir}/liquidsoap_station_name.txt") then
  raw = string.trim(file.contents("#{state_dir}/liquidsoap_station_name.txt"))
  if raw != "" then station_name := raw end
end

log("settings loaded: jingle_ratio=#{jingle_ratio()} duck_voice=#{duck_voice()} duck_intro=#{duck_intro()} archive_enabled=#{archive_enabled()} archive_bitrate=#{archive_bitrate()} stream_bitrate=#{stream_bitrate()} opus_enabled=#{opus_enabled()} opus_bitrate=#{opus_bitrate()} flac_enabled=#{flac_enabled()} aac_enabled=#{aac_enabled()} aac_bitrate=#{aac_bitrate()} ogg_icy_metadata=#{ogg_icy_metadata()} station_name=#{station_name()}")

# subhttp:<full-url> — whole-file download via curl (http.get.stream returns
# spurious 522s on the Cloudflare-fronted Navidrome origin).
#
# INVARIANT (#1405): curl exiting 0 is NOT proof of audio. Subsonic carries its
# error code INSIDE the body, so Navidrome answers a missing file with HTTP 200
# and a JSON/XML blob that `--fail` cannot see. The CONTENT TYPE is what
# identifies it, so refuse json/xml/text bodies, sub-4 KiB files and non-2xx.

# Below this a "track" cannot be audio worth airing: a Subsonic error body is a
# few hundred bytes, 4 KiB of MP3 is about a quarter of a second. Backstop for an
# origin that errors with no usable content type.
subhttp_min_bytes = 4096

# Per-handoff completion outcomes consumed by the controller over telnet. The
# probe token rides in a URL fragment (never sent to the origin), so a stale
# result for the same song id cannot satisfy a later push. Entries are removed
# when read.
subhttp_probe_outcomes = ref([])

def subhttp_probe_id(uri) =
  matches = string.extract(pattern="#subwave_probe=([^&#]+)", uri)
  list.assoc(default="", 1, matches)
end

def remember_subhttp_outcome(uri, outcome) =
  probe_id = subhttp_probe_id(uri)
  if probe_id != "" then
    kept = list.filter(fun(p) -> fst(p) != probe_id, subhttp_probe_outcomes())
    subhttp_probe_outcomes.set([(probe_id, outcome), ...kept])
  end
end

def take_subhttp_outcome(probe_id) =
  matches = list.filter(fun(p) -> fst(p) == probe_id, subhttp_probe_outcomes())
  if list.length(matches) == 0 then
    "pending"
  else
    subhttp_probe_outcomes.set(
      list.filter(fun(p) -> fst(p) != probe_id, subhttp_probe_outcomes())
    )
    snd(list.hd(matches))
  end
end

# Stream URLs carry Subsonic u/t/s query credentials. Keep operator-facing
# context without persisting replayable auth material or the internal probe id.
def redact_subhttp_uri(uri) =
  no_query = string.replace(pattern="\\?[^#]*", fun(_) -> "?[redacted]", uri)
  string.replace(pattern="#.*$", fun(_) -> "", no_query)
end

def proto_subhttp(~rlog, ~maxtime, arg) =
  ignore(rlog)
  uri = arg
  raw_timeout = int_of_float(maxtime - time())
  timeout = if raw_timeout < 5 then 5 else raw_timeout end
  ext =
    if string.contains(substring=".mp3", arg) then ".mp3"
    elsif string.contains(substring=".ogg", arg) then ".ogg"
    elsif string.contains(substring=".flac", arg) then ".flac"
    else ".mp3" end
  outfile = file.temp("liq-curl-", ext)
  # `-w` reports the FINAL response (after -L), status first so the content type
  # — which may itself contain a space, e.g. `application/json; charset=utf-8` —
  # can keep the rest of the line.
  cmd = "curl -sS -L --fail --max-time #{timeout} -w '%{http_code} %{content_type}' -o #{process.quote(outfile)} #{process.quote(uri)}"
  ret = process.run(timeout=float_of_int(timeout), cmd)
  info = string.trim(ret.stdout)
  http_code = list.hd(default="", string.split(separator=" ", info))
  ctype = string.case(lower=true, info)
  size = file.size(outfile)
  # An API error body, whatever the status: JSON and XML are the two Subsonic
  # error dialects, and text/* covers a proxy's HTML error page.
  error_body =
    string.contains(substring="json", ctype)
    or string.contains(substring="xml", ctype)
    or string.contains(substring="text/", ctype)
  safe_uri = redact_subhttp_uri(uri)
  safe_stderr = redact_subhttp_uri(ret.stderr)
  if not (ret.status == "exit" and ret.status.code == 0) then
    remember_subhttp_outcome(uri, "failed")
    log(label="protocol.subhttp", level=3, "curl failed for #{safe_uri}: status=#{ret.status} code=#{ret.status.code} http=#{http_code} stderr=#{safe_stderr}")
    file.remove(outfile)
    null
  elsif error_body then
    remember_subhttp_outcome(uri, "failed")
    log(label="protocol.subhttp", level=2, "music source returned an ERROR BODY, not audio, for #{safe_uri} (http=#{http_code}, content-type=#{info}, #{size} bytes) — the track is missing or unreadable at the origin; check the music server's own log")
    file.remove(outfile)
    null
  elsif size < subhttp_min_bytes then
    remember_subhttp_outcome(uri, "failed")
    log(label="protocol.subhttp", level=2, "music source returned only #{size} bytes for #{safe_uri} (http=#{http_code}, content-type=#{info}) — too small to be audio, treating as an error response")
    file.remove(outfile)
    null
  else
    remember_subhttp_outcome(uri, "ready")
    outfile
  end
end

protocol.add(temporary=true, syntax="subhttp:<full url>", doc="Navidrome stream via curl", "subhttp", proto_subhttp)

# QUEUE — the controller writes one annotated track URI to next.txt; polled
# every 1s into request.queue.

dj_queue = request.queue(id="dj_queue")
jingle_now_queue = request.queue(id="jingle_now_queue")

def poll_queue() =
  if file.exists("#{state_dir}/next.txt") then
    contents = string.trim(file.contents("#{state_dir}/next.txt"))
    file.remove("#{state_dir}/next.txt")
    if contents != "" then
      log("Queueing: #{redact_subhttp_uri(contents)}")
      ignore(dj_queue.push(request.create(contents)))
    end
  end
end
thread.run(every=1.0, poll_queue)

def poll_jingle_now() =
  if file.exists("#{state_dir}/jingle-now.txt") then
    contents = string.trim(file.contents("#{state_dir}/jingle-now.txt"))
    file.remove("#{state_dir}/jingle-now.txt")
    if contents != "" then
      log("Queueing on-demand jingle: #{contents}")
      ignore(jingle_now_queue.push(request.create(contents)))
    end
  end
end
thread.run(every=0.5, poll_jingle_now)

# Measured clip length for a jingle marker, in seconds; 0. means "unmeasured"
# and the controller falls back to its own 15s guess. The controller can only
# parse a RIFF header, and a jingle imported without ffmpeg keeps its original
# container, so only Liquidsoap can answer for an .mp3. request.duration decodes
# a header and RAISES on an unreadable/empty filename, so wrap every call — the
# duration is part of the payload, so a raise would cost the marker entirely.
def jingle_duration(fname) =
  try
    null.get(default=0., request.duration(fname))
  catch err do
    log(label="subwave", "jingle duration unavailable for #{fname} (#{err})")
    0.
  end
end

# Mark a manual jingle from its own source. It is deliberately outside
# music_meta: uploaded clips can retain ID3 tags, and no such tag may become the
# station's now-playing row or ICY title.
jingle_now_queue.on_metadata(synchronous=false, fun (m) -> begin
  jingle_now_on_air := true
  fname = m["filename"]
  file.write(
    data=json.stringify(compact=true, {
      filename = fname,
      durationSec = jingle_duration(fname),
      startedAt = time()
    }),
    atomic=true,
    temp_dir=jingle_now_tmp_dir,
    "#{state_dir}/jingle-playing.json"
  )
end)

# AUTONOMOUS FALLBACK — the controller maintains auto.m3u with mood-appropriate
# tracks; reload_mode="watch" picks up its rewrites.

auto_playlist = playlist(
  id="auto",
  reload_mode="watch",
  mode="randomize",
  "#{state_dir}/auto.m3u"
)

# MAIN MUSIC SOURCE — queue takes priority, falls back to autonomous.
music = fallback(
  id="music",
  track_sensitive=true,
  [dj_queue, auto_playlist]
)

# HARD TRACK-LENGTH CAP (#447) — the controller stamps liq_cue_out on autonomous
# picks and auto.m3u entries when a max-track-length is set; listener requests
# are deliberately UN-stamped. Must sit BEFORE the music_meta capture (one clean
# on_metadata per cut track) and before `cross` (the cut end drives a normal
# crossfade out).
music = cue_cut(music)


# The PRE-cross handle for the on_metadata hook attached further down. Hooking
# the post-cross source fires TWICE per transition (the crossfade's fades both
# pass initial_metadata= and the outgoing track wins), stranding the UI one song
# behind. Also what the starve guard samples.
music_meta = music

# Hard ceiling on how far ahead voice_marker may push voice_until. The gate
# fails toward SERVING jingles: a duration that measures wrong (corrupt header,
# a filename resolving to other media) would otherwise silence the rotate for
# that long, with nothing in the log to say why.
VOICE_GATE_MAX_SEC = 120.

# The gate arms at the clip's on_metadata, so a jingle handed to the rotate
# inside the ~1s say.txt poll seam is covered by neither this nor the
# controller's waitForJingleClear. intro_queue arms it too, not just
# voice_queue, so a link can't talk over a stinger; the cost is that a chatty
# persona skips some jingles and runs slightly under the configured ratio.

# JINGLES & STATION ID — rotate a jingle in every N tracks.
#
# CRITICAL: this rotate MUST sit here, on the raw pre-cross / pre-duck music
# source. `rotate` is track_sensitive and only advances at a track boundary of
# the source it is playing, and `cross` and the `smooth_add` layers present
# their output as ONE never-ending track, so a rotate above them plays a single
# jingle at startup and is stuck on music forever. music_meta is captured ABOVE
# this, so jingles never reach now-playing. An empty jingles.m3u is fine (rotate
# skips an unavailable source); jingle_ratio 0 = jingles OFF (#997), the rotate
# is not built at all.
music =
  if jingle_ratio() > 0 then
    jingles = playlist(
      id="jingles",
      mode="randomize",
      reload_mode="watch",
      "#{state_dir}/jingles.m3u"
    )
    # Announce each jingle to the controller (#997): jingles are otherwise
    # invisible to it and play outside its airVoice serialiser. Written at FEED
    # time — the jingle turns audible once the handover into it completes — and
    # the controller holds its voice chain until start + handover + clip length.
    jingles.on_metadata(synchronous=false, fun (m) ->
      file.write(
        data=json.stringify(compact=true, {
          filename = m["filename"],
          durationSec = jingle_duration(m["filename"]),
          startedAt = time()
        }),
        atomic=true,
        temp_dir=jingle_tmp_dir,
        "#{state_dir}/jingle-playing.json"
      )
    )
    # Unavailable while a bed is on air (can't split a bed from its song), while
    # a voice clip is on air (can't hand a stinger over the DJ), and while the
    # music chain is starved (can't serve stingers forever over dead air).
    jingles = source.available(jingles, {
      not bed_on_air() and not pause_talk_on_air() and not jingle_now_on_air() and
      time() > voice_until() and not music_starved()
    })
    rotate(weights=[1, jingle_ratio()], [jingles, music])
  else
    music
  end

# Manual presses wrap the automatic rotate so they win the next SAFE boundary,
# even when dj_queue already holds tracks or the rotate is due. While speech or
# a bed is live the source is unavailable but the request remains queued.
jingle_now = source.available(jingle_now_queue, {
  not bed_on_air() and not pause_talk_on_air() and time() > voice_until()
})
music = fallback(
  id="music_with_jingle_now",
  track_sensitive=true,
  [jingle_now, music]
)

# Per-track loudness normalisation: autocue attaches `liq_amplify` ("<n> dB",
# toward its -14 LUFS target) to every song it measured. BEFORE the cross so
# each track carries its own gain into the crossfade, and AFTER the music_meta
# capture.
music = amplify(override="liq_amplify", 1., music)

# THE HANDOVER — Liquidsoap's own `crossfade`, driven by autocue.
#
# This used to be a 550-line transition of our own (six DJ effects, pair-sized
# fade lengths, a show-boundary special case). It is now the stdlib operator,
# because that is what autocue is built to feed: its `cross.simple` transition
# reads the per-track `liq_cross_start_duration` / `liq_cross_end_duration`
# (the buffer), `liq_fade_in` / `liq_fade_out` (the fades) and
# `liq_fade_out_start_next` (where the next track enters) straight off the
# metadata autocue attached at resolution. A track that stops dead hands over
# with no overlap; one that rings out hands over inside its own decay.
#
# The explicit arguments are only the FALLBACK for an item autocue did not
# measure: a show-boundary cut (it carries a liq_cue_out, so autocue stands
# down on it — and a boundary cut is meant to be a plain fade, #1574), a bed,
# the pause-talk silence. The last two also carry a liq_cross_duration of their
# own, which `cross` still honours through its override_duration key. They are
# Liquidsoap's defaults, stated so nobody has to look them up.
music = crossfade(duration=5., fade_in=3., fade_out=3., music)

# DJ VOICE — TTS clips dropped as paths into say.txt / intro.txt.
# voice_queue = solo voice (heavy duck: station IDs, hourly, request
# back-announce); intro_queue = talk-over links (light duck).
# Everything pushed onto a voice/sfx channel is excluded from autocue: it is not
# a song, its level is tuned by the TTS chain (per-engine gain + mic_chain), and
# its exact length is what the voice markers and voice_until() time against.
# `liq_disable_autocue` is autocue's own documented off-switch; nested annotate
# is fine, so a clip that already carries a pause-delivery annotation keeps it.
def no_autocue(uri) =
  "annotate:liq_disable_autocue=\"true\":#{uri}"
end

voice_queue = request.queue(id="voice_queue")
intro_queue = request.queue(id="intro_queue")

def pause_voice_delivery_id(uri) =
  matches = string.extract(pattern="subwave_pause_delivery=\\\"([^\\\"]+)\\\"", uri)
  list.assoc(default="", 1, matches)
end

# The acceptance marker closes the controller-restart interval between removing
# say.txt and the voice's on_metadata. It is written only AFTER voice_queue.push
# returns, so "accepted" means this live mixer owns the stable delivery id.
# One writer (poll_voice), one temp dir. A failure is logged and degrades to the
# older mixer's stable-id/start-marker compatibility path.
def write_pause_voice_accepted(uri) =
  delivery_id = pause_voice_delivery_id(uri)
  if delivery_id != "" then
    try
      file.write(
        data=json.stringify(compact=true, {
          deliveryId = delivery_id,
          acceptedAt = time()
        }),
        atomic=true,
        temp_dir=pause_voice_accept_tmp_dir,
        "#{state_dir}/pause-talk-voice-accepted.json"
      )
    catch err do
      log(label="subwave", "pause voice acceptance marker failed (#{err})")
    end
  end
end

# AIR-TIME MARKER (#1382). on_metadata fires as the clip starts feeding, so
# `startedAt` IS the live-edge moment the words begin (the clock
# now-playing.json is stamped on); handoff time runs 0.5s of poll plus the queue
# and duck ramp ahead of it. The controller matches it back via `subwave_voice`,
# the id stamped into the clip's annotate: URI, which also filters out the silent
# lead-in. Like jingle-playing.json, the file is never deleted and the controller
# dedupes on a value it carries, not on the file's existence.
def voice_marker(channel, tmp_dir) =
  fun (m) ->
    begin
      voice_id = m["subwave_voice"]
      if voice_id != "" then
        # ONE clock read for both jobs, taken before either: re-reading time()
        # after the work below would skew the live-edge stamp.
        now = time()
        fname = m["filename"]

        # The marker goes out FIRST. Arming the jingle gate needs
        # request.duration, which can raise on an unreadable/empty filename; if
        # that ran first a raise would cost the marker entirely, and since the
        # file is never deleted awaitVoiceAir would burn its full 20s timeout
        # against the PREVIOUS clip's voiceId instead of degrading at once.
        file.write(
          data=json.stringify(compact=true, {
            voiceId = voice_id,
            channel = channel,
            filename = fname,
            startedAt = now
          }),
          atomic=true,
          temp_dir=tmp_dir,
          "#{state_dir}/voice-playing.json"
        )

        # Dedicated durable start acknowledgement for a pause voice. The
        # generic marker above may be overwritten by later speech before a
        # controller restarts; this one changes only on the next pause delivery.
        pause_delivery_id = m["subwave_pause_delivery"]
        if pause_delivery_id != "" then
          try
            file.write(
              data=json.stringify(compact=true, {
                deliveryId = pause_delivery_id,
                startedAt = now
              }),
              atomic=true,
              temp_dir=pause_voice_start_tmp_dir,
              "#{state_dir}/pause-talk-voice-started.json"
            )
          catch err do
            log(label="subwave", "pause voice start marker failed (#{err})")
          end
        end

        # Arm the jingle gate (see voice_until above). request.duration is
        # expensive, but this hook is synchronous=false so it runs off the
        # streaming thread. Two bounds: the 30s fallback covers a clip that
        # cannot be measured, the 120s cap one that measures wrong. An over-long
        # deadline silently starves the rotate.
        dur =
          try
            null.get(default=30., request.duration(fname))
          catch err do
            log(
              label="subwave",
              "voice duration unavailable for #{fname} (#{err}); jingle gate falls back to 30s"
            )
            30.
          end
        voice_until := now + min(dur, VOICE_GATE_MAX_SEC) + 2.
      end
    end
end

# synchronous=false: this does file I/O and must not sit on the streaming thread.
voice_queue.on_metadata(synchronous=false, voice_marker("say", voice_tmp_dir))
intro_queue.on_metadata(synchronous=false, voice_marker("intro", intro_tmp_dir))

# Sound-effects channel — short pre-rendered stingers the DJ agent plays UNDER
# its voice, path written into sfx.txt (broadcast/sfx.js + queue.playSfx). Not
# mic-chained: the audio is already produced.
sfx_queue = request.queue(id="sfx_queue")

# Silent lead-in clip, pushed immediately before each speech file: smooth_add
# ducks over the silence so the dip completes BEFORE the DJ's first word.
# request.queue plays the two pushes gaplessly.
leadin_path = "/sounds/leadin.wav"
has_leadin = file.exists(leadin_path)
if has_leadin then
  log("Voice lead-in enabled: #{leadin_path}")
else
  log("No #{leadin_path} — DJ voice will duck without a pre-roll lead-in")
end

def poll_voice() =
  if file.exists("#{state_dir}/say.txt") then
    contents = string.trim(file.contents("#{state_dir}/say.txt"))
    file.remove("#{state_dir}/say.txt")
    if contents != "" then
      log("DJ says: #{contents}")
      if has_leadin then
        ignore(voice_queue.push(request.create(no_autocue(leadin_path))))
      end
      ignore(voice_queue.push(request.create(no_autocue(contents))))
      write_pause_voice_accepted(contents)
    end
  end
end
thread.run(every=0.5, poll_voice)

def poll_intro() =
  if file.exists("#{state_dir}/intro.txt") then
    contents = string.trim(file.contents("#{state_dir}/intro.txt"))
    file.remove("#{state_dir}/intro.txt")
    if contents != "" then
      log("DJ talk-over: #{contents}")
      if has_leadin then
        ignore(intro_queue.push(request.create(no_autocue(leadin_path))))
      end
      ignore(intro_queue.push(request.create(no_autocue(contents))))
    end
  end
end
thread.run(every=0.5, poll_intro)

def poll_sfx() =
  if file.exists("#{state_dir}/sfx.txt") then
    contents = string.trim(file.contents("#{state_dir}/sfx.txt"))
    file.remove("#{state_dir}/sfx.txt")
    if contents != "" then
      log("DJ sound effect: #{contents}")
      # No lead-in: a stinger must start promptly to land under the voice.
      ignore(sfx_queue.push(request.create(no_autocue(contents))))
    end
  end
end
thread.run(every=0.5, poll_sfx)

# MIC CHAIN — broadcast-style processing on both voice channels (numbers tuned
# for an en_GB-alan-medium-ish voice).
#
# A FUNCTION, not a shared chain variable, so each call instantiates fresh
# operator nodes; reuse hits "Early computation of source content-type". An
# 80 Hz HPF + 3 kHz presence shelf are missing for the same error on
# request.queue sources.
def mic_chain(s) =
  # Fast attack, gentle ratio: tames TTS peaks without pumping.
  s = compress(
    attack=5.0,
    release=120.0,
    threshold=-18.0,
    ratio=4.0,
    knee=2.0,
    gain=7.0,
    s
  )
  # Makeup so the voice sits clearly above the ducked music bed.
  s = amplify(1.4, s)
  # No slap echo here: with the compressor's makeup gain it lifted the TTS noise
  # floor into an audible wash behind station IDs. The voice stays dry.
  s
end

# Edge fade-IN per clip: some engines cut the audio hard at the boundary and the
# compressor's makeup gain turns that edge into a tick. Runs BEFORE
# amplify/mic_chain so the compressor never sees the raw edge.
#
# fade.in ONLY — on a request.queue source this build doesn't know the remaining
# time, so fade.out treats the WHOLE clip as inside the fade zone and multiplies
# it to silence. Tail clicks must be faded at WAV-render time instead.
def edge_fade(s) =
  fade.in(duration=0.04, s)
end

# Per-segment voice trim: the controller stamps `liq_amplify` per spoken clip
# (settings.tts.gainDb + audio/tts.ts:voiceGainDb), the same mechanism as the
# music bus. BEFORE mic_chain so the fixed-threshold compressor sees a levelled
# input; the un-annotated lead-in plays at unity.
voice = mic_chain(amplify(override="liq_amplify", 1., edge_fade(voice_queue)))
intro = mic_chain(amplify(override="liq_amplify", 1., edge_fade(intro_queue)))

# SAFETY — the dead-air guard. `emergency` is an always-ready, non-silent
# single, so the broadcast never has nothing to pull.
#
# POSITION IS LOAD-BEARING (#1300 bug 7). It MUST stay ABOVE the studio-bed
# `add` below AND the three `smooth_add` ducking layers below that. `add` is
# ready whenever ANY input is, so anything mixed into the music chain makes the
# chain look alive while the music is starved and a fallback below the mix can
# only ever select index 0:
#   * the bed is `mksafe(single(...))`, and `mksafe` makes it INFALLIBLE;
#   * the stdlib builds smooth_add as
#       add(normalize=false, [normal, fallback(track_sensitive=false, [special, blank()])])
#     whose inner fallback falls through to `blank()`, so the special leg is
#     always ready regardless of `normal`.
# Measured: -91.0 dB with the fallback below the ducking, -3.0 dB with it here.
# Do not add a second guard further down "for safety".
#
# It must also stay BELOW `music_meta` and the jingle rotate so now-playing
# metadata and jingle counting are untouched; being above the ducking is what
# lets the DJ talk over the emergency loop exactly as over music.
#
# The fade-in is NOT a debounce and must never become one. track_sensitive=false
# switches the instant `music` reports not-ready, including on brief real gaps
# (cold boot before auto.m3u resolves, a seam where dj_queue and auto_playlist
# are both momentarily unready). Delaying the switch is the wrong fix: fire
# immediately and ramp the LEVEL. The music branch keeps the stdlib identity
# transition because coming BACK must be instant.
#
# BOTH fades below are needed; don't delete either. `switch` applies NO
# transition to its FIRST selection (measured on 2.4.5: "Switch to emergency."
# at boot vs "…with transition." after), and boot IS that first selection, so
# `emergency` carries its own one-shot fade — whose default
# track_sensitive=false memoises the ramp to the source's first frame ever,
# right for boot and useless later. The `transitions=` entry covers every later
# switch.
#
# Measured (100 ms RMS): boot -38.5 -> -9.0 dB over 1.0s; mid-run starve
# -32.6 -> -9.0 dB over 1.0s; recovery a single-window step with no ramp.
EMERGENCY_FADE_SEC = 1.0
emergency = single("/sounds/emergency.mp3")
# The `: source` casts drop fade.in's extra methods, which otherwise refuse to
# unify with the plain source the identity transition and `music` child are.
emergency = (fade.in(duration=EMERGENCY_FADE_SEC, emergency) : source)
music =
  fallback(
    id="music_safety",
    track_sensitive=false,
    transitions=[
      fun (_, back_to_music) -> back_to_music,      # identity: instant recovery
      fun (_, to_emergency) ->
        (fade.in(duration=EMERGENCY_FADE_SEC, to_emergency) : source)
    ],
    [music, emergency]
  )

# STUDIO BED — low-level room tone, mixed in BEFORE voice ducking so smooth_add
# ducks it with the music (otherwise it competes with the voice).

bed_path = "/sounds/bed.mp3"

# Disabled: the looping ambient bed was audible under the DJ's voice during
# links. Flip back to `true` to restore it. That is safe for the dead-air guard
# ONLY because the guard sits ABOVE this block, on `music` — `mksafe` makes the
# bed infallible, so this `add` is permanently ready and a guard built from
# `music_bus` would be silently disarmed by this flag (#1300 bug 7).
bed_enabled = false

music_bus =
  if bed_enabled and file.exists(bed_path) then
    log("Loading studio bed from #{bed_path}")
    bed = mksafe(single(id="bed", bed_path))
    add(
      normalize=false,
      weights=[1.0, 0.02],   # bed sits ~34 dB below music — barely there
      [music, bed]
    )
  else
    log("Studio bed off (bed_enabled=#{bed_enabled}) — music plays without a bed")
    music
  end

# DUCKING — gated talkbax. `smooth_add` drops the music to a fixed ratio
# whenever a voice source has signal; three stacked layers, one depth each.
#
# Gated, NOT RMS-keyed: an RMS sidechain follower drove the music bus to -91 dB
# even with voice_queue empty (git f38a9af). smooth_add cares only whether the
# channel has signal.
#
# `duration` is the fade into and out of the duck. It can be gentle on the voice
# layers because each gets a silent lead-in clip pushed ahead of the speech, so
# the dip completes BEFORE the DJ's first word.
#
# Both depths come from liquidsoap_duck_*.txt, read once at startup above, so a
# change needs a mixer restart.
ducked = smooth_add(
  duration=0.8,
  # heavy duck: 0.22 (the default) drops the music to ~-13 dB under solo voice
  p={duck_voice()},
  normal=music_bus,
  special=voice
)

# Light duck on top for talk-over links — leaves the song audible underneath.
radio = smooth_add(
  duration=0.8,
  p={duck_intro()},   # 0.30 default, ~-10 dB
  normal=ducked,
  special=intro
)

# SFX on top. A stinger rides BENEATH both the DJ and the music, so it barely
# ducks; its own level and p are the two knobs.
sfx_bed = amplify(0.7, sfx_queue)
radio = smooth_add(
  duration=0.3,     # snappier than voice — stingers are short, no lead-in clip
  p={0.7},          # ~-3 dB
  normal=radio,
  special=sfx_bed
)

# Neither the jingle rotate nor the emergency dead-air fallback can sit here —
# see the JINGLES and SAFETY blocks above (#1300 bug 7).

# IDLE GATE — silence the programme while nobody is listening. The controller
# flips idle_mode over telnet (idle_on/idle_off): the switch selects blank() and
# the chain above stops being pulled, frozen mid-track. Mounts STAY UP serving
# silence (contrast stream_off, which tears them down), so playback resumes
# where it froze. A plain blank() is safe; the #660 CPU spin was specific to
# blank.skip. Not persisted — a mixer restart comes back live and the controller
# re-asserts idle if the room is still empty.
idle_mode = ref(false)
radio = switch(
  id="idle_gate",
  track_sensitive=false,
  [({idle_mode()}, blank(id="idle_silence")), ({true}, radio)]
)

# blank.skip was REMOVED here (#660): with no music in the chain it busy-loops
# at ~100% CPU and starves Icecast, measured in ANY position. The emergency
# single already covers a dead source.

# MUSIC STARVE GUARD (#1300 bug 7). `rotate` skips unavailable sources, so with
# the music chain starved the jingle rotate serves stingers back to back forever
# and the `emergency` fallback cannot see it — `radio` is still available,
# because it is producing jingles (measured: music_ready=false,
# jingles_ready=true, radio_ready=true).
#
# So sample the PRE-rotate chain (music_meta) and, after a sustained window,
# make jingles unavailable: the rotate empties, `radio` goes unavailable, and
# the emergency single fires.
#
# The window IS the "a jingle may cover a brief hiccup" behaviour — the chain is
# legitimately not-ready while a request resolves at a boundary (bounded by the
# controller's SKIP_COMMIT_WAIT_MS = 20s). Recovery is unconditional: any tick
# that sees the source ready clears the latch. Suppressed while the idle gate
# holds the programme frozen, and entering idle clears the latch outright.
STARVE_GRACE_SEC = 30.0
STARVE_SAMPLE_SEC = 1.0

# The heartbeat refreshes `at` while the outage lasts, and deliberately does NOT
# run at the sample rate: the consumer only needs the marker younger than
# STARVE_MARKER_STALE_MS (60s, controller/src/broadcast/music-starve-pure.ts),
# and 1.0s would be ~3,600 atomic rewrites an hour on a state dir that is often
# an SD card or a spinning array. 10s keeps a 6x margin. EDGE writes (latch,
# recovery, startup) stay immediate.
STARVE_HEARTBEAT_SEC = 10.0

starved_for = ref(0.0)
starved_since = ref(0.0)
last_marker_write = ref(0.0)

# NEVER let this raise. An uncaught exception inside a thread.run callback kills
# that thread PERMANENTLY, freezing the guard at whatever it last latched —
# worst case the emergency loop forever with no path back (observed as an EACCES
# on an unwritable state mount). Reporting must not share a failure domain with
# the guard it reports on.
def write_starve_marker(starved, since) =
  # Stamped for EVERY write, edge or heartbeat, so an edge write restarts the
  # heartbeat window. Set before the write so a throwing write still spaces out
  # retries.
  last_marker_write := time()
  try
    file.write(
      data=json.stringify(compact=true, {
        starved = starved,
        since = since,
        at = time()
      }),
      atomic=true,
      temp_dir=starve_tmp_dir,
      "#{state_dir}/music-starved.json"
    )
  catch err do
    log(label="subwave", "music-starved.json write failed (#{err})")
  end
end

# Publish the healthy state at startup so a working station has the file.
write_starve_marker(false, 0.0)

thread.run(every=STARVE_SAMPLE_SEC, fun () -> begin
  if idle_mode() then
    starved_for := 0.0
    if music_starved() then
      music_starved := false
      write_starve_marker(false, 0.0)
    end
  elsif source.is_ready(music_meta) then
    starved_for := 0.0
    if music_starved() then
      music_starved := false
      log(label="subwave", "music source recovered - jingle rotate re-armed")
      write_starve_marker(false, 0.0)
    end
  else
    starved_for := starved_for() + STARVE_SAMPLE_SEC
    if music_starved() then
      # Refreshes `at` so the controller can tell a live outage from a marker
      # left by a mixer that died mid-outage.
      if time() - last_marker_write() >= STARVE_HEARTBEAT_SEC then
        write_starve_marker(true, starved_since())
      end
    elsif starved_for() >= STARVE_GRACE_SEC then
      music_starved := true
      starved_since := time()
      log(
        label="subwave",
        "MUSIC SOURCE STARVED for #{starved_for()}s - jingles gated off, emergency loop takes over"
      )
      write_starve_marker(true, starved_since())
    end
  end
end)

# BROADCAST BUS — masters preserved; the brick-wall limiter (20:1 at -1 dBFS) is
# the ONLY processing. A -14 LUFS normaliser, stereo widener and bus compressor
# were all removed for reshaping the masters. The limiter stays because MP3
# encoding generates inter-sample peaks ~0.5-1 dB over the source, so modern
# masters (~-0.3 dBFS TP) would clip decoders. Typically 0 dB of reduction.

radio = compress(
  attack=1.0,
  release=80.0,
  threshold=-1.0,
  ratio=20.0,
  knee=0.5,
  gain=0.0,
  radio
)

# METADATA — ICY title driven explicitly from the pre-cross on_meta hook so it
# matches now-playing.json. BOTH operators are load-bearing:
#  1. metadata.map strip kills ALL metadata still flowing through the chain.
#     the crossfade's fades pass initial_metadata=, so ~crossfade seconds after
#     on_meta fires the cross re-emits the OUTGOING track's metadata, which
#     would clobber the title back and freeze Icecast one track behind.
#  2. insert_metadata is then the ONLY source of stream metadata, pushed from
#     on_meta.
radio = metadata.map(update=false, strip=true, fun(_) -> [], radio)
radio = insert_metadata(radio)

def on_meta(m) =
  title = m["title"]
  artist = m["artist"]
  album = m["album"]
  filename = m["filename"]
  subsonic_id = m["subsonic_id"]
  # BEDS — an instrumental the controller pushed into dj_queue for the DJ to
  # talk over BETWEEN songs (broadcast/beds.ts). It rides the music chain but is
  # NOT a song: never reaches now-playing.json, never pushes an ICY title. It
  # carries no title/artist, so it must branch BEFORE the gate below, which
  # would drop it silently — this marker is the only way the controller learns
  # "bed on air, air the link now".
  if m["subwave_kind"] == "pause-talk" then
    jingle_now_on_air := false
    bed_on_air := false
    pause_talk_on_air := true
    log("on_meta: pause-talk silence started (#{filename})")
    file.write(
      data=json.stringify(compact=true, {
        filename = filename,
        pauseId = m["subwave_pause_id"],
        startedAt = time()
      }),
      atomic=true,
      temp_dir=pause_talk_tmp_dir,
      "#{state_dir}/pause-talk-playing.json"
    )
  elsif m["subwave_kind"] == "bed" then
    jingle_now_on_air := false
    pause_talk_on_air := false
    log("on_meta: bed started (#{filename})")
    bed_on_air := true
    file.write(
      data=json.stringify(compact=true, {
        filename = filename,
        startedAt = time()
      }),
      atomic=true,
      temp_dir=bed_tmp_dir,
      "#{state_dir}/bed-playing.json"
    )
  elsif title != "" or artist != "" then
    bed_on_air := false
    pause_talk_on_air := false
    jingle_now_on_air := false
    log("on_meta: title=#{title} | artist=#{artist} | album=#{album} | id=#{subsonic_id}")
    ts = int_of_float(time())
    # json.stringify, not interpolation: titles with embedded quotes or
    # backslashes produce invalid JSON.
    payload = json.stringify(compact=true, {
      title = title,
      artist = artist,
      album = album,
      subsonic_id = subsonic_id,
      filename = filename,
      timestamp = ts
    })
    # atomic=true — the controller re-reads this every 1.5s and treats ANY parse
    # failure as null, so an in-place write blanks now-playing for a tick.
    # temp_dir keeps the rename on the state fs (#1240, see ensure_tmp_dir).
    file.write(data=payload, atomic=true, temp_dir=np_tmp_dir, "#{state_dir}/now-playing.json")
    # Same metadata onto the Icecast stream, so the ICY title tracks the current
    # song instead of lagging a transition behind.
    radio.insert_metadata([
      ("title", title),
      ("artist", artist),
      ("album", album)
    ])
  else
    # Untitled, non-bed metadata (emergency single, untagged local file).
    # Nothing to publish, but it still marks the bed's end: without this reset
    # bed_on_air latches true and starves the jingle rotate until the next
    # tagged song.
    bed_on_air := false
    pause_talk_on_air := false
    jingle_now_on_air := false
  end
end

# Attached to `music_meta`, the PRE-cross handle (post-cross fires twice).
# on_metadata rather than on_track, because on_track gets swallowed by source
# switches (request queue -> auto playlist). synchronous=false: on_meta does
# file I/O, so it runs on the task queue, not the streaming thread.
music_meta.on_metadata(synchronous=false, on_meta)

# OUTPUT — broadcast to Icecast.
#
# Stream on/off control. Icecast outputs can't pause, but they can be shut down
# and recreated: stream_off disconnects every mount and stops the hourly
# archive, stream_on recreates them. force_start is what lets a recreated output
# start after init. State lives in refs, read back over telnet; NOT persisted.
#
# /stream.mp3 is the universal floor and always serves. Its default bitrate is
# 192, not 128: dense brick-walled masters produce audible encode grain at 128.
# Other mounts are opt-in and an unused mount costs nothing.
settings.init.force_start := true

# TEMPORARY (re-harden later): the broadcast entrypoint launches liquidsoap as
# root because the 2.4.4 base image changed the `liquidsoap` user's uid and made
# the persisted state files unwritable. Without this, liquidsoap refuses to
# start under a root euid. Revert with docker/broadcast-entrypoint.sh once the
# state files are re-chowned.
settings.init.allow_root := true

# Hourly archive path. The `{...}` wrapper makes it a GETTER so strftime re-runs
# each time output.file reopens; a bare string skips strftime and writes
# everything to one literal "%Y-%m-%d/%H-00.mp3" truncated each hour.
archive_path = {time.string("#{state_dir}/archive/%Y-%m-%d/%H-00.mp3")}

def make_stream_outputs() =
  # Every encoder below picks its bitrate from a fixed set of branches because
  # %mp3/%opus/%fdkaac(bitrate=…) each need a parse-time literal int — a ref
  # won't do. Keep the branches in sync with MP3_BITRATES / OPUS_BITRATES /
  # AAC_BITRATES in settings.ts.
  br = stream_bitrate()
  mp3_enc =
    if br <= 64 then
      %mp3(bitrate=64, samplerate=44100, stereo=true)
    elsif br <= 96 then
      %mp3(bitrate=96, samplerate=44100, stereo=true)
    elsif br <= 128 then
      %mp3(bitrate=128, samplerate=44100, stereo=true)
    elsif br <= 160 then
      %mp3(bitrate=160, samplerate=44100, stereo=true)
    elsif br <= 192 then
      %mp3(bitrate=192, samplerate=44100, stereo=true)
    else
      %mp3(bitrate=320, samplerate=44100, stereo=true)
    end
  mp3_out = output.icecast(
    mp3_enc,
    id="stream_mp3",
    fallible=true,
    host=environment.get(default="icecast", "ICECAST_HOST"),
    port=7702,
    password=environment.get("ICECAST_SOURCE_PASSWORD"),
    mount="/stream.mp3",
    name=station_name(),
    description="Personal frequency from the homelab",
    genre="Various",
    url="http://localhost:7700",
    radio
  )
  # Opus mandates 48 kHz internally, so this mount also costs a 44.1->48k
  # resample. application="audio" is the music tuning; 96 kbps is the
  # music-transparent default. When off, neither is built.
  opus_shutdown =
    if opus_enabled() then
      obr = opus_bitrate()
      opus_enc =
        if obr <= 96 then
          %opus(bitrate=96, samplerate=48000, channels=2, application="audio", vbr="constrained")
        elsif obr <= 128 then
          %opus(bitrate=128, samplerate=48000, channels=2, application="audio", vbr="constrained")
        elsif obr <= 192 then
          %opus(bitrate=192, samplerate=48000, channels=2, application="audio", vbr="constrained")
        elsif obr <= 256 then
          %opus(bitrate=256, samplerate=48000, channels=2, application="audio", vbr="constrained")
        else
          %opus(bitrate=320, samplerate=48000, channels=2, application="audio", vbr="constrained")
        end
      opus_out = output.icecast(
        opus_enc,
        id="stream_opus",
        fallible=true,
        # ICY metadata toggle (default ON). output.icecast's null default
        # guesses ICY off for Ogg and relies on in-band chained-Ogg re-emission,
        # but many clients (Ferrosonic, Cast, Symfonium) read the Ogg comment
        # once at connect and freeze on the first title (#1052), while
        # foobar2000 wants the opposite. Hence a toggle.
        send_icy_metadata=ogg_icy_metadata(),
        host=environment.get(default="icecast", "ICECAST_HOST"),
        port=7702,
        password=environment.get("ICECAST_SOURCE_PASSWORD"),
        mount="/stream.opus",
        name=station_name(),
        description="Personal frequency from the homelab",
        genre="Various",
        url="http://localhost:7700",
        radio
      )
      opus_out.shutdown
    else
      fun () -> ()
    end
  # Ogg-wrapped FLAC — streamable over Icecast, unlike the file-oriented native
  # %flac. No resample, no bitrate to pick: compression=5 is the FLAC default
  # and 16-bit is universally decodable.
  flac_shutdown =
    if flac_enabled() then
      flac_out = output.icecast(
        %ogg(
          %flac(
            samplerate=44100,
            channels=2,
            compression=5,
            bits_per_sample=16
          )
        ),
        id="stream_flac",
        fallible=true,
        # ICY toggle — see the /stream.opus note above (#1052 vs foobar2000).
        send_icy_metadata=ogg_icy_metadata(),
        host=environment.get(default="icecast", "ICECAST_HOST"),
        port=7702,
        password=environment.get("ICECAST_SOURCE_PASSWORD"),
        mount="/stream.flac",
        name=station_name(),
        description="Personal frequency from the homelab — lossless",
        genre="Various",
        url="http://localhost:7700",
        radio
      )
      flac_out.shutdown
    else
      fun () -> ()
    end
  # AAC-LC over Icecast as raw ADTS, for players that lack Opus.
  # afterburner=true trades CPU for quality; no resample; format="audio/aac"
  # pins the mount's advertised MIME so clients recognise the ADTS stream.
  aac_shutdown =
    if aac_enabled() then
      abr = aac_bitrate()
      aac_enc =
        if abr <= 128 then
          %fdkaac(bitrate=128, aot="mpeg4_aac_lc", transmux="adts", afterburner=true, samplerate=44100, channels=2)
        elsif abr <= 192 then
          %fdkaac(bitrate=192, aot="mpeg4_aac_lc", transmux="adts", afterburner=true, samplerate=44100, channels=2)
        else
          %fdkaac(bitrate=256, aot="mpeg4_aac_lc", transmux="adts", afterburner=true, samplerate=44100, channels=2)
        end
      aac_out = output.icecast(
        aac_enc,
        id="stream_aac",
        format="audio/aac",
        fallible=true,
        host=environment.get(default="icecast", "ICECAST_HOST"),
        port=7702,
        password=environment.get("ICECAST_SOURCE_PASSWORD"),
        mount="/stream.aac",
        name=station_name(),
        description="Personal frequency from the homelab",
        genre="Various",
        url="http://localhost:7700",
        radio
      )
      aac_out.shutdown
    else
      fun () -> ()
    end
  # HLS — the default listener transport. Segments and the rolling playlist are
  # written into the shared state dir; the edge serves that directory as plain
  # static files, so there is no second socket to keep alive and a listener who
  # drops off simply fetches the next segment when they come back.
  #
  # Built INSIDE make_stream_outputs like every icecast mount, so it follows the
  # same on-air lifecycle: /stream-off stops writing segments rather than
  # publishing the emergency loop to the world.
  #
  # `persist_at` keeps the segment numbering across a mixer restart, so a client
  # mid-playlist doesn't see the sequence jump backwards and stall.
  #
  # The bitrate branches are literals for the same reason the icecast encoders
  # are: an encoder parameter is resolved at parse time and a ref won't do.
  hls_shutdown =
    if hls_enabled() then
      hls_dir = "#{state_dir}/hls"
      ignore(file.mkdir(parents=true, hls_dir))
      # Segments are written HERE and moved into hls_dir complete. Same volume,
      # so the move is atomic — and a listener never fetches a file that is
      # still being written. Without it the half-written segments land in the
      # directory the edge serves, under names ending in "tmp".
      hls_tmp_dir = "#{state_dir}/tmp/hls"
      ignore(file.mkdir(parents=true, hls_tmp_dir))
      # Segment filenames that are unique FOREVER, not just within one run.
      #
      # The default name is <stream>_<position>.ts, and position restarts from
      # scratch whenever hls.config is lost — so yesterday's URL comes back
      # pointing at different audio. Anything caching between the station and
      # the listener (the operator's proxy, a CDN, the client itself) then
      # answers a new segment with old sound, and no amount of Cache-Control on
      # our side reliably undoes that. Stamping the name is what makes the
      # question moot. Byte-for-byte AzuraCast's scheme, on the same Liquidsoap.
      def hls_segment_name(m) =
        "#{m.stream_name}_#{hls_segment_duration()}_#{int_of_float(time())}_#{m.position}.#{m.extname}"
      end
      # Four AAC variants. Liquidsoap writes one sub-playlist per stream plus a
      # master playlist that lists them, which is what makes the client switch:
      # the player measures its own download rate per segment and steps down a
      # rung when it can't keep ahead, back up when it can. No server decision,
      # no operator knob — the ladder IS the feature, so the rungs are fixed.
      #
      # Literal bitrates because an encoder parameter resolves at parse time.
      hls_out = output.file.hls(
        id="stream_hls",
        fallible=true,
        playlist="live.m3u8",
        segment_duration=float_of_int(hls_segment_duration()),
        segments=hls_segments(),
        # Keep a couple of expired segments on disk past the playlist window so a
        # client that is a beat behind still resolves the URL it already holds.
        segments_overhead=2,
        segment_name=hls_segment_name,
        persist_at="#{state_dir}/hls.config",
        temp_dir=hls_tmp_dir,
        hls_dir,
        [
          ("aac_320", %ffmpeg(format="mpegts", %audio(codec="aac", b="320k", channels=2, samplerate=44100))),
          ("aac_256", %ffmpeg(format="mpegts", %audio(codec="aac", b="256k", channels=2, samplerate=44100))),
          ("aac_192", %ffmpeg(format="mpegts", %audio(codec="aac", b="192k", channels=2, samplerate=44100))),
          ("aac_128", %ffmpeg(format="mpegts", %audio(codec="aac", b="128k", channels=2, samplerate=44100))),
        ],
        radio
      )
      log("HLS on: #{hls_dir}/live.m3u8 · AAC 320/256/192/128k · #{hls_segment_duration()}s x #{hls_segments()} segments")
      hls_out.shutdown
    else
      log("HLS disabled — set stream.hlsEnabled=true in settings to re-enable")
      fun () -> ()
    end

  # Hourly archive. A second MP3 encoder running 24/7 is the biggest CPU cost in
  # the broadcast container, so the whole output is guarded. Built in here so it
  # follows the on-air lifecycle — off air stops the recording, rather than
  # writing hourly files of the emergency loop.
  archive_shutdown =
    if archive_enabled() then
      br = archive_bitrate()
      arch_out =
        if br <= 64 then
          output.file(%mp3(bitrate=64), fallible=true, reopen_when={0m0s}, archive_path, radio)
        elsif br <= 96 then
          output.file(%mp3(bitrate=96), fallible=true, reopen_when={0m0s}, archive_path, radio)
        elsif br <= 128 then
          output.file(%mp3(bitrate=128), fallible=true, reopen_when={0m0s}, archive_path, radio)
        elsif br <= 160 then
          output.file(%mp3(bitrate=160), fallible=true, reopen_when={0m0s}, archive_path, radio)
        elsif br <= 192 then
          output.file(%mp3(bitrate=192), fallible=true, reopen_when={0m0s}, archive_path, radio)
        else
          output.file(%mp3(bitrate=320), fallible=true, reopen_when={0m0s}, archive_path, radio)
        end
      arch_out.shutdown
    else
      log("Hourly archive disabled — set archive.enabled=true in settings to re-enable")
      fun () -> ()
    end
  fun () -> begin
    mp3_out.shutdown()
    opus_shutdown()
    flac_shutdown()
    aac_shutdown()
    hls_shutdown()
    archive_shutdown()
  end
end

stream_shutdown = ref(fun () -> ())
stream_on = ref(false)

def stream_up() =
  if not stream_on() then
    stream_shutdown := make_stream_outputs()
    stream_on := true
  end
end

def stream_down() =
  if stream_on() then
    fn = stream_shutdown()
    fn()
    stream_on := false
    # Drop now-playing.json so the UI stops advertising the last track: the
    # controller reads a missing file as "nothing playing". on_meta rewrites it
    # on the next track once back on air.
    if file.exists("#{state_dir}/now-playing.json") then
      file.remove("#{state_dir}/now-playing.json")
    end
  end
end

# On air at startup, hourly archive included.
stream_up()

# CONTROL — telnet commands, all operator-only, driven by the controller.
#
# `restart` is how every liquidsoap_*.txt setting takes effect: shut down, and
# the container restart-policy brings us back ~3s later with the new values.
server.register(
  "restart",
  description="Shut down so the container restarts with new settings",
  usage="restart",
  fun(_) -> begin
    log("Restart requested via server command")
    shutdown()
    "OK"
  end
)

# Off air / back on air on demand — the mounts go away entirely. Contrast the
# idle gate below, which keeps them up.
server.register(
  "stream_off",
  description="Take the station off air (disconnect the Icecast mount)",
  usage="stream_off",
  fun(_) -> begin
    log("Stream taken off air via server command")
    stream_down()
    "OK"
  end
)

server.register(
  "stream_on",
  description="Bring the station back on air",
  usage="stream_on",
  fun(_) -> begin
    log("Stream brought back on air via server command")
    stream_up()
    "OK"
  end
)

server.register(
  "stream_status",
  description="Report whether the station is on air (on/off)",
  usage="stream_status",
  fun(_) -> if stream_on() then "on" else "off" end
)

# Pause / resume while keeping the mounts up (the idle gate above). Idempotent
# and logs only on a state change, so the controller can re-assert cheaply.
server.register(
  "idle_on",
  description="Silence the programme while nobody listens (mounts stay up)",
  usage="idle_on",
  fun(_) -> begin
    if not idle_mode() then
      log("Idle gate ON via server command — programme paused, mounts stay up")
    end
    idle_mode := true
    "OK"
  end
)

server.register(
  "idle_off",
  description="Resume the programme after an idle pause",
  usage="idle_off",
  fun(_) -> begin
    if idle_mode() then
      log("Idle gate OFF via server command — programme resumed")
    end
    idle_mode := false
    "OK"
  end
)

server.register(
  "idle_status",
  description="Report whether the idle gate is active (on/off)",
  usage="idle_status",
  fun(_) -> if idle_mode() then "on" else "off" end
)

# Skip the current track: .skip() on the final source propagates down the chain
# and force-ends the track, after which the crossfade runs its normal handover into
# the next one (dj_queue item, else auto).
server.register(
  "skip",
  description="Skip the currently playing track",
  usage="skip",
  fun(_) -> begin
    log("Skip requested via server command")
    radio.skip()
    "OK"
  end
)

server.register(
  "subhttp_probe_status",
  description="Consume a proto_subhttp completion outcome: ready / failed / pending",
  usage="subhttp_probe_status <probe-id>",
  fun(arg) -> take_subhttp_outcome(string.trim(arg))
)

# What a skip would air next from dj_queue: "ready" (a resolved request is
# waiting), "resolving" (pushed but still downloading, so a skip now falls
# through to auto.m3u), or "empty". The controller polls this before `skip` so
# an operator skip airs the committed pick (#1300 bug 6). A request already
# popped for boundary prefetch is in neither state and reads as "empty", which
# the caller treats as keep-waiting, never as proof of an idle queue.
server.register(
  "dj_queue_status",
  description="Report the pending dj_queue state: ready / resolving / empty",
  usage="dj_queue_status",
  fun(_) -> begin
    q = dj_queue.queue()
    if list.length(q) == 0 then
      "empty"
    else
      ready = list.filter(fun(r) -> request.status(r) == "ready", q)
      if list.length(ready) > 0 then "ready" else "resolving" end
    end
  end
)

# Remove a PENDING request from dj_queue by RID, for DELETE /dj/queue/:trackId.
# Anything on air or already pulled as the next source is no longer in .queue()
# and answers NOT_FOUND, which the caller treats as "too late to cancel".
server.register(
  "dj_queue_remove",
  description="Remove a pending request from dj_queue by request id",
  usage="dj_queue_remove <rid>",
  fun(arg) -> begin
    rid = string.trim(arg)
    q = dj_queue.queue()
    matches = list.filter(fun(r) -> "#{request.id(r)}" == rid, q)
    if list.length(matches) == 0 then
      "NOT_FOUND"
    else
      # Removal MUST go through the stdlib's remove(). A filter +
      # set_queue(kept) rebuild looks equivalent but set_queue() FLUSHES
      # request.dynamic's inner queue wholesale, and a request already popped
      # for prefetch is in NEITHER visible list while its download runs, so the
      # flush orphans it.
      list.iter(fun(r) -> dj_queue.remove(r), matches)
      # Release the dropped request's file/URI now, rather than waiting for
      # Liquidsoap to flag it as leaked.
      list.iter(fun(r) -> request.destroy(r), matches)
      log("Removed request #{rid} from dj_queue via server command")
      "OK"
    end
  end
)
