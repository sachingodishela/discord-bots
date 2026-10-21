FROM node:24-bookworm-slim

ARG COPILOT_VERSION=1.0.101

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git ripgrep \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g "@github/copilot@${COPILOT_VERSION}" \
    && npm cache clean --force \
    && mkdir -p /data/state /workspace /home/node/.copilot \
    && chown -R node:node /data /workspace /home/node/.copilot

ENV NODE_ENV=production
WORKDIR /app

COPY package.json ./
COPY --chown=node:node src ./src

USER node
CMD ["node", "src/index.js"]
