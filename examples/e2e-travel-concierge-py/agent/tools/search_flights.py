# search_flights -- requires read:catalog. In the delegation demo, Research
# only gets it through the hop Planner delegated: it has no authority of its
# own. Python port of ../../.../searchFlights.ts.

from __future__ import annotations

from typing import Optional

from config import TOOLS
from personas.types import Persona
from agent.tools.protected_call import ProtectedResult, call_protected_tool


def search_flights(persona: Persona, origin: str, destination: str, date: Optional[str] = None) -> ProtectedResult:
    return call_protected_tool(persona, TOOLS["SEARCH"], {"origin": origin, "destination": destination, "date": date or ""})
