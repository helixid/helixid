// Drives the e2e-consent-demo (and its Python twin) 5-step flow through a real
// browser using the app's own `?demo=1` unattended-demo mode: the agent chat
// signs itself in, plans each turn, and the SP consent popups auto-advance at
// presentation pace. We just watch and screenshot each step, then assert the
// same thing the demo's own claim rests on -- the third booking (same SP)
// reuses the standing grant and opens no third popup.
//
// Usage: BASE_URL=http://localhost:4100 LABEL=js OUT_DIR=./screenshots tsx consent-flow.ts
import { chromium, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:4100';
const LABEL = process.env.LABEL ?? 'consent';
const OUT_DIR = process.env.OUT_DIR ?? './screenshots';

let shotIndex = 0;
async function shot(page: Page, name: string) {
  shotIndex += 1;
  const file = join(OUT_DIR, `${LABEL}-${String(shotIndex).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: file });
  console.log(`  [shot] ${file}`);
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const page = await context.newPage();

  let popupCount = 0;
  context.on('page', async (popup) => {
    popupCount += 1;
    const n = popupCount;
    try {
      await popup.waitForLoadState('domcontentloaded');
      await popup.setViewportSize({ width: 560, height: 760 });
      await popup.waitForTimeout(600);
      await popup.screenshot({ path: join(OUT_DIR, `${LABEL}-popup${n}-a-sp-login.png`) });
      console.log(`  [shot] popup ${n} sp-login`);
      // The SP login auto-submits at 1.6s, then the consent page renders and
      // auto-accepts at 3.4s after that render -- give it time to land on the
      // consent screen before capturing it.
      await popup.waitForSelector('#accept', { timeout: 10_000 }).catch(() => {});
      await popup.waitForTimeout(400);
      await popup.screenshot({ path: join(OUT_DIR, `${LABEL}-popup${n}-b-consent.png`) });
      console.log(`  [shot] popup ${n} consent`);
    } catch (err) {
      console.log(`  [popup ${n}] screenshot failed: ${(err as Error).message}`);
    }
  });

  console.log(`[consent-flow:${LABEL}] loading ${BASE_URL}/?demo=1`);
  await page.goto(`${BASE_URL}/?demo=1`, { waitUntil: 'domcontentloaded' });
  await shot(page, 'login-screen');

  await page.waitForSelector('#app:not(.hidden)', { timeout: 15_000 });
  await page.waitForTimeout(500);
  await shot(page, 'signed-in');

  console.log('  waiting for flight search results...');
  await page.waitForSelector('[data-action^="book-flight:"]', { timeout: 30_000 });
  await shot(page, 'flight-search-results');

  console.log('  waiting for airline consent prompt...');
  await page.waitForSelector('[data-action="consent"]', { timeout: 30_000 });
  await shot(page, 'airline-consent-requested');

  console.log('  waiting for flight booking to confirm (grant #1)...');
  await page.waitForFunction(() => document.querySelectorAll('.receipt').length >= 1, { timeout: 45_000 });
  await shot(page, 'flight-booked');

  console.log('  waiting for hotel search results...');
  await page.waitForSelector('[data-action^="book-hotel:"]', { timeout: 30_000 });
  await shot(page, 'hotel-search-results');

  console.log('  waiting for hotel consent prompt...');
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-action="consent"]');
      return el !== null;
    },
    { timeout: 30_000 },
  );
  await shot(page, 'hotel-consent-requested');

  console.log('  waiting for hotel booking to confirm (grant #2)...');
  await page.waitForFunction(() => document.querySelectorAll('.receipt').length >= 2, { timeout: 45_000 });
  await shot(page, 'hotel-booked');

  const popupsBeforeReturn = popupCount;
  console.log('  waiting for return flight booking (should reuse grant #1, no popup)...');
  await page.waitForFunction(() => document.querySelectorAll('.receipt').length >= 3, { timeout: 45_000 });
  await page.waitForTimeout(300);
  await shot(page, 'return-flight-booked-grant-reused');

  await shot(page, 'trust-rail-final');

  await browser.close();

  console.log(`[consent-flow:${LABEL}] popups opened: ${popupCount}`);
  if (popupCount !== popupsBeforeReturn) {
    throw new Error(
      `Regression: a 3rd consent popup opened for the return flight (popups=${popupCount}). ` +
        `The whole point of this demo is that the standing Airline grant is reused without re-prompting.`,
    );
  }
  if (popupCount !== 2) {
    throw new Error(`Expected exactly 2 consent popups (Airline + Hotel), saw ${popupCount}.`);
  }
  console.log(`[consent-flow:${LABEL}] PASS -- grant reuse confirmed, ${shotIndex} screenshots saved to ${OUT_DIR}`);
}

main().catch((err) => {
  console.error(`[consent-flow:${LABEL}] FAILED:`, err);
  process.exit(1);
});
