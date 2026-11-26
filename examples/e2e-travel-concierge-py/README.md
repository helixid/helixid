# e2e-travel-concierge-py — the travel concierge demo, in Python

> **`docker compose up` needs the KYA-OS releases.** This example runs on
> KYA-OS (request proofs, delegation chains, local verification) and depends on
> `helixid-sdk-py` 3.0 (with its middleware), and on the TypeScript demo's
> seeder, which needs `@helixid/sdk-js` 1.0. Until they are published, run the
> processes against local packages: see
> [Run against local packages](#run-against-local-packages).

A port of [`../e2e-travel-concierge`](../e2e-travel-concierge) that drives the
same flow through [`helixid-sdk-py`](https://github.com/helixid/helix-sdk-py)
instead of the JavaScript SDK. Same assertion, same trust model — a
self-custody LLM agent signs every tool call with its own key, and the MCP tool
refuses to run until the request proof and the delegation chain the agent
carries verify, in-process (KYA-OS).

Ports are offset so this demo can run **side by side** with the TypeScript one.

## Run it

You need **this repo and Docker. Nothing else** — no second checkout, no
pre-built sibling packages, no registry credentials:

```sh
git clone https://github.com/helixid/helixid.git
cd helixid/examples/e2e-travel-concierge-py
cp .env.example .env
#   edit .env → set LLM_API_KEY
#   LLM_PROVIDER is anthropic by default; openai | azure | gemini also work
docker compose up --build
```

Wait for `helixid-setup` to print `Seed complete` and exit, then open:

| URL | What |
|---|---|
| http://localhost:8091 | **Web chat** — pick the acting agent, talk to it |
| http://localhost:8082 | **Console** — log in `admin` / `admin`, open **Audit** |
| http://localhost:3002 | HelixID API |
| http://localhost:7101 | MCP server |
| http://localhost:4001 | Agent |

Reset to a clean slate: `docker compose down -v`.

## What to try

The chat has four guided use cases. All four hit the *same* MCP server and the
*same* `search_flights` / `book_flight` tools — only the agent's card and chain
change.

| Use case | Persona state | Expected |
|---|---|---|
| 1 — Full-access agent | Concierge is attested for `read:catalog` + `write:orders`; its chain allows both | Booking succeeds |
| 2 — Read-only agent | An agent onboarded at runtime (its key generated here) is attested for `read:catalog` only | Search succeeds; booking refused (`INSUFFICIENT_SCOPE`) |
| 3 — Revoked agent | Concierge's identity credential and root hop revoked through the live API | Call refused (`STATUS_REVOKED`) |
| 4 — Delegated agent | Research has no authority of its own, then carries a hop Planner signed with its own key allowing `read:catalog` | Delegated search succeeds; booking refused (`INSUFFICIENT_SCOPE`) |

Start with use case 1 and **Book flight BA249 for Ada Lovelace**. The MCP server
log shows the `GRANTED` decision; **Console → Audit** shows the agents'
creation, enrollment and issuance.

The no-LLM checks are the TypeScript demo's (same routes, same ports offset):
`POST /call-tool` on the agent, and a `tools/call` with no request proof to the
MCP server (refused `PROOF_MISSING`).

> This demo has **no scripted fallback**: if the LLM provider errors, the chat
> shows the provider error rather than degrading. The free Gemini tier returns
> `503 UNAVAILABLE` under load and rate-limits quickly, so prefer `anthropic`
> or `openai` for a steady run.

Ports, sign-ins and troubleshooting for every demo:
[`../README.md`](../README.md).

## What `docker compose up` actually does

Some services are built from this repo, one is pulled ready-made:

| Service | Where it comes from | Why |
|---|---|---|
| `helix-api` | built from this repo's root `Dockerfile` | it's the thing being demoed — you're running the code you just cloned |
| `mcp-server`, `agent` | built from `docker/python.Dockerfile` | the Python demo code, lives here |
| `helixid-setup` | built from the TypeScript demo's `node.Dockerfile` | the seeder is shared; it enrolls the service and the Concierge (keys on the shared volume) and writes the persona manifest, which the Python services read directly |
| `web` | built from the TypeScript demo's `web/` | the chat UI is identical, so it isn't duplicated |
| `console` | **pulled** from Docker Hub (`helixid/console`) | the Console is a separate repo (`helixid/helix-console`) that publishes a multi-arch image, so there's no reason to make you clone and build it |

`docker/console.Dockerfile` is two lines: `FROM helixid/console:latest` plus
this example's `docker/console-nginx.conf`, which serves the Console SPA and
reverse-proxies `/v1` and `/health` to `helix-api` so the browser talks to the
API **same-origin** — the demo API ships without CORS.

`helixid-sdk-py` is installed from PyPI during the image build
(`pip install "helixid-sdk-py[mcp-middleware]>=3.0"`). Nothing is vendored from a
sibling directory.

## Run against local packages

Until the KYA-OS releases are out, run HelixID's API from this repo
(`DID_METHOD=web`, `DID_DOMAIN` set to its host:port), the TypeScript demo's
seeder against local packages (see its README), and the Python services with a
local `helix-sdk-py` checkout installed (`pip install -e ../../../helix-sdk-py`):

```sh
export HELIX_API_URL=http://127.0.0.1:3000 HELIX_ADMIN_API_KEY=<the API's admin key> WALLETS_DIR=./.data MCP_PORT=7101 MCP_SERVER_URL=http://127.0.0.1:7101/mcp AGENT_PORT=4001
(cd ../e2e-travel-concierge && pnpm run setup)
python -m mcp_server.server & python -m agent.server
```

## Prerequisites

- **Docker + Docker Compose.**
- **An LLM API key** — Anthropic (default), OpenAI, or Azure OpenAI. The agent
  is a genuine LLM agent; it decides which tool to call.
- **No Hedera credentials.** HelixID runs in `did:web` mode and hosts each
  agent's and the service's DID document; each agent's key is generated by
  `helix init` and never leaves its own key directory. The trust flow is fully
  real and fully local.
