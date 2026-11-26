# e2e-consent-demo — End User consent, two independent Service Providers

> **`docker compose up` needs the KYA-OS releases.** This demo runs on KYA-OS
> consent (story L3-H): `@helixid/core` with KYA-OS, `@helixid/sdk-js` 1.0 and
> `@helixid/mcp-middleware` 1.0. Until those are published the compose build
> cannot install them; run the processes directly against local builds of the
> sibling packages instead (see "Running it without Docker").

The point of this demo is one assertion: **the second booking with the same
Service Provider does not ask the user again.**

Everything else exists to make that assertion mean something: two SPs with
their own `did:web` identities and their own keys, the user's consent given on
**HelixID's consent page** and signed by **the user's own key** for that SP,
and every protected call verified by the SP in-process.

---

## The 5-step flow

| Step | What happens | What to watch |
|---|---|---|
| 1 | User signs in to the agent | the agent acts for the SPs' user `ada`; no consent exists yet |
| 2 | Search TVM → Delhi | **no consent prompt** — `search_flights` is open and carries no `requiredScope` |
| 3 | Book a flight (Airline SP, first time) | the SP answers with its signed `needs_authorization` challenge → HelixID's consent page → the user approves → booking succeeds |
| 4 | Book a hotel (**different** SP) | a separate prompt; a different key of the user's signs it; the Airline's consent is untouched |
| 5 | Book a return flight (**same** Airline SP) | **no prompt** — the agent carries the hop it already holds |

The flow is covered end to end by the example's tests, which start a real
helix-api in process (SQLite, did:web), both SP servers and a self-custody
agent, and play the user on HelixID's consent page. No LLM is involved:

```bash
pnpm --filter @helixid/example-e2e-consent-demo test
```

---

## How consent works here (KYA-OS)

- **Everyone keeps their own key.** helixid is self-custody only. The seeder
  (`seed/seed.ts`) enrolls each SP as a service (admin `POST /v1/services`,
  `keyCustody: 'self'`): the SP generates its Ed25519 key and sends only the
  public key, and HelixID hosts its `did:web` document. It creates the agent
  (admin `POST /v1/agents`, `keyCustody: 'self'`) and runs `helixInit`, which
  generates the agent's key locally and enrolls it; HelixID issues its identity
  credential and attests its scopes (its Entity Card).
- **Every call is signed by the agent** (a request proof) and, once the user
  consented at that SP, carries its chain. Each SP verifies both in-process
  with `@helixid/mcp-middleware`'s local verifier: the DIDs, the agent's card,
  status lists read live, attenuation, each proof once. No call to HelixID per
  request.
- **A call without the user's authority** gets the SP's signed
  `needs_authorization` challenge (story L3-E). Its `authorizationUrl` is
  HelixID's consent page, for a consent request the SP signed with its key. The
  agent checks the SP's response proof before showing the URL.
- **On the consent page** the user approves, and HelixID signs the root hop of
  the agent's chain with **the user's pairwise `did:key`** for that SP (one per
  SP and SP user, held in HelixID's key store). The agent keeps the hop and
  retries; later calls carry it, and it is renewed inside the consent window
  without a click.
- **Consent never widens what the agent may do.** The consent screen offers
  only the agent's attested scopes ∩ the SP's catalog, and the SP's verifier
  intersects the chain with the agent's card again.

---

## Running it

```bash
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

The SPs and the agent share helix-api's network, so `did:web:localhost%3A3000:…`
resolves the same inside the stack as in your browser. Reset with
`docker compose down -v`.

### Running it without Docker

Start helixid's API (`pnpm dev` at the repo root, with `DID_METHOD=web` and
`DID_DOMAIN=localhost:3000`), then in this folder:

```bash
export HELIX_API_URL=http://localhost:3000 HELIX_ADMIN_API_KEY=<the API's admin key>
pnpm run setup          # enrolls both SPs and the agent, once
pnpm run sp:airline     # :4101
pnpm run sp:hotel       # :4102
pnpm run agent          # :4100
```

An LLM API key is optional (`LLM_PROVIDER` = gemini, openai or anthropic, and
`LLM_API_KEY`). Without one the agent uses its deterministic scripted planner;
the consent flow, which is the point of the demo, does not involve the LLM.

### Browser demo

Open <http://localhost:4100> and sign in: `traveler` / `demo123`. Ask for a
dated flight from TVM to Delhi, book option 1: the chat shows a consent card,
and **Review permissions** opens HelixID's consent page in a popup. Approve
there; the booking completes on its own. Ask for a Delhi hotel: a second,
independent consent. Ask for a return flight: it books with no prompt. The
right-hand rail shows each SP's consented scopes, the window, and the user's
key at that SP.

---

## What each piece owns

```
seed/            enrolls both SPs (self custody, did:web hosted by HelixID) and the agent (self custody)
sp-airline/      Helix Air  — catalog: book:flights, modify:booking
sp-hotel/        Helix Stay — catalog: book:hotel
sp-shared/       the SP app both are instances of: the KYA-OS gate (local verifier,
                 the consent challenge, response proofs) and the booking backend
agent/           request proofs, the consent hand-off, the stored hops, the chat
helixid-config/  scope strings, tool catalogs, ports
tests/           the 5-step flow, asserted end to end
```

Each SP logs its own decisions (open tool, consent challenge, authorization,
the action and its result) as JSON lines on stdout. The SP reports them itself:
recording them from the agent would mean trusting the agent's account of its
own authorization.
