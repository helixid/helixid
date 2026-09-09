# Shared image for the two Python services (mcp-server, agent). They differ
# only by which entrypoint runs, so compose overrides the command per
# service. Python port of ../../e2e-travel-concierge/docker/node.Dockerfile.
#
# Build context: this repo's root (see docker-compose.yml's `context: ../..`).
# Nothing outside this repo is needed -- helixid-sdk-py is a published PyPI
# package, so there's no sibling checkout.
#
#   docker build -f examples/e2e-travel-concierge-py/docker/python.Dockerfile -t helixid-travel-py .
FROM python:3.11-slim

WORKDIR /repo

# gcc for any sdist that needs compiling.
RUN apt-get update && apt-get install -y --no-install-recommends gcc && rm -rf /var/lib/apt/lists/*

# Manifests first for layer caching.
COPY examples/e2e-travel-concierge-py/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# helix-sdk-py from PyPI. The mcp-middleware extra pulls in the official MCP
# SDK that the mcp_server package uses for the wire protocol.
RUN pip install --no-cache-dir "helixid-sdk-py[mcp-middleware]>=0.1.1"

# The demo itself.
COPY examples/e2e-travel-concierge-py examples/e2e-travel-concierge-py

WORKDIR /repo/examples/e2e-travel-concierge-py
# Default command; docker-compose overrides it per service.
CMD ["python", "-m", "agent.server"]
