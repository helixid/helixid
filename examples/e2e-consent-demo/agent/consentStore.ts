// The agent's consents, one per SP: the root hop the user's did:key signed on
// Helix's consent page, the consent id and the window (KYA-OS story L3-H).
// Kept in a small local JSON file next to the agent's identity. The hop is
// useless without the agent's own key, so this file holds no secret.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface StoredConsent {
  serviceDid: string;
  consentId: string;
  hop: Record<string, any>;
  /** The end of the consented window, Unix seconds. */
  windowUntil: number;
  helixUrl: string;
}

export class ConsentStore {
  #cache: Record<string, StoredConsent> | undefined;

  constructor(private readonly file: string) {}

  async #all(): Promise<Record<string, StoredConsent>> {
    if (this.#cache) return this.#cache;
    const raw = await readFile(this.file, 'utf8').catch(() => null);
    this.#cache = raw ? (JSON.parse(raw) as Record<string, StoredConsent>) : {};
    return this.#cache;
  }

  async get(serviceDid: string): Promise<StoredConsent | undefined> {
    return (await this.#all())[serviceDid];
  }

  async put(consent: StoredConsent): Promise<void> {
    const all = await this.#all();
    all[consent.serviceDid] = consent;
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify(all, null, 2), 'utf8');
  }

  async drop(serviceDid: string): Promise<void> {
    const all = await this.#all();
    delete all[serviceDid];
    await writeFile(this.file, JSON.stringify(all, null, 2), 'utf8');
  }
}
