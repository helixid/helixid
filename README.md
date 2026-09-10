<p align="center">
  <h1 align="center">HelixID</h1>
  <p align="center"><strong>Cryptographic identity and authorization for AI agents.</strong></p>
  <p align="center">Replace API keys with verifiable, scoped, and auditable agent identity.</p>
</p>

<p align="center">
  <a href="https://github.com/helixid/helixid/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-blue.svg" alt="License"></a>
  <a href="https://www.w3.org/TR/vc-data-model-2.0/"><img src="https://img.shields.io/badge/W3C-VC%202.0-green.svg" alt="W3C VC 2.0"></a>
  <a href="https://www.w3.org/TR/did-core/"><img src="https://img.shields.io/badge/W3C-DID%201.0-green.svg" alt="W3C DID 1.0"></a>
</p>

---

## Documentation

Full documentation is at **[docs.helixid.dev](https://docs.helixid.dev)** — concepts,
guides, and reference. This README covers only what is specific to this repository.

| | |
|---|---|
| **Start here** | [Introduction](https://docs.helixid.dev/) |
| **Concepts** | [The Trust Stack](https://docs.helixid.dev/concepts/trust-stack) · [Two-Issuer Model](https://docs.helixid.dev/concepts/two-issuer-model) · [Delegation](https://docs.helixid.dev/concepts/delegation) · [Revocation](https://docs.helixid.dev/concepts/revocation) |
| **Get started** | [Quick Start](https://docs.helixid.dev/get-started/quick-start) · [Installation & Modes](https://docs.helixid.dev/get-started/installation-and-modes) |
| **Contributing** | [How to Contribute](https://docs.helixid.dev/contributing/how-to-contribute) · [`CONTRIBUTING.md`](CONTRIBUTING.md) |
| **Security** | [Reporting a Vulnerability](https://docs.helixid.dev/security/reporting-a-vulnerability) · [`SECURITY.md`](SECURITY.md) |

---

## What this is

AI agents authenticate with static API keys — credentials designed for humans
clicking through consent screens, not autonomous software making cross-boundary
decisions. That leaves no delegation chain, no scoped authority, no cross-org
trust, no revocation that actually works, and no cryptographic audit trail.

HelixID gives every agent a portable, verifiable, revocable credential instead.
An agent carries signed credentials proving what it may do; the service it calls
verifies them **locally** before acting; every decision is recorded.

Two credentials matter, and they come from different parties:

- **Agent-Authority VC** — issued once by the HelixID issuer at onboarding. The
  agent's ceiling: the most it could ever be allowed to do.
- **Delegated Grant VC** — issued by the service provider after the user logs in
  and consents. What the user actually approved, at that one service.

Authority is the **intersection** of the two. A grant can never widen what the
issuer granted, and the agent can never exceed what the user approved. Private
keys never leave the agent process.

> Full explanation, including why the two-issuer split matters and what
> "offline verification" does and does not mean:
> **[The Two-Issuer Model](https://docs.helixid.dev/concepts/two-issuer-model)** ·
> **[The Trust Stack](https://docs.helixid.dev/concepts/trust-stack)** ·
> **[Offline Verification](https://docs.helixid.dev/concepts/offline-verification)**

---

## Roles

Three parties, three different jobs:

| Role | Does | Never does |
|---|---|---|
| **Platform Operator** | Runs the issuer, onboards agents, holds their keys in custody, issues Agent-Authority VCs, signs presentations on an agent's behalf, revokes | Issue a Service Provider's consent grant |
| **AI Agent** | Asks the API for a presentation, presents it to services, delegates authority to sub-agents | Hold a private key, or sign anything itself |
| **Service Provider** | Verifies presentations, asks the user for consent, issues Delegated Grant VCs, enforces scope | Trust an agent's self-assertion |

Each role's full walkthrough — including what to run and what to check — is in
the docs: **[The Trust Stack](https://docs.helixid.dev/concepts/trust-stack)** and
**[Authorization & Scopes](https://docs.helixid.dev/concepts/authorization-and-scopes)**.

---

## Architecture

This repository is the **HelixID API** — the issuer and verifier service
(Fastify + Prisma). It issues Agent-Authority VCs, hosts status lists for
revocation, and records the audit trail. Verification itself happens in the
SDK, inside the calling service, not here.

The default runtime is Postgres + an in-memory cache + `did:web`, with no external
infrastructure. `did:hedera` is opt-in.

> Component-by-component architecture:
> **[The Trust Stack](https://docs.helixid.dev/concepts/trust-stack)** ·
> **[DIDs & Identity](https://docs.helixid.dev/concepts/dids-and-identity)** ·
> **[Verifiable Credentials](https://docs.helixid.dev/concepts/verifiable-credentials)**

---

## Performance

> "DLT is slow" is the first objection. Here's the data.

The DLT latency penalty exists only on the **write path** (DID anchoring,
credential issuance). The **verification hot path** — what matters for
real-time agent interactions — never touches the ledger.

| Operation | HelixID (cached) | JWT/OAuth | Raw Ed25519 |
|---|---|---|---|
| Credential verification | ~1-6 ms | 1-5 ms | ~0.1 ms |
| DID resolution | ~0.01 ms (cache hit) | N/A | N/A |
| Revocation check | ~0.01 ms (cached) | 50-200 ms (introspection) | Not supported |
| Full verification (warm) | ~1-6 ms | 1-5 ms | ~0.1 ms |

"Warm" means the DID document and status list are already cached. Cold, each is
a single static-document fetch — see the caching notes below. Even then, nothing
in the path asks the issuer to authorize the request; contrast the 50-200 ms
introspection call, which cannot be cached because its whole purpose is to be
asked fresh every time.

**Context:** A single LLM inference call takes 500ms-5s. HelixID verification
at ~5ms is noise in that budget. You get the same verification speed as JWT,
backed by cryptographic trust that JWT can never provide.

**Caching architecture:**
- **DID documents:** cached in-process automatically — 5 minutes for `did:web`,
  15 minutes for `did:hedera`. No configuration needed.
- **Status lists:** fetched per verification by default. The bitstring is a
  static document shared by every credential from that issuer, so it caches
  well — pass a `statusListResolver` to `verifyVP()` to serve it from your own
  cache, CDN, or local storage. `helix-api` already does this for the list it
  hosts.
- **Session token bridge:** For high-frequency scenarios (1000+ RPS), verify
  the VC once (~5ms), issue an ephemeral JWT for subsequent calls (~0.1ms).
  Best of both worlds.

## Quick Start

Three ways in, depending on what you want to see.

| Path | Time | Needs | Best for |
| --- | --- | --- | --- |
| **[Fastest path](#fastest-path-one-running-api-no-hedera-account-needed)** | 5 min | Node + a running `helix-api` | Seeing the VP build/verify cycle in code |
| **[Consent demo](#demo-a--user-consent-across-two-services)** | ~10 min | Docker | Watching a **user** grant consent and following the full audit trail — the best overview of what HelixID is for |
| **[Travel Concierge demo](#demo-b--llm-agent-with-a-protected-mcp-tool)** | ~10 min | Docker + LLM key | A real LLM agent calling a protected MCP tool, plus revocation and delegation |

New here? Run the **consent demo** — it needs no API key and shows the whole
identity → consent → verification → action → audit story end to end.

Run one demo at a time — the two TypeScript demos share ports `3000`/`8080`.
Ports, demo sign-ins and troubleshooting for all four are in
[`examples/README.md`](examples/README.md).

### Fastest path (one running API, no Hedera account needed)

No Hedera account, no wallet file, no key material of your own. The API generates and holds each agent's private
key, so trying out the SDK is just standing up the API and calling it. Useful for testing
the onboard/sign/verify flow locally, or if you already have a `helix-api` running some
other way.

**Step 0 — Get a running `helix-api`** (skip if you already have one)

The only dependency here is Docker — no Postgres, no manual `.env`, no Prisma
generation, and no sibling-repo checkout:

```bash
git clone https://github.com/helixid/helixid.git
cd helixid
docker compose -f docker-compose.local.yml up --build helix-api
```

Confirm it's up:

```bash
curl http://localhost:3000/health
```

Reset it any time with `docker compose -f docker-compose.local.yml down -v`.

**Step 1 — Install the SDK**

```bash
npm install @helixid/sdk-js
```

**Step 2 — Onboard an agent and get it a credential**

The server generates and holds the agent's key internally — nothing local, no
passphrase:

```typescript
import { HelixClient } from '@helixid/sdk-js'

const client = new HelixClient('http://localhost:3000', {
  adminApiKey: 'dev-admin-key-change-in-production', // matches docker-compose.local.yml
})

// Mint a one-use enrollment token (open endpoint, no auth needed)
const tokenRes = await fetch('http://localhost:3000/v1/enrollment-tokens', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ agentName: 'demo-agent', requestedScopes: ['read:orders'] }),
})
const { token } = await tokenRes.json()

const { agentDid, vcId } = await client.onboardAgent(token)

console.log(agentDid) // did:key:z6Mk...
```

**Step 3 — Sign and verify a VP**

```typescript
import { verifyVP } from '@helixid/sdk-js'

// The server signs on the agent's behalf -- it holds the only copy of the key
const vp = await client.signVP(agentDid, 'orders-service')

const result = await verifyVP(vp, client, {
  expectedTargetService: 'orders-service',
  allowSelfSigned: true, // dev only — remove in production
})

console.log(result.valid, result.agentDid, result.privilegeScopes)
// true  did:key:z6Mk...  ['read:orders']
```

For any valid HelixID scenario, use a real bootstrap token
enrollment so the root VC is signed by the trusted issuer.

---

### Demo A — user consent across two services

This is the diagram above, running. A travel agent books a flight and a hotel
from **two independent service providers**, each with its own `did:web`
identity, its own status list, and its own consent grant. No LLM API key
required — the agent falls back to a scripted planner if you don't set one.

```bash
git clone https://github.com/helixid/helixid.git
cd helixid/examples/e2e-consent-demo
cp .env.example .env
docker compose up --build
```

| URL | What |
| --- | --- |
| **http://localhost:4100** | Travel Planner chat — sign in `traveler` / `demo123` |
| **http://localhost:8080** | HelixID Console — sign in `admin` / `admin`, then open **Audit** |
| http://localhost:4101 | Airline SP (Helix Air) |
| http://localhost:4102 | Hotel SP (Helix Stay) |

**What to watch, in order:**

| Step | What happens | Why it matters |
| --- | --- | --- |
| 1 | Search for a flight | **No consent prompt** — search is read-only and carries no required scope |
| 2 | Try to book it | The airline refuses: it has never seen this agent, so it asks the **user** directly, on its own page |
| 3 | Approve the scopes | The airline signs a Delegated Grant VC, scoped to exactly what was approved |
| 4 | Booking completes | The agent presents a VP; the airline checks issuer trust, validity, and scope before acting |
| 5 | Book a hotel | A **different** SP, so it asks again — nothing the airline approved carries over |
| 6 | Book a return flight | **No prompt this time** — the airline's standing grant is reused |

Then open **Console → Audit**. Every step above is there in order: credential
issued, consent granted, credential presented, verification result,
authorization result, action performed, and the booking reference it produced.
A refusal is recorded just as clearly as an approval — that's the point.

Step 6 is covered by an automated regression test that asserts on prompt
*counts*, not just "the booking worked":

```bash
pnpm --filter @helixid/example-e2e-consent-demo test
```

Reset everything with `docker compose down -v`. Full walkthrough:
[`examples/e2e-consent-demo`](examples/e2e-consent-demo).

---

### Demo B — LLM agent with a protected MCP tool

See a real LLM travel agent enroll with HelixID, receive a scoped credential,
and call a protected MCP booking tool. The booking runs only after
`@helixid/mcp` verifies the agent's presentation against the live HelixID API.
This demo also covers **revocation** and **agent-to-agent delegation**.

<!-- Prefer a guided walkthrough? **[Try it on our website →](https://dgverse.in/helixid/try-it-out)**
Same demo, no local setup. -->

**Step 1 — Get an LLM API key**

The concierge uses a real LLM to decide when to call the booking tool. Obtain a
key from Anthropic, OpenAI, Azure OpenAI, or Google:

- [Anthropic Console](https://console.anthropic.com/settings/keys)
- [OpenAI Platform](https://platform.openai.com/api-keys)
- [Google AI Studio](https://aistudio.google.com/apikey) — free tier, but see the note below

> **On the free Gemini tier:** it returns `503 UNAVAILABLE` under load and
> rate-limits quickly. This demo has no scripted fallback, so it will show the
> provider error until it recovers. Anthropic or OpenAI give a steadier run.
> (The consent demo *does* fall back to a scripted planner.)

**Step 2 — Get the demo**

```bash
git clone https://github.com/helixid/helixid.git
cd helixid
cd examples/e2e-travel-concierge
cp .env.example .env
```

Edit `.env` and add your provider and API key:

```bash
LLM_PROVIDER=anthropic # anthropic (default) | openai | azure | gemini
LLM_API_KEY=your-provider-key
```

**Step 3 — Run it**

```bash
docker compose up --build
```

This starts the real issuer API with SQLite and local `did:key` identities,
HelixID Console, a protected MCP server, the LLM agent, and the web chat. A
one-shot setup service onboards one agent, issues its credential, records the
agent's DID to the shared volume, and exits. No wallet file and no key material
is written anywhere — the server holds the agent's key.

The Console/HelixID SQLite database is the source of truth for real agent trust
state: enrollment, issued credentials, scopes, revocation, status lists, and
audit events. The Travel Concierge app's persona list is only local demo state
used to show selectable agents in the chat UI; it is not the Console database and
does not replace HelixID's records.

Open:

| URL | What |
| --- | --- |
| **http://localhost:8090** | Travel Concierge chat |
| **http://localhost:8080** | HelixID Console — sign in with `admin` / `admin`, then open **Audit** |

**Step 4 — Try the four guided use cases**

The web chat has four tabs, each exercising a different trust decision against
the same MCP server and the same `search_flights` / `book_flight` tools:

| Use case | Persona / credential state | What to try | Expected result |
| --- | --- | --- | --- |
| **1 — Full-access agent** | Concierge has `read:catalog` + `write:orders` | Book a flight | Booking succeeds |
| **2 — Read-only agent** | Runtime-onboarded agent has only `read:catalog` | Search, then book | Search succeeds; booking is refused for missing `write:orders` |
| **3 — Revoked credential** | Concierge's issued VC is revoked through the live API | Retry booking | VP is rejected because the status-list bit is revoked |
| **4 — Delegated agent** | Research starts with no tool scopes, then receives a Planner-signed child VC with `read:catalog` | Search, then book | Delegated search succeeds; booking is refused because the child VC lacks `write:orders` |

Open **Use case 1 — Full-access agent**. With **Concierge Agent** selected,
type or click a suggestion:

> **Book flight BA249 for Ada Lovelace**

The LLM calls `book_flight`, the agent signs a fresh VP locally, and the MCP
server verifies the credential and its `write:orders` scope before creating the
booking. Refresh **Console → Audit** to see the enrollment, credential issuance,
and successful `VP_VERIFIED` event.

Open **Use case 2 — Read-only agent**. Generate an onboard token in Console,
then click **Onboard new agent** in the Travel Concierge chat and paste the
token. The agent service consumes the token, onboards the agent through the API,
adds only local persona metadata to the Travel Concierge manifest, and the new
agent appears in the persona selector — no restart. Select it and search
(succeeds, it has `read:catalog`), then try to book (refused — it lacks
`write:orders`). The Console/HelixID database remains the source of truth for
the real credential, scopes, revocation state, and audit trail.

Select **Concierge Agent**, open **Use case 3 — Revoked credential**, and click
**Revoke selected agent**. The agent service looks up the selected persona's
active credential through the API and calls `POST /v1/vcs/:vcId/revoke` with the
demo admin key. The browser never sees the VC, VP, or admin key. Retry the same
booking: the API still signs a VP for that agent, but HelixID rejects it because
the live status list now marks the credential revoked. Reset with `docker compose down -v` to issue a fresh
Concierge credential.

Open **Use case 4 — Delegated agent**. Create the demo Planner Agent
(`read:catalog` + `write:orders`, delegation depth 1) and Research Agent
(`read:catalog`), then delegate only `read:catalog` from Planner to Research.
Research can search through the delegated child credential, but booking is
refused because that delegated credential lacks `write:orders`. This path is
enforced by the SDK/MCP verifier; the shipped API does not yet expose API-side
delegation issuance or Console audit for local child-chain verification.

To exercise the denial path directly, call the MCP tool without a presentation:

```bash
curl -s http://localhost:7100/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"book_flight","arguments":{"flightId":"BA249","passengerName":"Mallory"}}}'
```

The protected tool refuses the booking because HelixID did not receive a valid
presentation.

Reset all demo state with:

```bash
docker compose down -v
```

---

### Building your own integration

The demo above runs the full trust chain for you. If you're wiring HelixID into your own agent or service, here's what's happening under the hood at each step:

```bash
pnpm install
pnpm build
```

This is a pnpm workspace. The current SDK package is `@helixid/sdk-js`, backed by the `@helixid/api` service.

#### Configure the API

Create or update `.env`. The default runtime is **no external infra** beyond the API process itself: `sqlite` storage + in-memory cache + `did:web`.

```bash
NODE_ENV=development
API_BASE_URL=http://localhost:3000

HELIX_STORAGE_ADAPTER=sqlite
HELIX_SQLITE_PATH=./data/helixid.sqlite
HELIX_CACHE_ADAPTER=memory

DID_METHOD=web
DID_DOMAIN=localhost:3000

HELIX_ADMIN_API_KEY=dev-admin-key-0001
HELIX_SIGNING_KEY=<32-byte-ed25519-private-key-hex>
```

Start the API:

```bash
set -a; source .env; set +a
pnpm --filter @helixid/api dev
```

Troubleshooting (SQLite users): if startup fails with
`SyntaxError: The requested module '@prisma/client' does not provide an export named 'PrismaClient'`,
it is usually an install/generation/runtime issue (not a SQLite requirement issue).

Regenerate Prisma client:

```bash
pnpm install
pnpm --filter @helixid/api db:generate
pnpm --filter @helixid/api dev
```

If needed, force a clean reinstall:

```bash
rm -rf node_modules helix-api/node_modules
pnpm install --force
pnpm --filter @helixid/api db:generate
pnpm --filter @helixid/api dev
```

SQLite mode does not require running database migrations.

#### Then: enroll, present, verify, delegate

Those steps are SDK work rather than API work, and the code differs per language.
Rather than duplicate it here, the full walkthrough — enrolling an agent,
building and verifying a presentation, and issuing an agent-signed child
credential — lives with the SDK it belongs to:

- **[SDK reference](https://docs.helixid.dev/sdk/sdk-js)** on the docs site
- [helix-sdk-js](https://github.com/helixid/helix-sdk-js) · [helix-sdk-py](https://github.com/helixid/helix-sdk-py)

For a version you can run rather than read, the demos under
[`examples/`](examples/) do all four end to end.

---

## Framework Integrations

The adapters live in the SDK repositories, not here:

| Framework | Package | Repository |
|---|---|---|
| LangChain / LangGraph | `@helixid/langchain` | [helix-sdk-js](https://github.com/helixid/helix-sdk-js) |
| MCP (middleware) | `@helixid/mcp-middleware` | [helix-sdk-js](https://github.com/helixid/helix-sdk-js) |
| MCP (server) | `@helixid/mcp-server` | [helix-sdk-js](https://github.com/helixid/helix-sdk-js) |
| LangChain / CrewAI / MCP (Python) | `helix_langchain`, `helix_crewai`, `helix_mcp_middleware` | [helix-sdk-py](https://github.com/helixid/helix-sdk-py) |

Working examples of each are under [`examples/`](examples/).

---

## Why not just use OAuth, JWT, or API keys?

Short answer: HelixID does not replace OAuth. Use OAuth for sessions and simple
internal APIs; use HelixID for cross-org trust, delegation chains, and auditable
credentials.

The long answer — including "API keys + RBAC is fine", "Ed25519 signing is
simpler", and why *verified* is not the same as *trusted* — is answered in full
at **[Why not just use…](https://docs.helixid.dev/comparisons/why-not-just-use)**.

---

## Standards & Ecosystem Alignment

HelixID builds on established and converging standards:

- **W3C Verifiable Credentials 2.0** (Recommendation, May 2025) — credential format
- **W3C Decentralized Identifiers 1.0** (Recommendation) — identity layer
- **W3C StatusList2021** — decentralized revocation
- **W3C AI Agent Protocol Community Group** (est. June 2025) — cross-origin agent communication
- **DIF Trusted AI Agents Working Group** — industry alignment
- **NIST NCCoE** — AI Agent Identity and Authorization (concept paper, Feb 2026)

## Self-Hosted

HelixID is fully self-hostable. The current open-source stack covers:

- DID methods: `did:web` (default), `did:key` (local), and `did:hedera` (optional, via `@helixid/did-hedera`)
- API-backed enrollment with local SDK key ownership
- SDK-local VP build/verify and SDK-local delegation
- VC issuance and revocation with Bitstring Status List hosting
- Optional JWT session bridge via API (`/v1/vp/verify` with `session: true`)

### Session tokens & secrets (JWT)

HelixID supports two session-token patterns. Pick the one that matches your deployment and threat model:

- API-issued EdDSA tokens (recommended for cross-service verification)
  - The API issues Ed25519-signed JWTs (EdDSA). Verifiers check these by fetching the session public key from `/v1/sessions/public-key` and calling the EdDSA verifier (e.g. `verifyJWT(token, publicKeyHex)`). No symmetric `JWT_SECRET` is required for EdDSA verification. This is the preferred approach when tokens are shared across services or organizations.

- SDK `SessionManager` (HMAC HS256 — local verifier)
  - The SDK provides a local `SessionManager` that signs and verifies JWTs with HMAC (HS256) using a symmetric secret. The constructor requires a secret of at least 16 characters; if omitted or too short the constructor throws an error: `SessionManager secret must be at least 16 characters`.
  - Example (verifier-managed sessions):

```ts
const session = new SessionManager({ secret: process.env.JWT_SECRET!, ttl: 600 });
```

  - Use this mode only when you control all verifiers and can securely store/rotate the secret. Do not reuse the same symmetric secret across untrusted services.

Recommendations:

- Prefer API-issued EdDSA tokens for production and cross-service deployments.
- For local development, set a demo `JWT_SECRET` in `.env` (many examples fall back to a demo secret). For production, generate a strong secret and store it securely:

```bash
# generate 32 bytes hex
openssl rand -hex 32
# or in node
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

- If you adopt the SDK `SessionManager` pattern, ensure every verifier instance receives the secret securely (secret manager, not checked into repo) and has a rotation plan.

- Note: missing `JWT_SECRET` has no effect on verifying API-issued EdDSA session tokens (those rely on the API public key), but it WILL prevent constructing a `SessionManager` for HS256 tokens in the SDK.

- LangChain/LangGraph and MCP middleware

### VP result caching (alternative to JWT sessions)

If you prefer not to manage a JWT secret, the verifier can cache the VP verification result directly by `vpId`. On repeat calls the agent presents the same VP — the verifier gets a cache hit and skips re-verification without any JWT issuance.

```typescript
// first call — verify and cache
const result = await verifyVP(incomingVP, { expectedTargetService: 'orders-service' })
await cache.set(`vp:${result.vpId}`, result, { ttl: result.expiresInSeconds })

// subsequent calls — cache hit, no re-verification
const cached = await cache.get(`vp:${incomingVP.id}`)
if (cached) return handleRequest(cached)
```

The VP's own expiry (`validUntil`) naturally bounds the cache TTL. No secret management required. Use this pattern for single-verifier deployments where the cache is local to the service.

## Project structure

```
helixid/
├── src/        # Fastify server entrypoint
├── prisma/     # schema and migrations
├── tests/      # unit + live suites
├── e2e/        # end-to-end package
├── examples/   # runnable demos — see examples/README.md
├── scripts/    # setup and maintenance
└── docs/       # design decisions and proposals
```

The other components are separate repositories — see
[The HelixID ecosystem](#the-helixid-ecosystem) below, or
**[Project Structure](https://docs.helixid.dev/get-started/project-structure)**
for how they fit together.

---

## Contributing

We welcome contributions. See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

Key areas where help is needed:

- **DID method implementations** — additional DID method resolvers
- **Framework integrations** — middleware for additional AI agent frameworks
- **Documentation** — tutorials, guides, and examples

## Community

- [GitHub Discussions](https://github.com/helixid/helixid/discussions) — questions, ideas, and show-and-tell
- [GitHub Issues](https://github.com/helixid/helixid/issues) — bug reports and feature requests

## The HelixID ecosystem

| Repository | What it is |
|---|---|
| **helixid** — you are here | HelixID API — the issuer and verifier service |
| [helix-core](https://github.com/helixid/helix-core) | `@helixid/core` — crypto, schemas, resolver, verification primitives |
| [helix-sdk-js](https://github.com/helixid/helix-sdk-js) | JS/TS SDK, CLI, LangChain + MCP middleware, consent widget |
| [helix-sdk-py](https://github.com/helixid/helix-sdk-py) | `helixid-sdk-py` — the Python SDK |
| [helix-console](https://github.com/helixid/helix-console) | Operator Console SPA |
| [helix-wiki](https://github.com/helixid/helix-wiki) | Source for [docs.helixid.dev](https://docs.helixid.dev) |

---

## License

[Apache License 2.0](LICENSE) — chosen for enterprise compatibility, explicit patent protection, and no copyleft friction for proprietary AI agent integrations.

## Contributors

Thanks to everyone who has contributed to HelixID!

<a href="https://github.com/helixid/helixid/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=helixid/helixid" />
</a>

<sub>Made with [contrib.rocks](https://contrib.rocks)</sub>

## Built By

HelixID is built by [DgVerse](https://www.dgverse.in) — building the trust layer for digital credentials and AI agents.

---

<p align="center">
  <em>Static auth primitives will fail at scale for autonomous AI systems.<br/>Cryptographic agent identity is the infrastructure-level solution.</em>
</p>
