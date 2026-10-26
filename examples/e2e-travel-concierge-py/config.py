# Shared constants and environment, Python port of ../e2e-travel-concierge/config.ts.
# Everything else in this example is a single-responsibility module: the MCP
# server verifies, the agent presents.

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Dict, List, Optional

# The demo maps travel actions onto already-shipped HelixID scopes: "search" is
# read:catalog and "book" is write:orders, at every service.
SCOPES = {
    "FLIGHTS_READ": "read:catalog",
    "FLIGHTS_BOOK": "write:orders",
}

# The protected MCP tools: flights at Helix Air, hotels at Helix Stay.
TOOLS = {
    "SEARCH": "search_flights",
    "BOOK": "book_flight",
    "SEARCH_HOTELS": "search_hotels",
    "BOOK_HOTEL": "book_hotel",
}


@dataclass(frozen=True)
class ToolDefinition:
    name: str
    required_scope: str


@dataclass(frozen=True)
class ServiceDefinition:
    id: str
    name: str
    domain: str
    # Helix Stay only acts on behalf of a traveler who consented: a VP that
    # names no user is refused with CONSENT_REQUIRED. Helix Air also accepts an
    # agent acting on its own organization-issued authority.
    require_user_consent: bool
    tools: List[ToolDefinition]

    @property
    def short_name(self) -> str:
        return self.name.split(" (")[0]


# The two Service Providers the MCP server plays. Each is enrolled once as a
# service on the API (POST /v1/services), which mints its DID and holds its
# key -- VPs are bound to that DID (`targetService`) and consent grants for it
# are signed with it.
SERVICES: Dict[str, ServiceDefinition] = {
    "air": ServiceDefinition(
        id="air",
        name="Helix Air (travel concierge demo)",
        domain="air.concierge-demo.example",
        require_user_consent=False,
        tools=[
            ToolDefinition(TOOLS["SEARCH"], SCOPES["FLIGHTS_READ"]),
            ToolDefinition(TOOLS["BOOK"], SCOPES["FLIGHTS_BOOK"]),
        ],
    ),
    "stay": ServiceDefinition(
        id="stay",
        name="Helix Stay (travel concierge demo)",
        domain="stay.concierge-demo.example",
        require_user_consent=True,
        tools=[
            ToolDefinition(TOOLS["SEARCH_HOTELS"], SCOPES["FLIGHTS_READ"]),
            ToolDefinition(TOOLS["BOOK_HOTEL"], SCOPES["FLIGHTS_BOOK"]),
        ],
    ),
}


def service_for_tool(tool_name: str) -> Optional[ServiceDefinition]:
    """Which service each tool belongs to."""
    for service in SERVICES.values():
        if any(tool.name == tool_name for tool in service.tools):
            return service
    return None


# Demo travelers an agent can act on behalf of. A consent grant records the
# user as credentialSubject.userDid; in production that DID comes from a real
# sign-in, here it is fixed so the scenarios are deterministic.
USERS: Dict[str, Dict[str, str]] = {
    "ada": {"id": "ada", "name": "Ada Lovelace", "did": "did:example:traveler:ada-lovelace"},
    "grace": {"id": "grace", "name": "Grace Hopper", "did": "did:example:traveler:grace-hopper"},
}

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
    # Internal HelixID API URL (compose service DNS name inside the network).
    helix_api_url: str
    # Admin key: onboarding tokens, signing VPs for server-held agent keys,
    # delegation, revocation, service enrollment and consent grants are all
    # admin-gated on a self-hosted server.
    admin_api_key: str
    # Manifest listing every enrolled persona (survives restarts on the volume).
    persona_manifest_path: str
    # Local index of consent grants issued through this demo (the platform holds the grants themselves).
    grant_index_path: str
    # The DIDs of the two demo services, once enrolled (no "list my services" route on OSS).
    service_index_path: str
    # MCP server base URL; every tool is served at <base>/mcp.
    mcp_base_url: str
    mcp_port: int
    agent_port: int
    llm_provider: str
    llm_model: Optional[str]
    azure_openai: AzureOpenAI

    def llm_api_key(self) -> str:
        return _required("LLM_API_KEY")


def _load_env() -> Env:
    # Shared volume for this app's local state (persona manifest, grant index, service DIDs).
    state_dir = os.environ.get("STATE_DIR") or os.environ.get("WALLETS_DIR") or "/wallets"
    return Env(
        helix_api_url=os.environ.get("HELIX_API_URL", "http://helix-api:3000"),
        admin_api_key=os.environ.get("HELIX_ADMIN_API_KEY", "dev-admin-key-change-in-production"),
        persona_manifest_path=os.path.join(state_dir, "personas.json"),
        grant_index_path=os.path.join(state_dir, "grants.json"),
        service_index_path=os.path.join(state_dir, "services.json"),
        mcp_base_url=os.environ.get("MCP_BASE_URL", "http://mcp-server:7100").rstrip("/"),
        mcp_port=int(os.environ.get("MCP_PORT", "7100")),
        agent_port=int(os.environ.get("AGENT_PORT", "4000")),
        llm_provider=os.environ.get("LLM_PROVIDER", "anthropic"),
        llm_model=os.environ.get("LLM_MODEL") or None,
        azure_openai=AzureOpenAI(api_version=os.environ.get("AZURE_OPENAI_API_VERSION", "2024-10-21")),
    )


env = _load_env()
