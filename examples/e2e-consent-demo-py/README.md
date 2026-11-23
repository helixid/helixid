# e2e-consent-demo-py — the consent demo, in Python

> **`docker compose up` needs the KYA-OS releases.** This demo runs on KYA-OS
> consent (story L3-H): `@helixid/core` with KYA-OS and the matching
> `helixid-sdk-py` (3.0, with `helix_mcp_middleware`). Until those are
> published, run the processes directly against the sibling checkouts (see
> "Running it without Docker").

A port of [`../e2e-consent-demo`](../e2e-consent-demo) that drives the same
flow through [`helixid-sdk-py`](https://github.com/helixid/helix-sdk-py)
instead of the JavaScript SDK. The point is unchanged: **the second booking
with the same Service Provider does not ask the user again.**

Two Service Providers with their own `did:web` identities and their own keys,
the user's consent given on **HelixID's consent page** and signed by **the
user's own key** for that SP, and every protected call verified by the SP
in-process. Ports are offset so this demo can run side by side with the
TypeScript one.

## Run it

```sh
cd helixid/examples/e2e-consent-demo-py
cp .env.example .env
docker compose up --build
```

| URL | What |
|---|---|
| http://localhost:4200 | Agent (`traveler` / `demo123`) |
| http://localhost:4201, :4202 | Airline and Hotel SPs (MCP endpoint, health) |
| http://localhost:8081 | **Console** — `admin` / `admin` |
| http://localhost:3001 | HelixID API, and its consent page |

The SPs and the agent share helix-api's network, so `did:web:localhost%3A3001:…`
resolves the same inside the stack as in your browser. Reset with
`docker compose down -v`. An LLM API key is optional: the consent flow runs
without one.

### Running it without Docker

Start helixid's API with `DID_METHOD=web` (e.g. `pnpm dev` at the repo root on
`:3001`, `DID_DOMAIN=localhost:3001`), then in this folder:

```sh
pip install -e ../../../helix-sdk-py -r requirements.txt   # until helixid-sdk-py 3.0 is published
export HELIX_API_URL=http://localhost:3001 HELIX_ADMIN_API_KEY=<the API's admin key>
python -m seed.seed          # enrolls both SPs and the agent, once
python -m sp_airline.server  # :4201
python -m sp_hotel.server    # :4202
python -m agent.server       # :4200
```

## What to try

Open the agent at <http://localhost:4200> and sign in as `traveler` / `demo123`.

1. **Search for a flight** — no consent prompt. Search is open and carries no
   required scope.
2. **Book it.** The Airline answers with its signed `needs_authorization`
   challenge, so the chat shows a consent card. **Review permissions** opens
   HelixID's consent page; approve there, and the booking completes on its own.
3. **Book a hotel.** A *different* Service Provider asks again, and a different
   key of yours signs it; nothing the Airline was given carries over.
4. **Book a return flight.** No prompt: the agent carries the hop it holds for
   the Airline.

## How consent works here (KYA-OS)

- **Everyone keeps their own key** (helixid is self-custody only). The seeder
  enrolls each SP (admin `POST /v1/services`, `keyCustody: 'self'`, only its
  public key sent; HelixID hosts its `did:web`) and creates the agent (admin
  `POST /v1/agents`, `keyCustody: 'self'`); `helix_init` generates the agent's
  key locally and enrolls it.
- **Every call is signed by the agent** and, once the user consented at that
  SP, carries its chain. The SP verifies both in-process with
  `helix_mcp_middleware`'s local verifier — no call to HelixID per request.
- **A call without the user's authority** gets the SP's signed
  `needs_authorization` challenge; its URL is HelixID's consent page, for a
  consent request the SP signed. The agent checks the SP's response proof
  before showing it.
- **On the consent page** HelixID signs the root hop of the agent's chain with
  **the user's pairwise `did:key`** for that SP. The agent keeps the hop,
  carries it on later calls, and renews it inside the consent window without a
  click. The consent screen offers only the agent's attested scopes ∩ the SP's
  catalog.

Each SP logs its own decisions as JSON lines on stdout. Ports, sign-ins and
troubleshooting for every demo: [`../README.md`](../README.md).
