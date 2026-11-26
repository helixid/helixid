# Shared, compose-time configuration for the consent demo (Python).
#
# Two independent Service Providers, each with its own did:web identity (its
# own key, its document hosted by Helix) and its own scope catalog. The user's
# consent at one never covers the other: each is the root of a chain signed by
# the user's own pairwise did:key on Helix's consent page (KYA-OS story L3-H).
#
# helixid is self-custody only: the SPs and the agent each generate their own
# key locally and send Helix only the public key (seed/seed.py).
#
# Python port of examples/e2e-consent-demo/helixid-config/index.ts -- kept
# field-for-field identical (SCOPES/SpDefinition/AIRLINE/HOTEL) so the SP/agent
# frontends and route contracts match the JS demo.

from __future__ import annotations

import os
from dataclasses import dataclass, field
import re
from typing import List, Optional

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
class ScopeEntry:
    """One scope an SP can ask a user to consent to, as the consent page shows it."""

    scope: str
    label: str
    description: Optional[str] = None
    required: Optional[bool] = None


@dataclass
class SpDefinition:
    id: str
    display_name: str
    port: int
    # Every scope this SP can ask consent for (its catalog). Helix refuses a
    # consent request for a scope the agent is not attested for, so what the
    # user sees is the agent's own scopes intersected with this catalog.
    scope_catalog: List[ScopeEntry] = field(default_factory=list)
    tools: List[DemoTool] = field(default_factory=list)


AIRLINE = SpDefinition(
    id="airline",
    display_name="Helix Air",
    port=int(os.environ.get("AIRLINE_PORT", "4201")),
    scope_catalog=[
        ScopeEntry(
            scope=SCOPES["BOOK_FLIGHTS"],
            label="Book flights",
            description="Purchase flights on your behalf",
        ),
        ScopeEntry(
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
                "by carrier and party size. Open, no consent required."
            ),
        ),
        DemoTool(
            name="book_flight",
            description="Book a flight. Requires the user consent for book:flights.",
            required_scope=SCOPES["BOOK_FLIGHTS"],
        ),
        DemoTool(
            name="modify_booking",
            description="Modify an existing booking. Requires the user consent for modify:booking.",
            required_scope=SCOPES["MODIFY_BOOKING"],
        ),
    ],
)

HOTEL = SpDefinition(
    id="hotel",
    display_name="Helix Stay",
    port=int(os.environ.get("HOTEL_PORT", "4202")),
    scope_catalog=[
        ScopeEntry(
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
                "rate. Open, no consent required."
            ),
        ),
        DemoTool(
            name="book_hotel",
            description="Book a hotel room. Requires the user consent for book:hotel.",
            required_scope=SCOPES["BOOK_HOTEL"],
        ),
    ],
)

SPS = [AIRLINE, HOTEL]


# The agent's own authority ceiling, issued by the platform operator at
# enrollment. The user's consent never widens this: the consent screen offers
# only these scopes intersected with the SP's catalog, and verification
# intersects the chain with them (effectiveScopes), so the agent credential is
# the upper bound and the root hop the user signed is the per-SP consent
# within it.
AGENT_PRIVILEGE_SCOPES = [SCOPES["BOOK_FLIGHTS"], SCOPES["MODIFY_BOOKING"], SCOPES["BOOK_HOTEL"]]

# The traveler's account at both SPs ("ada"). KYA-OS story L3-H: a user is
# known to Helix only as a pairwise did:key per (service, this id), created on
# the user's first consent and held by Helix; the id itself is never stored.
# The agent names the account it acts for in each call's _meta (a demo
# simplification: a production SP takes it from its own session or OAuth).
DEMO_SERVICE_USER = "ada"


@dataclass
class Env:
    host: str
    helix_api_url: str
    console_url: str
    # The API's admin key: the seeder enrolls both SPs and the agent with it.
    admin_api_key: str
    # Identity directory: each SP's DID with its own signing key, the agent's
    # DID with its own signing key (helix init's output), and the agent's
    # consent hops (demo only: keep real keys in a secret store or KMS).
    wallets_dir: str
    agent_port: int
    # How long a user's consent lasts (default 30 days), and each hop inside it
    # (default 1 h, renewed by the agent without a click).
    consent_window_seconds: int
    consent_hop_lifetime_seconds: int
    airline_url: str
    hotel_url: str
    llm_provider: str
    llm_api_key: str
    llm_model: str


def _load_env() -> Env:
    host = os.environ.get("DEMO_HOST", "localhost")
    return Env(
        host=host,
        # The HelixID API. Docker Compose shares its network with it (localhost:3001).
        helix_api_url=os.environ.get("HELIX_API_URL", "http://localhost:3001").rstrip("/"),
        console_url=os.environ.get("CONSOLE_URL", "http://localhost:8081"),
        admin_api_key=os.environ.get("HELIX_ADMIN_API_KEY", "dev-admin-key-change-in-production"),
        wallets_dir=os.environ.get("WALLETS_DIR", os.path.join(os.path.dirname(__file__), "..", ".data", "wallets")),
        agent_port=int(os.environ.get("AGENT_PORT", "4200")),
        consent_window_seconds=int(os.environ.get("CONSENT_WINDOW_SECONDS") or 30 * 24 * 3600),
        consent_hop_lifetime_seconds=int(os.environ.get("CONSENT_HOP_LIFETIME_SECONDS") or 3600),
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
    )


env = _load_env()

# Local runs against a loopback API read DID documents, cards and status lists over http.
allow_loopback_http = bool(re.match(r"^http://(localhost|127\.0\.0\.1)(:|/|$)", env.helix_api_url))


def agent_dir(wallets_dir: str) -> str:
    """Where the seeder writes the agent's identity: helix init's output (helix-agent.json, signing-key.env)."""
    return os.path.join(wallets_dir, "travel-planner")
