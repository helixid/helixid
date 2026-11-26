// search_flights — requires read:catalog. In the delegation demo, Research only
// gets it through the hop Planner delegated: it has no authority of its own.
import { TOOLS } from '../../config.js';
import type { Persona } from '../../personas/types.js';
import { callProtectedTool, type ProtectedResult } from './protectedCall.js';

export interface SearchFlightsArgs {
  origin: string;
  destination: string;
  date?: string;
}

export function searchFlights(persona: Persona, args: SearchFlightsArgs): Promise<ProtectedResult> {
  return callProtectedTool(persona, TOOLS.SEARCH, {
    origin: args.origin,
    destination: args.destination,
    date: args.date ?? '',
  });
}
