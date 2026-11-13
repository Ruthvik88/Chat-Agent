import './setup';
import assert from 'node:assert/strict';
import { checkCitations, modelSource, sourceMatchesEntity } from '../src/citations';
import { renderCitedMarkdown } from '../src/public/markdown.js';

const sources = [
  { id: 1, title: 'Oracle Siebel CRM pricing', url: 'https://www.itqlick.com/oracle-siebel-crm/pricing', excerpt: 'Oracle Siebel costs $24 per user.' },
  { id: 2, title: 'Best PaaS platforms | Railway', url: 'https://railway.com/guides/best-paas', excerpt: 'Render: Managed Postgres starts at $7.\nCompare: Railway vs Render.' },
  { id: 3, title: 'Pricing | Railway Docs', url: 'https://docs.railway.com/pricing', excerpt: 'Hobby starts at $5 per month.' },
  { id: 4, title: 'Marketing automation | Freshworks', url: 'https://freshworks.com/marketing-automation/pricing', excerpt: 'Marketing automation starts at $9.' },
];
const answer = 'Pipedrive Essentials is $24 [1].\nRailway Postgres starts at $7 [2].\nRailway Hobby starts at $5 [3].\nFreshsales Growth starts at $9 [4].\nRailway more details [99].';
const checks = checkCitations(answer, sources);
assert.deepEqual(checks.map((c) => c.verified), [false, false, true, false, false]);
assert.equal(checks.at(-1)!.reason, 'unknown source');
const html = renderCitedMarkdown(answer, sources, checks);
assert.equal((html.match(/unverified/g) ?? []).length, 4);
assert.match(html, /href="https:\/\/docs.railway.com\/pricing"/);
assert.doesNotMatch(html, /href="https:\/\/(www.itqlick|railway.com\/guides|freshworks)/);
assert.ok(sourceMatchesEntity({ title: 'nodejs releases', url: 'https://nodejs.org', excerpt: '' }, 'Node.js', 'Node.js v26 [1]'));
assert.ok(sourceMatchesEntity({ title: 'PIPEDRIVE pricing', url: 'https://pipedrive.com/pricing', excerpt: '' }, 'Pipedrive', 'pipedrive costs $24'));
assert.equal(sourceMatchesEntity({ title: 'Best PaaS | Railway', url: 'https://railway.com/guides/best', excerpt: 'Pricing starts at $7.\nCompare: Railway vs Render.' }, 'Railway', 'Railway costs $7'), false, 'publisher and navigation alone do not establish price attribution');
const context = modelSource({ ...sources[2], publishedDate: 'Wed, 11 Nov 2026 21:00:00 GMT' });
assert.equal(context.citation, '[3]'); assert.equal(context.domain, 'docs.railway.com'); assert.equal(context.publishedDate, '11 Nov 2026');
assert.ok(!('url' in context)); assert.equal(modelSource(sources[0]).publishedDate, 'undated');
// Partial citation fragments never get a source link, and hostile model URLs are not clickable.
assert.doesNotMatch(renderCitedMarkdown('Railway [', sources, []), /<a /);
assert.doesNotMatch(renderCitedMarkdown('[x](https://evil.test) https://evil.test', sources, []), /<a /);
assert.doesNotMatch(renderCitedMarkdown('\0CITE3\0', sources, []), /<a /, 'model cannot forge internal placeholders');
const grouped = 'Railway costs $5 [3, 99].';
assert.deepEqual(checkCitations(grouped, sources).map((c) => c.verified), [true, false]);
const groupedHtml = renderCitedMarkdown(grouped, sources, checkCitations(grouped, sources));
assert.match(groupedHtml, /href=/); assert.match(groupedHtml, /99.*unverified/);
const allBad = 'Pipedrive costs $24 [1].';
assert.match(renderCitedMarkdown(allBad, sources, checkCitations(allBad, sources)), /Pipedrive costs \$24.*unverified/);
const continued = 'Neon uses usage billing [1].\n* Scale Plan: Geared toward production compute priced per Unit [1].';
const neon = [{ id: 1, title: 'Neon pricing', url: 'https://neon.tech/pricing', excerpt: 'Neon compute usage pricing.' }];
assert.ok(checkCitations(continued, neon).every((c) => c.verified), 'plan/unit words are not mistaken for vendors');
const table = '| Claim | Verdict | Evidence |\n|---|---|---|\n| Pipedrive costs $24 | Unchanged | [1] |\n| Railway costs $7 | Changed | [2] |\n| Railway costs $5 | Unchanged | [3] |';
const tableHtml = renderCitedMarkdown(table, sources, checkCitations(table, sources));
assert.equal((tableHtml.match(/<td>Unverified<\/td>/g) ?? []).length, 2, 'bad evidence overrides only the affected table verdicts');
assert.equal((tableHtml.match(/<td>Unchanged<\/td>/g) ?? []).length, 1);
console.log('citation entity/attribution guard, soft failures, source IDs and safe UI links: all assertions passed');
