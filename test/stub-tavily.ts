import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';

/**
 * A local stand-in for api.tavily.com.
 *
 * It records every request body the agent sends and returns results that look
 * like Tavily's, so the whole pipeline (real Gemini, real agent loop, real
 * Tavily wire format) can be exercised without spending credits.
 *
 * Usage: npx tsx test/stub-tavily.ts [port]
 */
const PORT = Number(process.argv[2] ?? 8787);
const LOG = 'test/tavily-requests.jsonl';

const RESULTS: Record<string, Array<{ title: string; url: string; content: string; published_date?: string }>> = {
  'node.js latest version': [
    {
      title: 'Node.js releases',
      url: 'https://nodejs.org/en/about/previous-releases',
      content:
        'Node.js 24 entered Active LTS on 2025-10-28 and is the current release line. Node.js 25 is the Current release.',
      published_date: '2025-10-28',
    },
    {
      title: 'Download Node.js',
      url: 'https://nodejs.org/en/download',
      content: 'Latest LTS: v24.11.0. Latest Current: v25.0.0.',
      published_date: '2026-11-01',
    },
  ],
  'hubspot pricing': [
    {
      title: 'HubSpot pricing',
      url: 'https://www.hubspot.com/pricing',
      content:
        'HubSpot Starter is $20 per seat per month. Sales Hub Professional is $150 per seat per month.',
      published_date: '2026-11-05',
    },
  ],
  'salesforce pricing': [
    {
      title: 'Salesforce pricing',
      url: 'https://www.salesforce.com/pricing/',
      content:
        'Salesforce Starter Suite is $25 per user per month. Sales Cloud Enterprise is $165 per user per month.',
      published_date: '2026-11-05',
    },
  ],
  'hubspot salesforce pricing comparison': [
    {
      title: 'CRM pricing comparison 2026',
      url: 'https://example-crm.com/comparison',
      content:
        'HubSpot Starter rose to $20/seat in 2026. Salesforce Sales Cloud Enterprise now starts at $165/user.',
      published_date: '2026-11-06',
    },
  ],
  'neon pricing': [
    {
      title: 'Neon pricing',
      url: 'https://neon.tech/pricing',
      content:
        'Neon Free is $0. The launch plan is $19 per month for 100 CU-hours. Scale and Business plans are usage based.',
      published_date: '2026-11-04',
    },
  ],
  'railway pricing': [
    {
      title: 'Railway pricing',
      url: 'https://railway.app/pricing',
      content:
        'Railway uses a usage-based model. A small Postgres container typically costs $5 to $20 per month including RAM, disk and egress.',
      published_date: '2026-11-04',
    },
  ],
};

const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    let body: any = {};
    try {
      body = JSON.parse(raw);
    } catch {
      body = { __unparsed: raw };
    }
    writeFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), body }) + '\n', { flag: 'a' });

    const q = String(body.query ?? '').toLowerCase();
    // Match on the product term so a "Neon pricing" query does not return
    // HubSpot pages.
    const products = ['node.js', 'nodejs', 'node', 'hubspot', 'salesforce', 'neon', 'railway'];
    const product = products.find((p) => q.includes(p));
    let results = product
      ? Object.entries(RESULTS)
          .filter(([key]) => key.includes(product === 'node.js' ? 'node.js' : product))
          .flatMap(([, v]) => v)
      : [];
    if (!results.length) {
      results = Object.entries(RESULTS)
        .filter(([key]) => key.split(' ').some((w) => w.length > 3 && q.includes(w)))
        .flatMap(([, v]) => v);
    }
    if (!results.length) {
      results = [
        {
          title: `Search result for "${body.query}"`,
          url: 'https://example.com/generic',
          content: 'A generic page returned by the stub for this query.',
          published_date: '2026-11-10',
        },
      ];
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ results, response_time: 0.31 }));
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`stub tavily listening on http://127.0.0.1:${PORT}`);
});
