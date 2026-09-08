# Shared, compose-time configuration for the consent demo.
#
# Two independent Service Providers, each with its own did:web identity, its
# own status list, and its own grantable-scope catalog. Nothing is shared
# between them at runtime -- that independence is the point of steps 3 and 4
# of the demo flow.
#
# Python port of examples/e2e-consent-demo/helixid-config/index.ts
# -- kept field-for-field identical so the existing SP/agent frontends and
# route contracts need no changes.

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import List, Optional
from urllib.parse import quote

SCOPES = {
    "BOOK_FLIGHTS": "book:flights",
    "MODIFY_BOOKING": "modify:booking",
    "BOOK_HOTEL": "book:hotel",
}


@dataclass
class DemoTool:
    name: str
    description: str
    required_scope: Optional[str] = None

    def to_dict(self) -> dict:
        d = {"name": self.name, "description": self.description}
        if self.required_scope:
            d["metadata"] = {"requiredScope": self.required_scope}
        return d


@dataclass
class CuratedScopeEntry:
    scope: str
    label: str
    description: Optional[str] = None
    required: Optional[bool] = None


@dataclass
class SpDefinition:
    id: str
    display_name: str
    port: int
    curated_fallback: List[CuratedScopeEntry] = field(default_factory=list)
    tools: List[DemoTool] = field(default_factory=list)


AIRLINE = SpDefinition(
    id="airline",
    display_name="Helix Air",
    port=int(os.environ.get("AIRLINE_PORT", "4101")),
    curated_fallback=[
        CuratedScopeEntry(
            scope=SCOPES["BOOK_FLIGHTS"],
            label="Book flights",
            description="Purchase flights on your behalf",
        ),
        CuratedScopeEntry(
            scope=SCOPES["MODIFY_BOOKING"],
            label="Modify bookings",
            description="Change or cancel an existing flight booking",
        ),
    ],
    tools=[
        DemoTool(
            name="search_flights",
            description=(
                "Search available flights for a route and date. Optionally narrow "
                "by carrier and party size. Open, no grant required."
            ),
        ),
        DemoTool(
            name="book_flight",
            description="Book a flight. Requires a consent grant carrying book:flights.",
            required_scope=SCOPES["BOOK_FLIGHTS"],
        ),
        DemoTool(
            name="modify_booking",
            description="Modify an existing booking. Requires a consent grant carrying modify:booking.",
            required_scope=SCOPES["MODIFY_BOOKING"],
        ),
    ],
)

HOTEL = SpDefinition(
    id="hotel",
    display_name="Helix Stay",
    port=int(os.environ.get("HOTEL_PORT", "4102")),
    curated_fallback=[
        CuratedScopeEntry(
            scope=SCOPES["BOOK_HOTEL"],
            label="Book hotels",
            description="Reserve hotel rooms on your behalf",
        ),
    ],
    tools=[
        DemoTool(
            name="search_hotels",
            description=(
                "Search available hotels in a city. Optionally cap the nightly "
                "rate. Open, no grant required."
            ),
        ),
        DemoTool(
            name="book_hotel",
            description="Book a hotel room. Requires a consent grant carrying book:hotel.",
            required_scope=SCOPES["BOOK_HOTEL"],
        ),
    ],
)

SPS = [AIRLINE, HOTEL]


def sp_did_for(host: str, port: int) -> str:
    """did:web for a locally-hosted SP -- percent-encoded host:port, the form
    helix-api's resolver maps to http://<host>:<port>/.well-known/did.json."""
    return f"did:web:{quote(f'{host}:{port}', safe='')}"


def sp_base_url_for(host: str, port: int) -> str:
    return f"http://{host}:{port}"


def status_list_url_for(base_url: str) -> str:
    return f"{base_url}/status-list/1"


AGENT_PRIVILEGE_SCOPES = [SCOPES["BOOK_FLIGHTS"], SCOPES["MODIFY_BOOKING"], SCOPES["BOOK_HOTEL"]]

DEMO_USER_DID = "did:web:traveler.example"


@dataclass
class Env:
    host: str
    helix_api_url: str
    admin_api_key: str
    wallets_dir: str
    agent_port: int
    airline_url: str
    hotel_url: str
    llm_provider: str
    llm_api_key: str
    llm_model: str
    console_url: str


def _load_env() -> Env:
    host = os.environ.get("DEMO_HOST", "localhost")
    return Env(
        host=host,
        helix_api_url=os.environ.get("HELIX_API_URL", "http://helix-api:3000"),
        admin_api_key=os.environ.get("HELIX_ADMIN_API_KEY", "dev-admin-key-change-in-production"),
        wallets_dir=os.environ.get("WALLETS_DIR", "/wallets"),
        agent_port=int(os.environ.get("AGENT_PORT", "4100")),
        airline_url=os.environ.get("AIRLINE_URL", f"http://{host}:{AIRLINE.port}"),
        hotel_url=os.environ.get("HOTEL_URL", f"http://{host}:{HOTEL.port}"),
        llm_provider=os.environ.get("LLM_PROVIDER", "gemini"),
        llm_api_key=(
            os.environ.get("LLM_API_KEY")
            or os.environ.get("GEMINI_API_KEY")
            or os.environ.get("OPENAI_API_KEY")
            or os.environ.get("ANTHROPIC_API_KEY")
            or ""
        ),
        llm_model=os.environ.get("LLM_MODEL", ""),
        console_url=os.environ.get("CONSOLE_URL", "http://localhost:8080"),
    )


env = _load_env()


def agent_identity_path(wallets_dir: str, agent_id: str) -> str:
    """Where the seeder records the agent's onboarding result.

    Agent self-custody is retired: onboarding returns only {agentDid, vcId}
    and the private key never leaves the server, so there is no wallet file
    whose existence used to imply the agent's DID. The seeder writes this
    file instead, and the agent server reads it on boot.
    """
    return os.path.join(wallets_dir, f"{agent_id}.agent.json")
