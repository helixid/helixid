# e2e-travel-concierge-py — the travel concierge demo, in Python

A port of [`../e2e-travel-concierge`](../e2e-travel-concierge) that drives the
same flow through [`helixid-sdk-py`](https://github.com/helixid/helix-sdk-py)
instead of the JavaScript SDK. Same assertion, same trust model — an LLM agent
enrolls, receives a real credential, and the MCP tool refuses to run until the
presentation verifies against the live HelixID API.

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
*same* `search_flights` / `book_flight` tools — only the credential changes.

| Use case | Credential state | Expected |
|---|---|---|
| 1 — Full-access agent | Concierge has `read:catalog` + `write:orders` | Booking succeeds |
| 2 — Read-only agent | Agent onboarded with only `read:catalog` | Search succeeds; booking refused for missing `write:orders` |
| 3 — Revoked credential | Concierge's VC revoked through the live API | Presentation rejected — the status-list bit is set |
| 4 — Delegated agent | Research holds a Planner-signed child VC with `read:catalog` | Delegated search succeeds; booking refused |

Start with use case 1 and **Book flight BA249 for Ada Lovelace**. Then refresh
**Console → Audit** to see enrollment, issuance, and the `VP_VERIFIED` event.

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
| `helixid-setup` | built from the TypeScript demo's `node.Dockerfile` | the seeder is shared; it records each persona's DID in the manifest, and the Python services read that same shape (`agentDid`) directly |
| `web` | built from the TypeScript demo's `web/` | the chat UI is identical, so it isn't duplicated |
| `console` | **pulled** from Docker Hub (`helixid/console`) | the Console is a separate repo (`helixid/helix-console`) that publishes a multi-arch image, so there's no reason to make you clone and build it |

`docker/console.Dockerfile` is two lines: `FROM helixid/console:latest` plus
this example's `docker/console-nginx.conf`, which serves the Console SPA and
reverse-proxies `/v1` and `/health` to `helix-api` so the browser talks to the
API **same-origin** — the demo API ships without CORS.

`helixid-sdk-py` is installed straight from its public repo during the image
build (`pip install "helixid-sdk-py[mcp-middleware] @ git+https://github.com/helixid/helix-sdk-py"`).
Nothing is vendored from a sibling directory.

## Prerequisites

- **Docker + Docker Compose.**
- **An LLM API key** — Anthropic (default), OpenAI, or Azure OpenAI. The agent
  is a genuine LLM agent; it decides which tool to call.
- **No Hedera credentials.** Agents are onboarded as `did:key` identities and
  the issuer runs in `did:key` mode, so the trust flow is fully real and fully
  local.
