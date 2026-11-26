// A persona's own key (self custody): the `signing-key.env` helix init wrote
// to its key directory. Everything the agent signs -- its request proofs, the
// hops it delegates, its own status list -- is signed here, locally.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EnvSigner, base58btcEncode, kyaos, reissueHop } from '@helixid/sdk-js';
import { keyDirFor } from '../config.js';
import { admin } from '../helixid.js';
import type { Hop, Persona } from './types.js';

const ENV_VAR = 'HELIX_SIGNING_KEY';

export async function signerOf(persona: Persona): Promise<kyaos.Signer> {
  const file = await readFile(join(keyDirFor(persona.id), 'signing-key.env'), 'utf8');
  const hex = file.match(new RegExp(`^${ENV_VAR}=([0-9a-fA-F]+)\\s*$`, 'm'))?.[1];
  if (!hex) throw new Error(`No ${ENV_VAR} in ${persona.id}'s signing-key.env`);
  return new EnvSigner({ did: persona.agentDid, envVar: ENV_VAR, env: { [ENV_VAR]: hex } });
}

/** An eddsa-jcs-2022 Data Integrity proof by `signer` (the document's issuer): what HelixID verifies on a self-signed status list. */
async function signDataIntegrity(document: Record<string, unknown>, signer: kyaos.Signer): Promise<Record<string, unknown>> {
  const { proof: _ignored, ...unsecured } = document;
  void _ignored;
  const proof = {
    type: 'DataIntegrityProof',
    cryptosuite: 'eddsa-jcs-2022',
    created: new Date().toISOString(),
    verificationMethod: `${signer.did}#${signer.kid.replace(/^#/, '')}`,
    proofPurpose: 'assertionMethod',
  };
  const options = { ...proof, ...(unsecured['@context'] === undefined ? {} : { '@context': unsecured['@context'] }) };
  const signature = await signer.sign(kyaos.verifier.hashData(options, unsecured));
  return { ...unsecured, proof: { ...proof, proofValue: `z${base58btcEncode(signature)}` } };
}

/**
 * A self-custody issuer signs its own status list (KYA-OS L3-C): HelixID hosts
 * it but holds no key for it, and serves nothing until the issuer has signed
 * the current bits. Re-signed whenever a hop is issued or before a call that
 * carries one of this persona's hops.
 */
export async function publishOwnStatusList(persona: Persona): Promise<void> {
  if (!persona.statusList) return;
  const signer = await signerOf(persona);
  const unsigned = await admin<Record<string, unknown>>('GET', `/v1/status-list/${persona.statusList}/unsigned`);
  await admin('PUT', `/v1/status-list/${persona.statusList}`, await signDataIntegrity(unsigned, signer));
}

/**
 * The delegator's hop to `invoker` under the chain it holds, signed with its
 * own key: an entry on its own status list (admin POST
 * /v1/status-list/entries), then the hop built with that entry and signed
 * (the SDK's hop signer, reissueHop, sets the id and the entry and signs).
 */
export async function delegateHop(
  from: Persona,
  parent: Hop[],
  input: { invoker: string; allowedAction: string[]; validUntil: string },
): Promise<{ hop: Hop; statusList: string }> {
  const leaf = parent[parent.length - 1]!;
  const entry = await admin<{ statusListCredential: string; statusListIndex: string; id?: string }>('POST', '/v1/status-list/entries', { issuer: from.agentDid });
  const template = {
    '@context': leaf['@context'],
    type: ['VerifiableCredential', 'DelegationCredential'],
    issuer: from.agentDid,
    validUntil: input.validUntil,
    credentialSubject: {
      invoker: input.invoker,
      parentCapability: leaf.id,
      invocationTarget: leaf.credentialSubject.invocationTarget,
      allowedAction: input.allowedAction,
    },
  };
  const hop = (await reissueHop(template, {
    signer: await signerOf(from),
    statusEntry: { type: 'BitstringStatusListEntry', statusPurpose: 'revocation', statusListIndex: entry.statusListIndex, statusListCredential: entry.statusListCredential },
  })) as Hop;
  return { hop, statusList: entry.statusListCredential.split('/').pop()! };
}
