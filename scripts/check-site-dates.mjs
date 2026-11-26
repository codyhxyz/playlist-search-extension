// The site's dates must not go stale: each sitemap <lastmod> is at least its
// page's last commit date, and llms.txt's "Last updated" is the newest lastmod.
// Needs full git history (actions/checkout fetch-depth: 0).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const fail = (msg) => { console.error(`check-site-dates: ${msg}`); process.exitCode = 1; };

if (git('rev-parse', '--is-shallow-repository') !== 'false') {
  throw new Error('shallow clone: check out with fetch-depth: 0');
}

const sitemap = readFileSync('docs/sitemap.xml', 'utf8');
const entries = [...sitemap.matchAll(/<loc>https:\/\/playlist\.codyh\.xyz(\/[^<]*)<\/loc>\s*<lastmod>([\d-]+)<\/lastmod>/g)];
if (entries.length !== (sitemap.match(/<url>/g) || []).length) fail('every <url> needs a <loc> followed by a <lastmod>');

for (const [, path, lastmod] of entries) {
  const file = `docs${path.endsWith('/') ? `${path}index.html` : path}`;
  const committed = git('log', '-1', '--format=%cs', '--', file);
  if (!committed) fail(`${file} (from the sitemap) has no commits`);
  else if (committed > lastmod) fail(`${file} changed ${committed} but its sitemap lastmod is ${lastmod}`);
}

const newest = entries.map(([, , lastmod]) => lastmod).sort().at(-1);
const stated = readFileSync('docs/llms.txt', 'utf8').match(/^Last updated: ([\d-]+)$/m)?.[1];
if (stated !== newest) fail(`docs/llms.txt says Last updated: ${stated}, newest sitemap lastmod is ${newest}`);
