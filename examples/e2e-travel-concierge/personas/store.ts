// Manifest-backed persona registry. The manifest lives on the shared wallets
// volume as personas.json, so personas enrolled at runtime survive restarts and
// are visible to a freshly-booted agent. Held in memory for fast reads.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { env } from '../config.js';
import type { Persona, PersonaPublic } from './types.js';
import { toPublic } from './types.js';

let personas: Map<string, Persona> | null = null;

async function readManifest(): Promise<Persona[]> {
  try {
    const raw = await readFile(env.personaManifestPath, 'utf8');
    const parsed = JSON.parse(raw) as { personas?: (Persona & { agentDid?: string })[] };
    // A manifest from the previous version of this demo named the DID `agentDid`.
    return Array.isArray(parsed.personas) ? parsed.personas.map((p) => ({ ...p, did: p.did ?? p.agentDid ?? '' })) : [];
  } catch {
    return []; // missing/empty manifest → no personas yet
  }
}

async function writeManifest(list: Persona[]): Promise<void> {
  await mkdir(dirname(env.personaManifestPath), { recursive: true });
  await writeFile(env.personaManifestPath, `${JSON.stringify({ personas: list }, null, 2)}\n`, 'utf8');
}

/** Load the manifest into memory. Call once at process start. */
export async function loadPersonas(): Promise<void> {
  const list = await readManifest();
  personas = new Map(list.map((p) => [p.id, p]));
}

function ensureLoaded(): Map<string, Persona> {
  if (!personas) throw new Error('Persona registry not loaded — call loadPersonas() first.');
  return personas;
}

export function listPersonas(): PersonaPublic[] {
  return [...ensureLoaded().values()].map(toPublic);
}

export function getPersona(id: string): Persona | undefined {
  return ensureLoaded().get(id);
}

export function hasPersona(id: string): boolean {
  return ensureLoaded().has(id);
}

/**
 * Add a persona and persist. Re-reads the manifest first and merges, so an entry
 * written by the other process (seeder vs. agent) is never clobbered.
 */
export async function addPersona(persona: Persona): Promise<void> {
  const onDisk = await readManifest();
  const merged = new Map(onDisk.map((p) => [p.id, p]));
  merged.set(persona.id, persona);
  await writeManifest([...merged.values()]);
  personas = merged;
}

export async function updatePersona(id: string, patch: Partial<Persona>): Promise<Persona> {
  const onDisk = await readManifest();
  const merged = new Map(onDisk.map((p) => [p.id, p]));
  const current = merged.get(id);
  if (!current) throw new Error(`Unknown persona: ${id}`);
  const next = { ...current, ...patch };
  merged.set(id, next);
  await writeManifest([...merged.values()]);
  personas = merged;
  return next;
}
