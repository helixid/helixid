# Helix ID Examples

There are two kinds of examples here: **full demos you run with Docker**, and
**short scripts you run against a local API**.

## Full demos (Docker, one command)

> **The four demos below wait for the L3-H examples port** (a follow-up PR):
> they still present Helix VPs (`signVP`, `/v1/vp/verify`, `delegateAuthority`,
> `/v1/onboard`), which KYA-OS retired, and they install the published SDKs,
> which predate KYA-OS. Until then they do not run against this repo's API.
> [`e2e-screenshots`](./e2e-screenshots), the Playwright walkthrough of these
> demos' UIs, waits with them: it has no VP code of its own, only the demos'
> screens and scenario buttons, which that port reshapes.

Each of these is self-contained. You need this repo and Docker — no second
checkout, no pre-built sibling packages, no registry credentials:

```sh
cd examples/<demo>
cp .env.example .env     # set LLM_API_KEY if the demo needs one
docker compose up --build
```

| Demo | Language | What it proves | LLM key |
|---|---|---|---|
| [`e2e-travel-concierge`](./e2e-travel-concierge) | TypeScript | An LLM agent enrolls, gets a real credential, and an MCP tool refuses to run until the presentation verifies | required |
| [`e2e-travel-concierge-py`](./e2e-travel-concierge-py) | Python | Same flow through `helixid-sdk-py` | required |
| [`e2e-consent-demo`](./e2e-consent-demo) | TypeScript | Two independent Service Providers issue their own grants; the second booking with the same SP reuses the standing grant instead of re-prompting | optional |
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
`@helixid/sdk-js` / `@helixid/mcp` / `@helixid/widget` from npm, and
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
protected tool with no presentation and watch HelixID refuse it:

```sh
curl -s http://localhost:7100/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"book_flight","arguments":{"flightId":"BA249","passengerName":"Mallory"}}}'
# → "Refused by HelixID: no verifiable presentation was supplied."
```

**A booking is refused with `VC_EXPIRED`.** The demo credential has a limited
lifetime, and the setup step skips re-enrolment when the persona already
exists — so a stack you started days ago keeps presenting the stale credential.
Reset it:

```sh
docker compose down -v && docker compose up --build
```

`down -v` is also the right reset any time a demo's state looks wrong; all demo
state lives in those volumes.

**The consent popup never returns.** The Service Provider opens its consent
page in a popup and hands the signed grant back to the page that opened it, so
the demo needs popups allowed for `localhost` and the chat tab left open.

**The build fails partway through an install** with a socket or TLS error. The
SDK packages are installed as git dependencies, which run nested installs and
pull a lot over the network; a flaky connection fails the build. Re-run
`docker compose up --build` — it resumes from cached layers.

## Script (local API): a KYA-OS request proof, end to end

Start the API first (outside production it reads DID documents and status
lists over http on loopback):

```sh
set -a; source .env; set +a
pnpm --filter @helixid/api start
```

Then, with the same `HELIX_ADMIN_API_KEY`:

```sh
pnpm example:request-proof
```

[`request-proof.ts`](./request-proof.ts) needs no LLM and no Docker. It
registers a service, creates a self-custody agent (`POST /v1/agents`) and runs
`helix init` for it, so the agent's key is generated locally and only its
public half reaches helixid. It roots the agent's authority over the service
with one delegation hop (`POST /v1/grants`), has the agent sign a KYA-OS
request proof for one tool call with its own key, and verifies it through
`POST /v1/verify` with live status reads, accepting only an L3 verdict. Then it
shows the refusals a verifier must make: an action the chain does not allow
(`action_not_delegated`), the same proof again (`nonce_replayed`), and a call
after the root hop was revoked (`status_revoked`).

It replaces the VP-era scripts (`verify-vp*`, `self-verify`, `scope-check`,
`revocation-check`, `verifier-*`, `delegation-demo`): `/v1/vp/verify`, `signVP`,
VP sessions and `delegateAuthority` are retired with no backward compatibility.

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
