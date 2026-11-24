# book_flight -- requires the write:orders scope. The Concierge persona has
# it; the Search Agent does not, so the same call succeeds for one and is
# refused by the service's KYA-OS verifier for the other. Python port of ../../.../bookFlight.ts.

from __future__ import annotations

from config import TOOLS
from personas.types import Persona
from agent.tools.protected_call import ProtectedResult, call_protected_tool


def book_flight(persona: Persona, flight_id: str, passenger_name: str) -> ProtectedResult:
    return call_protected_tool(persona, TOOLS["BOOK"], {"flightId": flight_id, "passengerName": passenger_name})
