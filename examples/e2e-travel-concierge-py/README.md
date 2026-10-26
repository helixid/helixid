# e2e-travel-concierge-py — the travel concierge demo, in Python

A port of [`../e2e-travel-concierge`](../e2e-travel-concierge) that drives the
same 18 guided scenarios through [`helixid-sdk-py`](https://github.com/helixid/helix-sdk-py)
instead of the JavaScript SDK. Same assertion, same trust model: an LLM agent
calls a real MCP server playing two Service Providers (Helix Air, Helix Stay),
and every protected tool runs only after HelixID verifies the agent's
presentation — bound to that service's DID, carrying the traveler's consent
where the service requires it — against the live HelixID API.

The scenario table, the decision pipeline, the no-LLM curl check and the
caveats are in [`../e2e-travel-concierge/README.md`](../e2e-travel-concierge/README.md);
the agent's HTTP routes are identical, and the web UI is the same one
(`../e2e-travel-concierge/web`, built into the `web` container here).

One difference from the TypeScript version: FastMCP serves one path per
instance, so all four tools share `/mcp` and the MCP server derives the
service from the tool name. Every check is the same.

Ports are offset so this demo can run **side by side** with the TypeScript one.

## Run it

You need **this repo and Docker. Nothing else**:

```sh
git clone https://github.com/helixid/helixid.git
cd helixid/examples/e2e-travel-concierge-py
cp .env.example .env
#   edit .env → set LLM_API_KEY (only needed for the chat panel)
#   LLM_PROVIDER is anthropic by default; openai | azure | gemini also work
docker compose up --build
```

Wait for `helixid-setup` to print `Seed complete` and exit, then open:

| URL | What |
|---|---|
| http://localhost:8091 | **Scenarios + chat** — pick a scenario, run its steps, talk to an agent |
| http://localhost:8082 | **Console** — log in `admin` / `admin`, open **Audit** |
| http://localhost:3002 | HelixID API |
| http://localhost:7101 | MCP server |
| http://localhost:4001 | Agent |

Reset to a clean slate: `docker compose down -v`.

> The Python SDK used here must provide the `_meta["x-helix-vp"]` transport
> (`read_helix_vp_meta` / `encode_helix_vp`), which the published
> `helixid-sdk-py` may not yet. `docker/python.Dockerfile` installs
> `helixid-sdk-py[mcp-middleware]`; point it at a local checkout if needed.

## Layout

```
config.py                  scopes, tools, the two services, demo travelers, env
personas/
  platform.py              admin-key calls to the API, waiting out rate limits
  enroll.py                enrollment token → POST /v1/onboard
  store.py                 manifest-backed persona registry on the shared volume
  grants.py                local index of consent grants issued through the demo
mcp_server/
  server.py                Helix Air + Helix Stay: replay guard, verify, consent policy, scope
  service_registry.py      enrolls both services once (POST /v1/services); signs consent grants
agent/
  server.py                the HTTP building blocks the scenarios combine
  attacks.py               replay, tamper, wrong-service
  tools/protected_call.py  the only place a VP is requested (POST /v1/agents/:did/vp)
  chat/                    LLM tool loop + providers
```

The `helixid-setup` service is the TypeScript seeder from
`../e2e-travel-concierge` (it writes the same `personas.json` manifest), and
the `web` service is that example's UI — both shared rather than ported.
