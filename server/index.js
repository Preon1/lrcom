import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import https from 'https';
import path from 'path';
import express from 'express';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? '0.0.0.0';
const PUBLIC_DIR = path.resolve(process.env.PUBLIC_DIR ?? path.join(process.cwd(), 'public'));

const TURN_URLS = (process.env.TURN_URLS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const TURN_SECRET = process.env.TURN_SECRET ?? '';
const TURN_USERNAME_TTL_SECONDS = Number(process.env.TURN_USERNAME_TTL_SECONDS ?? 3600);

const TLS_KEY_PATH = process.env.TLS_KEY_PATH ?? '';
const TLS_CERT_PATH = process.env.TLS_CERT_PATH ?? '';
const USE_HTTPS = Boolean(TLS_KEY_PATH && TLS_CERT_PATH);

const app = express();

app.disable('x-powered-by');

// Security headers (minimal, no external deps)
app.use((req, res, next) => {
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'microphone=(self), camera=()');

  // Note: WebRTC needs 'connect-src' for WSS/WS to this origin.
  // Keep CSP simple; adjust if you add external assets.
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "base-uri 'none'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "img-src 'self' data:",
      "style-src 'self'",
      "script-src 'self'",
      "connect-src 'self' wss: ws:",
    ].join('; '),
  );

  next();
});

app.use(express.static(PUBLIC_DIR, {
  etag: false,
  lastModified: false,
  setHeaders(res) {
    // Avoid caching to reduce "traces"; browsers may still keep memory caches transiently.
    res.setHeader('Cache-Control', 'no-store');
  },
}));

app.get('/healthz', (req, res) => {
  res.type('text/plain').send('ok');
});

app.get('/turn', (req, res) => {
  // Optional helper endpoint (not required by UI), returns time-limited TURN creds.
  // No authentication is implemented (per spec). For private use, keep it behind your network.
  res.json(makeTurnConfig());
});

function makeTurnCredentials() {
  if (!TURN_SECRET || TURN_URLS.length === 0) return null;

  const now = Math.floor(Date.now() / 1000);
  const expiry = now + TURN_USERNAME_TTL_SECONDS;
  const username = String(expiry);

  const hmac = crypto.createHmac('sha1', TURN_SECRET).update(username).digest('base64');
  const credential = hmac;

  return {
    urls: TURN_URLS,
    username,
    credential,
  };
}

function makeTurnConfig() {
  const turn = makeTurnCredentials();
  if (!turn) return { iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }] };
  return {
    iceServers: [
      { urls: ['stun:stun.l.google.com:19302'] },
      turn,
    ],
  };
}

function safeName(input) {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (trimmed.length < 1 || trimmed.length > 32) return null;
  // Allow simple characters; avoid confusing/abusive control chars
  if (!/^[a-zA-Z0-9 _\-\.]+$/.test(trimmed)) return null;
  return trimmed;
}

function safeChatText(input) {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (trimmed.length < 1 || trimmed.length > 500) return null;
  // Avoid control characters
  if (/[\u0000-\u001F\u007F]/.test(trimmed)) return null;
  return trimmed;
}

function makeId() {
  return crypto.randomBytes(12).toString('hex');
}

const server = USE_HTTPS
  ? https.createServer(
      {
        key: fs.readFileSync(TLS_KEY_PATH),
        cert: fs.readFileSync(TLS_CERT_PATH),
      },
      app,
    )
  : http.createServer(app);

const wss = new WebSocketServer({ server });

/**
 * Ephemeral state only (memory); no persistence.
 * users: id -> { id, name, ws, lastMsgAt, inCallWith }
 */
const users = new Map();
const nameToId = new Map();

function broadcastPresence() {
  const list = Array.from(users.values()).map((u) => ({ id: u.id, name: u.name, busy: Boolean(u.inCallWith) }));
  const msg = JSON.stringify({ type: 'presence', users: list });
  for (const u of users.values()) {
    if (u.ws.readyState === 1) u.ws.send(msg);
  }
}

function broadcastChat(fromUser, text) {
  const atIso = new Date().toISOString();
  const msg = JSON.stringify({
    type: 'chat',
    atIso,
    from: fromUser.id,
    fromName: fromUser.name,
    text,
    private: false,
  });

  for (const u of users.values()) {
    if (!u.name) continue;
    if (u.ws.readyState === 1) u.ws.send(msg);
  }
}

function broadcastSystem(text) {
  const atIso = new Date().toISOString();
  const msg = JSON.stringify({
    type: 'chat',
    atIso,
    from: null,
    fromName: 'System',
    text,
    private: false,
  });

  for (const u of users.values()) {
    if (!u.name) continue;
    if (u.ws.readyState === 1) u.ws.send(msg);
  }
}

function sendPrivateChat(fromUser, toUser, text) {
  const atIso = new Date().toISOString();
  const msg = JSON.stringify({
    type: 'chat',
    atIso,
    from: fromUser.id,
    fromName: fromUser.name,
    to: toUser.id,
    toName: toUser.name,
    text,
    private: true,
  });

  if (fromUser.ws.readyState === 1) fromUser.ws.send(msg);
  if (toUser.ws.readyState === 1) toUser.ws.send(msg);
}

function parsePrivatePrefix(text) {
  // Supports:
  //   @Alice hello
  //   @"Alice Doe" hello
  if (typeof text !== 'string' || !text.startsWith('@')) return null;

  if (text.startsWith('@"')) {
    const closing = text.indexOf('"', 2);
    if (closing === -1) return null;
    const toName = text.slice(2, closing);
    const rest = text.slice(closing + 1);
    if (!rest.startsWith(' ')) return null;
    const body = rest.trim();
    if (!toName || !body) return null;
    return { toName, body };
  }

  const firstSpace = text.indexOf(' ');
  if (firstSpace === -1) return null;
  const toName = text.slice(1, firstSpace);
  const body = text.slice(firstSpace + 1).trim();
  if (!toName || !body) return null;
  return { toName, body };
}

function send(ws, obj) {
  if (ws.readyState !== 1) return;
  ws.send(JSON.stringify(obj));
}

function closeUser(userId) {
  const u = users.get(userId);
  if (!u) return;

  const name = u.name;

  // If in call, notify peer
  if (u.inCallWith) {
    const peer = users.get(u.inCallWith);
    if (peer) {
      peer.inCallWith = null;
      send(peer.ws, { type: 'callEnded', reason: 'peer_left' });
    }
  }

  users.delete(userId);
  if (name && nameToId.get(name) === userId) nameToId.delete(name);

  if (name) broadcastSystem(`${name} left.`);
  broadcastPresence();
}

function rateLimit(user, nowMs) {
  // Simple per-connection rate limit: max 20 messages per 2 seconds.
  // Implemented as a sliding counter with time bucket.
  if (!user._rl) user._rl = { windowStart: nowMs, count: 0 };
  const win = user._rl;
  if (nowMs - win.windowStart > 2000) {
    win.windowStart = nowMs;
    win.count = 0;
  }
  win.count++;
  return win.count <= 20;
}

wss.on('connection', (ws, req) => {
  const userId = makeId();
  const user = { id: userId, name: null, ws, lastMsgAt: Date.now(), inCallWith: null, _rl: null };
  users.set(userId, user);

  const clientIp = req?.socket?.remoteAddress ?? null;
  const turnConfig = makeTurnConfig();

  // Common failure: TURN URLs set to localhost, which only works on the server machine.
  const badTurn = TURN_URLS.some((u) => /\b(localhost|127\.0\.0\.1|::1)\b/i.test(u));
  const isRemoteClient = clientIp && !/^::1$|^127\.|^::ffff:127\./.test(clientIp);
  const turnWarning = badTurn && isRemoteClient
    ? 'TURN is configured for localhost; set LRCOM_TURN_HOST to your public domain/IP for Internet calls.'
    : null;

  send(ws, { type: 'hello', id: userId, turn: turnConfig, https: USE_HTTPS, clientIp, turnWarning });

  ws.on('message', (data) => {
    const now = Date.now();
    if (!rateLimit(user, now)) {
      send(ws, { type: 'error', code: 'RATE_LIMIT' });
      return;
    }

    let msg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      send(ws, { type: 'error', code: 'BAD_JSON' });
      return;
    }

    if (!msg || typeof msg.type !== 'string') {
      send(ws, { type: 'error', code: 'BAD_MESSAGE' });
      return;
    }

    if (msg.type === 'setName') {
      const name = safeName(msg.name);
      if (!name) {
        send(ws, { type: 'nameResult', ok: false, reason: 'invalid' });
        return;
      }
      const existing = nameToId.get(name);
      if (existing && existing !== userId) {
        send(ws, { type: 'nameResult', ok: false, reason: 'taken' });
        return;
      }

      // Release old name
      if (user.name && nameToId.get(user.name) === userId) nameToId.delete(user.name);

      user.name = name;
      nameToId.set(name, userId);
      send(ws, { type: 'nameResult', ok: true, name });
      broadcastSystem(`${name} joined.`);
      broadcastPresence();
      return;
    }

    // Require name for any other operations
    if (!user.name) {
      send(ws, { type: 'error', code: 'NO_NAME' });
      return;
    }

    if (msg.type === 'callStart') {
      const to = typeof msg.to === 'string' ? msg.to : null;
      if (!to || !users.has(to)) {
        send(ws, { type: 'callStartResult', ok: false, reason: 'not_found' });
        return;
      }
      if (to === userId) {
        send(ws, { type: 'callStartResult', ok: false, reason: 'self' });
        return;
      }

      const callee = users.get(to);
      if (!callee.name) {
        send(ws, { type: 'callStartResult', ok: false, reason: 'not_ready' });
        return;
      }
      if (user.inCallWith || callee.inCallWith) {
        send(ws, { type: 'callStartResult', ok: false, reason: 'busy' });
        return;
      }

      // Mark "ringing" as busy on both ends to avoid race calls.
      user.inCallWith = callee.id;
      callee.inCallWith = user.id;

      send(callee.ws, { type: 'incomingCall', from: user.id, fromName: user.name });
      send(ws, { type: 'callStartResult', ok: true });
      broadcastPresence();
      return;
    }

    if (msg.type === 'callReject') {
      const from = typeof msg.from === 'string' ? msg.from : null;
      const caller = from ? users.get(from) : null;
      if (caller) {
        caller.inCallWith = null;
        send(caller.ws, { type: 'callRejected', reason: 'rejected' });
      }
      user.inCallWith = null;
      broadcastPresence();
      return;
    }

    if (msg.type === 'callAccept') {
      const from = typeof msg.from === 'string' ? msg.from : null;
      const caller = from ? users.get(from) : null;
      if (!caller) {
        user.inCallWith = null;
        broadcastPresence();
        return;
      }
      // Keep inCallWith as set; caller will create offer.
      send(caller.ws, { type: 'callAccepted', by: userId, byName: user.name });
      return;
    }

    if (msg.type === 'signal') {
      const to = typeof msg.to === 'string' ? msg.to : null;
      const payload = msg.payload;
      if (!to || !users.has(to)) return;

      // Only allow signaling between paired call participants
      const peer = users.get(to);
      if (!peer) return;
      if (user.inCallWith !== peer.id || peer.inCallWith !== user.id) return;

      send(peer.ws, { type: 'signal', from: user.id, fromName: user.name, payload });
      return;
    }

    if (msg.type === 'callHangup') {
      const peerId = user.inCallWith;
      if (peerId) {
        const peer = users.get(peerId);
        if (peer) {
          peer.inCallWith = null;
          send(peer.ws, { type: 'callEnded', reason: 'hangup' });
        }
      }
      user.inCallWith = null;
      broadcastPresence();
      return;
    }

    if (msg.type === 'chatSend') {
      const raw = safeChatText(msg.text);
      if (!raw) {
        send(ws, { type: 'error', code: 'BAD_CHAT' });
        return;
      }

      const pm = parsePrivatePrefix(raw);
      if (pm) {
        const toId = nameToId.get(pm.toName);
        const toUser = toId ? users.get(toId) : null;
        if (!toUser || !toUser.name) {
          send(ws, { type: 'error', code: 'PM_NOT_FOUND' });
          return;
        }
        if (toUser.id === user.id) {
          send(ws, { type: 'error', code: 'PM_SELF' });
          return;
        }
        sendPrivateChat(user, toUser, pm.body);
        return;
      }

      broadcastChat(user, raw);
      return;
    }

    send(ws, { type: 'error', code: 'UNKNOWN_TYPE' });
  });

  ws.on('close', () => {
    closeUser(userId);
  });

  ws.on('error', () => {
    closeUser(userId);
  });
});

server.listen(PORT, HOST, () => {
  // Intentionally minimal logs
  if (process.env.STARTUP_LOG === '1') {
    console.log(`LRcom listening on ${USE_HTTPS ? 'https' : 'http'}://${HOST}:${PORT}`);
  }
});
