# E2E Travel Concierge v2 — "does this actually work?" in one command

A real LLM agent enrolls with HelixID, gets a real verifiable credential, calls a
**real MCP server**, and a protected tool runs only after `@helixid/mcp` verifies
the agent's presentation against the **live HelixID API** — every step landing in
Console's audit view.

Then it goes one step further: you enroll a **second agent at runtime** (no
restart, no config edit), switch to it in the UI, and watch HelixID **refuse** its
booking because its credential lacks the required scope. Same request, different
credential, different real outcome.

And then you revoke the original Concierge credential while everything is still
running. The next booking attempt is refused because the live status list now
marks that credential revoked — no restart, no config edit, no app-side denylist.

Finally, you create two demo agents and delegate only `read:catalog` from the
full-access Planner Agent to a no-access Research Agent. Research can search only
after it receives the delegated credential, and still cannot book because the
delegated authority does not include `write:orders`.

There are no mocks in the HelixID trust and enforcement path. Flight inventory
and booking responses are intentionally synthetic, but if a credential is
missing, invalid, revoked, or lacks the right scope, the action does not happen —
and you can prove it.

---

## What happens

```
Browser ──{personaId, "book BA249 for Ada"}──▶ Agent (LLM + MCP client)
                                                   │  1. LLM picks book_flight
                                                   │  2. agent signs a VP with the selected
                                                   │     persona's active credential
                                                   ▼
                                              MCP server ── @helixid/mcp ──▶ HelixID API
                                                   │   POST /v1/vp/verify → VP_VERIFIED / VP_REJECTED (audit)
                                                   │   requireScope(write:orders)
                                                   │   tool runs  ── only if verified AND authorized
                                                   ▼
Browser ◀── "Booked, BKG-…"  or  "refused: lacks write:orders" ── Agent (LLM speaks the real result)
```

- **Concierge Agent** (seeded at startup) holds `read:catalog` + `write:orders` →
  it can search *and* book.
- **Search Agent** (enrolled later, at runtime) holds only `read:catalog` → it can
  search, but HelixID refuses its bookings.
- **Revoked Concierge Agent** still has the same local wallet, but its credential
  status-list bit is flipped → HelixID rejects its next VP.
- **Delegated Research Agent** starts with no tool scopes, then presents a child
  credential delegated by Planner Agent with only `read:catalog` → search works,
  booking is refused.

## Prerequisites

- **Docker + Docker Compose.**
- **An LLM API key** — Anthropic (default), OpenAI, or Azure OpenAI. The agent is a
  genuine LLM agent; it decides which tool to call.
- **No Hedera credentials.** This demo enrolls each agent with a local `did:key`
  wallet through the single-roundtrip `/v1/enroll` path (no on-chain DID
  anchoring), and the issuer runs in `did:key` mode. The trust flow is fully real
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
| `web` | built from `web/` | the chat UI, lives here |
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
| http://localhost:8090 | **Web chat** — pick the acting agent, talk to it |
| http://localhost:8080 | **Console** — log in `admin` / `admin`, open **Audit** |

> **If the chat shows a provider error:** this demo has no scripted fallback,
> so an LLM outage stops it. The free Gemini tier returns `503 UNAVAILABLE`
> under load and rate-limits quickly — prefer `anthropic` or `openai`. To
> confirm the trust layer regardless, use the no-LLM check further down.
>
> Ports, sign-ins and troubleshooting for every demo: [`../README.md`](../README.md).

## Guided use cases

The web chat has four guided tabs. Each one exercises a different trust decision
with the same MCP server and the same `search_flights` / `book_flight` tools.

| Use case | Persona / credential state | What to try | Expected result |
| --- | --- | --- | --- |
| **1 — Full-access agent** | Concierge has `read:catalog` + `write:orders` | Book a flight | Booking succeeds |
| **2 — Read-only agent** | Runtime-onboarded agent has only `read:catalog` | Search, then book | Search succeeds; booking is refused for missing `write:orders` |
| **3 — Revoked credential** | Concierge's issued VC is revoked through the live API | Retry booking | VP is rejected because the status-list bit is revoked |
| **4 — Delegated agent** | Research starts with no tool scopes, then receives a Planner-signed child VC with `read:catalog` | Search, then book | Delegated search succeeds; booking is refused because the child VC lacks `write:orders` |

### 1) Happy path — Concierge books

Open **Use case 1 — Full-access agent**. With **Concierge Agent** selected, type
or click **Fill booking prompt**:

> **Book flight BA249 for Ada Lovelace**

You get a confirmation with a booking id. Refresh Console → Audit: a fresh
**`VP_VERIFIED`** event (plus the enrollment/issuance events from setup).

### 2) Onboard a second agent at runtime, then watch it get refused

In **Console**, generate an onboard/enrollment token for a booking-restricted
agent, for example **Search Agent** with only `read:catalog`.

Back in the Travel Concierge web chat, open **Use case 2 — Read-only agent** and
click **Open onboarding**. Paste that Console-generated token, give it a display
name such as `Search Agent`, and submit. The agent service consumes the token,
creates an encrypted local wallet, and writes only local persona metadata to the
manifest on the shared `wallets` volume. The Console/HelixID database remains the
source of truth for the real agent credential, scopes, revocation state, and
audit events.

The UI refreshes `/personas`, so **Search Agent** appears in the dropdown within
a few seconds — no restart. Select it and try:

> **Search flights from Mumbai to London** → succeeds (it has `read:catalog`).
>
> **Book flight BA249 for Grace Hopper** → the agent explains it was **refused**
> because it lacks `write:orders`.

Switch back to **Concierge Agent** and the same booking succeeds. That difference
is produced by HelixID, not by UI filtering — the booking tool is offered to both
agents; only the credential decides.

### 3) Revoke Concierge, then retry the same booking

With **Concierge Agent** selected, first run the happy-path booking so you have a
known-good baseline. Then open **Use case 3 — Revoked credential** in the web UI
and click **Revoke selected agent**.

The Travel Concierge agent service loads the selected persona's encrypted wallet,
reads the credential id, and calls the live HelixID admin endpoint
`POST /v1/vcs/:vcId/revoke`. The browser never sees the wallet, VC, VP, private
key, or admin API key.

Now ask Concierge to book again:

> **Book flight BA249 for Ada Lovelace**

The agent still signs a fresh VP with the same local wallet, but HelixID now sees
the revoked status-list bit and refuses the presentation. Refresh Console →
Audit: you should see the revocation event and a rejected VP verification for the
retry.

### 4) Delegate read access to another agent

Open **Use case 4 — Delegated agent** in the web UI.

Click **Create demo agents**. The agent service enrolls:

- **Planner Agent** with `read:catalog` + `write:orders` and
  `maxDelegationDepth: 1`.
- **Research Agent** with no tool scopes.

At this point, Research has a real issuer-backed base VC, but it carries an empty
`privilegeScopes` array. That credential is useful as Research's identity, not as
tool authority. It cannot search or book.

Click **Delegate read access**. The service loads Planner's wallet server-side,
uses Planner's HelixID-issued credential as the trusted root, creates a
Planner-signed child VC for Research with only `read:catalog`, stores that child
VC in Research's encrypted wallet, and marks Research to present the delegated
credential on its next tool call. The browser receives only safe persona metadata.

With **Research Agent** selected, try:

> **Search flights from Mumbai to London** → succeeds through delegated
> `read:catalog`.
>
> **Book flight BA249 for Ada Lovelace** → refused because the delegated
> credential does not contain `write:orders`.

This proves delegation cannot exceed the parent credential: the delegated scope
may be equal to or narrower than the parent, but it cannot add new authority.
Research's base credential cannot search or book; the delegated child credential
adds only `read:catalog`, so Research can search but cannot escalate to booking.
Self-issued VCs are not used as trusted delegation roots in this scenario; they
are only for quick-start/local development flows.

### Prove the enforcement is real (no LLM in the loop)

Call the MCP tool directly with **no presentation** — refused by HelixID, not the app:

```sh
curl -s http://localhost:7100/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"book_flight","arguments":{"flightId":"BA249","passengerName":"Mallory"}}}'
# → tool result is an error: "Refused by HelixID: no verifiable presentation was supplied."
```

### Reset

```sh
docker compose down -v      # wipes HelixID SQLite state, wallets, and persona manifest
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
| `WALLET_PASSPHRASE` | setup, agent | `demo-passphrase` | Encrypts every persona wallet |

For Azure OpenAI, set `LLM_PROVIDER=azure`, put the resource key in `LLM_API_KEY`,
and set `AZURE_OPENAI_ENDPOINT` + `AZURE_OPENAI_DEPLOYMENT` (a deployment of a
tool-calling model such as `gpt-4o`).

The HelixID API's identity settings (`DID_METHOD=key`, the issuer DID, the signing
key) are fixed in `docker-compose.yml` because they must agree with each other;
they're dev values and clearly marked.

## Personas, wallets, and the browser boundary

- A **persona** is a selectable enrolled-agent context: its own wallet, credential,
  and scopes. The active persona's wallet signs the next protected tool call.
- A wallet can hold multiple VCs. The demo stores the selected VC id as
  `activeCredentialId`: normal personas use their issuer-issued base VC, while
  delegated Research uses the Planner-signed child VC. If `activeCredentialId` is
  missing, the demo falls back to the first wallet credential; if the wallet is
  empty or the active VC id is not found, VP creation fails instead of silently
  using the wrong credential.
- The persona registry is app-local convenience state for this demo: it lets the
  Travel Concierge UI list/select agents and locate each encrypted wallet file. It
  stores safe credential-selection metadata such as `activeCredentialId`, but not
  the VC itself, and is deliberately separate from the Console/HelixID database.
- The Console/HelixID database is the source of truth for enrollment,
  issuer-backed credentials and their scopes, status lists, revocation, and API
  audit events. Agent-issued delegated child VCs remain in the receiving agent's
  encrypted wallet and are verified from their signed delegation chain. In a real
  deployment, the agent app and the organization Console would be hosted
  separately and would not share a database.
- The local persona registry is backed by the shared `wallets` volume today, so
  runtime-enrolled agents survive restarts and a freshly-booted agent sees them.
- The **browser never handles wallet material**: chat only sends `{ personaId,
  message, conversationId }` and receives `{ reply }`. During onboarding, the
  browser carries the one-time Console-generated token to the agent service, but
  it never receives a wallet, VC, VP, private key, or persisted credential
  material.
- Conversation history is keyed by `(conversationId, personaId)`, so one agent's
  context never leaks into another's.

## Layout — one file, one job

```
config.ts                 shared constants (scopes, tools, target service, wallets dir)
personas/                 the runtime persona model
  store.ts                manifest-backed registry (list / get / add), on the shared volume
  enroll.ts               shared enroll (Console/setup token → did:key wallet → POST /v1/enroll)
helixid-setup/seed.ts     run-once: enroll the Concierge persona → manifest → exit 0
mcp-server/server.ts      real MCP server; search_flights + book_flight, each guarded by @helixid/mcp
agent/
  server.ts               GET /personas, POST /chat, onboarding, revocation, delegation demo routes
  chat/providers/         anthropic (default) | openai | azure adapter (v1 SPEC §5.7 pattern)
  chat/runChatTurn.ts     LLM tool-loop; runs every tool call as the selected persona
  tools/protectedCall.ts  the only place a VP is created (per-persona active credential)
web/                      static chat UI (nginx): persona selector + reverse-proxy to the agent
docker/                   Dockerfiles + the Console nginx override
```

Within the Travel Concierge application, only `helixid-setup/`, `personas/`, and
`agent/` create, store, or sign wallet, VC, or VP material. The HelixID API issues
and stores issuer-backed credentials; the MCP server receives and verifies VPs;
the web app doesn't know HelixID exists.

## Shipped-capability notes (honest caveats)

- **Verification vs. authorization in the audit trail.** The shipped API's
  `/v1/vp/verify` audits the *verification* result: `VP_VERIFIED` for a valid
  presentation, `VP_REJECTED` for a forged/expired/revoked one. It does **not**
  model scope. So when the Search Agent is refused for lacking `write:orders`, its
  presentation still shows as `VP_VERIFIED` in Console (its identity *was* verified)
  — the scope denial is enforced by `@helixid/mcp` and surfaced in the MCP server
  logs and back to the agent. There is no shipped "insufficient-scope" audit event
  to emit; we don't fabricate one.
- **`@helixid/mcp` verifies but does not emit an audit event.** Its middleware runs
  `verifyVP` locally (real: it resolves the issuer DID and checks the live status
  list) and enforces scope — that is the decision. To make the *verification* also
  visible in Console, `mcp-server` additionally calls the API's authoritative
  `POST /v1/vp/verify`. Both calls are real. If `@helixid/mcp` gains audit emission
  upstream, that second call can be dropped.
- **Delegated children inherit parent revocation.** Locally agent-signed child VCs
  do not receive an independent status-list entry. Both the authoritative API
  `/v1/vp/verify` path and the SDK/MCP verifier resolve and validate the complete
  delegation chain, then check each status-bearing ancestor. Revoking the root
  or another status-bearing parent therefore rejects all descendants.
- **Authorization is the shipped scope/expiry/revocation check**, not OPA/Rego
  (which isn't live) — the same `verifyVP` + `requireScope` path v1 uses.
- **Guided revocation is intentionally destructive for that demo run.** Once you
  revoke Concierge, its existing credential will keep failing until you reset the
  demo state with `docker compose down -v` and start again.
