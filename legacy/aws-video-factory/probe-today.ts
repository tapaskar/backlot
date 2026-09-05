import { google } from 'googleapis';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const SECRET = existsSync(resolve(__dirname, '.client_secret.json'))
  ? resolve(__dirname, '.client_secret.json')
  : '/Users/tapas/Desktop/client_secret.json';
const c = JSON.parse(readFileSync(SECRET, 'utf-8'));
const o = new google.auth.OAuth2(c.installed.client_id, c.installed.client_secret, 'http://localhost:8085');
o.setCredentials(JSON.parse(readFileSync(resolve(__dirname, '.youtube-token.json'), 'utf-8')));
const yt = google.youtube({ version: 'v3', auth: o });

(async () => {
  const ch = await yt.channels.list({ mine: true, part: ['contentDetails'] });
  const pl = ch.data.items![0].contentDetails!.relatedPlaylists!.uploads!;
  const items = await yt.playlistItems.list({ playlistId: pl, part: ['snippet', 'contentDetails'], maxResults: 4 });
  for (const it of items.data.items || []) {
    console.log(it.contentDetails!.videoId, '|', it.contentDetails!.videoPublishedAt, '|', (it.snippet!.title||'').slice(0,90));
  }
})();
