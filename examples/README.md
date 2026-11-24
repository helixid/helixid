# Helix ID Examples

There are two kinds of examples here: **full demos you run with Docker**, and
**short scripts you run against a local API**.

## Full demos (Docker, one command)

Each of these is self-contained. You need this repo and Docker — no second
checkout, no pre-built sibling packages, no registry credentials:

```sh
cd examples/<demo>
cp .env.example .env     # set LLM_API_KEY if the demo needs one
docker compose up --build
```

> **The four demos below need the KYA-OS releases.** They are ported to
> KYA-OS (request proofs and delegation chains, verified in-process; consent
> on Helix's consent page) against `@helixid/core` 3.x with KYA-OS,
> `@helixid/sdk-js` 1.0, `@helixid/mcp-middleware` 1.0 and `helixid-sdk-py` 3.0.
> Until those are published, `docker compose up` builds against older
> packages and the demos don't run; each demo's README shows how to run it
> against local checkouts meanwhile.

| Demo | Language | What it proves | LLM key |
|---|---|---|---|
| [`e2e-travel-concierge`](./e2e-travel-concierge) | TypeScript | A self-custody LLM agent signs a request proof per call; the MCP service verifies it and the agent's chain in-process before a tool runs | required |
| [`e2e-travel-concierge-py`](./e2e-travel-concierge-py) | Python | Same flow through `helixid-sdk-py` | required |
| [`e2e-consent-demo`](./e2e-consent-demo) | TypeScript | Two independent Service Providers each ask the user's consent on Helix's consent page, where the user's own key signs the agent's root hop; the second booking with the same SP reuses it instead of re-prompting | optional |
| [`e2e-consent-demo-py`](./e2e-consent-demo-py) | Python | Same flow through `helixid-sdk-py` | optional |

**How the demos are wired.** Every demo builds `helix-api` from this repo's
root `Dockerfile` — you run the code you just cloned — and builds its own demo
services from `docker/`. The one exception is the **Console**, which is
*pulled* from Docker Hub as `helixid/console` rather than built: it lives in
its own repo (`helixid/helix-console`) and publishes a multi-arch image, so
there's no reason to make you clone it. Each demo's
`docker/console.Dockerfile` is two lines — `FROM helixid/console:latest` plus
its own nginx server block, which same-origin-proxies `/v1` to `helix-api`
because the demo API ships without CORS.

SDK packages resolve as ordinary dependencies during the image build:
`@helixid/sdk-js` / `@helixid/mcp-middleware` from npm, and
`helixid-sdk-py` from PyPI. Nothing is vendored from a sibling directory.

## Where each demo listens

Run **one demo at a time**. The two TypeScript demos both publish `3000` and
`8080`, so they collide with each other; the Python ports are offset so a
Python demo can run alongside its TypeScript twin.

| | `e2e-consent-demo` | `e2e-consent-demo-py` | `e2e-travel-concierge` | `e2e-travel-concierge-py` |
|---|---|---|---|---|
| Main UI | **4100** (chat) | **4200** (chat) | **8090** (chat) | **8091** (chat) |
| Console | **8080** | **8081** | **8080** | **8082** |
| HelixID API | 3000 | 3001 | 3000 | 3002 |
| Airline SP | 4101 | 4201 | — | — |
| Hotel SP | 4102 | 4202 | — | — |
| MCP server | — | — | 7100 | 7101 |

Every sign-in in these demos uses a fixed demo credential:

| Where | Sign in with |
|---|---|
| Travel Planner / Concierge chat | `traveler` / `demo123` |
| Service Provider consent page (Helix Air, Helix Stay) | `ada` / `demo123` |
| HelixID Console | `admin` / `admin` |

## When a demo doesn't behave

**"gemini is temporarily unavailable" / "rate-limited".** Nothing is wrong with
your setup — the free Google AI Studio tier returns `503 UNAVAILABLE` under
load and rate-limits quickly. The **consent demos fall back to a scripted
planner** and keep working (the chat header switches to `Scripted planner`).
The **travel-concierge demos have no fallback** and will surface the error
until the provider recovers. Set `LLM_PROVIDER=anthropic` or `openai` in `.env`
for a steadier run.

If the provider is down and you want to confirm the trust layer still works,
the travel-concierge demos ship a check with no LLM in the loop — call the
protected tool with no request proof and watch the service refuse it:

```sh
curl -s http://localhost:7100/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"book_flight","arguments":{"flightId":"BA249","passengerName":"Mallory"}}}'
# → "Refused by HelixID [PROOF_MISSING]: no request proof was supplied."
```

**A booking is refused with `STATUS_REVOKED` after a long pause.** A
self-custody agent's own status list (it signs its delegation hops) lapses
after the API's status-list lifetime unless the agent re-signs it; the demos
re-sign before each call, but a stack left for days may still hold stale
state. Reset it:

```sh
docker compose down -v && docker compose up --build
```

`down -v` is also the right reset any time a demo's state looks wrong; all demo
state lives in those volumes.

**The consent popup never opens.** The agent opens Helix's consent page in a
popup and waits for the decision there, so the demo needs popups allowed for
`localhost` and the chat tab left open.

**The build fails partway through an install** with a socket or TLS error. The
SDK packages are installed as git dependencies, which run nested installs and
pull a lot over the network; a flaky connection fails the build. Re-run
`docker compose up --build` — it resumes from cached layers.

## Scripts (local API): KYA-OS, end to end

Start the API first (outside production it reads DID documents and status
lists over http on loopback):

```sh
set -a; source .env; set +a
pnpm --filter @helixid/api start
```

Then, with the same `HELIX_ADMIN_API_KEY` (and `HELIX_API_URL` if the API is
not on `http://localhost:3000`):

```sh
pnpm example:request-proof
pnpm example:self-verify
pnpm example:revocation-check
pnpm example:delegation-demo
```

None needs an LLM or Docker. Each registers a service, creates self-custody
agents (`POST /v1/agents`) and runs `helix init` for them, so every agent's key
is generated locally and only its public half reaches helixid. Each root hop
(`POST /v1/grants`) roots an agent's authority over the service; the agent signs
a KYA-OS request proof for each tool call with its own key, and the service
accepts only an L3 verdict (live status reads). Until the KYA-OS SDKs are
published they run against the local SDK checkouts, as `framework-middleware`
does.

- [`request-proof.ts`](./request-proof.ts): one call verified through
  `POST /v1/verify`, then the refusals a verifier must make: an action the
  chain does not allow (`action_not_delegated`) and the same proof again
  (`nonce_replayed`). Then cached against live status: the same kind of call,
  each with a fresh proof, verified from the status cache (no `liveStatus`:
  level L2, which the L3 policy refuses) and with a live read
  (`liveStatus: true`: L3, accepted). Last, a call after the root hop was
  revoked (`status_revoked`).
- [`self-verify.ts`](./self-verify.ts): the service runs every check itself,
  in-process, with `createLocalVerifier` (`@helixid/mcp-middleware`): it reads
  the agent's DID document, keys and card from where they are published, then
  shows each check refusing on purpose (request hash, audience, nonce,
  attenuation, a cached status read held to L2, a revoked hop).
- [`revocation-check.ts`](./revocation-check.ts): the agent's identity
  credential revoked (`POST /v1/vcs/:id/revoke`, the bit set on the status
  list, the next call refused `status_revoked`), its renewal refused, a
  replacement agent enrolled, and that agent's credential renewed before it
  expires (`POST /v1/vcs/:id/renew`).
- [`delegation-demo.ts`](./delegation-demo.ts): agent-to-agent delegation. The
  planner signs a hop to a research agent with its own key, narrowed to one
  scope, and publishes its own signed status list; the research agent is
  accepted for that scope, refused for the one the planner kept, and a hop
  wider than its parent is refused (`attenuation_violation`).

## Real Framework Middleware

[`framework-middleware`](./framework-middleware) shows the real LangChain and
MCP adapters on KYA-OS: a self-custody agent enrolled with `helix init`, a
request proof on every MCP request (`HelixIDToolWrapper` /
`kyaos.withRequestProof`), and `helixidMCPMiddleware` verifying it in-process.
Until the KYA-OS SDKs are published it runs against the local SDK checkouts;
see its README.

```sh
pnpm example:middleware:setup
pnpm example:middleware:langchain
pnpm example:middleware:mcp
```
