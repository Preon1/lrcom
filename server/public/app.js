const qs = (id) => document.getElementById(id);

const setupEl = qs('setup');
const appShellEl = qs('appShell');
const incomingEl = qs('incoming');
const chatEl = qs('chat');

const nameInput = qs('name');
const joinBtn = qs('join');
const leaveBtn = qs('leave');
const hangupBtn = qs('hangup');
const toggleUsersBtn = qs('toggleUsers');
const sidebarEl = qs('sidebar');

const usersEl = qs('users');
const meEl = qs('me');
const peerEl = qs('peer');

const setupStatus = qs('setupStatus');
const lobbyStatus = qs('lobbyStatus');
const callStatus = qs('callStatus');
const callIdleEl = qs('callIdle');
const callActiveEl = qs('callActive');
const techInfoEl = qs('techInfo');

const acceptBtn = qs('accept');
const rejectBtn = qs('reject');
const callerNameEl = qs('callerName');

const remoteAudiosEl = qs('remoteAudios');

const chatMessagesEl = qs('chatMessages');
const chatInput = qs('chatInput');
const chatSendBtn = qs('chatSend');
const filterPrivateEl = qs('filterPrivate');
const filterPublicEl = qs('filterPublic');
const filterSystemEl = qs('filterSystem');

const themeToggleSetupBtn = qs('themeToggleSetup');
const themeToggleHeaderBtn = qs('themeToggleHeader');
const enableNotificationsBtn = qs('enableNotifications');

const setupForm = qs('setupForm');

const debugEnabled = new URLSearchParams(location.search).get('debug') === '1';
const debugPanel = qs('debugPanel');
const debugLogEl = qs('debugLog');

function logDebug(...args) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`;
  // Always log to console to help diagnose remote issues.
  // (No persistence; this is runtime-only.)
  console.log('LRcom', line);

  if (debugEnabled && debugLogEl) {
    debugLogEl.textContent += line + '\n';
    debugLogEl.scrollTop = debugLogEl.scrollHeight;
  }
}

const THEME_ORDER = ['system', 'light', 'dark'];
let themeMode = 'system';

function applyTheme(mode) {
  themeMode = THEME_ORDER.includes(mode) ? mode : 'system';
  const root = document.documentElement;
  if (themeMode === 'system') {
    root.removeAttribute('data-theme');
  } else {
    root.setAttribute('data-theme', themeMode);
  }

  const label = `Theme: ${themeMode[0].toUpperCase()}${themeMode.slice(1)}`;
  if (themeToggleSetupBtn) themeToggleSetupBtn.textContent = label;
  if (themeToggleHeaderBtn) themeToggleHeaderBtn.textContent = label;
}

function cycleTheme() {
  const i = THEME_ORDER.indexOf(themeMode);
  const next = THEME_ORDER[(i + 1 + THEME_ORDER.length) % THEME_ORDER.length];
  applyTheme(next);
}

let ws;
let myId = null;
let myName = null;
let roomId = null;
let pendingIncomingFrom = null;
let pendingIncomingRoomId = null;

/** @type {Map<string, RTCPeerConnection>} */
const pcs = new Map();
/** @type {Map<string, string>} */
const peerNames = new Map();

let localStream;
let iceConfig;

let chatMessages = [];

let replyContextMenuEl = null;
let replyContextTarget = null;

let ringtoneCtx;
let ringtoneOsc;
let ringtoneGain;

let wakeLock = null;
let swRegistration = null;

function notificationsSupported() {
  return typeof window !== 'undefined' && 'Notification' in window;
}

function notificationsGranted() {
  return notificationsSupported() && Notification.permission === 'granted';
}

function updateNotificationsButton() {
  if (!enableNotificationsBtn) return;
  if (!notificationsSupported()) {
    enableNotificationsBtn.textContent = 'Notifications unavailable';
    enableNotificationsBtn.disabled = true;
    return;
  }

  if (Notification.permission === 'granted') {
    enableNotificationsBtn.textContent = 'Notifications on';
  } else if (Notification.permission === 'denied') {
    enableNotificationsBtn.textContent = 'Notifications blocked';
  } else {
    enableNotificationsBtn.textContent = 'Enable notifications';
  }
}

async function ensureServiceWorker() {
  try {
    if (!('serviceWorker' in navigator)) return null;
    if (swRegistration) return swRegistration;
    // sw.js is served from the site root, so scope './' covers the app.
    swRegistration = await navigator.serviceWorker.register('./sw.js', { scope: './' });
    return swRegistration;
  } catch {
    return null;
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/\-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

async function tryEnableWebPushForThisSocket() {
  // Optional: requires VAPID keys on the server and browser Push support.
  try {
    if (!notificationsGranted()) return false;
    if (!('serviceWorker' in navigator)) return false;
    if (!('PushManager' in window)) return false;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;

    const res = await fetch('./api/push/public-key', { cache: 'no-store' });
    if (!res.ok) return false;
    const data = await res.json();
    if (!data?.enabled || !data?.publicKey) return false;

    const reg = await navigator.serviceWorker.ready;
    const existing = await reg.pushManager.getSubscription();
    const subscription = existing ?? await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(data.publicKey),
    });

    send({ type: 'pushSubscribe', subscription });
    return true;
  } catch {
    return false;
  }
}

function notify(title, body, opts = {}) {
  try {
    if (!notificationsGranted()) return;
    // Prefer notifications when not visible.
    if (!document.hidden) return;

    // eslint-disable-next-line no-new
    new Notification(title, {
      body,
      tag: opts.tag ?? 'lrcom',
      renotify: true,
    });
  } catch {
    // ignore
  }
}

function vibrate(pattern) {
  try {
    if (navigator.vibrate) navigator.vibrate(pattern);
  } catch {
    // ignore
  }
}

async function enableWakeLock() {
  // Wake Lock only works while visible; helps keep the app active while open.
  try {
    if (!('wakeLock' in navigator)) return;
    if (document.visibilityState !== 'visible') return;
    if (wakeLock) return;
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => {
      wakeLock = null;
    });
  } catch {
    // ignore
  }
}

async function disableWakeLock() {
  try {
    if (wakeLock) await wakeLock.release();
  } catch {
    // ignore
  } finally {
    wakeLock = null;
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void enableWakeLock();
  else void disableWakeLock();
});

async function enableNotifications() {
  if (!notificationsSupported()) return;
  const perm = await Notification.requestPermission();
  updateNotificationsButton();
  if (perm !== 'granted') return;

  await ensureServiceWorker();
  // Web Push is optional and best-effort.
  void tryEnableWebPushForThisSocket();
}

function isMobileLayout() {
  return window.matchMedia && window.matchMedia('(max-width: 640px)').matches;
}

function isMobileTextEntry() {
  // Keyboard behavior should follow device input characteristics, not viewport width.
  // Touch devices (phones/tablets) should treat Enter as newline; Send button submits.
  return (navigator.maxTouchPoints ?? 0) > 0
    || (window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
}

function setUsersOpen(open) {
  if (!appShellEl) return;
  appShellEl.classList.toggle('users-open', Boolean(open));
}

function closeUsersIfMobile() {
  if (isMobileLayout()) setUsersOpen(false);
}

const accountControlsEl = qs('accountControls');
const sidebarControlsEl = qs('sidebarControls');

function updateResponsiveChrome() {
  if (!accountControlsEl || !sidebarControlsEl || !appShellEl) return;
  if (isMobileLayout()) {
    if (accountControlsEl.parentElement !== sidebarControlsEl) {
      sidebarControlsEl.appendChild(accountControlsEl);
    }
  } else {
    const headerRight = document.querySelector('.header-right');
    if (headerRight && accountControlsEl.parentElement !== headerRight) {
      headerRight.insertBefore(accountControlsEl, headerRight.firstChild);
    }
  }
}

function setView(view) {
  // New layout: only two main views.
  const joined = view !== 'setup';
  setupEl.classList.toggle('hidden', joined);
  appShellEl.classList.toggle('hidden', !joined);
  chatEl.classList.toggle('hidden', !joined);

  if (!joined) setUsersOpen(false);
}

function showIncoming(show) {
  incomingEl.classList.toggle('hidden', !show);
}

function setText(el, text) {
  el.textContent = text ?? '';
}

function renderTechInfo(voice) {
  if (!techInfoEl) return;
  if (!voice || (!voice.turnHost && voice.relayPortsTotal == null)) {
    setText(techInfoEl, '');
    return;
  }

  const parts = [];
  if (voice.turnHost) parts.push(`TURN ${voice.turnHost}`);

  if (typeof voice.relayPortsUsedEstimate === 'number' && typeof voice.relayPortsTotal === 'number') {
    parts.push(`UDP relay ports ~${voice.relayPortsUsedEstimate}/${voice.relayPortsTotal}`);
  } else if (typeof voice.relayPortsTotal === 'number') {
    parts.push(`UDP relay ports ${voice.relayPortsTotal}`);
  } else if (typeof voice.relayPortsUsedEstimate === 'number') {
    parts.push(`UDP relay ports in use ~${voice.relayPortsUsedEstimate}`);
  }

  if (typeof voice.maxConferenceUsersEstimate === 'number') {
    parts.push(`est conf max ~${voice.maxConferenceUsersEstimate} users`);
  } else if (typeof voice.capacityCallsEstimate === 'number') {
    parts.push(`est 1:1 max ~${voice.capacityCallsEstimate} calls`);
  }

  setText(techInfoEl, parts.join(' • '));
}

function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}`;
}

function startRingtone() {
  try {
    ringtoneCtx = new (window.AudioContext || window.webkitAudioContext)();
    ringtoneOsc = ringtoneCtx.createOscillator();
    ringtoneGain = ringtoneCtx.createGain();
    ringtoneOsc.type = 'sine';
    ringtoneOsc.frequency.value = 880;
    ringtoneGain.gain.value = 0.0;
    ringtoneOsc.connect(ringtoneGain);
    ringtoneGain.connect(ringtoneCtx.destination);
    ringtoneOsc.start();

    let on = false;
    const tick = () => {
      if (!ringtoneGain) return;
      on = !on;
      ringtoneGain.gain.setTargetAtTime(on ? 0.08 : 0.0, ringtoneCtx.currentTime, 0.01);
    };
    // Classic ring cadence
    const i1 = setInterval(tick, 350);
    ringtoneCtx._interval = i1;
  } catch {
    // ignore
  }
}

function stopRingtone() {
  try {
    if (ringtoneCtx?._interval) clearInterval(ringtoneCtx._interval);
    ringtoneOsc?.stop();
    ringtoneOsc?.disconnect();
    ringtoneGain?.disconnect();
    ringtoneCtx?.close();
  } catch {
    // ignore
  } finally {
    ringtoneCtx = null;
    ringtoneOsc = null;
    ringtoneGain = null;
  }
}

async function ensureMic() {
  // Mic requires secure context (https or localhost)
  if (!localStream) {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  }
  return localStream;
}

function micErrorMessage(err) {
  const name = err?.name;
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
    return 'Microphone blocked. Allow microphone access in your browser and try again.';
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return 'No microphone found.';
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return 'Microphone is in use by another app.';
  }
  if (name === 'SecurityError') {
    return 'Microphone requires HTTPS (or localhost).';
  }
  return 'Microphone access failed.';
}

function handleMicError(err) {
  logDebug('mic error', { name: err?.name, message: err?.message });
  // Prefer surfacing on the lobby status line; it’s visible in most states.
  setText(lobbyStatus, micErrorMessage(err));
}

function renderUsers(users) {
  usersEl.innerHTML = '';

  const others = users.filter((u) => u.id !== myId);
  if (others.length === 0) {
    const li = document.createElement('li');
    li.textContent = 'No one else is online.';
    usersEl.appendChild(li);
    return;
  }

  for (const u of others) {
    const li = document.createElement('li');

    const left = document.createElement('div');
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = u.name;

    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = u.busy ? 'busy' : 'available';

    left.appendChild(name);
    left.appendChild(meta);

    const actions = document.createElement('div');
    actions.className = 'actions';

    const messageBtn = document.createElement('button');
    messageBtn.className = 'secondary';
    messageBtn.classList.add('icon-only');
    messageBtn.setAttribute('aria-label', `Message ${u.name}`);
    messageBtn.innerHTML = '<svg class="icon" aria-hidden="true" focusable="false"><use xlink:href="./icons.svg#message"></use></svg>';
    messageBtn.addEventListener('click', () => {
      const needsQuotes = /\s/.test(u.name);
      const prefix = needsQuotes ? `@"${u.name}" ` : `@${u.name} `;
      if (chatInput) {
        chatInput.value = prefix;
        chatInput.focus();
        chatInput.setSelectionRange(chatInput.value.length, chatInput.value.length);
      }

      closeUsersIfMobile();
    });

    const callBtn = document.createElement('button');
    callBtn.classList.add('icon-only');
    callBtn.setAttribute('aria-label', roomId ? `Add ${u.name} to call` : `Call ${u.name}`);
    callBtn.innerHTML = '<svg class="icon" aria-hidden="true" focusable="false"><use xlink:href="./icons.svg#call"></use></svg>';
    // Disable if the other user is already in a call, or already connected in our room.
    callBtn.disabled = Boolean(u.busy) || (roomId && peerNames.has(u.id));
    callBtn.addEventListener('click', () => {
      closeUsersIfMobile();
      startCall(u.id, u.name);
    });

    actions.appendChild(messageBtn);
    actions.appendChild(callBtn);

    li.appendChild(left);
    li.appendChild(actions);
    usersEl.appendChild(li);
  }
}

function send(msg) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(msg));
}

function parseCandidateType(candidateStr) {
  // candidate:... typ host|srflx|relay ...
  if (typeof candidateStr !== 'string') return 'unknown';
  const m = candidateStr.match(/\btyp\s+(host|srflx|relay|prflx)\b/i);
  return (m?.[1] ?? 'unknown').toLowerCase();
}

function peerListText() {
  const names = Array.from(peerNames.entries())
    .filter(([id]) => id !== myId)
    .map(([, name]) => name)
    .filter(Boolean);
  if (names.length === 0) return '';
  return names.join(', ');
}

function ensureRemoteAudioEl(peerId) {
  if (!remoteAudiosEl) return null;
  const existing = remoteAudiosEl.querySelector(`audio[data-peer-id="${peerId}"]`);
  if (existing) return existing;

  const a = document.createElement('audio');
  a.autoplay = true;
  a.dataset.peerId = peerId;
  remoteAudiosEl.appendChild(a);
  return a;
}

function removeRemoteAudioEl(peerId) {
  if (!remoteAudiosEl) return;
  const a = remoteAudiosEl.querySelector(`audio[data-peer-id="${peerId}"]`);
  if (a) a.remove();
}

function updateCallHeader() {
  const peersText = peerListText();
  setText(peerEl, peersText);
  if (roomId && peerNames.size > 0) {
    callIdleEl?.classList.add('hidden');
    callActiveEl?.classList.remove('hidden');
  } else {
    callActiveEl?.classList.add('hidden');
    callIdleEl?.classList.remove('hidden');
  }
}

function closePeerConnection(peerId) {
  const pc = pcs.get(peerId);
  if (!pc) return;
  try { pc.close(); } catch { /* ignore */ }
  pcs.delete(peerId);
  peerNames.delete(peerId);
  removeRemoteAudioEl(peerId);
}

function resetRoomState() {
  roomId = null;
  pendingIncomingFrom = null;
  pendingIncomingRoomId = null;
  for (const peerId of Array.from(pcs.keys())) closePeerConnection(peerId);
  peerNames.clear();
  setText(callStatus, '');
  updateCallHeader();
  stopRingtone();
  showIncoming(false);
}

function resetCallState() {
  resetRoomState();
}

function clearChat() {
  chatMessages = [];
  if (chatMessagesEl) chatMessagesEl.innerHTML = '';
}

function getChatKind({ fromName, private: isPrivate }) {
  if (fromName === 'System') return 'system';
  if (isPrivate) return 'private';
  return 'public';
}

function formatChatTime(atIso) {
  const at = new Date(atIso);
  return isNaN(at.getTime()) ? String(atIso) : at.toLocaleString('en-US');
}

function parseReplyPrefix(text) {
  if (typeof text !== 'string') return null;
  if (!text.startsWith('@reply [')) return null;
  const close = text.indexOf(']');
  if (close === -1) return null;

  const after = text.slice(close + 1);
  if (!after.startsWith(' \n') && !after.startsWith('\n') && !after.startsWith(' \r\n') && !after.startsWith('\r\n')) return null;

  const inside = text.slice(7, close); // after "@reply ["
  const sep = inside.lastIndexOf(' • ');
  if (sep === -1) return null;
  const replyToName = inside.slice(0, sep).trim();
  const replyToTime = inside.slice(sep + 3).trim();

  // Skip optional leading space before newline.
  const bodyStart = text.startsWith('@reply [') && text[close + 1] === ' ' ? close + 3 : close + 2;
  const replyBody = text.slice(bodyStart).replace(/^\r?\n/, '');

  if (!replyToName || !replyToTime) return null;
  return { replyToName, replyToTime, replyBody };
}

function ensureReplyContextMenu() {
  if (replyContextMenuEl) return replyContextMenuEl;
  const el = document.createElement('div');
  el.className = 'context-menu hidden';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'secondary';
  btn.textContent = 'Reply';
  btn.addEventListener('click', () => {
    if (replyContextTarget) triggerReply(replyContextTarget);
    hideReplyContextMenu();
  });

  el.appendChild(btn);
  document.body.appendChild(el);
  replyContextMenuEl = el;

  document.addEventListener('click', () => hideReplyContextMenu());
  window.addEventListener('scroll', () => hideReplyContextMenu(), { passive: true });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideReplyContextMenu();
  });

  return el;
}

function hideReplyContextMenu() {
  if (!replyContextMenuEl) return;
  replyContextMenuEl.classList.add('hidden');
  replyContextTarget = null;
}

function showReplyContextMenu(x, y, target) {
  const el = ensureReplyContextMenu();
  replyContextTarget = target;
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  el.classList.remove('hidden');
}

function triggerReply(target) {
  if (!chatInput) return;
  const stamp = target.atIso ?? target.time;
  const prefix = `@reply [${target.fromName} • ${stamp}] \n`;
  chatInput.value = prefix;
  chatInput.focus();
  chatInput.setSelectionRange(chatInput.value.length, chatInput.value.length);
  autoGrowChatInput();
}

function flashChatLine(el) {
  el.classList.remove('chat-flash');
  // Force reflow so animation retriggers.
  void el.offsetWidth;
  el.classList.add('chat-flash');
  setTimeout(() => el.classList.remove('chat-flash'), 900);
}

function scrollToReferencedMessage(replyToName, replyToTime) {
  if (!chatMessagesEl) return;
  const kids = Array.from(chatMessagesEl.children);
  const replyLooksIso = typeof replyToTime === 'string' && /\d{4}-\d{2}-\d{2}T/.test(replyToTime);
  const exact = kids.find((el) => {
    if (el?.dataset?.fromName !== replyToName) return false;
    if (replyLooksIso) return el?.dataset?.atIso === replyToTime;
    return el?.dataset?.time === replyToTime;
  });

  // Tolerant ISO matching (handles minor formatting differences like missing milliseconds).
  let match = exact;
  if (!match && replyLooksIso) {
    const targetMs = Date.parse(replyToTime);
    if (!Number.isNaN(targetMs)) {
      match = kids.find((el) => {
        if (el?.dataset?.fromName !== replyToName) return false;
        const ms = Date.parse(el?.dataset?.atIso ?? '');
        if (Number.isNaN(ms)) return false;
        return Math.abs(ms - targetMs) <= 1000;
      });
    }
  }

  if (!match) return;

  // If filters are hiding the target, auto-enable the relevant filter so scrolling is visible.
  if (match.classList.contains('chat-hidden')) {
    const kind = match.dataset.kind;
    if (kind === 'private' && filterPrivateEl) filterPrivateEl.checked = true;
    if (kind === 'public' && filterPublicEl) filterPublicEl.checked = true;
    if (kind === 'system' && filterSystemEl) filterSystemEl.checked = true;
    applyChatFilter();
  }

  match.scrollIntoView({ behavior: 'smooth', block: 'center' });
  flashChatLine(match);
}

function replyIconSvg() {
  // Placeholder: user will provide the final SVG.
  return '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><path fill="currentColor" d="M10 9V5l-7 7 7 7v-4.1c7.1 0 10.9 2.2 14 7.1-1-8.1-5.1-13.9-14-13.9z"/></svg>';
}

function attachSwipeReply(lineEl, target) {
  const inner = lineEl.querySelector('.chat-line-inner');
  const action = lineEl.querySelector('.chat-reply-action');
  if (!inner || !action) return;

  let startX = 0;
  let startY = 0;
  let active = false;
  let moved = false;
  let lastDx = 0;

  const reset = () => {
    active = false;
    moved = false;
    lastDx = 0;
    inner.style.transition = 'transform 160ms ease-in-out';
    inner.style.transform = 'translateX(0px)';
    action.style.opacity = '0';
    setTimeout(() => {
      inner.style.transition = '';
    }, 180);
  };

  lineEl.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return;
    startX = e.clientX;
    startY = e.clientY;
    active = true;
    moved = false;
    lastDx = 0;
    inner.style.transition = 'none';
    try { lineEl.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  });

  lineEl.addEventListener('pointermove', (e) => {
    if (!active || e.pointerType !== 'touch') return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;

    if (!moved) {
      if (Math.abs(dx) < 8) return;
      if (Math.abs(dy) > Math.abs(dx)) {
        active = false;
        return;
      }
      moved = true;
    }

    // Only allow left swipe.
    const width = lineEl.getBoundingClientRect().width || 1;
    const maxReveal = Math.min(88, width * 0.45);
    const clamped = Math.max(-maxReveal, Math.min(0, dx));
    lastDx = clamped;
    inner.style.transform = `translateX(${clamped}px)`;
    action.style.opacity = String(Math.min(1, Math.abs(clamped) / maxReveal));
    e.preventDefault();
  }, { passive: false });

  lineEl.addEventListener('pointerup', (e) => {
    if (!active || e.pointerType !== 'touch') return;
    const width = lineEl.getBoundingClientRect().width || 1;
    const shouldTrigger = Math.abs(lastDx) > width * 0.2;
    reset();
    if (shouldTrigger) triggerReply(target);
  });

  lineEl.addEventListener('pointercancel', () => reset());
}

function applyChatFilter() {
  if (!chatMessagesEl) return;
  const showPrivate = filterPrivateEl?.checked ?? true;
  const showPublic = filterPublicEl?.checked ?? true;
  const showSystem = filterSystemEl?.checked ?? true;

  for (const el of Array.from(chatMessagesEl.children)) {
    const kind = el.dataset.kind;
    const visible = (kind === 'private' && showPrivate)
      || (kind === 'public' && showPublic)
      || (kind === 'system' && showSystem);
    el.classList.toggle('chat-hidden', !visible);
  }
}

function renderChatMessage({ atIso, fromName, text, private: isPrivate, toName }) {
  if (!chatMessagesEl) return;

  const time = formatChatTime(atIso);
  const reply = parseReplyPrefix(text);
  const isReply = Boolean(reply);

  const line = document.createElement('div');
  line.className = 'chat-line';
  line.dataset.kind = getChatKind({ fromName, private: isPrivate });

  line.dataset.fromName = fromName;
  line.dataset.time = time;
  line.dataset.atIso = atIso;
  if (isReply) {
    line.classList.add('chat-reply');
    line.dataset.replyToName = reply.replyToName;
    line.dataset.replyToTime = reply.replyToTime;
  }

  const swipe = document.createElement('div');
  swipe.className = 'chat-swipe';

  const action = document.createElement('div');
  action.className = 'chat-reply-action';
  action.innerHTML = replyIconSvg();

  const inner = document.createElement('div');
  inner.className = 'chat-line-inner';

  const meta = document.createElement('div');
  meta.className = 'chat-meta';
  if (isPrivate) {
    const badge = document.createElement('span');
    badge.className = 'chat-badge chat-badge-private';
    badge.textContent = 'private';

    const textNode = document.createElement('span');
    textNode.textContent = ` ${fromName}${toName ? ` → ${toName}` : ''} • ${time}`;

    meta.appendChild(badge);
    meta.appendChild(textNode);
  } else {
    meta.textContent = `${fromName} • ${time}`;
  }

  const body = document.createElement('div');
  body.className = 'chat-text';

  if (isReply) {
    const banner = document.createElement('div');
    banner.className = 'chat-reply-banner';
    const replyTimeLabel = /\d{4}-\d{2}-\d{2}T/.test(reply.replyToTime)
      ? formatChatTime(reply.replyToTime)
      : reply.replyToTime;
    banner.textContent = `Reply to ${reply.replyToName} • ${replyTimeLabel}`;
    banner.style.cursor = 'pointer';
    banner.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      scrollToReferencedMessage(reply.replyToName, reply.replyToTime);
    });
    body.textContent = reply.replyBody;
    inner.appendChild(meta);
    inner.appendChild(banner);
    inner.appendChild(body);
  } else {
    body.textContent = text;
    inner.appendChild(meta);
    inner.appendChild(body);
  }

  swipe.appendChild(action);
  swipe.appendChild(inner);
  line.appendChild(swipe);

  // Desktop: right-click context menu to reply.
  line.addEventListener('contextmenu', (e) => {
    if (isMobileTextEntry()) return;
    if (fromName === 'System') return;
    e.preventDefault();
    showReplyContextMenu(e.pageX, e.pageY, { fromName, time, atIso });
  });

  // Mobile: swipe left to reply.
  if (fromName !== 'System') {
    attachSwipeReply(line, { fromName, time, atIso });
  }

  chatMessagesEl.appendChild(line);
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;

  applyChatFilter();
}

function sendChat() {
  const text = (chatInput?.value ?? '').trim();
  if (!text) return;
  send({ type: 'chatSend', text });
  if (chatInput) {
    chatInput.value = '';
    autoGrowChatInput();
  }
}

function autoGrowChatInput() {
  if (!chatInput) return;
  // Only makes sense for textarea.
  if (chatInput.tagName !== 'TEXTAREA') return;

  // If empty, collapse to a single-row height.
  if (!chatInput.value) {
    chatInput.style.height = 'auto';
    chatInput.style.overflowY = 'hidden';
    return;
  }

  // Reset to measure.
  chatInput.style.height = 'auto';

  const cs = window.getComputedStyle(chatInput);
  const lineHeight = Number.parseFloat(cs.lineHeight) || 20;
  const paddingTop = Number.parseFloat(cs.paddingTop) || 0;
  const paddingBottom = Number.parseFloat(cs.paddingBottom) || 0;
  const borderTop = Number.parseFloat(cs.borderTopWidth) || 0;
  const borderBottom = Number.parseFloat(cs.borderBottomWidth) || 0;
  const maxHeight = (lineHeight * 8) + paddingTop + paddingBottom + borderTop + borderBottom;

  const target = Math.min(chatInput.scrollHeight, maxHeight);
  chatInput.style.height = `${target}px`;
  chatInput.style.overflowY = chatInput.scrollHeight > maxHeight ? 'auto' : 'hidden';
}

async function ensurePeerConnection(peerId) {
  if (pcs.has(peerId)) return pcs.get(peerId);

  const pc = new RTCPeerConnection(iceConfig ?? undefined);
  pcs.set(peerId, pc);

  logDebug('RTCPeerConnection created', {
    peerId,
    iceServers: (iceConfig?.iceServers ?? []).map((s) => ({ urls: s.urls })),
  });

  pc.onicegatheringstatechange = () => {
    logDebug('iceGatheringState', peerId, pc.iceGatheringState);
  };

  pc.oniceconnectionstatechange = () => {
    logDebug('iceConnectionState', peerId, pc.iceConnectionState);
  };

  pc.onconnectionstatechange = () => {
    logDebug('connectionState', peerId, pc.connectionState);
  };

  pc.onsignalingstatechange = () => {
    logDebug('signalingState', peerId, pc.signalingState);
  };

  pc.onicecandidateerror = (ev) => {
    logDebug('iceCandidateError', peerId, {
      errorCode: ev.errorCode,
      errorText: ev.errorText,
      url: ev.url,
      address: ev.address,
      port: ev.port,
    });
  };

  pc.onicecandidate = (ev) => {
    if (ev.candidate) {
      logDebug('local ICE candidate', peerId, parseCandidateType(ev.candidate.candidate));
      send({ type: 'signal', to: peerId, payload: { kind: 'ice', candidate: ev.candidate } });
    }
  };

  pc.ontrack = (ev) => {
    const a = ensureRemoteAudioEl(peerId);
    if (a) a.srcObject = ev.streams[0];
  };

  try {
    const stream = await ensureMic();
    for (const track of stream.getTracks()) {
      pc.addTrack(track, stream);
    }
  } catch (err) {
    // If mic is blocked/denied, don’t leave a half-initialized peer connection around.
    try { pc.close(); } catch { /* ignore */ }
    pcs.delete(peerId);
    throw err;
  }

  pc.addEventListener('connectionstatechange', () => {
    if (!pcs.has(peerId)) return;
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      closePeerConnection(peerId);
      updateCallHeader();
    }
  });

  return pc;
}

async function startCall(peerId, peerName) {
  try {
    // Request mic on a direct user gesture (Call/Add click) to avoid browser denial.
    await ensureMic();
  } catch (err) {
    handleMicError(err);
    return;
  }

  setText(lobbyStatus, roomId ? 'Inviting…' : 'Calling…');
  peerNames.set(peerId, peerName);
  updateCallHeader();
  send({ type: 'callStart', to: peerId });
}

async function onIncomingCall(from, fromName) {
  pendingIncomingFrom = from;
  pendingIncomingRoomId = null;
  setText(callerNameEl, fromName);
  showIncoming(true);
  startRingtone();

  notify('Incoming call', `From ${fromName}`, { tag: 'lrcom-call' });
  vibrate([200, 100, 200, 100, 400]);
}

async function onIncomingCallRoom(from, fromName, incomingRoomId) {
  pendingIncomingFrom = from;
  pendingIncomingRoomId = incomingRoomId;
  setText(callerNameEl, fromName);
  showIncoming(true);
  startRingtone();

  notify('Incoming call', `From ${fromName}`, { tag: 'lrcom-call' });
  vibrate([200, 100, 200, 100, 400]);
}

async function acceptIncoming() {
  if (!pendingIncomingFrom) return;

  try {
    // Request mic on a direct user gesture (Accept click).
    await ensureMic();
  } catch (err) {
    handleMicError(err);
    return;
  }

  stopRingtone();
  showIncoming(false);
  setText(callStatus, 'Connecting…');
  updateCallHeader();
  send({ type: 'callAccept', from: pendingIncomingFrom, roomId: pendingIncomingRoomId });
}

function rejectIncoming() {
  stopRingtone();
  showIncoming(false);
  if (pendingIncomingFrom) send({ type: 'callReject', from: pendingIncomingFrom, roomId: pendingIncomingRoomId });
  pendingIncomingFrom = null;
  pendingIncomingRoomId = null;
}

function hangup() {
  send({ type: 'callHangup' });
  resetCallState();
}

function leave() {
  try { ws?.close(); } catch { /* ignore */ }
  ws = null;

  setUsersOpen(false);

  resetCallState();
  clearChat();
  myId = null;
  myName = null;
  iceConfig = null;

  // Stop mic usage
  try { localStream?.getTracks()?.forEach((t) => t.stop()); } catch { /* ignore */ }
  localStream = null;

  setText(meEl, '');
  setText(setupStatus, '');
  setText(lobbyStatus, '');
  setText(callStatus, '');
  setText(techInfoEl, '');
  setView('setup');
}

async function doJoin() {
  setText(setupStatus, 'Connecting…');

  const desiredName = nameInput.value.trim();
  if (!desiredName) {
    setText(setupStatus, 'Enter a name.');
    return;
  }

  ws = new WebSocket(wsUrl());

  logDebug('ws connecting', wsUrl());

  ws.addEventListener('open', () => {
    logDebug('ws open');
    send({ type: 'setName', name: desiredName });

    // If user already granted notifications, attempt SW + push wiring for this socket.
    if (notificationsGranted()) {
      void ensureServiceWorker().then(() => tryEnableWebPushForThisSocket());
    }
  });

  ws.addEventListener('message', async (ev) => {
    const msg = JSON.parse(ev.data);

    if (msg.type === 'hello') {
      myId = msg.id;
      iceConfig = msg.turn;

      renderTechInfo(msg.voice);

      if (msg.turnWarning) {
        logDebug('TURN warning', msg.turnWarning);
        // Also surface as status text for non-debug users
        setText(setupStatus, msg.turnWarning);
      }

      logDebug('hello', { id: myId, clientIp: msg.clientIp, https: msg.https });
      return;
    }

    if (msg.type === 'nameResult') {
      if (!msg.ok) {
        setText(setupStatus, msg.reason === 'taken' ? 'Name is taken.' : 'Invalid name.');
        try { ws.close(); } catch {}
        ws = null;
        return;
      }

      myName = msg.name;
      setText(meEl, myName);
      setText(setupStatus, '');
      setView('lobby');

      // Show ephemeral disclaimer as the first System message for this session.
      clearChat();
      const first = {
        atIso: new Date().toISOString(),
        fromName: 'System',
        text: 'Messages are not saved; they exist only while you\u2019re connected.',
        private: false,
        toName: null,
      };
      chatMessages.push(first);
      renderChatMessage(first);

      updateResponsiveChrome();

      updateNotificationsButton();
      void enableWakeLock();
      return;
    }

    if (msg.type === 'presence') {
      renderUsers(msg.users ?? []);
      renderTechInfo(msg.voice);
      return;
    }

    if (msg.type === 'chat') {
      const entry = {
        atIso: msg.atIso,
        fromName: msg.fromName,
        text: msg.text,
        private: Boolean(msg.private),
        toName: msg.toName ?? null,
      };
      chatMessages.push(entry);
      renderChatMessage(entry);

      // Notify on messages from others when we're not in the foreground.
      if (msg.fromName && msg.fromName !== myName) {
        const prefix = msg.private ? 'Private message' : 'Message';
        notify(prefix, `${msg.fromName}: ${msg.text}`, { tag: msg.private ? 'lrcom-pm' : 'lrcom-chat' });
      }
      return;
    }

    if (msg.type === 'incomingCall') {
      logDebug('incomingCall', { from: msg.from, fromName: msg.fromName, roomId: msg.roomId });
      if (msg.roomId) {
        await onIncomingCallRoom(msg.from, msg.fromName, msg.roomId);
      } else {
        await onIncomingCall(msg.from, msg.fromName);
      }
      return;
    }

    if (msg.type === 'callStartResult') {
      if (!msg.ok) {
        setText(lobbyStatus, `Call failed: ${msg.reason}`);
      } else {
        setText(lobbyStatus, 'Ringing…');
      }
      return;
    }

    if (msg.type === 'callRejected') {
      setText(lobbyStatus, 'Call rejected.');
      // If we were not in a room yet, reset call state.
      if (!roomId) resetCallState();
      return;
    }

    if (msg.type === 'callEnded') {
      setText(lobbyStatus, 'Call ended.');
      resetCallState();
      return;
    }

    if (msg.type === 'roomPeers') {
      // You joined a room; peers list are existing members.
      roomId = msg.roomId ?? roomId;
      try {
        for (const p of (msg.peers ?? [])) {
          if (!p?.id || p.id === myId) continue;
          peerNames.set(p.id, p.name ?? '');
          await ensurePeerConnection(p.id);
        }
      } catch (err) {
        handleMicError(err);
        // Bail out of the call cleanly if we can’t access the mic.
        hangup();
        return;
      }
      setText(lobbyStatus, '');
      setText(callStatus, 'Connecting…');
      updateCallHeader();
      return;
    }

    if (msg.type === 'roomPeerJoined') {
      roomId = msg.roomId ?? roomId;
      const p = msg.peer;
      if (!p?.id || p.id === myId) return;
      peerNames.set(p.id, p.name ?? '');
      updateCallHeader();

      // Existing members create offers to the new peer.
      let pc;
      try {
        pc = await ensurePeerConnection(p.id);
      } catch (err) {
        handleMicError(err);
        hangup();
        return;
      }
      setText(callStatus, 'Connecting…');
      const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: false });
      await pc.setLocalDescription(offer);
      send({ type: 'signal', to: p.id, payload: { kind: 'offer', sdp: offer } });
      return;
    }

    if (msg.type === 'roomPeerLeft') {
      const peerId = msg.peerId;
      if (peerId) closePeerConnection(peerId);
      updateCallHeader();

      // If we are now alone, end call.
      if (peerNames.size === 0) {
        resetCallState();
      }
      return;
    }

    if (msg.type === 'signal') {
      const payload = msg.payload;
      if (!payload || !payload.kind) return;

      logDebug('signal', { kind: payload.kind, from: msg.from, fromName: msg.fromName });

      const fromId = msg.from;
      if (fromId && msg.fromName) peerNames.set(fromId, msg.fromName);

      if (payload.kind === 'offer') {
        const peerId = msg.from;
        if (!peerId) return;
        let pc;
        try {
          pc = await ensurePeerConnection(peerId);
        } catch (err) {
          handleMicError(err);
          hangup();
          return;
        }

        await pc.setRemoteDescription(payload.sdp);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        send({ type: 'signal', to: peerId, payload: { kind: 'answer', sdp: answer } });
        return;
      }

      if (payload.kind === 'answer') {
        const peerId = msg.from;
        if (!peerId) return;
        const pc = pcs.get(peerId);
        if (!pc) return;
        await pc.setRemoteDescription(payload.sdp);
        setText(callStatus, 'Connected');
        return;
      }

      if (payload.kind === 'ice') {
        const peerId = msg.from;
        if (!peerId) return;
        const pc = pcs.get(peerId);
        if (!pc) return;
        logDebug('remote ICE candidate', peerId, parseCandidateType(payload.candidate?.candidate));
        try {
          await pc.addIceCandidate(payload.candidate);
        } catch {
          // ignore
        }
      }
    }
  });

  ws.addEventListener('close', () => {
    logDebug('ws close');
    leave();
  });

  ws.addEventListener('error', () => {
    logDebug('ws error');
    setText(setupStatus, 'Connection error.');
  });
}

joinBtn.addEventListener('click', (e) => {
  e.preventDefault();
  doJoin();
});

setupForm?.addEventListener('submit', (e) => {
  e.preventDefault();
  doJoin();
});

nameInput?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    doJoin();
  }
});

toggleUsersBtn?.addEventListener('click', () => {
  setUsersOpen(!appShellEl.classList.contains('users-open'));
});

document.addEventListener('click', (e) => {
  if (!isMobileLayout()) return;
  if (!appShellEl.classList.contains('users-open')) return;

  const t = e.target;
  if (!(t instanceof Node)) return;
  if (sidebarEl?.contains(t)) return;
  if (toggleUsersBtn?.contains(t)) return;

  setUsersOpen(false);
});

leaveBtn.addEventListener('click', () => {
  if (confirm('Logout and leave LRcom?')) leave();
});
hangupBtn.addEventListener('click', hangup);

acceptBtn.addEventListener('click', acceptIncoming);
rejectBtn.addEventListener('click', rejectIncoming);

// Best-effort cleanup: server also removes presence on WS close.
window.addEventListener('beforeunload', () => {
  try { ws?.close(); } catch {}
});

chatSendBtn?.addEventListener('click', sendChat);
chatInput?.addEventListener('input', autoGrowChatInput);
chatInput?.addEventListener('focus', autoGrowChatInput);

chatInput?.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;

  // Mobile: Enter inserts newline; send is only via the Send button.
  if (isMobileTextEntry()) {
    return;
  }

  // Desktop: Enter sends, Shift+Enter inserts newline.
  if (!e.shiftKey) {
    e.preventDefault();
    sendChat();
  }
});

filterPrivateEl?.addEventListener('change', applyChatFilter);
filterPublicEl?.addEventListener('change', applyChatFilter);
filterSystemEl?.addEventListener('change', applyChatFilter);

setView('setup');

updateResponsiveChrome();
window.addEventListener('resize', updateResponsiveChrome);

applyTheme('system');

autoGrowChatInput();

themeToggleSetupBtn?.addEventListener('click', cycleTheme);
themeToggleHeaderBtn?.addEventListener('click', cycleTheme);

enableNotificationsBtn?.addEventListener('click', () => {
  void enableNotifications();
});

updateNotificationsButton();

if (debugEnabled && debugPanel) {
  debugPanel.classList.remove('hidden');
  logDebug('debug enabled');
}
