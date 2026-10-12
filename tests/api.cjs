const fs = require('node:fs'), vm = require('node:vm'), assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const source = fs.readFileSync(__dirname + '/../worker.js', 'utf8');
const context = vm.createContext({
  URL, Request, Response, Headers, TextEncoder, TextDecoder, AbortController, crypto: webcrypto,
  atob, btoa, setTimeout, clearTimeout, console,
  fetch() { throw new Error('Live HTTP is forbidden in API fixtures.'); },
  connect() { return { opened: Promise.resolve(), closed: Promise.resolve(), close: async () => {} }; },
});
vm.runInContext(source.replace("import { connect } from 'cloudflare:sockets';", '').replace('export default', 'globalThis.worker ='), context);
const store = new Map();
const env = { ADMIN_TOKEN: 'offline-fixture-token', INGEST_TOKEN: 'separate-fixture-token', SUB_KV: {
  get: async key => store.get(key) ?? null,
  put: async (key, value) => store.set(key, value), delete: async key => store.delete(key),
}};
let checks = 0;
async function call(path, method = 'GET', body, token = env.ADMIN_TOKEN, bindings = env) {
  const response = await context.worker.fetch(new Request('https://monitor.example.com' + path, {
    method, headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), bindings, { waitUntil() {} });
  return { response, data: await response.json() };
}
async function test(name, fn) { await fn(); checks++; console.log('PASS ' + name); }
(async () => {
  await test('Public page is the embedded dashboard', async () => {
    const r = await context.worker.fetch(new Request('https://monitor.example.com/'), env, {});
    assert.equal(r.status, 200); assert((await r.text()).includes('<title>订阅监控面板</title>'));
    assert(r.headers.get('content-security-policy').includes("connect-src 'self'"));
  });
  await test('API rejects absent credentials', async () => assert.equal((await call('/api/status', 'GET', undefined, '')).response.status, 401));
  await test('API rejects incorrect credentials', async () => assert.equal((await call('/api/status', 'GET', undefined, 'wrong')).response.status, 401));
  await test('Missing KV is explicit', async () => assert.equal((await call('/api/status', 'GET', undefined, env.ADMIN_TOKEN, { ADMIN_TOKEN: env.ADMIN_TOKEN })).response.status, 503));
  await test('Empty status succeeds with admin token', async () => assert.equal((await call('/api/status')).data.subs.length, 0));
  let pushId, fileId;
  await test('Push subscription creation stores no private URL', async () => {
    const r = await call('/api/subs', 'POST', { name: 'Synthetic push', mode: 'push' });
    assert.equal(r.response.status, 200); pushId = r.data.sub.id;
    assert.equal(JSON.parse(store.get('list'))[0].url, undefined);
  });
  await test('HTTP subscription URLs are rejected', async () => assert.equal((await call('/api/subs', 'POST', { name: 'Unsafe', url: 'http://example.com/sub' })).response.status, 400));
  const resource = fs.readFileSync(__dirname + '/../examples/demo.yaml', 'utf8');
  await test('File import retains valid quota and nodes', async () => {
    const r = await call('/api/import', 'POST', { name: 'Synthetic file', content: resource });
    assert.equal(r.response.status, 200); assert.equal(r.data.nodes, 2); assert.equal(r.data.hasUsage, true);
    fileId = r.data.sub.id; assert.equal(r.data.sub.remaining, 8 * 1024 ** 3);
  });
  await test('Failed reimport leaves old records untouched', async () => {
    const before = store.get('data:' + fileId), list = store.get('list');
    const r = await call('/api/import?id=' + fileId, 'POST', { name: 'Changed', content: 'proxy-providers:\n  missing: {}' });
    assert.equal(r.response.status, 422); assert.equal(store.get('data:' + fileId), before); assert.equal(store.get('list'), list);
  });
  await test('Public nodes do not expose host or port', async () => {
    const s = (await call('/api/status')).data.subs.find(s => s.id === fileId);
    for (const n of s.nodes) { assert.equal(n.host, undefined); assert.equal(n.port, undefined); assert.equal(n.password, undefined); }
    assert.equal(s.url, undefined);
  });
  await test('Import cannot overwrite non-file subscriptions', async () => assert.equal((await call('/api/import?id=' + pushId, 'POST', { name: 'Replacement', content: resource })).response.status, 404));
  await test('Manual quota rejects impossible remaining', async () => assert.equal((await call('/api/quota?id=' + fileId, 'POST', { total: 10, remaining: 11, noExpiry: true })).response.status, 400));
  await test('Manual quota is explicitly marked and has no daily estimate', async () => {
    const r = await call('/api/quota?id=' + fileId, 'POST', { total: 10 * 1024 ** 3, remaining: 7 * 1024 ** 3, noExpiry: true });
    assert.equal(r.data.sub.quotaSource, 'manual'); assert.equal(r.data.sub.usageToday, null);
  });
  await test('Push accepts real fixture metadata', async () => {
    const r = await call('/api/push?id=' + pushId, 'POST', { body: resource });
    assert.equal(r.data.ok, true); assert.equal(r.data.hasUsage, true);
  });
  await test('HTML challenge is not accepted as a subscription', async () => assert.equal((await call('/api/push?id=' + pushId, 'POST', { body: '<html><body>challenge</body></html>' })).response.status, 422));
  await test('Legacy ingestion uses its separate credential', async () => assert.equal((await call('/api/ingest', 'POST', { id: pushId, status: 200, content: resource })).response.status, 401));
  await test('Legacy ingestion cannot replace files', async () => assert.equal((await call('/api/ingest', 'POST', { id: fileId, status: 200, content: resource }, env.INGEST_TOKEN)).response.status, 409));
  await test('Delete removes definition and corresponding snapshot', async () => {
    assert.equal((await call('/api/subs?id=' + fileId, 'DELETE')).data.ok, true);
    assert.equal(store.has('data:' + fileId), false); assert.equal((await call('/api/status')).data.subs.length, 1);
  });
  console.log(`Passed ${checks} offline API checks; HTTP and sockets are mocked.`);
})().catch(error => { console.error(error); process.exit(1); });
