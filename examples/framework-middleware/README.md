# Framework Middleware

This example demonstrates the real HelixID LangChain and MCP adapters against a live Helix API. It does not mock the Helix client, presentation signing, verification, or the onboarding flow.

The setup flow creates a real agent DID through the Helix onboarding API and issues a real `HelixAgentCredential`. The LangChain and MCP scripts then ask the API to sign a presentation on that agent's behalf, and verify it through the API.

Agent self-custody is retired: the server generates the agent's keypair at onboarding and holds the private key, so nothing here creates a wallet, a passphrase, or any local key material.

## Who Needs What

Setup onboards the agent and issues its VC. That is a one-time platform-operator action, not something every LangChain or MCP developer repeats.

| Who | Does what | Needs |
| --- | --- | --- |
| Platform operator | Runs `setup-live.ts` once to onboard the agent | Running Helix API, admin key |
| Framework developer | Adds `HelixIDMiddleware`, `HelixIDToolWrapper`, or MCP middleware to app code | Agent DID, `HELIX_API_URL`, admin key |

The middleware value is that framework developers do not handle cryptography, DID anchoring, VC issuance, or VP construction directly. Once an agent is onboarded, a few lines of config make every protected tool call carry a verifiable credential.

Note that the admin key is no longer setup-only. Signing a presentation is now
`POST /v1/agents/:did/vp`, which is admin-gated in OSS — there is no per-agent
credential narrower than that key. Anything running this middleware therefore
holds it, which is a real reduction in scoping versus self-custody, where only
the agent's own key could sign for itself.

## Prerequisites

Configure the root `.env` for the local API flow:

```sh
HELIX_ADMIN_API_KEY=...
```

Prepare the environment:

```sh
pnpm install
```

Start the API with the root environment loaded:

```sh
set -a; source .env; set +a
pnpm --filter @helixid/api dev
```

## Run

In a second terminal, the platform operator runs setup once:

```sh
set -a; source .env; set +a
pnpm example:middleware:setup
```

After setup, a LangChain or MCP developer needs the recorded agent identity, the Helix API URL, and the admin key:

```sh
export API_BASE_URL=http://localhost:3000
export HELIX_ADMIN_API_KEY=...
pnpm example:middleware:langchain
pnpm example:middleware:mcp
```

`setup-live.ts` writes `agent/agent.json`, holding only the agent's DID and credential id. No key material is written, and the file is ignored by Git.

## What Each Script Shows

`setup-live.ts` creates a one-use enrollment token, completes real onboarding via `POST /v1/onboard`, records the agent's DID and credential id, and prints the agent DID, VC id, granted scopes, and expiry.

`langchain.ts` uses `HelixIDMiddleware` to inject `_helixVP` into tool input, verifies that VP through the live API, then uses `HelixIDToolWrapper` around a small structured tool.

`mcp.ts` uses `attachHelixVP` to add a real `Authorization: HelixVP ...` header, sends that request through `helixidMCPMiddleware`, demonstrates an allowed `read:orders` call, and demonstrates an insufficient-scope denial for `write:inventory`.

## Environment Overrides

- `API_BASE_URL`: Helix API URL, default `http://localhost:3000`
- `HELIX_ADMIN_API_KEY`: admin key used to sign presentations, default `dev-admin-key-change-in-production`
- `HELIX_TARGET_SERVICE`: VP target service, default `amazon`
- `HELIX_USER_DID`: simulated user DID, default `did:web:user.example.com`
