/**
 * Initialise the upload guard on this machine. Run ONCE on the machine you
 * intend to publish from:
 *   cd /Volumes/wininstall/trading-dashboard/video
 *   npx tsx factory/init-guard.ts
 *
 * Re-running on another machine without --force will refuse to clobber.
 * To rotate the guard (e.g. after suspecting another machine got a copy):
 *   npx tsx factory/init-guard.ts --force
 */

import { randomUUID } from 'crypto';
import { hostname } from 'os';
import { writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const GUARD_FILE = resolve(__dirname, '..', '.upload-guard');
const FORCE = process.argv.includes('--force');

if (existsSync(GUARD_FILE) && !FORCE) {
  console.error(
    `Guard already exists at ${GUARD_FILE}.\n` +
    `If you want to rotate it (invalidates the old fingerprint), re-run with --force.`
  );
  process.exit(1);
}

const guard = {
  uuid: randomUUID(),
  machine: hostname(),
  createdAt: new Date().toISOString(),
};
writeFileSync(GUARD_FILE, JSON.stringify(guard, null, 2));
console.log(`Wrote guard at ${GUARD_FILE}`);
console.log(`  machine    = ${guard.machine}`);
console.log(`  uuid (full)= ${guard.uuid}`);
console.log(`  fingerprint= ${guard.uuid.replace(/-/g, '').slice(0, 8)}  ← embedded in upload descriptions`);
console.log('');
console.log('Make sure .upload-guard is gitignored. Do NOT copy this file to other machines.');
