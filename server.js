"use strict";
/* Dalal Terminal — static host + GFDL proxy.
 * Serves the dashboard from ./public and relays GFDL REST calls so the
 * browser avoids CORS. Access tokens are passed through from the client
 * (in the proxied URL); the server never stores them. An allowlist on the
 * target host prevents the proxy from being used as an open relay (SSRF).
 */
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = process.env.PORT || 10000;
const PUBLIC_DIR = path.join(__dirname, "public");

// Hosts the proxy is allowed to reach. Default covers the GFDL/lisuns feed;
// extend via GFDL_ALLOWED_HOSTS="host1,host2" (exact host or ".suffix").
const DEFAULT_HOSTS = ["test.lisuns.com", ".lisuns.com", "qbase.lisuns.com", "ctrue.lisuns.com"];
const ALLOWED_HOSTS = (process.env.GFDL_ALLOWED_HOSTS
  ? process.env.GFDL_ALLOWED_HOSTS.split(",").map(s => s.trim()).filter(Boolean)
  : DEFAULT_HOSTS);

function hostAllowed(host) {
  host = (host || "").toLowerCase();
  return ALLOWED_HOSTS.some(h => h.startsWith(".") ? host.endsWith(h) || host === h.slice(1) : host === h);
}

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
  ".woff2": "font/woff2", ".map": "application/json"
};

function sendStatic(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { "content-type": "text/plain" }); res.end("Not found"); return; }
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream", "cache-control": "no-cache" });
    res.end(buf);
  });
}

function proxy(req, res, targetUrl) {
  let target;
  try { target = new URL(targetUrl); }
  catch (e) { res.writeHead(400, cors()); res.end(JSON.stringify({ error: "bad target url" })); return; }
  if (target.protocol !== "https:" && target.protocol !== "http:") {
    res.writeHead(400, cors()); res.end(JSON.stringify({ error: "unsupported protocol" })); return;
  }
  if (!hostAllowed(target.hostname)) {
    res.writeHead(403, cors());
    res.end(JSON.stringify({ error: "host not allowed", host: target.hostname,
      hint: "add it to GFDL_ALLOWED_HOSTS on the service" }));
    return;
  }
  const mod = target.protocol === "https:" ? https : http;
  const upstream = mod.request(target, { method: "GET", timeout: 20000,
    headers: { "accept": "application/json, text/plain, */*", "user-agent": "DalalTerminal/1.0" } }, up => {
    const chunks = [];
    up.on("data", c => chunks.push(c));
    up.on("end", () => {
      const body = Buffer.concat(chunks);
      res.writeHead(up.statusCode || 200, Object.assign(cors(), {
        "content-type": up.headers["content-type"] || "application/json; charset=utf-8" }));
      res.end(body);
    });
  });
  upstream.on("timeout", () => { upstream.destroy(); });
  upstream.on("error", err => {
    res.writeHead(502, cors());
    res.end(JSON.stringify({ error: "upstream failed", detail: String(err && err.message || err) }));
  });
  upstream.end();
}

function cors() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,OPTIONS",
    "access-control-allow-headers": "*",
    "content-type": "application/json; charset=utf-8"
  };
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://localhost");

  if (req.method === "OPTIONS") { res.writeHead(204, cors()); res.end(); return; }

  if (u.pathname === "/api") {
    const target = u.searchParams.get("u");
    if (!target) { res.writeHead(400, cors()); res.end(JSON.stringify({ error: "missing ?u=" })); return; }
    return proxy(req, res, target);
  }

  if (u.pathname === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, allowedHosts: ALLOWED_HOSTS })); return;
  }

  // static
  let rel = decodeURIComponent(u.pathname);
  if (rel === "/" || rel === "") rel = "/index.html";
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end("Forbidden"); return; }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return sendStatic(res, path.join(PUBLIC_DIR, "index.html")); // SPA-ish fallback
    sendStatic(res, file);
  });
});

server.listen(PORT, () => {
  console.log("Dalal Terminal on :" + PORT + " — proxy allowlist:", ALLOWED_HOSTS.join(", "));
});
