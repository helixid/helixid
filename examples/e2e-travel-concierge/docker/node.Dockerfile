# Shared image for the three Node services (helixid-setup, mcp-server, agent).
# They live in one workspace package and differ only by which entrypoint runs,
# so compose overrides the command per service.
#
# Build context: this repo's root (see docker-compose.yml's `context: ../..`).
# Nothing outside this repo is needed -- @helixid/sdk-js and @helixid/mcp are
# git dependencies on the public helixid/helix-sdk-js repo (@helixid/mcp is
# this consumer's own dependency key for that repo's mcp-middleware package),
# so a plain `pnpm install` resolves them with no sibling checkout.
#
#   docker build -f examples/e2e-travel-concierge/docker/node.Dockerfile -t helixid-travel-node .
FROM node:24.15.0-alpine
RUN corepack enable
# git is what resolves the github: dependency specs above.
RUN apk add --no-cache git
# Prefer IPv4 for package downloads (some Docker VM networks have flaky IPv6).
ENV NODE_OPTIONS=--dns-result-order=ipv4first
# A container has no TTY, so a corepack download prompt would abort the process.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /repo

# Manifests first for layer caching, then the sources this example builds against.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./

# Bake pnpm into the image, version taken from the packageManager field in
# package.json. `corepack enable` only installs shims -- with no prepared
# version the shim downloads pnpm on FIRST USE, so at runtime every container
# start re-downloads it and exits as soon as the prompt finds no TTY.
RUN corepack install

COPY examples/e2e-travel-concierge examples/e2e-travel-concierge

RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --no-frozen-lockfile --filter @helixid/example-e2e-travel-concierge

WORKDIR /repo/examples/e2e-travel-concierge
# Default command; docker-compose overrides it with `pnpm setup|mcp|agent`.
CMD ["pnpm", "run", "agent"]
