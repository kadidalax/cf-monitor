# CF Monitor

Cloudflare Worker probe monitoring panel built with Worker + D1 + Durable Objects + React.

It provides a public status dashboard, an admin panel, server agent reporting APIs, historical metrics, GPU history, ping monitoring, notification rules, audit logs, backup export, and local/remote migration scripts.

## One-Click Deploy To Cloudflare

For beginners, use the button below. It opens Cloudflare's deploy wizard. In most cases you can keep clicking **Next / Continue / Deploy**.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/kadidalax/cf-monitor)

### Required Values In The Wizard

When Cloudflare asks for environment variables or secrets, add these three values:

| Name | Example | Notes |
| --- | --- | --- |
| `JWT_SECRET` | `change-this-to-a-random-32-byte-string-2026` | Must be at least 32 bytes. Use a long random string. |
| `ADMIN_USERNAME` | `admin` | Initial admin username. |
| `ADMIN_PASSWORD` | `change-this-password` | Must be at least 12 bytes. Do not use a public/default password. |

The first successful login creates the initial admin account in D1. After that, the admin is stored in the database.

### After Deploy

Open the deployed Worker URL, usually like:

```text
https://cf-monitor.<your-account>.workers.dev
```

Then open:

```text
https://cf-monitor.<your-account>.workers.dev/login
```

Log in with the `ADMIN_USERNAME` and `ADMIN_PASSWORD` you entered in the Cloudflare wizard.

## What Cloudflare Creates

The deploy button reads the root `wrangler.toml` and provisions:

- Cloudflare Worker
- D1 database binding: `DB`
- Durable Object: `LIVE_DATA`
- Durable Object: `RATE_LIMIT`
- Static assets from `frontend/dist`
- Cron trigger every 10 minutes

The root deploy script builds the frontend, runs Worker type checks, and deploys the Worker. On first request, the Worker initializes the D1 schema automatically so the deploy button can complete without a pre-existing D1 `database_id`.

## Manual Deploy

If you prefer command line deployment:

```bash
npm install
npm run build
```

Create a D1 database if you do not already have one:

```bash
npm run db:create
```

Copy the generated D1 `database_id` into `wrangler.toml`.

If you also deploy from inside the `worker/` directory, copy the same ID into `worker/wrangler.toml`.

Set secrets:

```bash
cd worker
npx wrangler secret put JWT_SECRET
npx wrangler secret put ADMIN_USERNAME
npx wrangler secret put ADMIN_PASSWORD
```

Deploy:

```bash
cd ..
npm run deploy
```

## Local Development

Create local Worker secrets:

```bash
copy worker\.dev.vars.example worker\.dev.vars
```

Edit `worker/.dev.vars`:

```text
JWT_SECRET=replace-with-a-long-random-local-dev-secret-at-least-32-bytes
ADMIN_USERNAME=admin
ADMIN_PASSWORD=replace-with-a-local-dev-password-at-least-12-bytes
```

Build and prepare local D1:

```bash
npm run build
npm run db:migrate:local
npm --prefix worker run db:seed:local
```

Run the local Worker:

```bash
npm run dev:worker -- --local --ip 127.0.0.1 --port 8787
```

Open:

```text
http://127.0.0.1:8787
```

## Agent

The agent source lives in `agent/`.

After deploying the panel, log in to the admin panel, create a server node, copy its install command or token, then install the agent on your server.

Linux one-line install template:

```bash
wget -qO- 'https://raw.githubusercontent.com/kadidalax/cf-monitor/refs/heads/main/agent/install-linux.sh' | sudo bash -s -- --server 'https://your-worker.workers.dev' --token 'YOUR_NODE_TOKEN'
```

Windows PowerShell install template:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "iwr 'https://raw.githubusercontent.com/kadidalax/cf-monitor/refs/heads/main/agent/install-windows.ps1' -UseBasicParsing -OutFile 'install-windows.ps1'; & '.\install-windows.ps1' -Server 'https://your-worker.workers.dev' -Token 'YOUR_NODE_TOKEN'"
```

By default the installer downloads the latest prebuilt agent binary from GitHub Releases. No Go compiler is required on the VPS. If you need a custom binary, paste its URL in the admin panel's install dialog or pass `--binary-url` / `-BinaryUrl`.

## Repository Layout

```text
agent/      Go server probe agent
frontend/   React admin panel and public dashboard
worker/     Cloudflare Worker API, D1 migrations, Durable Objects
```

## Important Security Notes

- Do not commit `worker/.dev.vars`.
- Do not reuse the example password in production.
- Keep `JWT_SECRET` long and random.
- Hidden nodes are excluded from public APIs.
- Public APIs remove sensitive fields such as tokens and raw IP addresses.

## Useful Commands

```bash
npm run build               # frontend build + Worker type check
npm run deploy              # build + remote D1 migrations + Worker deploy
npm run verify              # build-only verification
npm run db:migrate:remote   # remote D1 migrations only
npm run db:migrate:local    # local D1 migrations only
```
