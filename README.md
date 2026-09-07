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

## The Problem

AI agents are authenticating with static API keys and bearer tokens — credentials designed for humans clicking through OAuth consent screens, not autonomous software making thousands of cross-boundary decisions per hour.

This breaks in predictable ways:

- **No delegation chain.** When Agent A spawns Agent B to call Service C, there's no standard way to prove B is authorized to act on A's behalf.
- **No scoped authority.** API keys are all-or-nothing. An agent that needs read access to one table gets the same key as one that needs admin access to everything.
- **No cross-org trust.** When your agent calls a third-party service, both sides rely on shared secrets and manual API key exchange. There's no way to verify authority without bilateral integration.
- **No revocation that works.** Revoking a compromised agent means rotating keys across every service it touched.
- **No audit trail.** "Who authorized this agent to do that?" is answered by grepping logs, not cryptographic proof.

HelixID fixes this by giving every AI agent a cryptographic identity — a portable, verifiable, revocable credential that works across organizational boundaries without requiring the parties to know each other in advance.

## How It Works

In one sentence: **an agent carries signed credentials proving what it may do, the
service it calls verifies them locally before acting, and every decision is
recorded.**

Two credentials matter, and they come from different parties:

1. **Agent-Authority VC** — issued once by the HelixID issuer when the agent is
   onboarded. This is the agent's *ceiling*: the most it could ever be allowed
   to do.
2. **Delegated Grant VC** — issued by the service provider after the **user**
   logs in and consents. This is what the user actually approved, for that one
   service.

Authority is the **intersection** of the two. A grant can never widen what the
issuer gave the agent, and the agent can never act beyond what the user
approved. Both credentials live in the agent's local wallet — private keys never
leave the agent process.

![HelixID flow — agent requests a VP from its wallet, presents it to the MCP server, the server verifies it locally, and the outcome is written to the audit log](docs/assets/helixid-flow.svg)

Walking the diagram:

| Step | What happens |
| --- | --- |
| **1–2** | The agent asks its wallet for a Verifiable Presentation (VP). The wallet bundles the credentials and signs — locally, no network call. |
| **3** | The agent makes its normal tool call, with the signed VP attached. |
| **4** | The service verifies signature, expiry, revocation, and scopes **in-process** — it never calls the issuer to ask whether this particular request is allowed. |
| **5** | Allowed → the tool runs. Denied → an error, and the action never happens. |
| **6** | The outcome is written to the audit log either way — approvals *and* refusals. |

Step 4 is what makes this usable on a hot path and across organizations that
have no prior integration with each other. It's also the claim most worth
stating precisely.

### What "offline verification" means here

The property is: **no synchronous call to the issuer asking it to vouch for this
specific request.** No token introspection, no authorization endpoint, nothing on
the issuer's side that has to be awake and reasoning about this call. That is the
real contrast with routing every request through a token-minting bridge.

It does not mean literally zero network. With `did:web`, verification may make
two HTTP reads — both static, cacheable documents, neither of them a question
about your request:

- **DID resolution** — `GET https://<issuer-domain>/.well-known/did.json` for the
  public key. The same document every time until the key rotates; cached
  in-process for 5 minutes.
- **Revocation** — fetch the status list and read one bit. A single bitstring
  covers every credential that issuer has ever signed, so it is a shared static
  file, not a per-credential lookup.

Everything else — VP and VC signatures, expiry, the delegation chain, scope
intersection — is computed from data already inside the presentation. Zero
network.

Anchor the DID on a ledger and even those reads leave the issuer out of it:
`did:key` carries the public key inside the identifier itself, and `did:hedera`
(via the optional `@helixid/did-hedera` package) reads the DID document from a
public Hedera mirror node — the issuer's own domain is never contacted.

## What HelixID Does

HelixID is a **5-layer trust stack** for AI agents, not just an identity library:

| Layer              | What It Does                                                                                                     | How                                                   |
| ------------------ | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| **1. Identity**    | Every agent gets a DID (Decentralized Identifier) bound to a cryptographic keypair                               | W3C DID (`did:web` default, `did:key` local, `did:hedera` optional) |
| **2. Authority**   | Scoped, time-bound credentials that prove what an agent is allowed to do                                         | W3C Verifiable Credentials with delegation chains     |
| **3. Enforcement** | Runtime verification and authorization checks at execution boundaries                                              | SDK/core verification + verifier-owned policy checks  |
| **4. Audit**       | Ordered record of the whole chain — issuance, consent, presentation, verification, authorization, action, result | Adapter-based `audit_log` store + structured stdout/file |
| **5. Revocation**  | Decentralized revocation read as a static, cacheable document — no per-credential call to the issuer             | Bitstring Status List |

## Roles

HelixID is built around three distinct actors. Each has a different relationship with the SDK and the issuer service.

| Role | Who | What they do |
|---|---|---|
| **Platform Operator** | The team building the AI product | Creates issuer DID, mints bootstrap tokens, issues VCs to agents, manages revocation |
| **AI Agent** | The autonomous software process | Holds a wallet, signs VPs, presents credentials, delegates authority to sub-agents |
| **Service Provider** | The API or service the agent calls | Verifies incoming VPs, checks scopes, optionally issues a session JWT or caches the result |

### Platform Operator

The operator runs the issuer service (self-hosted `helix-api` or CLI for low volume). They never touch agent private keys — they only control the issuance policy.

```typescript
// Operator: mint a bootstrap token for a new agent (authenticated operator call)
// POST /v1/enrollment-tokens
// { agentName, requestedScopes, maxDelegationDepth, requestedDomains }
// → { bootstrapToken }

// Operator: revoke an agent's credential
// CLI
helix revoke --vc-id <vcId> --status-list ./public/status/1.json --wallet issuer.enc
```

The operator's private key (issuer signing key) never leaves the issuer service. It is the trust anchor for every VC issued in their trust domain.

### AI Agent

The agent holds a wallet containing its DID, keypair, and credentials. All signing operations are local — no private key ever leaves the agent process.

```typescript
import { AgentWallet, VPBuilder, delegate } from '@helixid/sdk-js'

// load wallet on every startup
const wallet = await AgentWallet.loadOrCreate('./wallet.enc', process.env.WALLET_PASSPHRASE!)

// build and sign a VP — fully local, no network
const vp = await new VPBuilder({
  credentials: [wallet.credentials[0]],   // add a consent grant VC as a second entry when one applies
  holderDid: wallet.getDID(),
  userDid: 'did:web:user.example.com',
  targetService: 'orders-service',
}).sign(wallet.getPrivateKeyHex(), `${wallet.getDID()}#key-1`)

// delegate to a sub-agent — fully local, self-signed (Option A)
const childVC = await delegate(
  { to: 'did:key:z6Mk...sub-agent', scopes: ['read:orders'], expiresIn: 3600 },
  wallet,
)
```

### Service Provider

The verifier never calls the issuer's API to authorize a request. `verifyVP()` computes signatures, expiry, delegation chain, and scopes from the presentation itself; the only outbound reads are static documents — the DID document (cached in-process) and, when the VC carries a `credentialStatus`, the status list. See [what "offline verification" means here](#what-offline-verification-means-here).

```typescript
import { verifyVP, SessionManager } from '@helixid/sdk-js'

const result = await verifyVP(incomingVP, {
  expectedTargetService: 'orders-service',
})

// replay protection — verifier owns this store
const seen = await redis.get(`vpid:${result.vpId}`)
if (seen) throw new Error('REPLAY_DETECTED')
await redis.set(`vpid:${result.vpId}`, '1', 'EX', result.expiresInSeconds)

// scope check — effectiveScopes is the enforcement field: identical to
// privilegeScopes unless the VP carried a consent grant, in which case it is
// the intersection of the two
if (!result.effectiveScopes.includes('read:orders')) throw new Error('INSUFFICIENT_SCOPE')

// session handling — verifier's choice, both optional

// Option A: issue a short-lived JWT, agent reuses it for subsequent calls
const session = new SessionManager({ secret: process.env.JWT_SECRET!, ttl: 600 })
const token = await session.issue({ agentDid: result.agentDid, scopes: result.effectiveScopes })

// Option B: cache the VP result by vpId, skip re-verification on repeat calls
await cache.set(`vp:${result.vpId}`, result, { ttl: result.expiresInSeconds })
```

Neither session option is required. The verifier can re-verify the VP on every call if preferred. The SDK supports all three paths.

## Architecture

HelixID uses a hybrid 3-layer architecture that delivers the trust properties
of verifiable credentials with the performance of JWTs:

```
┌─────────────────────────────────────────────────────────────┐
│                     YOUR AI AGENT                            │
│                                                                │
│  ┌─────────────┐   ┌──────────────┐   ┌─────────────────┐   │
│  │  Layer 3    │   │   Layer 2    │   │    Layer 1      │   │
│  │  Ed25519    │   │  Ephemeral   │   │   VC-Based       │   │
│  │  Direct     │   │    JWT       │   │   Identity       │   │
│  │  Signing    │   │  Sessions    │   │                  │   │
│  │             │   │              │   │                  │   │
│  │ • did:key   │   │ • Verify VC  │   │ • DID creation   │   │
│  │ • Local dev │   │   once       │   │ • Delegated VCs  │   │
│  │ • MCP tool  │   │ • Issue JWT  │   │ • StatusList     │   │
│  │   auth      │   │   (5-15 min) │   │   revocation     │   │
│  │             │   │ • Hot path   │   │ • Cross-org      │   │
│  │  ~0.1ms     │   │  ~0.1ms/req  │   │   trust          │   │
│  └─────────────┘   └──────────────┘   └─────────────────┘   │
│                                                                │
│  ┌──────────────────────────────────────────────────────┐    │
│  │    API audit log (adapter store + stdout/file)        │    │
│  │   Issuance · revocation · session-bridge verification │    │
│  └──────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

**Why three layers?** Different trust contexts need different tradeoffs:

- **Layer 1 (VCs)** — Use when agents cross organizational boundaries, when
  delegation chains matter, when you need revocation and audit. This is the
  foundation.
- **Layer 2 (JWT sessions)** — Verify the VC once, issue a short-lived JWT
  for subsequent calls. Best for high-frequency internal calls where you've
  already established trust.
- **Layer 3 (Ed25519 direct)** — For local development, MCP tool
  authentication, and internal agent-to-tool calls where both parties share
  a trust context.

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

Three ways in, depending on what you want to see. All run locally.

| Path | Time | Needs | Best for |
| --- | --- | --- | --- |
| **[5-minute path](#5-minute-path-no-infrastructure)** | 5 min | Node only | Seeing the VP build/verify cycle in code, no infra at all |
| **[Consent demo](#demo-a--user-consent-across-two-services)** | ~10 min | Docker | Watching a **user** grant consent and following the full audit trail — the best overview of what HelixID is for |
| **[Travel Concierge demo](#demo-b--llm-agent-with-a-protected-mcp-tool)** | ~10 min | Docker + LLM key | A real LLM agent calling a protected MCP tool, plus revocation and delegation |

New here? Run the **consent demo** — it needs no API key and shows the whole
identity → consent → verification → action → audit story end to end.

Run one demo at a time — the two TypeScript demos share ports `3000`/`8080`.
Ports, demo sign-ins and troubleshooting for all four are in
[`examples/README.md`](examples/README.md).

### 5-minute path (no infrastructure)

No Postgres, no Redis, no Hedera account, no running API. Works immediately after install —
useful for testing the VP/verification flow locally, or if you already have a VC issued by
a self-hosted issuer or any other means.

**Step 1 — Install the SDK**

```bash
npm install @helixid/sdk-js
```

**Step 2 — Generate an agent identity and load or self-issue a dev credential**

```typescript
import { AgentWallet, selfIssueVC } from '@helixid/sdk-js'

const wallet = await AgentWallet.create('./wallet.enc', 'dev-passphrase');


// If you already have a VC issued by a self-hosted issuer, CLI, or any other
// spec-compliant source, load it directly:
await wallet.addCredential(existingVC)

// Quick-start only: self-issue a credential for local development.
// Self-issued VCs carry no issuer-attested authority and are not valid for
// production, demos that prove trust, revocation, or delegation. Verifiers
// reject them by default because allowSelfSigned defaults to false.
const vc = await selfIssueVC(
  { scopes: ['read:orders'], expiresIn: 3600 },
  wallet,
)
await wallet.addCredential(vc)

console.log(wallet.getDID()) // did:key:z6Mk...
```

**Step 3 — Build, present, and verify a VP (fully local)**

```typescript
import { VPBuilder, verifyVP } from '@helixid/sdk-js'

const vp = await new VPBuilder({
  credentials: [wallet.credentials[0]],   // add a consent grant VC as a second entry when one applies
  holderDid: wallet.getDID(),
  userDid: 'did:web:user.example.com',
  targetService: 'orders-service',
}).sign(wallet.getPrivateKeyHex(), `${wallet.getDID()}#key-1`)

const result = await verifyVP(vp, {
  expectedTargetService: 'orders-service',
  allowSelfSigned: true,  // dev only — remove in production
})

console.log(result.valid, result.agentDid, result.privilegeScopes)
// true  did:key:z6Mk...  ['read:orders']
```

Full round trip for local development only. No issuer, no API call, no Hedera.
For any valid HelixID scenario, swap `selfIssueVC` for a real bootstrap token
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
one-shot setup service enrolls one agent, issues its credential, saves its
encrypted wallet to the shared volume, and exits.

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
token. The agent service consumes the token, creates a local encrypted wallet,
adds only local persona metadata to the Travel Concierge manifest, and the new
agent appears in the persona selector — no restart. Select it and search
(succeeds, it has `read:catalog`), then try to book (refused — it lacks
`write:orders`). The Console/HelixID database remains the source of truth for
the real credential, scopes, revocation state, and audit trail.

Select **Concierge Agent**, open **Use case 3 — Revoked credential**, and click
**Revoke selected agent**. The agent service loads the selected persona's
wallet server-side, reads the credential id, and calls
`POST /v1/vcs/:vcId/revoke` with the demo admin key. The browser never sees the
wallet, VC, VP, private key, or admin key. Retry the same booking: the wallet
still signs a VP, but HelixID rejects it because the live status list now marks
the credential revoked. Reset with `docker compose down -v` to issue a fresh
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

#### Enroll an Agent

The onboarding flow is a single SDK round trip using a one-time **bootstrap token** (single-use, short TTL) delivered out-of-band (env var, secret manager, CI variable).

```typescript
import { AgentWallet, HelixClient } from '@helixid/sdk-js'

const wallet = await AgentWallet.create('./wallet.enc', process.env.WALLET_PASSPHRASE!)
const client = new HelixClient(process.env.HELIX_API_URL!)

const vc = await client.enroll(process.env.HELIX_BOOTSTRAP_TOKEN!, wallet)

console.log(wallet.did, vc.id)
```

A bootstrap token is **not** an identity credential. It is a one-time permission slip that says: "whoever presents this may enroll one new agent with these scopes/delegation limits/domains."

Creating that token is a privileged **operator policy action** (not an agent action), because it decides authority:

1. Operator decides policy (`requestedScopes`, `maxDelegationDepth`, `requestedDomains`)
2. Operator mints token via `POST /v1/enrollment-tokens` (authenticated operator call)
3. Operator delivers token out-of-band (env var, Kubernetes Secret, CI variable, etc.)
4. Agent SDK presents token via `client.enroll(...)` and receives VC

This boundary is intentional: if agents could mint their own bootstrap tokens, identity and authorization would collapse into self-granted authority.

#### Present and Verify a VP (SDK-local)

```typescript
import { AgentWallet, VPBuilder, verifyVP } from '@helixid/sdk-js';

const wallet = await AgentWallet.load('agent/wallet.enc', 'change-this-passphrase');
const credential = wallet.credentials[0];
if (!credential) throw new Error('Wallet has no credential');

const signedVP = await new VPBuilder({
  credentials: [credential],
  holderDid: wallet.getDID(),
  userDid: 'did:web:user.example.com',
  targetService: 'orders-service',
}).sign(wallet.getPrivateKeyHex(), `${wallet.getDID()}#key-1`);

const result = await verifyVP(signedVP, {
  expectedTargetService: 'orders-service',
});

console.log(result.valid, result.agentDid, result.privilegeScopes);
```

`verifyVP()` runs in-process, with no call to the issuer's authorization logic: VP signature, VC signature, validity window, revocation (when `credentialStatus` exists), target-service checks, and delegation-chain integrity. Only DID resolution and the status-list read go over the network, and both are static-document fetches — pass `statusListResolver` to serve the list from your own cache or storage. `vpId` is returned for caller-managed replay protection. If you need a session JWT bridge, call `POST /v1/vp/verify` with `session: true`.

#### Delegate Authority (SDK-local, agent-signed child)

```typescript
import { AgentWallet, delegate } from '@helixid/sdk-js';

const wallet = await AgentWallet.load('agent/wallet.enc', 'change-this-passphrase');

const delegatedCredential = await delegate(
  {
    to: 'did:key:z6Mk...delegatee',
    scopes: ['read:analytics'],
    expiresIn: 3600,
    // optional: fromVC: specific issuer-backed parent VC from wallet
  },
  wallet,
);

console.log(
  delegatedCredential.id,
  delegatedCredential.credentialSubject.privilegeScopes,
  delegatedCredential.credentialSubject.delegationDepth,
);
```

Delegation is **Option A**: Agent A signs the child VC locally, and verifiers
enforce chain integrity, scope subset, and max depth from the VC chain itself.
The parent/root VC must still be issuer-backed; self-issued VCs are only for the
quick-start path and are not accepted as a trusted delegation root. There is no
API delegation endpoint.

## Framework Integrations

### LangChain / LangGraph

```typescript
import { HelixIDMiddleware } from '@helixid/langchain';

const middleware = HelixIDMiddleware({
  walletPassphrase: process.env.WALLET_PASSPHRASE!,
  walletFilePath: './agent-wallet.enc',
  userDid: 'did:web:user.example.com',
  targetService: 'orders',
});
```

### MCP (Model Context Protocol)

```typescript
import { attachHelixVP, helixidMCPMiddleware } from '@helixid/mcp';

const requireHelix = helixidMCPMiddleware({
  requiredScopes: ['read:orders'],
});

const outboundCall = await attachHelixVP(
  { name: 'orders.lookup', input: { orderId: 'ORD-1001' } },
  {
    walletPassphrase: process.env.WALLET_PASSPHRASE!,
    walletFilePath: './agent-wallet.enc',
    userDid: 'did:web:user.example.com',
    targetService: 'orders',
  },
);
```

## Why Not Just Use...

### "OAuth/JWT already does this"

OAuth authenticates users to services. It was not designed for autonomous agents that spawn sub-agents, cross organizational boundaries, and need offline-verifiable delegation chains. JWT claims are opaque and custom per system — there's no standard way for Service C to verify that Agent B was delegated authority from Agent A by Organization X without calling Organization X's token server. A HelixID credential carries its own proof: verifying it needs the issuer's public key and its revocation bitstring — two static documents that cache or sit on a CDN — never a live call to the issuer asking whether this request should go through.

### "API keys + RBAC is fine"

For single-tenant, human-supervised agents calling known APIs — sure. When agents autonomously discover and invoke services across organizations, API keys require bilateral key exchange and RBAC requires a shared permission model. Neither exists in cross-org agent-to-agent scenarios. HelixID provides portable authority that works without prior integration.

### "Ed25519 signing is simpler"

Ed25519 proves "this key signed this payload." HelixID proves "Organization X attests that Agent Y has Authority Z, verified by anyone, revocable at any time, with a full delegation chain." Simple signing gives you cryptographic proof of origin. VCs give you cryptographic proof of delegated authority. These are fundamentally different properties.

### "Verified ≠ Trusted"

Correct. Verification is necessary but not sufficient. HelixID combines identity, credentialed authority, verification at runtime, audit evidence, and revocation controls so trust decisions can be made from cryptographic proof instead of shared secrets.

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

## Project Structure

```
helixid/
├── helix-core/           # Core crypto, schemas, resolver, VP/delegation/self-signed primitives
├── helix-api/            # Fastify API: enrollment, VC lifecycle, status list, did:web, session bridge
├── helix-sdk-js/         # SDK: AgentWallet, VPBuilder, verifyVP, delegate, HelixClient (enrollment/API ops)
├── console/              # Operator web console — agents, enrollment, and the audit trail
├── packages/
│   ├── mcp/              # MCP middleware
│   ├── langchain/        # LangChain/LangGraph integration
│   ├── cli/              # CLI workflows
│   ├── did-hedera/       # Hedera DID method resolver
│   └── widget/           # Embeddable user-consent widget
├── examples/
│   ├── e2e-consent-demo/       # User consent across two independent SPs (Demo A)
│   ├── e2e-travel-concierge/   # LLM agent + protected MCP tool (Demo B)
│   ├── framework-middleware/   # Live LangChain and MCP middleware examples
│   ├── verify-vp.ts
│   ├── scope-check.ts
│   ├── self-verify.ts
│   └── revocation-check.ts
├── e2e/                  # End-to-end test package
├── docs/                 # Architecture flows, decisions, public surfaces, testing guides
├── scripts/              # Setup and helper scripts
└── docker-compose.yml    # Local API stack (sqlite+memory+did:web default)
```

## Contributing

We welcome contributions. See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

Key areas where help is needed:

- **DID method implementations** — additional DID method resolvers
- **Framework integrations** — middleware for additional AI agent frameworks
- **Documentation** — tutorials, guides, and examples

## Community

- [GitHub Discussions](https://github.com/helixid/helixid/discussions) — questions, ideas, and show-and-tell
- [GitHub Issues](https://github.com/helixid/helixid/issues) — bug reports and feature requests

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
