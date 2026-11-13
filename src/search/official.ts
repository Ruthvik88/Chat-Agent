/** Known product identities; unknown products can supply an inferred domain in the tool call. */
const products: Array<[RegExp, string, string]> = [
  [/\bneon\b/i, 'Neon serverless Postgres', 'neon.tech'],
  [/\brailway\b/i, 'Railway PaaS Postgres', 'railway.com'],
  [/\bnode[. ]?js\b/i, 'Node.js JavaScript runtime', 'nodejs.org'],
  [/\bpipedrive\b/i, 'Pipedrive CRM', 'pipedrive.com'],
  [/\bfreshsales\b/i, 'Freshsales CRM', 'freshworks.com'],
  [/\bhub\s?spot\b/i, 'HubSpot CRM', 'hubspot.com'],
  [/\bsalesforce\b/i, 'Salesforce CRM', 'salesforce.com'],
  [/\bzoho\b/i, 'Zoho CRM', 'zoho.com'],
  [/\brender\b/i, 'Render PaaS', 'render.com'],
];

export function officialProducts(text: string) {
  return products.filter(([pattern]) => pattern.test(text)).map(([, name, domain]) => ({ name, domain }));
}

export function onOfficialDomain(url: string, domains: string[]): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return domains.some((d) => host === d.toLowerCase() || host.endsWith(`.${d.toLowerCase()}`));
  } catch { return false; }
}

export function isDated(value: string | undefined, now: Date): boolean {
  const cutoff = new Date(now);
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 1);
  return !!value && Date.parse(value) < cutoff.getTime();
}
