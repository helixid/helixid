// Copyright 2026 DgVerse LLP
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//    http://www.apache.org/licenses/LICENSE-2.0

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // @helixid/did-hedera is consumed as a pnpm git+path dependency pinned
    // to a commit (github:helixid/helix-sdk-js#path:did-hedera). pnpm's
    // virtual store therefore names that package's real directory with a
    // literal '#<sha>' in it. Vite's default module resolution follows
    // symlinks to that real path and then treats the module specifier like
    // a URL, so everything from '#' onward is parsed as a fragment and
    // dropped -- "Cannot find module '.../#<sha>.../dist/index.js'" even
    // though the file exists. preserveSymlinks keeps resolution on the
    // clean top-level node_modules/@helixid/did-hedera symlink (no '#'),
    // which avoids the bug entirely. Confirmed: a plain Node import of the
    // same package (outside Vite/Vitest) already resolved fine, and both
    // static and dynamic imports of this package failed identically before
    // this fix -- purely a Vite path-resolution quirk with this one
    // git+path dependency, not a real issue with the package itself.
    preserveSymlinks: true,
  },
  test: {
    // Scoped to this package's own tests/ tree. Needed now that this
    // config lives at the workspace root: vitest's default discovery glob
    // is recursive, and examples/ and e2e/ are workspace siblings that
    // sit *underneath* the root now -- each has its own test setup (or,
    // for examples/e2e-consent-demo, known-broken tests already excluded
    // from CI for unrelated reasons -- see the decision log) and must
    // not be swept into this package's own test run.
    include: ['tests/**/*.test.ts'],
    setupFiles: ['./tests/setup.ts'],
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      thresholds: {
        lines: 90,
        statements: 90,
        branches: 85,
        functions: 90,
      },
      exclude: [
        'src/index.ts',
        'src/server.ts',
        'src/prisma.ts',
        'src/loadEnv.ts',
        'src/**/index.ts',
        'src/hedera/mock/**',
        'src/hedera/IHederaClient.ts',
        'src/repositories/index.ts',
        'src/services/agent/index.ts',
        'src/services/did/index.ts',
        'src/services/vc/index.ts',
        'src/services/vp/index.ts',
        'src/audit/index.ts',
        'src/middleware/index.ts',
        'src/services/vc/IVCService.ts',
        'src/services/vp/IVPService.ts',
        'src/services/agent/IAgentService.ts',
        'src/services/did/IDIDService.ts',
        'vitest.config.ts',
        'tests/**', // Explicitly exclude tests folder
      ],
    },
  },
});
