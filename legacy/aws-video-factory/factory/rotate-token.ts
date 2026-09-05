/**
 * Rotate the OAuth refresh token.
 *
 * Why: the .youtube-token.json sitting on THIS machine is a copy of whatever
 * is also sitting on any OTHER machine that ever had it. The only way to
 * disable a leaked copy is to revoke the refresh token at Google's end —
 * which invalidates it everywhere — and then re-auth here to get a fresh one.
 *
 * Run interactively on the machine you trust:
 *   cd /Volumes/wininstall/trading-dashboard/video
 *   npx tsx factory/rotate-token.ts
 *
 * After this completes:
 *   - This Mac has a new token in .youtube-token.json
 *   - Every other machine that had the old token now gets "invalid_grant"
 *     when it tries to upload — same failure mode as April 30
 *   - To bring another machine back online, copy the new token there
 *     (defeats the purpose) OR run --reauth on that machine (it goes
 *     through its own browser consent, becomes legitimately authorised)
 */

import { google } from 'googleapis';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import { resolve } from 'path';
import { createServer } from 'http';
import { execSync } from 'child_process';

const SECRET_PATH =
  process.env.YOUTUBE_CLIENT_SECRET ||
  (existsSync(resolve(__dirname, '..', '.client_secret.json'))
    ? resolve(__dirname, '..', '.client_secret.json')
    : '/Users/tapas/Desktop/client_secret.json');
const TOKEN_PATH = process.env.YOUTUBE_TOKEN_PATH
  ? resolve(process.env.YOUTUBE_TOKEN_PATH)
  : resolve(__dirname, '..', '.youtube-token.json');

const SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
];

async function main() {
  if (!existsSync(SECRET_PATH)) throw new Error(`client_secret not found at ${SECRET_PATH}`);
  if (!existsSync(TOKEN_PATH)) {
    console.log(`No existing token at ${TOKEN_PATH} — nothing to revoke. Proceeding to fresh auth.`);
  }

  const creds = JSON.parse(readFileSync(SECRET_PATH, 'utf-8'));
  const { client_id, client_secret } = creds.installed || creds.web;
  const oauth2 = new google.auth.OAuth2(client_id, client_secret, 'http://localhost:8085');

  // Step 1: revoke the current refresh token at Google.
  if (existsSync(TOKEN_PATH)) {
    const cur = JSON.parse(readFileSync(TOKEN_PATH, 'utf-8'));
    if (cur.refresh_token) {
      try {
        await oauth2.revokeToken(cur.refresh_token);
        console.log('Revoked old refresh_token at Google. Any other machine using it is now dead.');
      } catch (err: any) {
        // 400 means already revoked / expired — fine, the goal is reached.
        const msg = err?.response?.data?.error_description || err?.message || String(err);
        console.warn(`Revoke endpoint replied: ${msg}. Continuing — old token is no longer usable.`);
      }
    }
    unlinkSync(TOKEN_PATH);
    console.log(`Removed local token at ${TOKEN_PATH}.`);
  }

  // Step 2: fresh consent → new tokens
  console.log('Opening browser for fresh consent (scopes: upload + readonly)...');
  const authUrl = oauth2.generateAuthUrl({ access_type: 'offline', scope: SCOPES, prompt: 'consent' });
  const code = await new Promise<string>((resolveCode, rejectCode) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url || '', 'http://localhost:8085');
      const c = url.searchParams.get('code');
      if (c) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h1>Token rotated.</h1><p>You can close this tab.</p><script>window.close()</script>');
        server.close();
        resolveCode(c);
      } else {
        res.writeHead(400);
        res.end('Missing code');
        rejectCode(new Error('no auth code'));
      }
    });
    server.listen(8085, () => {
      console.log('Listening on http://localhost:8085 ...');
      execSync(`open "${authUrl}"`);
    });
  });
  const { tokens } = await oauth2.getToken(code);
  oauth2.setCredentials(tokens);
  writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
  console.log(`New token written to ${TOKEN_PATH}.`);
  console.log('Done. The other machine (if any) is now locked out.');
}

main().catch((err) => { console.error('rotate-token failed:', err.message); process.exit(1); });
