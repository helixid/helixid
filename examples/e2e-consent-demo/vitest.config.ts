import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// pnpm's git-dependency store directory embeds a literal '#' in its name
// (".../helix-sdk-js.git#<commit>/..."), which Node's ESM loader treats as a
// URL fragment delimiter and truncates on dynamic import() / pathToFileURL —
// a real quirk of this local pnpm store layout, unrelated to the SDK itself.
// A plain alias to that path still breaks because Vite re-derives a file URL
// internally. Instead we alias to a '#'-free mirror of the built package
// (see node_modules/.helix-sdk-js-mirror, synced whenever the SDK rebuilds),
// which resolves cleanly for the test runner.
const sdkEntry = fileURLToPath(
  new URL('../../node_modules/.helix-sdk-js-mirror/dist/index.js', import.meta.url),
);
// Same '#'-in-pnpm-store-path quirk applies to the git-dependency
// @helixid/widget package (its store dir contains both '#<commit>' and
// '&path+widget'), so it gets the same mirror-and-alias treatment.
const widgetServerEntry = fileURLToPath(
  new URL('../../node_modules/.helix-widget-mirror/dist/server/index.js', import.meta.url),
);

export default defineConfig({
  resolve: {
    alias: {
      '@helixid/sdk-js': sdkEntry,
      '@helixid/widget/server': widgetServerEntry,
    },
  },
  test: {
    environment: 'node',
    // The 5-step flow drives two real HTTP servers end to end.
    testTimeout: 30_000,
    env: {
      // issueGrant()/verifyVP() are API-mediated (the SDK-API-only design),
      // so tests/utils/liveApi.ts's startLiveApi() boots a real helix-api per
      // suite. SQLite keeps that fully local — no Postgres/DATABASE_URL needed.
      LIVE_STORAGE_ADAPTER: 'sqlite',
    },
  },
});
