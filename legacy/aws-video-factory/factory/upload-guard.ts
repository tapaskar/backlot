/**
 * Upload guard — refuse to publish from any machine that hasn't been explicitly
 * authorised.
 *
 * Problem: OAuth credentials are tied to a Google account, not to hardware. If
 * someone else has a copy of this repo + .youtube-token.json + .client_secret.json,
 * they can still publish to the channel — that's what happened with NqRBnxoBMPk
 * on May-11: an unknown machine uploaded a stale-code thumbnail to the channel.
 *
 * Defence: every videos.insert and thumbnails.set call reads `.upload-guard`
 * (gitignored, machine-local) BEFORE hitting Google's API. Missing or corrupt
 * file → throw, abort, no upload. To enrol a new machine, run
 *   npx tsx factory/init-guard.ts
 * on that machine. The file is not committed to git.
 *
 * Additionally, every upload's description is stamped with `[ats-fp:<short>]`
 * (first 8 hex chars of the guard UUID). To audit which machine produced which
 * video, grep the description for that marker.
 */

import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

const GUARD_FILE = resolve(__dirname, '..', '.upload-guard');

export interface UploadGuard {
  uuid: string;       // random UUID generated at init time
  machine: string;    // hostname at init time (for human readability only)
  createdAt: string;
}

export function readUploadGuard(): UploadGuard {
  if (!existsSync(GUARD_FILE)) {
    throw new Error(
      `[upload-guard] Missing ${GUARD_FILE}.\n` +
      `This pipeline refuses to upload from a machine that hasn't been authorised.\n` +
      `On the intended publishing machine, run:\n` +
      `  cd ${resolve(__dirname, '..')}\n` +
      `  npx tsx factory/init-guard.ts\n` +
      `The .upload-guard file MUST NOT be committed to git.`
    );
  }
  let parsed: UploadGuard;
  try {
    parsed = JSON.parse(readFileSync(GUARD_FILE, 'utf-8'));
  } catch (err: any) {
    throw new Error(`[upload-guard] Guard file is not valid JSON: ${err?.message}`);
  }
  if (!parsed.uuid || !parsed.machine || !parsed.createdAt) {
    throw new Error('[upload-guard] Guard file is missing required fields (uuid/machine/createdAt).');
  }
  return parsed;
}

/** Throws if upload not allowed. Returns guard on success. */
export function assertUploadAllowed(operation: string): UploadGuard {
  const guard = readUploadGuard();
  // Soft sanity check: hostname drift is fine (humans rename machines) but log it.
  // The uuid is the actual authority.
  const { hostname } = require('os') as typeof import('os');
  if (guard.machine !== hostname()) {
    console.warn(
      `[upload-guard] note: ${operation} guard was created on "${guard.machine}" ` +
      `but current hostname is "${hostname()}". Proceeding (uuid is authoritative).`
    );
  }
  return guard;
}

/** Short fingerprint suitable for embedding in a video description. */
export function fingerprint(guard: UploadGuard): string {
  return guard.uuid.replace(/-/g, '').slice(0, 8);
}
