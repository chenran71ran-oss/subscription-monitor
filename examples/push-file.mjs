import { readFile } from 'node:fs/promises';

const { MONITOR_URL, MONITOR_ADMIN_TOKEN, MONITOR_SUB_ID, MONITOR_USERINFO } = process.env;
if (!MONITOR_URL || !MONITOR_ADMIN_TOKEN || !MONITOR_SUB_ID || !process.argv[2]) {
  console.error('Set MONITOR_URL, MONITOR_ADMIN_TOKEN, MONITOR_SUB_ID; pass a UTF-8 file path.');
  process.exit(1);
}
const target = new URL(MONITOR_URL);
if (target.protocol !== 'https:' || target.username || target.password || target.search || target.hash || !/^\/[\s]*$/.test(target.pathname)) {
  throw new Error('MONITOR_URL must be your HTTPS dashboard origin without credentials, path or query.');
}
const bytes = await readFile(process.argv[2]);
if (bytes.length > 1_000_000) throw new Error('File exceeds 1 MB.');
const body = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
const endpoint = new URL('/api/push', target);
endpoint.searchParams.set('id', MONITOR_SUB_ID);
const response = await fetch(endpoint, {
  method: 'POST', redirect: 'error', signal: AbortSignal.timeout(60000),
  headers: { authorization: `Bearer ${MONITOR_ADMIN_TOKEN}`, 'content-type': 'application/json' },
  body: JSON.stringify({ body, contentType: 'text/plain', ...(MONITOR_USERINFO ? { userinfo: MONITOR_USERINFO } : {}) }),
});
// Never log the resource, token, request URL or an unreviewed diagnostic response.
const result = await response.json();
if (!response.ok || result.ok !== true) throw new Error(`Push failed (HTTP ${response.status}); inspect your private dashboard.`);
console.log(`Push accepted: ${result.nodes ?? '?'} retained nodes; fresh quota: ${Boolean(result.hasUsage)}.`);
