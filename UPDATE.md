# Update

Stack stoppen.

```bash
sudo -i
cd /volume2/docker/subwave
rm -rf src
curl -fsSL https://github.com/gatzenga/subwave/archive/refs/heads/develop.tar.gz | tar xz
mv subwave-develop src
cd src
docker build -f docker/Dockerfile.aio --build-arg WITH_CLAP=1 --build-arg WITH_DEMUCS=1 --build-arg SITE_URL=https://subwave.vkugler.ch -t subwave:latest .
cp /volume2/docker/subwave/src/docker-compose.yml /volume2/docker/subwave/docker-compose.yaml
```

Stack starten.

```bash
docker image prune -f
```

## Prüfen

```bash
docker run --rm subwave:latest liquidsoap --check /etc/liquidsoap/radio.liq
curl -sI https://subwave.vkugler.ch/hls/live.m3u8 | head -1
curl -sI https://subwave.vkugler.ch/stream.mp3 | head -1
docker logs subwave --tail 50
```

## Rollback

```bash
docker images | grep subwave
docker tag <alte-image-id> subwave:latest
```

Stack neu starten.
