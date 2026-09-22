#!/usr/bin/env bash
# PID 1 for the all-in-one image. Decides ONE thing — which uid the station
# runs as — and then hands over to the supervisor, which is unchanged either
# way.
#
# Without PUID/PGID this is a no-op: exec the supervisor as root, exactly as
# the image did before this file existed. That is the contract. An existing
# station must not be able to tell this shipped.
#
# With PUID/PGID it rewrites the baked-in `subwave` user to those ids, hands it
# the few directories inside the IMAGE that get written at runtime, and drops
# privileges. It does NOT touch the state volume beyond its top level: the
# operator owns that through their NAS's ACLs, and a container rewriting
# ownership on a volume it did not create is exactly the surprise this change
# exists to remove.
#
# Nothing here is fatal. Every failure warns and continues as root — a station
# that refuses to boot over an ownership convenience is strictly worse than one
# running with the old permissions and saying so.
#
# Sourceable for tests: SUBWAVE_ENTRYPOINT_LIB=1 stops before it acts.
set -u

log() { printf '[entrypoint] %s\n' "$*" >&2; }

# Image-side paths written at runtime. Small and ours, so a recursive chown is
# cheap and safe. The state volume is deliberately NOT in this list.
IMAGE_WRITABLE_DIRS="/etc/icecast2 /var/log/icecast2 /var/run/icecast2 /var/log/liquidsoap /web/.next"

# PURE. Decides who the station runs as, given the operator's two variables and
# the uid this process already has. Echoes either `root` (change nothing) or
# `<uid>:<gid>`. Every rejection is silent-by-return — the caller logs, so the
# decision stays testable.
#
# Both variables are required together: a PUID without a PGID would leave the
# group as whatever the image baked in, which is precisely the half-applied
# ownership this is meant to end. Malformed means unset, per the same rule
# every setting in this codebase follows.
subwave_target_ids() {
	local puid=${1:-} pgid=${2:-} current_uid=${3:-0}
	# Not root: nothing to drop from, and no id to rewrite with.
	[ "$current_uid" = "0" ] || { echo root; return 0; }
	case "$puid" in ''|*[!0-9]*) echo root; return 0 ;; esac
	case "$pgid" in ''|*[!0-9]*) echo root; return 0 ;; esac
	# PUID=0 is "run as root", stated explicitly rather than by omission.
	[ "$puid" != "0" ] || { echo root; return 0; }
	echo "${puid}:${pgid}"
}

if [ "${SUBWAVE_ENTRYPOINT_LIB:-}" = "1" ]; then
	return 0 2>/dev/null || exit 0
fi

SUPERVISOR=${SUBWAVE_SUPERVISOR_BIN:-/usr/local/bin/subwave-supervisor}
TARGET=$(subwave_target_ids "${PUID:-}" "${PGID:-}" "$(id -u)")

if [ "$TARGET" = "root" ]; then
	# The branch every existing station takes. Say why only when the operator
	# clearly meant to use the feature and it did not apply.
	if [ -n "${PUID:-}${PGID:-}" ] && [ "$(id -u)" = "0" ]; then
		log "PUID='${PUID:-}' PGID='${PGID:-}' not usable as a pair — running as root, unchanged"
	fi
	exec "$SUPERVISOR"
fi

UID_WANTED=${TARGET%%:*}
GID_WANTED=${TARGET##*:}

# Every tool below is standard Debian, but a missing one must degrade rather
# than strand the operator with a container that will not start.
for tool in groupmod usermod setpriv; do
	command -v "$tool" >/dev/null 2>&1 && continue
	log "WARNING $tool is missing from this image — cannot switch user, running as root"
	exec "$SUPERVISOR"
done

# -o allows an id that already belongs to another account: on a NAS the
# operator's ids are whatever their system handed out, not ours to refuse.
groupmod -o -g "$GID_WANTED" subwave 2>/dev/null \
	|| log "WARNING could not set group id $GID_WANTED"
usermod -o -u "$UID_WANTED" -g "$GID_WANTED" subwave 2>/dev/null \
	|| log "WARNING could not set user id $UID_WANTED"

for d in $IMAGE_WRITABLE_DIRS; do
	mkdir -p "$d" 2>/dev/null || true
	chown -R "$UID_WANTED:$GID_WANTED" "$d" 2>/dev/null \
		|| log "WARNING could not hand $d to $UID_WANTED:$GID_WANTED"
done

# The state volume: its TOP level only, and only when it is still ours from the
# image build. Everything inside belongs to the operator's ACL. If this fails,
# the supervisor's own bootstrap reports which directory it cannot write.
chown "$UID_WANTED:$GID_WANTED" /var/sub-wave 2>/dev/null || true

# Tells the supervisor that one uid owns everything now, so it can stop
# spraying 777 over the state tree — which on a NAS overwrites the ACL the
# operator just set, and is half the reason this change exists.
export SUBWAVE_SINGLE_UID=1

log "running as ${UID_WANTED}:${GID_WANTED}"
exec setpriv --reuid "$UID_WANTED" --regid "$GID_WANTED" --init-groups "$SUPERVISOR"
