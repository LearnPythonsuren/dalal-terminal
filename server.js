"use strict";
/* Dalal Terminal — static host + GFDL REST proxy + GFDL WebSocket relay.
 *
 *  Price/quotes stream over WebSockets (GFDL SubscribeRealtime).
 *  Fundamentals / MF / IPO / News use REST via /api.
 *
 *  WS relay: a browser opens  wss://<thishost>/ws , then sends
 *     {"__open":{"endpoint":"ws://gfdlhost:port","token":"<key>"}}
 *  The server dials the upstream GFDL socket, authenticates with the token,
 *  replies {"__ready":true}, then transparently relays GFDL frames both ways
 *  (SubscribeRealtime up, RealtimeResult down). Tokens are passed through from
 *  the browser and never stored. A host allowlist guards REST and WS targets.
 */
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const WebSocket = require("ws");

const PORT = process.env.PORT || 10000;
const PUBLIC_DIR = path.join(__dirname, "public");

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
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".map": "application/json"
};
function cors() {
  return { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,OPTIONS",
    "access-control-allow-headers": "*", "content-type": "application/json; charset=utf-8" };
}
function sendStatic(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { "content-type": "text/plain" }); res.end("Not found"); return; }
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream", "cache-control": "no-cache" });
    res.end(buf);
  });
}

/* ---------- REST proxy (fundamentals / MF / IPO / news) ---------- */
function proxy(req, res, targetUrl) {
  let target;
  try { target = new URL(targetUrl); }
  catch (e) { res.writeHead(400, cors()); res.end(JSON.stringify({ error: "bad target url" })); return; }
  if (target.protocol !== "https:" && target.protocol !== "http:") {
    res.writeHead(400, cors()); res.end(JSON.stringify({ error: "unsupported protocol" })); return;
  }
  if (!hostAllowed(target.hostname)) {
    res.writeHead(403, cors());
    res.end(JSON.stringify({ error: "host not allowed", host: target.hostname, hint: "add it to GFDL_ALLOWED_HOSTS" })); return;
  }
  const mod = target.protocol === "https:" ? https : http;
  const upstream = mod.request(target, { method: "GET", timeout: 20000,
    headers: { "accept": "application/json, text/plain, */*", "user-agent": "DalalTerminal/1.0" } }, up => {
    const chunks = [];
    up.on("data", c => chunks.push(c));
    up.on("end", () => {
      res.writeHead(up.statusCode || 200, Object.assign(cors(), {
        "content-type": up.headers["content-type"] || "application/json; charset=utf-8" }));
      res.end(Buffer.concat(chunks));
    });
  });
  upstream.on("timeout", () => upstream.destroy());
  upstream.on("error", err => {
    res.writeHead(502, cors()); res.end(JSON.stringify({ error: "upstream failed", detail: String(err && err.message || err) }));
  });
  upstream.end();
}

/* ---------- HTTP server ---------- */
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
    res.end(JSON.stringify({ ok: true, ws: "/ws", allowedHosts: ALLOWED_HOSTS })); return;
  }
  let rel = decodeURIComponent(u.pathname);
  if (rel === "/" || rel === "") rel = "/index.html";
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end("Forbidden"); return; }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return sendStatic(res, path.join(PUBLIC_DIR, "index.html"));
    sendStatic(res, file);
  });
});

/* ---------- WebSocket relay (price stream) ---------- */
const wss = new WebSocket.Server({ server, path: "/ws", maxPayload: 4 * 1024 * 1024 });

function wsEndpointAllowed(endpoint) {
  try {
    const t = new URL(endpoint);
    if (t.protocol !== "ws:" && t.protocol !== "wss:") return false;
    return hostAllowed(t.hostname);
  } catch (e) { return false; }
}

wss.on("connection", client => {
  let upstream = null;
  let opened = false;
  let alive = true;
  client.on("pong", () => { alive = true; });

  const closeBoth = () => {
    try { client.close(); } catch (e) {}
    try { upstream && upstream.close(); } catch (e) {}
  };

  client.on("message", raw => {
    const text = typeof raw === "string" ? raw : raw.toString();
    if (!opened) {
      // first frame must be the open handshake
      let msg;
      try { msg = JSON.parse(text); } catch (e) { msg = null; }
      const open = msg && msg.__open;
      if (!open || !open.endpoint) {
        client.send(JSON.stringify({ __error: "first message must be {\"__open\":{endpoint,token}}" })); return;
      }
      if (!wsEndpointAllowed(open.endpoint)) {
        client.send(JSON.stringify({ __error: "endpoint host not allowed", endpoint: open.endpoint })); return;
      }
      opened = true;
      try {
        upstream = new WebSocket(open.endpoint, { handshakeTimeout: 15000, maxPayload: 1 << 24 });
      } catch (e) {
        client.send(JSON.stringify({ __error: "could not open upstream: " + (e && e.message) })); closeBoth(); return;
      }
      let authed = false;
      upstream.on("open", () => {
        upstream.send(JSON.stringify({ MessageType: "Authenticate", Password: open.token || "" }));
      });
      upstream.on("message", m => {
        const s = typeof m === "string" ? m : m.toString();
        if (!authed) {
          let r; try { r = JSON.parse(s); } catch (e) { r = null; }
          if (r && r.MessageType === "AuthenticateResult") {
            if (r.Complete) { authed = true; if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ __ready: true })); }
            else if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ __error: "authentication failed", detail: r.Message || "" }));
            return;
          }
        }
        if (client.readyState === WebSocket.OPEN) client.send(s); // relay GFDL frames downstream
      });
      upstream.on("close", (code) => { if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ __upstream_closed: code || 0 })); closeBoth(); });
      upstream.on("error", err => { if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ __error: "upstream error: " + (err && err.message) })); closeBoth(); });
      return;
    }
    // after open: relay browser frames (SubscribeRealtime, etc.) upstream
    if (upstream && upstream.readyState === WebSocket.OPEN) upstream.send(text);
  });

  client.on("close", () => closeBoth());
  client.on("error", () => closeBoth());
});

// drop dead sockets
const heartbeat = setInterval(() => {
  wss.clients.forEach(c => {
    if (c.__dead) { try { c.terminate(); } catch (e) {} return; }
    c.__dead = true;
    try { c.ping(); c.__dead = false; } catch (e) {}
  });
}, 30000);
wss.on("close", () => clearInterval(heartbeat));

server.listen(PORT, () => {
  console.log("Dalal Terminal on :" + PORT + " — REST /api, WS /ws — allowlist:", ALLOWED_HOSTS.join(", "));
});
