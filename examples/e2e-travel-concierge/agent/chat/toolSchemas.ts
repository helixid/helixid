// The tools the LLM is allowed to call. Note these are the *agent-facing* schemas
// (what the model sees): plain business arguments, no VP. The HelixID presentation
// is attached one layer down (tools/protectedCall.ts) and enforced one layer down
// again by the MCP server. The model never sees a VP.

export const SYSTEM_PROMPT = [
  'You are a travel concierge agent. You can search and book flights (Helix Air) with',
  'search_flights and book_flight, and search and book hotels (Helix Stay) with',
  'search_hotels and book_hotel.',
  'When the user asks to book something specific, call the booking tool with its',
  'identifier and the traveler\'s name. When they ask what is available, call the',
  'matching search tool. A message may start with a context note naming the traveler',
  'you are acting for; use that name as the passenger or guest unless told otherwise.',
  'After a tool returns, tell the user plainly what happened. If an action was',
  'refused, explain the reason from the tool result (e.g. missing consent or scope)',
  'rather than inventing one. Never claim a booking succeeded unless the tool result',
  'says so.',
].join(' ');

export interface ToolSchema {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, { type: string; description?: string }>;
    required: string[];
  };
}

export const TOOL_SCHEMAS: ToolSchema[] = [
  {
    name: 'search_flights',
    description: 'Search available flights between two cities.',
    parameters: {
      type: 'object',
      properties: {
        origin: { type: 'string', description: 'Origin city or airport code' },
        destination: { type: 'string', description: 'Destination city or airport code' },
        date: { type: 'string', description: 'Optional travel date, YYYY-MM-DD' },
      },
      required: ['origin', 'destination'],
    },
  },
  {
    name: 'book_flight',
    description: 'Book a specific flight by id for a named passenger.',
    parameters: {
      type: 'object',
      properties: {
        flightId: { type: 'string', description: 'Flight identifier, e.g. BA249' },
        passengerName: { type: 'string', description: 'Full name of the passenger' },
      },
      required: ['flightId', 'passengerName'],
    },
  },
  {
    name: 'search_hotels',
    description: 'Search hotels in a city (Helix Stay).',
    parameters: {
      type: 'object',
      properties: {
        city: { type: 'string', description: 'City to search hotels in' },
        checkIn: { type: 'string', description: 'Optional check-in date, YYYY-MM-DD' },
      },
      required: ['city'],
    },
  },
  {
    name: 'book_hotel',
    description: 'Book a specific hotel by id for a named guest (Helix Stay).',
    parameters: {
      type: 'object',
      properties: {
        hotelId: { type: 'string', description: 'Hotel identifier, e.g. H-101' },
        guestName: { type: 'string', description: 'Full name of the guest' },
      },
      required: ['hotelId', 'guestName'],
    },
  },
];
