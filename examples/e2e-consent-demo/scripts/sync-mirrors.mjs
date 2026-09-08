// Creates the '#'-free package mirrors that vitest.config.ts aliases to.
//
// pnpm's git-dependency store directories embed a literal '#' in their names
// (".../helix-sdk-js.git#<commit>/..."), which Node's ESM loader treats as a
// URL fragment delimiter and truncates. Vite re-derives a file URL internally,
// so a plain alias to the store path breaks too. The workaround is to alias to
// a copy whose path contains no '#'.
//
// The copy needs its dependencies as well: a bare copy of the package
// directory loses pnpm's peer node_modules, so `@noble/ed25519` and friends
// stop resolving. Symlinking the store's sibling node_modules restores that.
//
// Idempotent — safe to re-run, and it re-syncs whenever the SDK is reinstalled.
import { cp, mkdir, rm, symlink, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const exampleRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(exampleRoot, '..', '..');
const nodeModules = join(repoRoot, 'node_modules');

/** Where a package actually lives, following pnpm's symlink into the store. */
async function realPackagePath(specifier) {
  for (const base of [nodeModules, join(exampleRoot, 'node_modules')]) {
    const candidate = join(base, ...specifier.split('/'));
    try {
      return await (await import('node:fs/promises')).realpath(candidate);
    } catch {
      // try the next location
    }
  }
  throw new Error(`Cannot find ${specifier}. Run pnpm install first.`);
}

async function mirror(specifier, mirrorName) {
  const source = await realPackagePath(specifier);
  const target = join(nodeModules, mirrorName);
  await rm(target, { recursive: true, force: true });
  await cp(source, target, { recursive: true, dereference: false });

  // node_modules sits two levels up from the package inside pnpm's store:
  // <store>/<pkg-id>/node_modules/<@scope>/<name>
  const peerNodeModules = dirname(dirname(source));
  await rm(join(target, 'node_modules'), { recursive: true, force: true });
  await symlink(peerNodeModules, join(target, 'node_modules'), 'dir');

  await stat(target);
  console.log(`[mirrors] ${specifier} -> node_modules/${mirrorName}`);
}

await mkdir(nodeModules, { recursive: true });
await mirror('@helixid/sdk-js', '.helix-sdk-js-mirror');
await mirror('@helixid/widget', '.helix-widget-mirror');
