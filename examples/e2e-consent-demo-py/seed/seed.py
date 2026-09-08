# e2e-consent-demo-py seeder. Python port of seed/seed.ts.
#
# Run-once migration, not a service. It:
#   1. provisions a did:web DID for each demo SP, generating and hosting each
#      SP's initial status list in the same step;
#   2. enrolls the Travel Planner Agent against the live HelixID API;
#   3. prints agent DID, both SP DIDs, both status-list URLs, and Console URL.

from __future__ import annotations

import json
import os
import time

import requests

from helix_sdk.client import HelixClient

from helixid_config import (
    AGENT_PRIVILEGE_SCOPES,
    DEMO_USER_DID,
    SPS,
    agent_identity_path,
    env,
)
from sp_shared.identity import provision_sp_identity, state_path

AGENT_ID = "travel-planner"


def log(actor: str, message: str) -> None:
    print(f"[{actor}] {message}", flush=True)


def read_identity(path: str):
    """The agent's recorded onboarding result, or None on a first run."""
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return None


def wait_for_api(url: str, attempts: int = 60) -> None:
    for _ in range(attempts):
        try:
            res = requests.get(f"{url}/health", timeout=3)
            if res.ok:
                log("Setup", f"HelixID API is healthy at {url}.")
                return
        except requests.RequestException:
            pass
        time.sleep(2)
    raise RuntimeError(f"HelixID API at {url} did not become healthy in time.")


def mint_token(display_name: str, scopes: list) -> str:
    res = requests.post(
        f"{env.helix_api_url}/v1/enrollment-tokens",
        json={
            "agentName": display_name,
            "requestedScopes": scopes,
            "requestedDomains": [],
            "maxDelegationDepth": 0,
        },
        timeout=10,
    )
    body = res.json() if res.content else {}
    if not res.ok or not body.get("token"):
        raise RuntimeError(f"Failed to mint enrollment token: HTTP {res.status_code}")
    return body["token"]


def main() -> None:
    os.makedirs(env.wallets_dir, exist_ok=True)

    # -- 1. SP identities: did:web + initial status list, together -----------
    provisioned = []
    for sp in SPS:
        identity, status_list, created = provision_sp_identity(env.wallets_dir, sp.id, env.host, sp.port)

        if created:
            with open(state_path(env.wallets_dir, sp.id), "w", encoding="utf-8") as f:
                json.dump({"statusList": status_list, "grants": []}, f, indent=2)
            log("SP", f"Provisioned {sp.display_name}: {identity.did}")
            log("SP", f"  status list -> {identity.statusListUrl}")
        else:
            log("SP", f"{sp.display_name} already provisioned ({identity.did}); reusing.")

        provisioned.append({"id": sp.id, "did": identity.did, "statusListUrl": identity.statusListUrl})

    # -- 2. Travel Planner Agent onboarding (server custody) -------------------
    wait_for_api(env.helix_api_url)

    identity_file = agent_identity_path(env.wallets_dir, AGENT_ID)
    identity = read_identity(identity_file)

    if identity is not None:
        log("Setup", f'Agent "{AGENT_ID}" already onboarded; reusing {identity["agentDid"]}.')
    else:
        token = mint_token("Travel Planner Agent", list(AGENT_PRIVILEGE_SCOPES))
        client = HelixClient(env.helix_api_url, admin_api_key=env.admin_api_key)
        # Two calls on purpose: minting the enrollment token is the agent
        # owner's action, onboarding redeems it. There is no wallet,
        # passphrase or local key any more -- the server generates and holds
        # the agent's key.
        identity = client.onboard_agent(token, [])
        with open(identity_file, "w", encoding="utf-8") as handle:
            json.dump(identity, handle, indent=2)
        log("Helix ID", f"Onboarded agent {identity['agentDid']} (credential {identity['vcId']}).")

    agent_did = identity["agentDid"]

    # -- 3. Summary ------------------------------------------------------------
    print("")
    log("Setup", "Seed complete.")
    log("Agent", f"Travel Planner DID : {agent_did}")
    log("Agent", f"Authority scopes   : {', '.join(AGENT_PRIVILEGE_SCOPES)}")
    log("Agent", f"End user           : {DEMO_USER_DID}")
    for sp in provisioned:
        log("SP", f"{sp['id']} DID          : {sp['did']}")
        log("SP", f"{sp['id']} status list  : {sp['statusListUrl']}")
    log("Setup", f"Console            : {env.console_url}")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001
        print(f"[Setup] Seeding failed: {exc}", flush=True)
        raise SystemExit(1) from exc
