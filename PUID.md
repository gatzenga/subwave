# Running as a non-root user (PUID / PGID)

**Status: plan, not implemented.** This is the working paper for that change —
what is true today, what has to move, in which order, and how we know it worked.

The operator's goal, in their words: create a `subwave` user on the NAS, hand
that user the folder (ACL, not chmod), pass its ids into the container, done.

## Where we are today

| Process | Runs as | Writes outside the state dir |
| --- | --- | --- |
| icecast2 | **`icecast2`** (via `sudo -E -u`) | `/etc/icecast2/icecast.xml` (rendered at boot), `/var/log/icecast2`, `/var/run/icecast2` |
| liquidsoap | root | `/var/log/liquidsoap` (symlinked into the state root), `/tmp` |
| controller (node) | root | `/tmp`, Demucs weights → `~/.cache/torch` |
| web (next.js) | root | `/web/.next/cache` |
| caddy | root | `$HOME/.local/share/caddy`, binds **port 80** |

Two uids already share one directory, which is the whole reason
`docker/aio/supervisor.sh` sprays `chmod 777` over the state tree and warns when
it cannot. The cost is not tidiness: `secrets.env` is deliberately `600` inside a
`777` directory, and on the host every file belongs to root, so the operator
needs sudo to read their own logs and a backup runs as the wrong user.

`HF_HOME=/var/sub-wave/hf-cache` is already set — the CLAP side of the model
cache is in the state dir and needs nothing. Demucs is NOT: it pulls `htdemucs`
through `torch.hub`, which writes to `TORCH_HOME` or, unset as it is today,
`~/.cache/torch`. Under root that is `/root/.cache`. **This is the one trap in
the whole change**: miss it and every container start re-downloads hundreds of
megabytes, or the analyzer simply fails.

## The contract

- **`PUID`/`PGID` absent → byte-identical to today.** Root, `sudo -u icecast2`,
  the 777 fallback, all of it. An existing station must not notice this shipped.
  (Same rule as every settings default: absent coerces to the pre-existing
  behaviour.)
- **Set → one uid owns everything.** All five processes run as it, every file it
  creates belongs to it, and the blanket 777 is not needed any more.
- **A failure warns and continues.** A station that refuses to boot over an
  ownership convenience is worse than one on a degraded mount — the same posture
  `bootstrap_state_dirs` already takes.
- **With `PUID` set the container performs no `chmod` and no `chown` at all.**
  Not on boot, not ever. This is the actual requirement, stated by the operator:
  they set owner and rights once in the NAS interface and never touch it again.
  A container that rewrites modes on every start is precisely the Nextcloud
  misery being escaped — and worse on a NAS, because a blanket `chmod 777`
  overwrites the ACL the operator just set. We read and write as the id we were
  given; anything we cannot write, we report.

## What has to move

| # | Thing | Why | Risk |
| --- | --- | --- | --- |
| 1 | Caddy binds **:80** | Ports below 1024 need root. Listen on **8080** instead; compose maps `7700:8080`; `EXPOSE 8080`. Rejected the alternative (`setcap cap_net_bind_service`) — it survives neither a rebuild nor a reader's understanding. | low |
| 2 | `sudo -E -u icecast2` | Goes away: one user runs everything. `/var/log/icecast2` + `/var/run/icecast2` get chowned at build. | low |
| 3 | `/etc/icecast2` | The supervisor renders `icecast.xml`, `stream-mounts.xml` and `trusted-proxies.xml` into it at every boot. Must be writable by the user. | low |
| 4 | Caddy's data dir | Defaults to `$HOME/.local/share/caddy`. Set `XDG_DATA_HOME` + `XDG_CONFIG_HOME` under the state dir so it has somewhere to write whatever uid it runs as. | low, silent when wrong |
| 5 | **`TORCH_HOME`** | Demucs weights, see above. Point it at the state dir beside `HF_HOME`. | **the real one** |
| 6 | `/web/.next/cache` | Next.js standalone writes its runtime cache there. Chown at build. | low |
| 7 | The `chmod 777` block | Keep for the root path; skip it when we own the tree. Do not delete — the fallback is what keeps an upgraded station booting. | medium |

## Implementation sketch

**`docker/Dockerfile.aio`**
- Create the user: `groupadd -g 1000 subwave && useradd -u 1000 -g 1000 -d /var/sub-wave -s /bin/sh subwave` (ids are defaults; the entrypoint rewrites them).
- `chown subwave:subwave` on `/etc/icecast2`, `/var/log/icecast2`, `/var/run/icecast2`, `/var/log/liquidsoap`, `/web/.next`.
- `ENV TORCH_HOME=/var/sub-wave/torch-cache XDG_DATA_HOME=/var/sub-wave/xdg XDG_CONFIG_HOME=/var/sub-wave/xdg`.
- `EXPOSE 8080` and the Caddyfile's `:80` → `:8080`.

**New entrypoint, ahead of `supervisor.sh`**
1. No `PUID`/`PGID`, or not running as root → `exec supervisor.sh` unchanged. This is the branch every existing install takes.
2. Otherwise: `groupmod -o -g "$PGID" subwave`, `usermod -o -u "$PUID" subwave`, chown the image-side dirs listed above (they are small and ours), best-effort chown of `/var/sub-wave` itself (not `-R`), then
   `exec setpriv --reuid "$PUID" --regid "$PGID" --init-groups supervisor.sh`.
   `setpriv` comes with util-linux and is already in the image — no `gosu`, no new dependency.

**`docker/aio/supervisor.sh`**
- Drop the `sudo -E -u icecast2` prefix (the whole script already runs as the right user by then).
- Gate the 777 sweep: when the tree is already ours, skip and log one line saying so.

**`docker-compose.yml`**
- Document `PUID` / `PGID`, change the port mapping to `127.0.0.1:7700:8080`.

## Order of work

1. Dockerfile user + ownership + env (nothing behaves differently yet).
2. Caddy to 8080 + compose mapping. **Verify the station still plays** before going further — this alone can take the edge down.
3. Entrypoint with the root fallback. Verify again with no `PUID` set: must be identical to today.
4. `sudo` removal + the 777 gate.
5. Only then set `PUID`/`PGID` on the NAS and watch it come up.

## Migration for the existing station

The state dir is full of root-owned files from the root era. That is cleared up
**once, in the NAS interface** — set the folder's owner to `subwave` with read
and write, let it apply recursively — not with a shell command, and never again
afterwards. Everything the container creates from then on belongs to that id by
construction, and a default ACL on the folder carries the rights to new files
without anyone intervening.

If the container does boot into a tree it cannot write, it says so in the log
and keeps running on what it can reach. It will not try to fix it.

## How we know it worked

- `docker exec subwave ps -o user,comm` → five processes, one user, no root.
- `ls -l /volume2/docker/subwave/state` on the host → everything owned by
  `subwave`, and no more `777` modes on new files.
- `secrets.env` still `600`.
- Station plays, admin loads, `/hls/live.m3u8` serves, a track gets analysed
  (proves the model caches resolved), Piper speaks (proves `state/voice` is
  writable).
- Unset `PUID`/`PGID`, restart: everything still works, as root, exactly as
  before.

## Settled

Whether the container should repair ownership itself: **no.** Report, never
touch. The operator manages this in the NAS interface, and the point of the
whole change is that it stays managed there — the container's job is to run
under the id it is given and stop having opinions about permissions.

The 777 sweep is therefore not just skipped when `PUID` is set; skipping it is
half the value of the change.
