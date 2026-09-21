#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

PLATFORM=linux/arm64
ARCH_LABEL=arm
IMAGE=subwave
TAG=${TAG:-latest}
SITE_URL=${SITE_URL:-https://subwave.vkugler.ch}

if [ "${LEAN:-0}" = "1" ]; then
  BUILD_ARGS=(--build-arg WITH_CLAP=0 --build-arg WITH_DEMUCS=0)
  FLAVOUR=lean
else
  BUILD_ARGS=(--build-arg WITH_CLAP=1 --build-arg WITH_DEMUCS=1)
  FLAVOUR=heavy
fi

OUT="$HOME/Desktop/${IMAGE}-${ARCH_LABEL}-${FLAVOUR}-${TAG}.tar"

docker build \
  --platform "$PLATFORM" \
  -f docker/Dockerfile.aio \
  "${BUILD_ARGS[@]}" \
  --build-arg SITE_URL="$SITE_URL" \
  -t "${IMAGE}:${TAG}" \
  .

rm -f "$OUT"
docker save "${IMAGE}:${TAG}" -o "$OUT"

echo
echo "$OUT"
echo "$(du -h "$OUT" | cut -f1)"
