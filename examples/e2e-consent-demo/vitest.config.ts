import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // The flow drives a real helix-api and two real SP servers end to end.
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    env: {
      // tests/utils/liveApi.ts's startLiveApi() boots a real helix-api per
      // suite: SQLite keeps it fully local, and did:web lets it host the SPs'
      // and the agent's DID documents (self custody, Helix hosting).
      LIVE_STORAGE_ADAPTER: 'sqlite',
      LIVE_DID_METHOD: 'web',
    },
  },
});
