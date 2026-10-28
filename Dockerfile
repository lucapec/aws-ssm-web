# syntax=docker/dockerfile:1
#
# NOTE: SAML SSO mode opens a real Chromium on the host for the interactive
# login (playwright-core driving the system browser) - it does not work in
# this container without X11 forwarding and a browser in the image. To use
# SSO run the app directly on the host (`pnpm start`). Local profile mode
# (~/.aws, including IAM Identity Center via `aws sso login`) works the same
# in both.

# ---- deps: build node-pty native binding with pnpm ----
FROM node:24-bookworm-slim AS deps
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# ---- runtime: awscli v2 + session-manager-plugin + app ----
FROM node:24-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl unzip ca-certificates \
    && curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-$(dpkg --print-architecture | sed 's/amd64/x86_64/;s/arm64/aarch64/').zip" -o /tmp/awscliv2.zip \
    && unzip -q /tmp/awscliv2.zip -d /tmp \
    && /tmp/aws/install \
    && rm -rf /tmp/awscliv2.zip /tmp/aws \
    && curl -fsSL "https://s3.amazonaws.com/session-manager-downloads/plugin/latest/$(dpkg --print-architecture | sed 's/amd64/ubuntu_64bit/;s/arm64/ubuntu_arm64/')/session-manager-plugin.deb" -o /tmp/smp.deb \
    && dpkg -i /tmp/smp.deb \
    && rm -f /tmp/smp.deb \
    && apt-get purge -y curl unzip \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

# reuse the "node" user (uid/gid 1000) baked into the base image so it
# matches the host user's uid — needed for the read-only ~/.aws bind mount
WORKDIR /app
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json server.js sso.js aws.js ./
COPY --chown=node:node public ./public
COPY --chown=node:node entrypoint.sh ./
# ~/.aws must exist and be owned by node before docker mounts ~/.aws/sso
# inside it; otherwise docker creates it as root and the entrypoint can't write.
RUN chmod +x entrypoint.sh && install -d -o node -g node /home/node/.aws

USER node
ENV HOME=/home/node
ENV HOST=0.0.0.0
ENV PORT=4177
EXPOSE 4177
ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["node", "server.js"]
