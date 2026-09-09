// Drives the e2e-travel-concierge (and its Python twin) four guided use cases
// through a real browser: full-access booking, a read-only agent onboarded at
// runtime, a revoked credential, and a delegated child credential. Each step
// is a genuine LLM tool call and a genuine HelixID verification -- nothing is
// mocked. Screenshots every step; the one enrollment token needed for use
// case 2 is minted directly against the live API (the same unauthenticated
// POST /v1/enrollment-tokens the Console UI itself calls), so this doesn't
// depend on the separately-published Console app's DOM.
//
// Usage:
//   WEB_URL=http://localhost:8090 API_URL=http://localhost:3000 \
//   LABEL=js OUT_DIR=./screenshots tsx concierge-flow.ts
import { chromium, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const WEB_URL = process.env.WEB_URL ?? 'http://localhost:8090';
const API_URL = process.env.API_URL ?? 'http://localhost:3000';
const LABEL = process.env.LABEL ?? 'concierge';
const OUT_DIR = process.env.OUT_DIR ?? './screenshots';

let shotIndex = 0;
async function shot(page: Page, name: string) {
  shotIndex += 1;
  const file = join(OUT_DIR, `${LABEL}-${String(shotIndex).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: file });
  console.log(`  [shot] ${file}`);
}

function botCount(page: Page) {
  return page.locator('#log .msg.bot').count();
}

async function send(page: Page, message: string) {
  await page.fill('#m', message);
  const before = await botCount(page);
  await page.click('#s');
  await page.waitForFunction(
    (n) => document.querySelectorAll('#log .msg.bot').length > n,
    before,
    { timeout: 60_000 },
  );
  await page.waitForTimeout(300);
}

async function lastBotText(page: Page): Promise<string> {
  return page.locator('#log .msg.bot').last().innerText();
}

async function mintEnrollmentToken(scopes: string[], agentName: string): Promise<string> {
  const res = await fetch(`${API_URL}/v1/enrollment-tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agentName, requestedScopes: scopes, requestedDomains: [] }),
  });
  const body = (await res.json()) as { token?: string; error?: unknown };
  if (!res.ok || !body.token) {
    throw new Error(`Failed to mint enrollment token: HTTP ${res.status} ${JSON.stringify(body)}`);
  }
  return body.token;
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1200, height: 950 } });
  const page = await context.newPage();

  console.log(`[concierge-flow:${LABEL}] loading ${WEB_URL}`);
  await page.goto(WEB_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => (document.querySelector('#persona') as HTMLSelectElement).options.length > 0, {
    timeout: 30_000,
  });
  await shot(page, 'loaded-personas-ready');

  // ── Use case 1: full-access Concierge books ────────────────────────────
  console.log('  use case 1: Concierge books BA249...');
  await page.click('[data-fill="Book flight BA249 for Ada Lovelace"]');
  const before1 = await botCount(page);
  await page.click('#s');
  await page.waitForFunction((n) => document.querySelectorAll('#log .msg.bot').length > n, before1, {
    timeout: 60_000,
  });
  await page.waitForTimeout(300);
  await shot(page, 'uc1-concierge-booking-success');
  console.log(`    reply: ${(await lastBotText(page)).slice(0, 140)}`);

  // ── Use case 2: onboard a read-only agent at runtime, then get refused ─
  console.log('  use case 2: onboarding a read-only Search Agent...');
  await page.click('[data-tab="readonly"]');
  await shot(page, 'uc2-tab-readonly');

  const token = await mintEnrollmentToken(['read:catalog'], 'Search Agent');
  await page.click('#scenario-onboard');
  await page.fill('#onboard-name', 'Search Agent');
  await page.fill('#onboard-token', token);
  await shot(page, 'uc2-onboard-form-filled');
  await page.click('#onboard-submit');
  await page.waitForFunction(
    () => [...document.querySelectorAll('#persona option')].some((o) => (o as HTMLOptionElement).text === 'Search Agent'),
    { timeout: 20_000 },
  );
  await page.selectOption('#persona', { label: 'Search Agent' });
  await shot(page, 'uc2-search-agent-onboarded');

  await send(page, 'Search flights from Mumbai to London');
  await shot(page, 'uc2-search-succeeds');
  console.log(`    search reply: ${(await lastBotText(page)).slice(0, 140)}`);

  await send(page, 'Book flight BA249 for Grace Hopper');
  await shot(page, 'uc2-booking-refused-no-write-scope');
  console.log(`    booking reply: ${(await lastBotText(page)).slice(0, 140)}`);

  // ── Use case 3: revoke Concierge's credential, retry, get refused ──────
  console.log('  use case 3: revoking Concierge credential...');
  await page.click('[data-tab="revoked"]');
  await shot(page, 'uc3-tab-revoked');
  await page.click('#scenario-select-concierge');
  await page.click('#scenario-revoke');
  await page.waitForFunction(
    () => /Revoked/.test(document.querySelector('#log')?.textContent ?? ''),
    { timeout: 20_000 },
  );
  await shot(page, 'uc3-credential-revoked');

  await send(page, 'Book flight BA249 for Ada Lovelace');
  await shot(page, 'uc3-booking-refused-revoked-credential');
  console.log(`    retry reply: ${(await lastBotText(page)).slice(0, 140)}`);

  // ── Use case 4: delegate read-only authority to a second agent ─────────
  console.log('  use case 4: delegating read:catalog to a Research Agent...');
  await page.click('[data-tab="delegated"]');
  await shot(page, 'uc4-tab-delegated');
  await page.click('#scenario-delegation-setup');
  await page.waitForFunction(
    () => /Created delegation demo agents/.test(document.querySelector('#log')?.textContent ?? ''),
    { timeout: 30_000 },
  );
  await shot(page, 'uc4-planner-and-research-created');

  await page.click('#scenario-delegate');
  await page.waitForFunction(
    () => /Delegated read:catalog/.test(document.querySelector('#log')?.textContent ?? ''),
    { timeout: 30_000 },
  );
  await shot(page, 'uc4-delegated-read-catalog');

  await page.click('#scenario-select-research');
  await send(page, 'Search flights from Mumbai to London');
  await shot(page, 'uc4-delegated-search-succeeds');
  console.log(`    delegated search reply: ${(await lastBotText(page)).slice(0, 140)}`);

  await send(page, 'Book flight BA249 for Ada Lovelace');
  await shot(page, 'uc4-delegated-booking-refused-no-write-scope');
  console.log(`    delegated booking reply: ${(await lastBotText(page)).slice(0, 140)}`);

  await browser.close();
  console.log(`[concierge-flow:${LABEL}] PASS -- ${shotIndex} screenshots saved to ${OUT_DIR}`);
}

main().catch((err) => {
  console.error(`[concierge-flow:${LABEL}] FAILED:`, err);
  process.exit(1);
});
