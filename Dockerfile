FROM node:24-bookworm-slim AS dependencies

RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/codex-terminal
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:24-bookworm-slim AS herdr
ARG TARGETARCH
COPY scripts/install-herdr.mjs /tmp/install-herdr.mjs
RUN node /tmp/install-herdr.mjs "$TARGETARCH" && herdr --version

# Build with scripts/build.sh to refresh stable tooling releases.
FROM dependencies AS remobi
RUN npm install --no-save --package-lock=false --build-from-source remobi@latest \
    && node -p "'Installed remobi@' + require('./node_modules/remobi/package.json').version" \
    && npm cache clean --force
COPY scripts/patch-remobi-client.mjs /tmp/remobi-patch/scripts/
COPY app/mobile-input.js app/mobile-copy.js app/image-attachments.js /tmp/remobi-patch/app/
RUN node /tmp/remobi-patch/scripts/patch-remobi-client.mjs node_modules/remobi/dist/client.iife.js node_modules/remobi/dist/cli.mjs

FROM node:24-bookworm-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git openssh-client procps ripgrep python3 util-linux tini \
    && rm -rf /var/lib/apt/lists/*
RUN npm install --global @openai/codex && npm cache clean --force

ENV HOME=/home/node \
    TERM=xterm-256color

COPY --from=remobi /opt/codex-terminal /opt/codex-terminal
COPY app /opt/codex-terminal
COPY --from=herdr /usr/local/bin/herdr /usr/local/bin/herdr

RUN mkdir -p /workspace && chown node:node /workspace
USER node
WORKDIR /workspace
EXPOSE 7681

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/opt/codex-terminal/start.mjs"]

# Optional automation image. Keep browsers outside both persistent volumes.
FROM runtime AS browser
USER root
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers
COPY scripts/configure-browser.mjs /tmp/configure-browser.mjs
RUN npm install --global @playwright/cli@latest \
    && playwright-cli --version \
    && playwright-cli install-browser chromium --with-deps --no-shell \
    && node /tmp/configure-browser.mjs "$(npm root -g)/@playwright/cli" \
    && chown -R node:node /home/node/.playwright \
    && chmod -R a+rX /opt/playwright-browsers \
    && npm cache clean --force \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* /tmp/configure-browser.mjs
USER node

# A build without --target retains the compact terminal image.
FROM runtime AS default
