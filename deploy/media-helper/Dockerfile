ARG HELPER_DEPENDENCY_IMAGE=metalcated/homey-eufy-installer:3.44.7-native-test
ARG HELPER_NODE_IMAGE=node:24.21.0-bookworm-slim
FROM --platform=$BUILDPLATFORM ${HELPER_DEPENDENCY_IMAGE} AS helper_dependencies

FROM ${HELPER_NODE_IMAGE} AS helper_runtime_base
RUN --mount=type=cache,target=/var/cache/apt \
    --mount=type=cache,target=/var/lib/apt/lists \
    apt-get update && apt-get install --yes --no-install-recommends ffmpeg ca-certificates

FROM helper_runtime_base AS media-helper
LABEL io.metalcated.eufy-media.protocol="1" \
      io.metalcated.eufy-media.sdk="4.2.6" \
      io.metalcated.eufy-media.version="0.1.2"
WORKDIR /app
# The pinned production dependency tree contains JavaScript/protocol assets and
# no native addons. It is reusable across the build host and the target VM.
COPY --from=helper_dependencies /app/node_modules ./node_modules
COPY lib/helpers ./lib/helpers
COPY helper/service.cjs helper/index.cjs ./helper/
COPY deploy/media-helper/healthcheck.cjs ./healthcheck.cjs
RUN mkdir -p /data /cache && chown node:node /data /cache
USER node
ENV EUFY_MEDIA_BIND=127.0.0.1 \
    EUFY_MEDIA_PORT=8769 \
    EUFY_MEDIA_SECRET_FILE=/data/auth.key \
    EUFY_MEDIA_CACHE_DIR=/cache \
    EUFY_MEDIA_FFMPEG=/usr/bin/ffmpeg
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD ["node", "healthcheck.cjs"]
CMD ["node", "helper/index.cjs"]
