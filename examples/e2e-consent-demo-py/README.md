# e2e-consent-demo-py — the consent demo, in Python

A port of [`../e2e-consent-demo`](../e2e-consent-demo) that drives the same
flow through [`helixid-sdk-py`](https://github.com/helixid/helix-sdk-py)
instead of the JavaScript SDK. The point of the demo is unchanged: **the
second booking with the same Service Provider does not ask the user again.**

Two Service Providers with their own `did:web` identities and their own status
lists, real grant credentials signed by each SP's own key, and real VP
verification on every protected call.

Ports are offset so this demo can run **side by side** with the TypeScript one.

## Run it

You need **this repo and Docker. Nothing else** — no second checkout, no
pre-built sibling packages, no registry credentials:

```sh
git clone https://github.com/helixid/helixid.git
cd helixid/examples/e2e-consent-demo-py
cp .env.example .env
docker compose up --build
```

| URL | What |
|---|---|
| http://localhost:4201/consent | **Airline SP** (Helix Air) consent page |
| http://localhost:4202/consent | **Hotel SP** (Helix Stay) consent page |
| http://localhost:4200 | Agent |
| http://localhost:8081 | **Console** — log in `admin` / `admin`, open **Audit** |
| http://localhost:3001 | HelixID API |

Reset to a clean slate: `docker compose down -v`.

An LLM API key is **optional** here — the consent/grant flow is what's being
demonstrated, and it runs without one.

## What to try

Open the agent at <http://localhost:4200> and sign in as `traveler` / `demo123`.

1. **Search for a flight** — no consent prompt. Search is read-only and carries
   no required scope.
2. **Book it.** The Airline has never seen this agent, so it refuses and asks
   *you* directly, on its own page. Sign in there as `ada` / `demo123`, review
   the scopes in the real HelixID consent widget, and accept.
3. **Book a hotel.** A *different* Service Provider, so it asks again — nothing
   the Airline approved carries over.
4. **Book a return flight.** No prompt this time: the Airline's standing grant
   is reused.

Then open **Console → Audit** (<http://localhost:8081>, `admin` / `admin`) and
read the trail: credential issued, consent granted, credential presented,
verification result, authorization result, action performed. Refusals are
recorded as clearly as approvals — that's the point.

Ports, sign-ins and troubleshooting for every demo:
[`../README.md`](../README.md).

## What `docker compose up` actually does

Some services are built from this repo, one is pulled ready-made:

| Service | Where it comes from | Why |
|---|---|---|
| `helix-api` | built from this repo's root `Dockerfile` | it's the thing being demoed — you're running the code you just cloned |
| `seed`, `sp-airline`, `sp-hotel`, `agent` | built from `docker/python.Dockerfile` | the Python demo code, lives here |
| `console` | **pulled** from Docker Hub (`helixid/console`) | the Console is a separate repo (`helixid/helix-console`) that publishes a multi-arch image, so there's no reason to make you clone and build it |

`docker/console.Dockerfile` is two lines: `FROM helixid/console:latest` plus
this example's `docker/console-nginx.conf`, which serves the Console SPA and
reverse-proxies `/v1` and `/health` to `helix-api` so the browser talks to the
API **same-origin** — the demo API ships without CORS.

Two things come from public sources during the image build, with nothing
vendored from a sibling directory:

- `helixid-sdk-py` — `pip install "helixid-sdk-py[dev] @ git+https://github.com/helixid/helix-sdk-py"`.
- `@helixid/widget` — the consent widget has no Python port, so a first build
  stage installs it from the public `helixid/helix-sdk-js` repo and copies the
  resulting browser bundle in. `sp_shared/serve.py` serves it from
  `widget-dist/` by default; set `WIDGET_DIST_PATH` to point somewhere else
  when running outside Docker.
