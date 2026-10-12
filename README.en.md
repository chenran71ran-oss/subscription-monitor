# Subscription Monitor

[简体中文](README.md) · [Deployment](docs/deployment.md) · [API](docs/api.md) · [Contributing](CONTRIBUTING.md)

A self-hosted subscription quota and node TCP monitoring dashboard built for **Cloudflare Workers + KV**. The first open-source version is **v01** (package version **0.1.0**), based on the pre-release **Demo v18**. The interface is currently in Chinese; this English README is a project overview, not a claim of an English UI.

![Desktop dashboard with synthetic data](docs/assets/desktop-light.png)

## Features

- HTTPS subscription retrieval, UTF-8 YAML / JSON / text file imports, and external ingestion.
- Quota, usage, remaining traffic, expiry, node counts, and collection diagnostics when supplied by upstream data.
- Calendar-day usage derived from quota snapshots using Asia/Shanghai boundaries; partial history is explicitly indicated.
- URI / Base64 inputs, common Clash YAML and JSON, sing-box JSON, and a subset of section-based proxy text configs.
- QX-compatible quota metadata and Shadowrocket STATUS parsing adapted to the Worker runtime.
- Cloudflare-to-endpoint TCP connection timing, protocol counts, and name-derived region visualization.
- Four display modes, light / system / dark themes, integrated liquid feedback, responsive layouts, drag ordering, and a central display.
- Bearer-protected APIs, optional Cron checks, and a copy-paste single-file Worker build.

## Deployment

For the simplest deployment, paste [worker.js](worker.js) into a Cloudflare **module Worker**, bind a KV namespace as `SUB_KV`, and set the `ADMIN_TOKEN` secret. Open the Worker URL and enter your token. Add a Cron trigger if monitoring should continue while the browser is closed.

For CLI deployment, use Node.js 22+:

```bash
npm ci
cp wrangler.example.toml wrangler.toml
npx wrangler login
npx wrangler kv namespace create SUB_KV
```

Replace the KV namespace ID in `wrangler.toml`, then run:

```bash
npm run check
npx wrangler deploy
npx wrangler secret put ADMIN_TOKEN
```

Never commit your real configuration, tokens, or subscriptions. `INGEST_TOKEN` is optional and only required for the legacy Windows ingestion endpoint. See the [deployment guide](docs/deployment.md).

## What the data means

Parsing nodes does not create missing quota information. One-time quotas work when the upstream provides recognizable fields. Files are static snapshots. Preserved older quota data must be interpreted with its timestamp.

Node timing measures **Cloudflare → endpoint TCP establishment**, not local-device latency or authenticated proxy throughput. This project does not run the Quantumult X, Clash, or mihomo proxy core. UDP / QUIC protocols are marked unsupported for TCP measurement. Provider dashboard login scraping and online code update / rollback are not implemented.

The browser reads snapshots every 60 seconds; collection is performed by manual checks, Cron, or push ingestion. KV is eventually consistent, and concurrent writes are not transactional.

## Development

```bash
npm ci
npm run build
npm run check
npx playwright install chromium
npm run test:ui
```

Edit `src/worker.js`, `web/index.html`, `web/styles.css`, and `web/app.js`; rebuild `worker.js` and `worker.txt`. Builds use deterministic asset embedding and no runtime CDN. Tests use synthetic fixtures; offline tests are not proof that a particular provider can be fetched from Cloudflare.

The [documentation index](docs/README.md) covers architecture, compatibility, API, troubleshooting, migration, and design decisions. Report sanitized reproduction cases using our issue templates. See [SECURITY.md](SECURITY.md) before sharing diagnostics.

## Credits and license

Documentation structure was informed by [Uptime Kuma](https://github.com/louislam/uptime-kuma), [Komari](https://github.com/komari-monitor/komari), and [Sub-Store](https://github.com/sub-store-org/Sub-Store). Quota compatibility research referenced [KOP-XIAO/QuantumultX](https://github.com/KOP-XIAO/QuantumultX); its remote parser is not bundled or executed.

[MIT License](LICENSE) · [Provenance notice](NOTICE.md)
