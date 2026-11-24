// The tools the LLM is allowed to call. Note these are the *agent-facing* schemas
// (what the model sees): plain business arguments, no proof. The request proof
// and the delegation chain are attached one layer down (tools/protectedCall.ts)
// and enforced one layer down again by the MCP server. The model never sees them.

export const SYSTEM_PROMPT = [
  'You are a travel concierge agent. You can search flights with the search_flights',
  'tool and book a specific flight with the book_flight tool.',
  'When the user asks to book a specific flight, call book_flight with the flight',
  'identifier and passenger name. When they ask what flights are available, call',
  'search_flights.',
  'After a tool returns, tell the user plainly what happened. If an action was',
  'refused, explain the reason from the tool result (e.g. the agent is not',
  'authorised) rather than inventing one. Never claim a booking succeeded unless',
  'the tool result says so.',
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
];
