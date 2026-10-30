FROM node:24-bookworm-slim AS dependencies

RUN apt-get update && apt-get install --yes --no-install-recommends git ca-certificates
RUN git config --global url."https://github.com/".insteadOf "ssh://git@github.com/" \
    && git config --global --add url."https://github.com/".insteadOf "git@github.com:"

# Keep installer tools outside the application dependency tree. The client's
# pinned Git revision runs prepare; pin its otherwise undeclared copyfiles tool.
RUN npm install --prefix /opt/homey-cli --ignore-scripts --no-audit --no-fund homey@4.6.1 copyfiles@2.4.1
ENV NODE_PATH=/opt/homey-cli/node_modules
ENV PATH=/opt/homey-cli/node_modules/.bin:${PATH}

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
    && node -e 'require("eufy-security-client")'

FROM dependencies AS verified
COPY . .
RUN npm test \
    && node --test helper/config.test.cjs \
    && homey app validate --level debug \
    && homey app build \
    && node scripts/check-media.cjs
RUN --network=none node scripts/check-p2p-lifecycle.cjs \
    && node scripts/check-owned-p2p-lifecycle.cjs \
    && node scripts/check-native-video-rsa.cjs
RUN --network=none node scripts/check-camera-helper.cjs

FROM verified AS installer
RUN node scripts/check-package.cjs

ENV HOMEY_HOME=/auth
CMD ["sh", "-c", "if [ -n \"${HOMEY_ID:-}\" ]; then homey select --id \"$HOMEY_ID\"; else homey select; fi && node scripts/install-app.cjs"]
