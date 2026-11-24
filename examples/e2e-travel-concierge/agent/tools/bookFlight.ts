// book_flight — requires the write:orders scope. The Concierge persona has it;
// the Search Agent does not, so the same call succeeds for one and is refused by
// the service's KYA-OS verifier for the other.
import { TOOLS } from '../../config.js';
import type { Persona } from '../../personas/types.js';
import { callProtectedTool, type ProtectedResult } from './protectedCall.js';

export interface BookFlightArgs {
  flightId: string;
  passengerName: string;
}

export function bookFlight(persona: Persona, args: BookFlightArgs): Promise<ProtectedResult> {
  return callProtectedTool(persona, TOOLS.BOOK, {
    flightId: args.flightId,
    passengerName: args.passengerName,
  });
}
