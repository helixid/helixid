# Shared image for the four Python services (seed, sp-airline, sp-hotel,
# agent). They differ only by which module's __main__ runs, so compose
# overrides the command per service.
#
# Build context: this repo's root (see docker-compose.yml's `context: ../..`).
# Nothing outside this repo is needed -- helixid-sdk-py is a published PyPI
# package, and the consent widget's browser bundle is built in the first
# stage below from the published @helixid/widget npm package.

# ── Stage 1: get @helixid/widget's browser bundle ────────────────────────────
# @helixid/widget has no Python port; the SPs serve its pre-built dist as
# static assets. The npm package already ships a pre-built dist/, so this is
# just a plain install -- no build step needed.
FROM node:24.15.0-alpine AS widget
WORKDIR /w
RUN npm init -y >/dev/null && npm install --no-save @helixid/widget@^0.1.0
RUN mkdir -p /widget-dist && cp -r /w/node_modules/@helixid/widget/dist/. /widget-dist/

# ── Stage 2: the demo itself ─────────────────────────────────────────────────
FROM python:3.11-slim

WORKDIR /repo

# pynacl and cryptography (helix-sdk-py's crypto deps) ship manylinux wheels,
# so gcc is only a fallback.
RUN apt-get update && apt-get install -y --no-install-recommends gcc && rm -rf /var/lib/apt/lists/*

# Manifests first for layer caching.
COPY examples/e2e-consent-demo-py/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# helix-sdk-py from PyPI.
RUN pip install --no-cache-dir "helixid-sdk-py[dev]>=0.1.1"

# The demo itself.
COPY examples/e2e-consent-demo-py examples/e2e-consent-demo-py

# Widget bundle from stage 1. sp_shared/serve.py looks here by default; a
# non-Docker run can point WIDGET_DIST_PATH somewhere else instead.
COPY --from=widget /widget-dist \
     /repo/examples/e2e-consent-demo-py/widget-dist

WORKDIR /repo/examples/e2e-consent-demo-py
# Default command; docker-compose overrides it per service.
CMD ["python", "-m", "agent.server"]
