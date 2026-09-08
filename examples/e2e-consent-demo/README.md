# e2e-consent-demo — End User consent, two independent Service Providers

The point of this demo is one assertion: **the second booking with the same
Service Provider does not ask the user again.**

Everything else exists to make that assertion mean something — two SPs with
their own `did:web` identities and their own status lists, real grant
credentials signed by each SP's own key, and real `verifyVP()` enforcement on
every protected call.

This demo does **not** modify `examples/e2e-travel-concierge`. It is a separate
folder with its own seeding, its own compose file, and its own SPs.

---

## The 5-step flow

| Step | What happens | What to watch |
|---|---|---|
| 1 | User logs in; the agent holds a `userDid` | no VP exists yet |
| 2 | Search TVM → Delhi | **no consent prompt** — `search_flights` is open, read-only, and carries no `requiredScope` |
| 3 | Book a flight (Airline SP, first time) | SP refuses → consent page → grant issued → booking succeeds |
| 4 | Book a hotel (**different** SP) | a separate prompt and a separate grant; the Airline's grant is untouched |
| 5 | Book a return flight (**same** Airline SP) | **no prompt, no new grant** — the standing grant is reused |

Step 5 is covered by an automated regression test that asserts on counts, not
on "the booking succeeded":

```bash
pnpm --filter @helixid/example-e2e-consent-demo test
```

The test drives two real SP servers over real HTTP — real `did:web` resolution,
real signing, real `verifyVP()`, real status-list fetches. No LLM is involved,
so it runs in CI.

---

## Running it

You need **this repo and Docker. Nothing else** — no second checkout, no
pre-built sibling packages, no registry credentials:

```bash
git clone https://github.com/helixid/helixid.git
cd helixid/examples/e2e-consent-demo
cp .env.example .env
docker compose up --build
```

| Service | URL |
|---|---|
| Airline SP (Helix Air) | http://localhost:4101 |
| Hotel SP (Helix Stay) | http://localhost:4102 |
| Agent | http://localhost:4100 |
| Console (audit) | http://localhost:8080 — `admin` / `admin` |

Reset to a clean slate: `docker compose down -v`.

### What `docker compose up` actually does

Some services are built from this repo, one is pulled ready-made:

| Service | Where it comes from | Why |
|---|---|---|
| `helix-api` | built from this repo's root `Dockerfile` | it's the thing being demoed — you're running the code you just cloned |
| `seed`, `sp-airline`, `sp-hotel`, `agent` | built from `docker/node.Dockerfile` | demo code, lives here |
| `console` | **pulled** from Docker Hub (`helixid/console`) | the Console is a separate repo (`helixid/helix-console`) that publishes a multi-arch image, so there's no reason to make you clone and build it |

The Console step is worth spelling out, because it's the one that used to
require a second checkout. `docker/console.Dockerfile` is two lines: it starts
`FROM helixid/console:latest` and copies in `docker/console-nginx.conf`. That
nginx config serves the Console SPA and reverse-proxies `/v1` and `/health` to
`helix-api`, so the browser talks to the API **same-origin** — the demo API
ships without CORS, and the Console calls it from the browser.

The SDK packages (`@helixid/sdk-js`, `@helixid/widget`) resolve as ordinary git
dependencies on the public `helixid/helix-sdk-js` repo during `pnpm install`
inside the image. No vendoring, no sibling directories.

An LLM API key is optional. The demo supports Gemini, OpenAI, and Anthropic
without changing application code:

```bash
cp .env.example .env
```

Then choose one provider in `.env`:

```dotenv
# Gemini
LLM_PROVIDER=gemini
LLM_API_KEY=your-gemini-key
LLM_MODEL=gemini-flash-latest

# OpenAI
LLM_PROVIDER=openai
LLM_API_KEY=your-openai-key

# Anthropic
LLM_PROVIDER=anthropic
LLM_API_KEY=your-anthropic-key
```

`LLM_MODEL` is optional. The example files select `gemini-flash-latest`; if the
value is omitted, the agent uses a provider-specific demo default. The API key
stays in the agent container and is never exposed to the
chat page, either SP, the widget, an MCP request, a VC, or a VP.

If `LLM_API_KEY` is empty or absent, the agent automatically uses its
deterministic scripted planner. The same chat, tool validation, consent, VP,
and grant-reuse paths still run, so the demo remains usable offline and in CI.

> **No LLM key, or the provider is down?** This demo keeps working — it falls
> back to a deterministic scripted planner and the chat header switches to
> `Scripted planner`. The consent and grant flow, which is the point of the
> demo, does not involve the LLM at all.
>
> Ports, sign-ins and troubleshooting for every demo: [`../README.md`](../README.md).

### Browser demo

Open <http://localhost:4100> and sign in to the Travel Planner:

- username: `traveler`
- password: `demo123`
- user DID after login: `did:web:traveler.example`

The chat uses the selected LLM's native tool/function calling to choose among a
strict allowlist of Airline and Hotel tools. Tool arguments are validated by
the agent before execution; the LLM never receives credential material. The chat header shows the active provider/model, or `Scripted
fallback` when no API key is configured. The agent retains the latest 12
planning turns within the authenticated login
session, so route/date clarification can span multiple messages. History is
cleared on logout or agent restart. Flight searches require a date and
currently include TVM ↔ Delhi and TVM ↔ Mumbai inventory; unsupported routes,
past dates, and dates more than one year ahead return no flights instead of
fabricated results. Ask for a dated flight from TVM to Delhi, book option 1, ask for a Delhi
hotel, then ask for a return flight. On the first booking at each SP, the chat opens that SP in a
Google-login-style popup. Sign in there with `ada` / `demo123`, review the real
HelixID consent widget, and accept. The signed grant returns to the agent and
the booking retries automatically.

The return Airline booking reuses the standing Airline grant, so the chat goes
straight to a confirmed PNR without opening the login or consent popup again.

### Sample chat flow

Here is a concrete example of the consent behavior in the browser demo:

```text
User: Search for a flight from TVM to Delhi for a date in the near future.
Agent: Shows available flights.

User: Book option 1.
Agent: The Airline SP asks for consent, so the first consent widget appears.
User: Accept the consent prompt.
Agent: The booking continues and succeeds.

User: Find a hotel in Delhi.
Agent: The Hotel SP asks for consent, so a second consent widget appears.
User: Accept the consent prompt.
Agent: The hotel booking continues and succeeds.

User: Book a return flight from Delhi to TVM.
Agent: No new widget appears, because the Airline grant is already valid and
       the agent reuses the existing consent grant for the same Service Provider.
```

In other words: the first booking triggers a widget for the Airline SP, the
second booking triggers a separate widget for the Hotel SP, and the third
booking does not show a widget because the agent already has a valid VC/grant
for that same SP.

---

## What each piece owns

```
seed/            provisions both SP did:web identities + their initial status
                 lists, then enrolls the Travel Planner Agent
sp-airline/      Helix Air  — catalog: book:flights, modify:booking
sp-hotel/        Helix Stay — catalog: book:hotel
sp-shared/       the SP app both of the above are instances of
agent/           agent identity, VP requests, consent handoff
helixid-config/  scope strings, tool catalogs, ports
tests/           the 5-step flow, asserted end to end
```

Each SP app owns four things and hosts two artifacts:

| Route | Purpose |
|---|---|
| `POST /api/mcp` | MCP endpoint — `tools/list` and `tools/call`, with the scope gate |
| `GET /api/consent/scopes?agentDid=` | resolves this SP's full grantable-scope catalog |
| `POST /api/consent/accept` | signs and persists the grant — **the only place the SP's key is used** |
| `GET /consent` | the consent page, rendering the real `@helixid/widget` controller |
| `GET /.well-known/did.json` | its `did:web` document, so anyone can verify its grants |
| `GET /status-list/1` | its Bitstring status list, so anyone can check revocation |

---

## The activity trail

The operator console's **Audit & Governance** page at `http://localhost:8080`
records the whole chain, not just the consent moment. The agent UI deliberately
does not show it: the audit trail is an operator surface, and having it in two
places invites the two disagreeing.

```
✓ Credential Issued        Helix Air signs a DelegationGrantCredential
✓ Consent Granted          the platform records it against the agent
✓ Credential Presented     agent → Helix Air, with the tool it wants to call
✓ Verification Success     signatures, validity windows, revocation
✓ Authorization Granted    required scope present in effectiveScopes
✓ Action Performed         CONFIRMED — FLT-3664780C
```

Failures are recorded the same way, which is the point:

```
✓ Verification Success     the credential is perfectly valid…
⃠ Authorization BLOCKED    …but "book:flights" is not in [modify:booking]
```

The four call-time events are separate records because any one of them can be
the thing that failed — a presentation can verify and still be refused. Every
event carries the same envelope (agent, user, credential, issuer, service,
tool, required and effective scopes, result, reason), and the events from one
user action share a `correlationId`, so a trail can be queried after the fact
rather than only read top to bottom.

Who emits what:

| Emitter | Events |
|---|---|
| Service Provider | `VC_ISSUED`, `VC_PRESENTED`, `VP_VERIFIED`/`VP_REJECTED`, `AUTHZ_GRANTED`/`AUTHZ_DENIED`, `TOOL_INVOKED` |
| helix-api | `CONSENT_GRANTED` when the SP finalizes a grant |
| helix-api | enrollment, DID and VC lifecycle events |

The SP reports its own verdicts deliberately: recording them from the agent
would mean trusting the agent's account of its own authorization. All emission
is best-effort — an unreachable audit sink never fails a booking.

---

## Two things worth understanding

**Why a scoped tool checks for a grant, not just for scope.** When a VP carries
no grant, `effectiveScopes` is just the agent's own `privilegeScopes` — and the
agent VC must itself carry `book:flights` for a grant to have any effect at all,
since the intersection is bounded by the agent's ceiling. So an agent presenting
only its platform-issued credential would pass a scope check having never asked
the user anything. Each SP therefore requires that a grant **it issued** is
present in the presentation, and then enforces `effectiveScopes` on top. That is
what makes consent load-bearing rather than decorative.

**Why the browser never sees a private key.** The consent page collects a
selection and POSTs it. `issueGrant()` runs inside `POST /api/consent/accept`,
in the SP's own process, with the SP's own key. The page receives a signed
credential back and never any key material. A test asserts the SP's private key
appears in none of its responses.

---

## Not included

- **No LLM dependency for CI.** Native Gemini/OpenAI/Anthropic tool calling is
  available for the browser demo, while the deterministic no-key planner keeps
  the credential flow reproducible and testable without network access.
- **No audit routing.** Epic 4's routing module is parked, so consent events
  (`consent_granted` / `consent_revoked`) are not emitted anywhere. Each SP logs
  its decisions to stdout, and the platform's own six event types still land in
  Console via `helix-api`. See the epic handoff for the exact gap.
