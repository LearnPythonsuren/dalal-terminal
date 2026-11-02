# Dalal Terminal

A single-page NSE market terminal: sector **heat map** (NIFTY 50/100/500, Cash/F&O, market-cap/equal sizing, % change / volume / turnover, 1m/5m/daily), **fundamentals**, **mutual funds**, **IPO centre**, and a **news** wire — with a Settings page where each data class (Price, Fundamentals, Mutual Fund, IPO, News) can use its own GFDL endpoint and access token.

## How it runs

- `server.js` serves the dashboard from `public/` and exposes `/api?u=<encoded GFDL url>`, a thin proxy that relays the call and adds CORS headers so the browser can reach GFDL. **Tokens are passed through from the browser and never stored server-side.**
- An allowlist (`GFDL_ALLOWED_HOSTS`, comma-separated host or `.suffix`) restricts which hosts the proxy will reach. Default: the `*.lisuns.com` GFDL feed.

## Local

```bash
node server.js         # http://localhost:10000
```

Then open Settings in the UI and paste your per-API base URLs and access tokens.

## Deploy (Render)

Node web service, build `npm install`, start `node server.js`, health check `/healthz`. Set `GFDL_ALLOWED_HOSTS` if your endpoints are on a different host.
