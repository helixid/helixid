# Shared image for the four Python services (seed, sp-airline, sp-hotel,
# agent). They differ only by which module's __main__ runs, so compose
# overrides the command per service.
#
# Build context: this repo's root (see docker-compose.yml's `context: ../..`).
# Nothing outside this repo is needed -- helixid-sdk-py comes from the public
# helixid/helix-sdk-py repo, and the consent widget's browser bundle is built
# in the first stage below from the public helixid/helix-sdk-js repo.

# ── Stage 1: build @helixid/widget's browser bundle ──────────────────────────
# @helixid/widget has no Python port; the SPs serve its pre-built dist as
# static assets. Installing the package runs its own prepare/build script,
# which is what produces dist/.
FROM node:24.15.0-alpine AS widget
RUN apk add --no-cache git
# A container has no TTY, so a corepack download prompt would abort the build.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# This must be pnpm, and specifically pnpm 9, for two independent reasons:
#   * `#path:` is pnpm-only syntax. npm silently ignores it and installs the
#     helix-sdk-js workspace ROOT, which has no dist/ and builds nothing.
#   * pnpm 10 refuses to run a git dependency's prepare script
#     (ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED), and that prepare is what builds
#     dist/. 9.15.2 matches the packageManager both repos pin.
RUN corepack enable && corepack prepare pnpm@9.15.2 --activate
WORKDIR /w
RUN npm init -y >/dev/null
RUN pnpm add "github:helixid/helix-sdk-js#path:widget"
# pnpm links the package out of a content-addressed store, so dereference the
# symlink into plain files that the COPY in the next stage can read.
RUN mkdir -p /widget-dist && cp -rL /w/node_modules/@helixid/widget/dist/. /widget-dist/

# ── Stage 2: the demo itself ─────────────────────────────────────────────────
FROM python:3.11-slim

WORKDIR /repo

# pynacl and cryptography (helix-sdk-py's crypto deps) ship manylinux wheels,
# so gcc is only a fallback; git resolves the pip git+ spec below.
RUN apt-get update && apt-get install -y --no-install-recommends gcc git && rm -rf /var/lib/apt/lists/*

# Manifests first for layer caching.
COPY examples/e2e-consent-demo-py/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# helix-sdk-py from its public repo.
RUN pip install --no-cache-dir \
    "helixid-sdk-py[dev] @ git+https://github.com/helixid/helix-sdk-py"

# The demo itself.
COPY examples/e2e-consent-demo-py examples/e2e-consent-demo-py

# Widget bundle from stage 1. sp_shared/serve.py looks here by default; a
# non-Docker run can point WIDGET_DIST_PATH somewhere else instead.
COPY --from=widget /widget-dist \
     /repo/examples/e2e-consent-demo-py/widget-dist

WORKDIR /repo/examples/e2e-consent-demo-py
# Default command; docker-compose overrides it per service.
CMD ["python", "-m", "agent.server"]
