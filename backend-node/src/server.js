// DT-WATCH BTS v2 — Node.js real-time gateway.
//
// Owns: WebSocket push for live alarm/threshold notifications, DT-upload
// progress, TRP job progress, multi-user tree-edit sync, and the
// AI-report streaming proxy. Everything it pushes originates elsewhere
// (Django enqueues, Go processes) and reaches this gateway via Redis
// pub/sub — this service does not talk to Postgres directly and does not
// touch the v1 system's files in any way (see ../../docs/RUNBOOK.md).
//
// Phase 0 scope: HTTP health check + a WebSocket endpoint that accepts
// connections and echoes a 'welcome' event. Redis pub/sub relay and real
// event types (alarm.raised, tree.updated, trp.job.progress, ...) are
// Phase 4/5/6 work per the migration plan — wiring them in now, before
// Django/Go actually produce those events, would just be dead code.

import 'dotenv/config';
import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import Redis from 'ioredis';

const PORT = process.env.PORT || 8090;
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const CORS_ALLOWED_ORIGIN = process.env.CORS_ALLOWED_ORIGIN || 'http://localhost:5180';

const app = express();

// The React shell (a different origin — different port — from the browser's
// point of view) calls this over plain fetch(), which browsers block by
// default without an explicit CORS allow-header. No new dependency needed;
// Phase 0 only has one route to allow.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', CORS_ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Track Redis connectivity for the health check, without ever letting a
// Redis outage crash the gateway — degrade to "no real-time relay" rather
// than going down entirely, since the REST API (Django) staying reachable
// matters more than live push.
let redisStatus = 'connecting';
const redis = new Redis(REDIS_URL, { lazyConnect: true, retryStrategy: () => 2000 });
redis.on('ready', () => { redisStatus = 'ok'; });
redis.on('error', (err) => { redisStatus = 'error: ' + err.message; });
redis.connect().catch(() => { /* status already tracked via 'error' event */ });

app.get('/health', (req, res) => {
  const ok = redisStatus === 'ok';
  res.status(ok ? 200 : 200).json({
    // Redis being down degrades real-time push but the gateway process
    // itself is still up and should report 200 so orchestration doesn't
    // restart-loop it over a transient Redis blip — degraded, not dead.
    service: 'dt-watch-node-gateway',
    status: ok ? 'ok' : 'degraded',
    redis: redisStatus,
    websocket_clients: wss ? wss.clients.size : 0,
  });
});

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (socket) => {
  socket.send(JSON.stringify({ type: 'welcome', message: 'dt-watch real-time gateway connected' }));

  socket.on('message', (raw) => {
    // Phase 0: no client->server commands defined yet. Echo back so a
    // connectivity test from the React shell has something to see.
    socket.send(JSON.stringify({ type: 'echo', received: raw.toString() }));
  });
});

server.listen(PORT, () => {
  console.log(`[dt-watch-node-gateway] listening on :${PORT} (http + ws at /ws)`);
});
