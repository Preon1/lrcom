import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import https from 'https';
import path from 'path';
import express from 'express';
import { WebSocketServer } from 'ws';
import webpush from 'web-push';

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? '0.0.0.0';
const PUBLIC_DIR = path.resolve(process.env.PUBLIC_DIR ?? path.join(process.cwd(), 'public'));

const TURN_URLS = (process.env.TURN_URLS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const TURN_SECRET = process.env.TURN_SECRET ?? '';
const TURN_USERNAME_TTL_SECONDS = Number(process.env.TURN_USERNAME_TTL_SECONDS ?? 3600);

const TURN_RELAY_MIN_PORT = Number(process.env.TURN_RELAY_MIN_PORT ?? 0);
const TURN_RELAY_MAX_PORT = Number(process.env.TURN_RELAY_MAX_PORT ?? 0);

const TLS_KEY_PATH = process.env.TLS_KEY_PATH ?? '';
const TLS_CERT_PATH = process.env.TLS_CERT_PATH ?? '';
const USE_HTTPS = Boolean(TLS_KEY_PATH && TLS_CERT_PATH);

// Optional Web Push (background notifications). If keys are not provided, the app
// still supports in-tab notifications when the page is open.
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY ?? '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY ?? '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT ?? 'mailto:lrcom@localhost';
const PUSH_ENABLED = Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);

if (PUSH_ENABLED) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

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

app.get('/api/push/public-key', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ enabled: PUSH_ENABLED, publicKey: PUSH_ENABLED ? VAPID_PUBLIC_KEY : null });
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
  // Avoid control characters (but allow newlines for multiline chat)
  // Allow: LF (\n) and CR (\r). Disallow everything else in C0 controls.
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(trimmed)) return null;
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
 * users: id -> { id, name, ws, lastMsgAt, roomId }
 */
const users = new Map();
const nameToId = new Map();

/**
 * rooms: roomId -> { id, members:Set<string> }
 */
const rooms = new Map();

/**
 * Web Push subscriptions (ephemeral server-side; memory only): userId -> subscription
 * NOTE: browsers persist subscriptions client-side until they expire or are revoked.
 */
const pushSubscriptions = new Map();

async function sendPushToUser(userId, payload) {
  if (!PUSH_ENABLED) return;
  const sub = pushSubscriptions.get(userId);
  if (!sub) return;
  try {
    await webpush.sendNotification(sub, JSON.stringify(payload));
  } catch (err) {
    const statusCode = err?.statusCode;
    if (statusCode === 404 || statusCode === 410) {
      pushSubscriptions.delete(userId);
    }
  }
}

function getTurnHostLabel() {
  // Best-effort parse from the first TURN url: turn:host:port?transport=...
  const first = TURN_URLS[0];
  if (!first) return null;
  const m = first.match(/^turns?:([^:?]+)(?::(\d+))?/i);
  if (!m) return null;
  const host = m[1];
  const port = m[2] ?? '3478';
  return `${host}:${port}`;
}

function getActiveCallCount() {
  // Room with 2+ members counts as an active call.
  let calls = 0;
  for (const r of rooms.values()) {
    if ((r.members?.size ?? 0) >= 2) calls++;
  }
  return calls;
}

function getPeerLinksEstimate() {
  // Mesh conference: number of peer connections ~= sum over rooms of k choose 2.
  let links = 0;
  for (const r of rooms.values()) {
    const k = r.members?.size ?? 0;
    if (k >= 2) links += (k * (k - 1)) / 2;
  }
  return links;
}

function getVoiceStats() {
  const turnHost = getTurnHostLabel();

  const hasRelayRange = Number.isFinite(TURN_RELAY_MIN_PORT)
    && Number.isFinite(TURN_RELAY_MAX_PORT)
    && TURN_RELAY_MIN_PORT > 0
    && TURN_RELAY_MAX_PORT >= TURN_RELAY_MIN_PORT;

  const relayPortsTotal = hasRelayRange
    ? (TURN_RELAY_MAX_PORT - TURN_RELAY_MIN_PORT + 1)
    : null;

  const activeCalls = getActiveCallCount();

  // Estimation (worst-case): mesh conference
  // - each peer link is one RTCPeerConnection between two participants
  // - if both sides relay, that's ~2 relay allocations (ports)
  const peerLinks = getPeerLinksEstimate();
  const relayPortsUsedEstimateRaw = Math.floor(peerLinks * 2);
  const relayPortsUsedEstimate = relayPortsTotal == null
    ? relayPortsUsedEstimateRaw
    : Math.min(relayPortsUsedEstimateRaw, relayPortsTotal);

  // Keep this as a simple reference number: max 2-party calls if every participant needs relay.
  const capacityCallsEstimate = relayPortsTotal == null ? null : Math.floor(relayPortsTotal / 2);

  // Estimate max conference users (mesh) under worst-case relaying:
  // linkBudget = floor(relayPortsTotal / 2) because ~2 relay ports per peer-link
  // find max k such that k*(k-1)/2 <= linkBudget
  let maxConferenceUsersEstimate = null;
  if (typeof relayPortsTotal === 'number') {
    const linkBudget = Math.floor(relayPortsTotal / 2);
    const disc = 1 + 8 * linkBudget;
    maxConferenceUsersEstimate = Math.floor((1 + Math.sqrt(disc)) / 2);
  }

  return {
    turnHost,
    relayPortsTotal,
    relayPortsUsedEstimate,
    capacityCallsEstimate,
    maxConferenceUsersEstimate,
    activeCalls,
  };
}

function broadcastPresence() {
  const list = Array.from(users.values()).map((u) => ({ id: u.id, name: u.name, busy: Boolean(u.roomId) }));
  const msg = JSON.stringify({ type: 'presence', users: list, voice: getVoiceStats() });
  for (const u of users.values()) {
    if (u.ws.readyState === 1) u.ws.send(msg);
  }
}

function getRoom(roomId) {
  return roomId ? rooms.get(roomId) : null;
}

function ensureRoom(roomId) {
  if (!rooms.has(roomId)) rooms.set(roomId, { id: roomId, members: new Set() });
  return rooms.get(roomId);
}

function leaveRoom(user) {
  const rid = user.roomId;
  if (!rid) return;
  const room = rooms.get(rid);
  user.roomId = null;
  if (!room) return;
  room.members.delete(user.id);
  for (const memberId of room.members) {
    const m = users.get(memberId);
    if (!m) continue;
    send(m.ws, { type: 'roomPeerLeft', roomId: rid, peerId: user.id });
  }
  if (room.members.size <= 1) {
    // If one user remains, end the room for them.
    const lastId = Array.from(room.members)[0];
    if (lastId) {
      const last = users.get(lastId);
      if (last) {
        last.roomId = null;
        send(last.ws, { type: 'callEnded', reason: 'alone' });
      }
    }
    rooms.delete(rid);
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

    if (u.id !== fromUser.id) {
      void sendPushToUser(u.id, {
        title: 'LRcom message',
        body: `${fromUser.name}: ${text}`,
        tag: 'lrcom-chat',
        url: '/',
      });
    }
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

  void sendPushToUser(toUser.id, {
    title: 'LRcom private message',
    body: `${fromUser.name}: ${text}`,
    tag: 'lrcom-pm',
    url: '/',
  });
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

  // If in room, leave room and notify others
  if (u.roomId) {
    leaveRoom(u);
  }

  users.delete(userId);
  pushSubscriptions.delete(userId);
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
  const user = { id: userId, name: null, ws, lastMsgAt: Date.now(), roomId: null, _rl: null };
  users.set(userId, user);

  const clientIp = req?.socket?.remoteAddress ?? null;
  const turnConfig = makeTurnConfig();

  // Common failure: TURN URLs set to localhost, which only works on the server machine.
  const badTurn = TURN_URLS.some((u) => /\b(localhost|127\.0\.0\.1|::1)\b/i.test(u));
  const isRemoteClient = clientIp && !/^::1$|^127\.|^::ffff:127\./.test(clientIp);
  const turnWarning = badTurn && isRemoteClient
    ? 'TURN is configured for localhost; set LRCOM_TURN_HOST to your public domain/IP for Internet calls.'
    : null;

  send(ws, { type: 'hello', id: userId, turn: turnConfig, https: USE_HTTPS, clientIp, turnWarning, voice: getVoiceStats() });

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

    // Push subscription can arrive before a name is set.
    if (msg.type === 'pushSubscribe') {
      if (!PUSH_ENABLED) return;
      if (msg.subscription && typeof msg.subscription === 'object') {
        pushSubscriptions.set(userId, msg.subscription);
      }
      return;
    }

    if (msg.type === 'pushUnsubscribe') {
      pushSubscriptions.delete(userId);
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
      if (callee.roomId) {
        send(ws, { type: 'callStartResult', ok: false, reason: 'busy' });
        return;
      }

      // New room or invite into existing room
      const rid = user.roomId ?? makeId();
      const room = ensureRoom(rid);
      room.members.add(user.id);
      room.members.add(callee.id);

      user.roomId = rid;
      callee.roomId = rid;

      send(callee.ws, { type: 'incomingCall', from: user.id, fromName: user.name, roomId: rid });

      void sendPushToUser(callee.id, {
        title: 'Incoming call',
        body: `From ${user.name}`,
        tag: 'lrcom-call',
        url: '/',
        requireInteraction: true,
      });
      send(ws, { type: 'callStartResult', ok: true });
      broadcastPresence();
      return;
    }

    if (msg.type === 'callReject') {
      const from = typeof msg.from === 'string' ? msg.from : null;
      const rid = typeof msg.roomId === 'string' ? msg.roomId : user.roomId;
      const caller = from ? users.get(from) : null;
      if (caller) send(caller.ws, { type: 'callRejected', reason: 'rejected' });

      // Remove rejecter from the room; if room collapses, last member gets callEnded.
      if (rid && user.roomId === rid) {
        leaveRoom(user);
      } else {
        user.roomId = null;
      }
      broadcastPresence();
      return;
    }

    if (msg.type === 'callAccept') {
      const from = typeof msg.from === 'string' ? msg.from : null;
      const caller = from ? users.get(from) : null;
      const rid = typeof msg.roomId === 'string' ? msg.roomId : user.roomId;
      if (!caller) {
        user.roomId = null;
        broadcastPresence();
        return;
      }

      if (!rid || caller.roomId !== rid || user.roomId !== rid) {
        user.roomId = null;
        broadcastPresence();
        return;
      }

      const room = getRoom(rid);
      if (!room) {
        user.roomId = null;
        broadcastPresence();
        return;
      }

      // Notify existing members to connect to the new joiner
      const peer = { id: user.id, name: user.name };
      for (const memberId of room.members) {
        if (memberId === user.id) continue;
        const m = users.get(memberId);
        if (!m) continue;
        send(m.ws, { type: 'roomPeerJoined', roomId: rid, peer });
      }

      // Send the joiner a list of existing members to prepare for offers
      const peers = Array.from(room.members)
        .filter((id) => id !== user.id)
        .map((id) => {
          const u2 = users.get(id);
          return u2 ? { id: u2.id, name: u2.name } : null;
        })
        .filter(Boolean);

      send(user.ws, { type: 'roomPeers', roomId: rid, peers });

      return;
    }

    if (msg.type === 'signal') {
      const to = typeof msg.to === 'string' ? msg.to : null;
      const payload = msg.payload;
      if (!to || !users.has(to)) return;

      // Only allow signaling between users in the same room
      const peer = users.get(to);
      if (!peer) return;
      if (!user.roomId || user.roomId !== peer.roomId) return;

      send(peer.ws, { type: 'signal', from: user.id, fromName: user.name, payload });
      return;
    }

    if (msg.type === 'callHangup') {
      leaveRoom(user);
      broadcastPresence();
      return;
    }

    if (msg.type === 'chatSend') {
      const raw = safeChatText(msg.text);
      if (!raw) {
        send(ws, { type: 'error', code: 'BAD_CHAT' });
        return;
      }

      // Replies use a reserved prefix that intentionally begins with '@'.
      // Don’t treat it as a private message to user named "reply".
      const pm = raw.startsWith('@reply [') ? null : parsePrivatePrefix(raw);
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
