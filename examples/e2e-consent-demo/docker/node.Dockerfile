# Shared image for the consent demo's seed, service providers, and agent.
# They live in one workspace package and differ only by which entrypoint runs,
# so compose overrides the command per service.
#
# Build context: this repo's root (see docker-compose.yml's `context: ../..`).
# Nothing outside this repo is needed -- @helixid/sdk-js and @helixid/widget
# are both published npm packages, so a plain `pnpm install` resolves them
# from the registry with no sibling checkout and no credentials.
#
#   docker build -f examples/e2e-consent-demo/docker/node.Dockerfile -t helixid-consent-node .
FROM node:24.15.0-alpine

RUN corepack enable
# Prefer IPv4 for package downloads (some Docker VM networks have flaky IPv6).
ENV NODE_OPTIONS=--dns-result-order=ipv4first
# A container has no TTY, so a corepack download prompt would abort the process.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0

WORKDIR /repo

# Workspace metadata first for layer caching, then just this demo's package.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./

# Bake pnpm into the image, version taken from the packageManager field in
# package.json. `corepack enable` only installs shims -- with no prepared
# version the shim downloads pnpm on FIRST USE, so at runtime every container
# start re-downloads it and exits as soon as the prompt finds no TTY.
RUN corepack install

COPY examples/e2e-consent-demo examples/e2e-consent-demo

RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --no-frozen-lockfile --filter @helixid/example-e2e-consent-demo

WORKDIR /repo/examples/e2e-consent-demo
CMD ["pnpm", "run", "agent"]
