# Shared image for the four Python services (seed, sp-airline, sp-hotel,
# agent). They differ only by which module's __main__ runs, so compose
# overrides the command per service.
#
# Build context: this repo's root (see docker-compose.yml's `context: ../..`).
# Nothing outside this repo is needed -- helixid-sdk-py (with
# helix_mcp_middleware) is a published PyPI package; this demo needs its
# KYA-OS release (see README.md).
FROM python:3.11-slim

WORKDIR /repo

RUN apt-get update && apt-get install -y --no-install-recommends gcc && rm -rf /var/lib/apt/lists/*

COPY examples/e2e-consent-demo-py/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY examples/e2e-consent-demo-py examples/e2e-consent-demo-py

WORKDIR /repo/examples/e2e-consent-demo-py
CMD ["python", "-m", "agent.server"]
