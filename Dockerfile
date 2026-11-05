FROM node:24-bookworm-slim

ARG TARGETARCH
ARG TTYD_VERSION=1.7.7

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git openssh-client procps ripgrep tmux tini \
    && rm -rf /var/lib/apt/lists/*

# Download the upstream ttyd binary and verify its pinned SHA-256.
RUN set -eux; \
    case "${TARGETARCH:-amd64}" in \
      amd64) ttyd_arch=x86_64; ttyd_sha=8a217c968aba172e0dbf3f34447218dc015bc4d5e59bf51db2f2cd12b7be4f55 ;; \
      arm64) ttyd_arch=aarch64; ttyd_sha=b38acadd89d1d396a0f5649aa52c539edbad07f4bc7348b27b4f4b7219dd4165 ;; \
      *) echo "Unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl --fail --location --show-error --silent \
      "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.${ttyd_arch}" \
      --output /usr/local/bin/ttyd; \
    echo "${ttyd_sha}  /usr/local/bin/ttyd" | sha256sum -c -; \
    chmod 0755 /usr/local/bin/ttyd

RUN npm install --global @openai/codex && npm cache clean --force

ENV HOME=/home/node \
    TERM=xterm-256color

USER node
WORKDIR /workspace
EXPOSE 7681

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["ttyd", "--writable", "--port", "7681", \
     "--client-option", "fontSize=24", \
     "--client-option", "lineHeight=1.2", \
     "tmux", "new-session", "-A", "-s", "main"]
