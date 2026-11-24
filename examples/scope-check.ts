// Scope check is the authorization-only subset of verifier logic.
// `revocation-check.ts` demonstrates credential status transitions (active→revoked)
// and re-enrollment. This file focuses only on: given an already-verified,
// active payload, does the agent hold the required scope for this service?

type VerifiedPayloadWithCredentialSubject = {
  valid: true;
  agentDid: string;
  userDid: string;
  targetService: string;
  verifiedAt: string;
  credentialSubject: {
    privilegeScopes: string[];
  };
};

type ScopeDecision = {
  granted: boolean;
  reason: string;
};

const thisService = 'booking-platform-prod';

// A real implementation receives the { valid, agentDid, userDid, targetService,
// verifiedAt } payload from POST /v1/vp/verify. The scopes are extracted from
// credentialSubject.privilegeScopes in the embedded VC after verification:
// const privilegeScopes = signedVP.verifiableCredential[0].credentialSubject.privilegeScopes;
export function requiresScope(
  verifiedPayload: VerifiedPayloadWithCredentialSubject,
  requiredScope: string,
  expectedTargetService = thisService,
): ScopeDecision {
  if (verifiedPayload.targetService !== expectedTargetService) {
    return {
      granted: false,
      reason: `VP was issued for ${verifiedPayload.targetService}, not ${expectedTargetService}.`,
    };
  }

  const held = verifiedPayload.credentialSubject.privilegeScopes;
  if (!held.includes(requiredScope)) {
    return {
      granted: false,
      reason: `Agent holds [${held.join(', ')}], ${requiredScope} is required.`,
    };
  }

  return {
    granted: true,
    reason: `Agent holds ${requiredScope}.`,
  };
}

type Scenario = {
  id: number;
  description: string;
  payload: VerifiedPayloadWithCredentialSubject;
  requiredScope: string;
  expectedTargetService?: string;
};

function payload(
  privilegeScopes: string[],
  targetService = thisService,
): VerifiedPayloadWithCredentialSubject {
  return {
    valid: true,
    agentDid: 'did:key:z6Mkscopeexampleagent',
    userDid: 'did:key:z6Mkscopeexampleuser',
    targetService,
    verifiedAt: new Date().toISOString(),
    credentialSubject: { privilegeScopes },
  };
}

const scenarios: Scenario[] = [
  {
    id: 1,
    description: 'Granted, simple match',
    payload: payload(['read:catalog']),
    requiredScope: 'read:catalog',
  },
  {
    id: 2,
    description: 'Denied, missing scope',
    payload: payload(['read:catalog']),
    requiredScope: 'write:orders',
  },
  {
    id: 3,
    description: 'Granted, agent holds multiple scopes',
    payload: payload(['read:catalog', 'write:orders', 'read:inventory']),
    requiredScope: 'read:inventory',
  },
  {
    id: 4,
    description: 'Denied, no scope implies another',
    payload: payload(['read:catalog', 'write:orders', 'read:inventory']),
    requiredScope: 'write:inventory',
  },
  // Target service binding is a security property. A VP is minted for one
  // service. If another service accepts it, an agent credentialed for service A
  // can act on service B. The verifier must match targetService to itself.
  {
    id: 5,
    description: 'Denied, target service mismatch',
    payload: payload(['read:catalog'], 'booking-platform-staging'),
    requiredScope: 'read:catalog',
    expectedTargetService: thisService,
  },
];

const rows = scenarios.map((scenario) => {
  const decision = requiresScope(
    scenario.payload,
    scenario.requiredScope,
    scenario.expectedTargetService,
  );
  console.log(
    `Scenario ${scenario.id} - ${scenario.description}: ${decision.granted ? 'GRANTED' : 'DENIED'}`,
  );
  console.log(`  ${decision.reason}`);
  return {
    scenario,
    decision,
  };
});

console.log(
  '\nScenario | Agent Scopes                       | Required        | Target Match | Result',
);
console.log(
  '---------|------------------------------------|-----------------|--------------|--------',
);
for (const row of rows) {
  const scopes = row.scenario.payload.credentialSubject.privilegeScopes.join(', ');
  const targetMatch =
    row.scenario.payload.targetService === (row.scenario.expectedTargetService ?? thisService)
      ? 'yes'
      : 'no';
  const result = row.decision.granted ? 'GRANTED' : 'DENIED';
  console.log(
    `${String(row.scenario.id).padEnd(8)} | ${scopes.padEnd(34)} | ${row.scenario.requiredScope.padEnd(15)} | ${targetMatch.padEnd(12)} | ${result}`,
  );
}

// If your verifier needs richer rules, extend `requiresScope` with local policy
// checks (for example: operation-specific conditions or tenant-level constraints).
