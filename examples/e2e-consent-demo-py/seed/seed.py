# e2e-consent-demo-py seeder. Python port of examples/e2e-consent-demo/seed/seed.ts.
#
# Run once, not a service. It:
#   1. enrolls each demo SP as a service at HelixID, self custody: the SP
#      generates its own Ed25519 key and sends only the public key; HelixID
#      hosts its did:web (sp_shared/identity.py);
#   2. onboards the Travel Planner Agent, self custody: the operator creates
#      it (admin POST /v1/agents, keyCustody 'self'), and helix_init generates
#      the agent's key locally and enrolls it with the token. Helix issues its
#      identity credential and attests its scopes (its Entity Card); the
#      private key stays in the wallets directory;
#   3. prints the agent DID, both SP DIDs and the Console URL.
#
# A user's consent is not seeded: it is given on Helix's consent page, the
# first time an SP asks (KYA-OS story L3-H).

from __future__ import annotations

import json
import os
import time

import requests
from dotenv import load_dotenv

load_dotenv()

from helix_sdk.custody import helix_init  # noqa: E402

from helixid_config import AGENT_PRIVILEGE_SCOPES, SPS, agent_dir, env  # noqa: E402
from sp_shared.identity import enroll_sp_service  # noqa: E402


def log(actor: str, message: str) -> None:
    print(f"[{actor}] {message}", flush=True)


def wait_for_api(url: str, attempts: int = 60) -> None:
    for _ in range(attempts):
        try:
            if requests.get(f"{url}/health", timeout=5).ok:
                log("Setup", f"HelixID API is healthy at {url}.")
                return
        except requests.RequestException:
            pass
        time.sleep(2)
    raise RuntimeError(f"HelixID API at {url} did not become healthy in time.")


def onboard_agent() -> str:
    """The agent's DID, onboarding it on a first run."""
    directory = agent_dir(env.wallets_dir)
    summary = os.path.join(directory, "helix-agent.json")
    if os.path.exists(summary):
        with open(summary, "r", encoding="utf-8") as f:
            did = json.load(f)["did"]
        log("Setup", f"Agent already onboarded; reusing {did}.")
        return did
    response = requests.post(
        f"{env.helix_api_url}/v1/agents",
        json={"name": "Travel Planner Agent (Python)", "scopes": AGENT_PRIVILEGE_SCOPES, "keyCustody": "self"},
        headers={"x-admin-api-key": env.admin_api_key},
        timeout=15,
    )
    created = response.json() if response.content else {}
    if not response.ok or not created.get("enrollmentToken"):
        error = created.get("error") if isinstance(created.get("error"), dict) else {}
        raise RuntimeError(error.get("message") or f"agent creation failed: HTTP {response.status_code}")
    # The key is generated here and never leaves this directory; Helix gets the public key and a proof of possession.
    init = helix_init(env.helix_api_url, created["enrollmentToken"], directory)
    log("Helix ID", f"Onboarded agent {init.did} ({init.label}, status {init.status}).")
    return init.did


def main() -> None:
    os.makedirs(env.wallets_dir, exist_ok=True)
    wait_for_api(env.helix_api_url)

    enrolled = []
    for sp in SPS:
        identity, created = enroll_sp_service(env.wallets_dir, sp, env.host, sp.port, env.helix_api_url, env.admin_api_key)
        log("SP", f"Enrolled {sp.display_name}: {identity.did}" if created else f"{sp.display_name} already enrolled ({identity.did}); reusing.")
        enrolled.append((sp.id, identity.did))

    agent_did = onboard_agent()

    print("", flush=True)
    log("Setup", "Seed complete.")
    log("Agent", f"Travel Planner DID : {agent_did}")
    log("Agent", f"Attested scopes    : {', '.join(AGENT_PRIVILEGE_SCOPES)}")
    for sp_id, did in enrolled:
        log("SP", f"{sp_id} DID          : {did}")
    log("Setup", f"Console            : {env.console_url}")


if __name__ == "__main__":
    main()
