# Shared configuration -- Python port of ../e2e-travel-concierge/config.ts,
# kept field-for-field identical so web/, helixid-setup, helix-api and
# Console (all unchanged, still JS/TS) need no changes.

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Optional

SCOPES = {
    "FLIGHTS_READ": "read:catalog",
    "FLIGHTS_BOOK": "write:orders",
}

TOOLS = {
    "BOOK": "book_flight",
    "SEARCH": "search_flights",
}

PROTECTED_TOOL = TOOLS["BOOK"]

TARGET_SERVICE = "travel-booking-mcp"

USER_DID = "did:web:demo-traveler"

INITIAL_PERSONA = {
    "id": "concierge",
    "display_name": "Concierge Agent",
    "scopes": [SCOPES["FLIGHTS_READ"], SCOPES["FLIGHTS_BOOK"]],
}


def _required(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"Missing required env var: {name}")
    return value


@dataclass
class AzureOpenAI:
    api_version: str

    def endpoint(self) -> str:
        return _required("AZURE_OPENAI_ENDPOINT")

    def deployment(self) -> str:
        return _required("AZURE_OPENAI_DEPLOYMENT")


@dataclass
class Env:
    helix_api_url: str
    admin_api_key: str
    wallets_dir: str
    persona_manifest_path: str
    mcp_server_url: str
    mcp_port: int
    agent_port: int
    llm_provider: str
    llm_model: Optional[str]
    azure_openai: AzureOpenAI

    def llm_api_key(self) -> str:
        return _required("LLM_API_KEY")


def agent_identity_path(persona_id: str) -> str:
    """Where a persona's onboarding result is recorded. Server custody: no
    wallet file, no passphrase, no local key material."""
    return os.path.join(env.wallets_dir, f"{persona_id}.agent.json")


def _load_env() -> Env:
    wallets_dir = os.environ.get("WALLETS_DIR", "/wallets")
    return Env(
        helix_api_url=os.environ.get("HELIX_API_URL", "http://helix-api:3000"),
        admin_api_key=os.environ.get("HELIX_ADMIN_API_KEY", "dev-admin-key-change-in-production"),
        wallets_dir=wallets_dir,
        persona_manifest_path=os.path.join(wallets_dir, "personas.json"),
        mcp_server_url=os.environ.get("MCP_SERVER_URL", "http://mcp-server:7100/mcp"),
        mcp_port=int(os.environ.get("MCP_PORT", "7100")),
        agent_port=int(os.environ.get("AGENT_PORT", "4000")),
        llm_provider=os.environ.get("LLM_PROVIDER", "anthropic"),
        llm_model=os.environ.get("LLM_MODEL") or None,
        azure_openai=AzureOpenAI(api_version=os.environ.get("AZURE_OPENAI_API_VERSION", "2024-10-21")),
    )


env = _load_env()
