# E2E Travel Concierge — HelixID's trust decisions, scenario by scenario

A real LLM agent calls a **real MCP server** playing two Service Providers, and
every protected tool runs only after HelixID verifies the agent's presentation
against the **live HelixID API** — every verification landing in Console's
audit view.

The web UI walks through 18 guided scenarios (4 basics plus 14 numbered ones):
what an organization-issued credential allows, what a traveler's **consent**
adds, how authority flows (and stops) through **agent-to-agent delegation**,
and **attacks that must fail**. Every scenario onboards its own fresh agents and
checks each step's real outcome against the expected one.

There are no mocks in the HelixID trust and enforcement path. Flight and hotel
inventory and booking responses are intentionally synthetic, but if a
credential is missing, invalid, revoked, out of scope, or lacks the traveler's
consent, the action does not happen — and you can prove it.

---

## What happens

```
Browser ──{personaId, onBehalfOf?, "book H-101"}──▶ Agent (LLM + MCP client)
                     │ 1. LLM picks a tool
                     │ 2. POST /v1/agents/:did/vp {targetService: <service DID>, userDid?}
                     │    → VP with the agent's credential(s) + the traveler's consent grant
                     ▼
     MCP server: Helix Air (/mcp/air) · Helix Stay (/mcp/stay)
        1. replay guard (each VP id once)
        2. POST /v1/vp/verify, bound to this service → VP_VERIFIED / VP_REJECTED (audit)
        3. consent policy (Stay acts only for a consenting traveler)
        4. @helixid/mcp requireScope — effective scopes = agent ∩ traveler's consent
        5. tool runs  ── only if all of the above pass
```

| Service | Tools | Policy |
|---|---|---|
| **Helix Air** | `search_flights` (`read:catalog`), `book_flight` (`write:orders`) | Accepts an agent acting on its own organization-issued authority |
| **Helix Stay** | `search_hotels` (`read:catalog`), `book_hotel` (`write:orders`) | Acts only for a traveler who consented |

Both services are enrolled on the API at startup (`POST /v1/services`), so each
has a platform-minted DID, and the platform signs its consent grants with its key.

## Prerequisites

- **Docker + Docker Compose.**
- **An LLM API key** — Anthropic (default), OpenAI, or Azure OpenAI. The agent is a
  genuine LLM agent; it decides which tool to call.
- **No Hedera credentials.** This demo onboards each agent as a `did:key`
  identity through `POST /v1/onboard` (no on-chain DID anchoring), and the issuer
  runs in `did:key` mode. Agent self-custody is retired, so the server generates
  and holds each agent's key — nothing writes a wallet or a private key locally. The trust flow is fully real
  and fully local. (If `did:key`/Hedera modes change upstream, only the API env in
  `docker-compose.yml` would need revisiting.)

## Run it

You need **this repo and Docker. Nothing else** — no second checkout, no
pre-built sibling packages, no registry credentials:

```sh
git clone https://github.com/helixid/helixid.git
cd helixid/examples/e2e-travel-concierge
cp .env.example .env
#   edit .env → set LLM_API_KEY
#   LLM_PROVIDER is anthropic by default; openai | azure | gemini also work
docker compose up --build
```

### What `docker compose up` actually does

Some services are built from this repo, one is pulled ready-made:

| Service | Where it comes from | Why |
|---|---|---|
| `helix-api` | built from this repo's root `Dockerfile` | it's the thing being demoed — you're running the code you just cloned |
| `helixid-setup`, `mcp-server`, `agent` | built from `docker/node.Dockerfile` | demo code, lives here |
| `web` | built from `web/` | the scenario UI, lives here |
| `console` | **pulled** from Docker Hub (`helixid/console`) | the Console is a separate repo (`helixid/helix-console`) that publishes a multi-arch image, so there's no reason to make you clone and build it |

The Console step is worth spelling out, because it's the one that used to
require a second checkout. `docker/console.Dockerfile` is two lines: it starts
`FROM helixid/console:latest` and copies in `docker/console-nginx.conf`. That
nginx config serves the Console SPA and reverse-proxies `/v1` and `/health` to
`helix-api`, so the browser talks to the API **same-origin** — the demo API
ships without CORS, and the Console calls it from the browser.

The SDK packages (`@helixid/sdk-js`, `@helixid/mcp`) resolve as ordinary git
dependencies on the public `helixid/helix-sdk-js` repo during `pnpm install`
inside the image. No vendoring, no sibling directories.

Wait for `helixid-setup` to print `Seed complete` and exit. Then open:

| URL | What |
| --- | --- |
| http://localhost:8090 | **Scenarios + chat** — pick a scenario, run its steps, talk to an agent |
| http://localhost:8080 | **Console** — log in `admin` / `admin`, open **Audit** |

> **If the chat shows a provider error:** this demo has no scripted fallback,
> so an LLM outage stops it. The free Gemini tier returns `503 UNAVAILABLE`
> under load and rate-limits quickly — prefer `anthropic` or `openai`. To
> confirm the trust layer regardless, use the no-LLM check further down.
>
> Ports, sign-ins and troubleshooting for every demo: [`../README.md`](../README.md).

## Guided scenarios

Open http://localhost:8090. The left sidebar lists every scenario by number —
**hover one to see what it demonstrates and what to expect**. Select it, then
**Run all steps** (it onboards fresh agents and runs each step, marking results
*as expected* / *NOT as expected*), or run the steps one at a time. The chat
panel drives the same agents through the LLM; pick who the agent acts **on
behalf of**, and the service's consent screen pops up when consent is needed.

| # | Scenario | What it proves |
|---|---|---|
| A | Full-access agent | An org credential with `read:catalog` + `write:orders` can search and book |
| B | Read-only agent | Same tools, narrower credential: booking refused (`INSUFFICIENT_SCOPE`) |
| C | Revoked credential | Revoke live; the next call is refused — no restart, no denylist |
| D | Agent → agent delegation | Planner delegates only `read:catalog` to a no-scope Research agent |
| 1 | User → agent consent | Helix Stay refuses until Ada consents; her consent is a grant signed by Helix Stay |
| 2 | User → agent → agent | Ada's consent to the Concierge flows to the Hotel Scout it delegates to; Grace's (never given) doesn't |
| 3 | Session vs standing consent | "Just this trip" = 24h grant, "always" = long-lived; both reused without re-prompting |
| 4 | Traveler revokes consent | The agent stops acting for Ada, but still works for Grace and on its own authority |
| 5 | Two travelers, one agent | Ada's grant does nothing for Grace; consenting to *search only* still blocks booking |
| 6 | Two services | Stay consent doesn't open Air; a VP signed for Stay is rejected by Air |
| 7 | Delegation depth limit | `maxDelegationDepth: 1` allows one hop; the second is refused |
| 8 | Revoking the parent | Revoke Planner and Research's delegated authority disappears |
| 9 | Delegation that expires | A 20-second delegation: allowed inside the window, refused after |
| 10 | Replaying a captured VP | Second use of the same VP refused (`VP_REPLAYED`) |
| 11 | Tampering with a credential | Editing scopes inside a signed VP breaks the signature |
| 12 | Scope escalation in delegation | A read-only Planner can't delegate `write:orders` |
| 13 | Prompt injection | A hotel listing tells the AI to book a ₹48,000 suite; Ada consented to search only |
| 14 | Deactivated agent DID | Retire the agent's DID — **see the did:key caveat below; expected to show a gap here** |

### Prove the enforcement is real (no LLM in the loop)

Call the MCP tool directly with **no presentation** — refused by HelixID, not the app:

```sh
curl -s http://localhost:7100/mcp/air \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"book_flight","arguments":{"flightId":"BA249","passengerName":"Mallory"}}}'
# → tool result is an error: "Refused by HelixID at Helix Air [VP_MISSING]: no verifiable presentation was supplied."
```

The agent's building blocks are plain HTTP too — e.g. `POST /call-tool`
(`personaId`, `toolName`, `input`, optional `userId`), `POST /consent`,
`POST /delegate-agent`, `POST /revoke-agent`, `POST /revoke-grant`, and the
attacks under `/attack/*`. `POST /onboard-agent` also accepts a one-use `token`
generated in Console, whose scopes win over the requested ones.

### Reset

```sh
docker compose down -v      # wipes HelixID SQLite state, personas, grant index and service DIDs
```

## Configuration

| Variable | Service | Default | Purpose |
| --- | --- | --- | --- |
| `LLM_PROVIDER` | agent | `anthropic` | `anthropic`, `openai`, or `azure` |
| `LLM_API_KEY` | agent | — (**required**) | Your real provider key (Azure: the resource key) |
| `AZURE_OPENAI_ENDPOINT` | agent | — | `azure` only, e.g. `https://<resource>.openai.azure.com` |
| `AZURE_OPENAI_DEPLOYMENT` | agent | — | `azure` only — chat deployment name (used as the model) |
| `AZURE_OPENAI_API_VERSION` | agent | `2024-10-21` | `azure` only |
| `HELIX_ADMIN_API_KEY` | setup, console | `dev-admin-key-change-in-production` | Demo admin key for Console/API admin surfaces |
| `HELIX_ADMIN_API_KEY` | setup, agent, mcp-server | `dev-admin-key-change-in-production` | Also used to sign presentations, delegate, revoke, and enroll the services / sign their grants — see below |

For Azure OpenAI, set `LLM_PROVIDER=azure`, put the resource key in `LLM_API_KEY`,
and set `AZURE_OPENAI_ENDPOINT` + `AZURE_OPENAI_DEPLOYMENT` (a deployment of a
tool-calling model such as `gpt-4o`).

The HelixID API's identity settings (`DID_METHOD=key`, the issuer DID, the signing
key) are fixed in `docker-compose.yml` because they must agree with each other;
they're dev values and clearly marked.

## Key custody and the browser boundary

- **Agents hold no keys.** The server generates each agent's keypair at
  onboarding and holds it encrypted at rest; every presentation is signed by
  `POST /v1/agents/:did/vp`. That route is admin-gated in OSS, so the agent
  service holds the admin key. The MCP server holds it too, to enroll the two
  services and ask the API to sign their consent grants.
- **The browser never handles credential material**: it sends persona ids,
  traveler ids and messages, and receives replies, tool outcomes and safe
  persona metadata — never a VC, VP or key.
- The persona manifest, grant index and service DIDs are app-local
  convenience state on the shared volume. The HelixID database remains the
  source of truth for agents, credentials, grants, status lists and audit events.
- Conversation history is keyed by `(conversationId, personaId, traveler)`, so
  one agent's context never leaks into another's.

## Layout — one file, one job

```
config.ts                  scopes, tools, the two services, demo travelers, env
personas/
  store.ts                 manifest-backed persona registry on the shared volume
  enroll.ts                enrollment token → POST /v1/onboard
  grants.ts                local index of consent grants issued through the demo
  platform.ts              admin-key calls to the API, waiting out rate limits
helixid-setup/seed.ts      run-once: onboard the initial Concierge persona → exit 0
mcp-server/
  server.ts                Helix Air + Helix Stay: replay guard, verify, consent policy, scope
  serviceRegistry.ts       enrolls both services once; signs consent grants
agent/
  server.ts                the HTTP building blocks the scenarios combine
  attacks.ts               replay, tamper, wrong-service
  tools/protectedCall.ts   the only place a VP is requested
  chat/                    LLM tool loop + providers
web/                       the scenario UI (nginx): sidebar, steps, chat, consent screen
```

## Shipped-capability notes (honest caveats)

- **Scenario 14 can't be enforced in this did:key setup.** A `did:key`'s
  document is derived from the DID itself, so verifiers never consult the
  registry — deactivating it (`POST /v1/dids/:did/deactivate`) records the fact
  but its VPs still verify. On a `did:web` platform the document answers 410
  and the scenario passes (see the enterprise hosted example).
- **Replay protection lives in the verifier.** `/v1/vp/verify` is stateless;
  the MCP server remembers each VP id until it expires (in-memory).
- **Two consent rules are enforced by the service, not the verifier:** a VP
  that names a traveler must carry a grant (the verifier alone would accept it
  with the agent's full scopes), and the grant's issuer must be this service
  (the verifier checks the grant's agent and user, not its issuer).
- **Scope and consent denials aren't audited by the API.** The presentation
  still shows as `VP_VERIFIED` in Console (its identity *was* verified); the
  refusal is in the MCP server log and the tool result.
- **Authorization is the shipped scope/expiry/revocation/consent check**, not
  OPA/Rego (which isn't live).
