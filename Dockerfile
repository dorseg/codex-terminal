FROM node:24-bookworm-slim AS dependencies

RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/codex-terminal
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Build with scripts/build.sh (or --no-cache-filter remobi) to refresh latest.
FROM dependencies AS remobi
RUN npm install --no-save --package-lock=false --build-from-source remobi@latest \
    && node -p "'Installed remobi@' + require('./node_modules/remobi/package.json').version" \
    && npm cache clean --force

FROM node:24-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git openssh-client procps ripgrep tmux tini \
    && rm -rf /var/lib/apt/lists/*
RUN npm install --global @openai/codex && npm cache clean --force

ENV HOME=/home/node \
    TERM=xterm-256color

COPY --from=remobi /opt/codex-terminal /opt/codex-terminal
COPY app /opt/codex-terminal
COPY tmux.conf /etc/tmux.conf

USER node
WORKDIR /workspace
EXPOSE 7681

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/opt/codex-terminal/start.mjs"]
