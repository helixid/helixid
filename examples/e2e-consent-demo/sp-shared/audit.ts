// Service-Provider-side activity log.
//
// The SP is the only party that knows several facts the activity trail needs:
// whether a call's proof and chain verified, why they did not, and whether
// the scope a tool requires was in the user's consent. Recording those from
// the agent would mean trusting the agent's account of its own authorization,
// so the SP logs them itself, from the process that made the decision.
//
// This demo writes them to the SP's own log, one JSON line each. The legacy
// shared audit-log endpoint is retired; delivering these to Helix's recorder
// (AuditTrail over POST /v1/audit/submissions, KYA-OS A-1/A-2) is not wired in
// this example. Every emission is best-effort: a booking is not less valid
// because a log write failed.

import type { AuditEventType } from '@helixid/sdk-js';

/** The activity envelope; field names are fixed so one trail can be queried later. */
export interface ActivityEvent {
  event: AuditEventType;
  correlationId?: string | undefined;
  agentDid?: string | undefined;
  /** The user's did:key that signed the root hop, when the call carried one. */
  userDid?: string | undefined;
  toolName?: string | undefined;
  requiredScope?: string | undefined;
  effectiveScopes?: string[] | undefined;
  result?: 'success' | 'failure' | 'blocked' | undefined;
  reason?: string | undefined;
  resultSummary?: string | undefined;
}

export interface AuditEmitter {
  emit(event: ActivityEvent): void;
}

export interface AuditEmitterOptions {
  serviceDid: string;
  serviceName: string;
  /** Where each line goes; default stdout. */
  write?: (line: string) => void;
}

export function createAuditEmitter(options: AuditEmitterOptions): AuditEmitter {
  const write = options.write ?? ((line: string): void => void process.stdout.write(`${line}\n`));
  return {
    emit(event: ActivityEvent): void {
      try {
        write(JSON.stringify({ timestamp: new Date().toISOString(), serviceDid: options.serviceDid, serviceName: options.serviceName, ...event }));
      } catch {
        // Never surfaces to the caller.
      }
    },
  };
}
