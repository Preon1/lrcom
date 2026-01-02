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

const acceptBtn = qs('accept');
const rejectBtn = qs('reject');
const callerNameEl = qs('callerName');

const remoteAudio = qs('remoteAudio');

const chatMessagesEl = qs('chatMessages');
const chatInput = qs('chatInput');
const chatSendBtn = qs('chatSend');
const filterPrivateEl = qs('filterPrivate');
const filterPublicEl = qs('filterPublic');
const filterSystemEl = qs('filterSystem');

const themeToggleSetupBtn = qs('themeToggleSetup');
const themeToggleHeaderBtn = qs('themeToggleHeader');

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
let currentPeer = null;
let pendingIncomingFrom = null;

let pc;
let localStream;
let iceConfig;

let chatMessages = [];

let ringtoneCtx;
let ringtoneOsc;
let ringtoneGain;

function isMobileLayout() {
  return window.matchMedia && window.matchMedia('(max-width: 640px)').matches;
}

function setUsersOpen(open) {
  if (!appShellEl) return;
  appShellEl.classList.toggle('users-open', Boolean(open));
}

function closeUsersIfMobile() {
  if (isMobileLayout()) setUsersOpen(false);
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
    messageBtn.textContent = 'Message';
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
    callBtn.textContent = 'Call';
    callBtn.disabled = Boolean(u.busy) || Boolean(currentPeer);
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

function resetCallState() {
  currentPeer = null;
  pendingIncomingFrom = null;
  setText(peerEl, '');
  setText(callStatus, '');
  remoteAudio.srcObject = null;

  callActiveEl?.classList.add('hidden');
  callIdleEl?.classList.remove('hidden');

  try {
    pc?.close();
  } catch {
    // ignore
  }
  pc = null;

  stopRingtone();
  showIncoming(false);
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

  const line = document.createElement('div');
  line.className = 'chat-line';
  line.dataset.kind = getChatKind({ fromName, private: isPrivate });

  const meta = document.createElement('div');
  meta.className = 'chat-meta';
  const at = new Date(atIso);

  const time = isNaN(at.getTime()) ? atIso : at.toLocaleString();
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
  body.textContent = text;

  line.appendChild(meta);
  line.appendChild(body);
  chatMessagesEl.appendChild(line);
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;

  applyChatFilter();
}

function sendChat() {
  const text = (chatInput?.value ?? '').trim();
  if (!text) return;
  send({ type: 'chatSend', text });
  if (chatInput) chatInput.value = '';
}

async function createPeerConnection() {
  pc = new RTCPeerConnection(iceConfig ?? undefined);

  logDebug('RTCPeerConnection created', {
    iceServers: (iceConfig?.iceServers ?? []).map((s) => ({ urls: s.urls })),
  });

  pc.onicegatheringstatechange = () => {
    logDebug('iceGatheringState', pc.iceGatheringState);
  };

  pc.oniceconnectionstatechange = () => {
    logDebug('iceConnectionState', pc.iceConnectionState);
  };

  pc.onconnectionstatechange = () => {
    logDebug('connectionState', pc.connectionState);
  };

  pc.onsignalingstatechange = () => {
    logDebug('signalingState', pc.signalingState);
  };

  pc.onicecandidateerror = (ev) => {
    logDebug('iceCandidateError', {
      errorCode: ev.errorCode,
      errorText: ev.errorText,
      url: ev.url,
      address: ev.address,
      port: ev.port,
    });
  };

  pc.onicecandidate = (ev) => {
    if (ev.candidate && currentPeer) {
      logDebug('local ICE candidate', parseCandidateType(ev.candidate.candidate));
      send({ type: 'signal', to: currentPeer, payload: { kind: 'ice', candidate: ev.candidate } });
    }
  };

  pc.ontrack = (ev) => {
    remoteAudio.srcObject = ev.streams[0];
  };

  const stream = await ensureMic();
  for (const track of stream.getTracks()) {
    pc.addTrack(track, stream);
  }

  // Periodically dump selected ICE candidate pair once connected
  const interval = setInterval(async () => {
    if (!pc) return;
    if (!['connected', 'completed'].includes(pc.iceConnectionState)) return;

    try {
      const stats = await pc.getStats();
      let selectedPair;
      let local;
      let remote;

      stats.forEach((r) => {
        if (r.type === 'transport' && r.selectedCandidatePairId) {
          selectedPair = stats.get(r.selectedCandidatePairId);
        }
      });

      if (selectedPair) {
        local = stats.get(selectedPair.localCandidateId);
        remote = stats.get(selectedPair.remoteCandidateId);
        logDebug('selectedCandidatePair', {
          localType: local?.candidateType,
          localIp: local?.ip,
          localPort: local?.port,
          remoteType: remote?.candidateType,
          remoteIp: remote?.ip,
          remotePort: remote?.port,
          nominated: selectedPair?.nominated,
          state: selectedPair?.state,
        });
      }
    } catch {
      // ignore
    }
  }, 5000);

  pc.addEventListener('connectionstatechange', () => {
    if (!pc || pc.connectionState === 'closed' || pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
      clearInterval(interval);
    }
  });
}

async function startCall(peerId, peerName) {
  setText(lobbyStatus, 'Calling…');
  send({ type: 'callStart', to: peerId });
  // Wait for callAccepted before creating offer
}

async function onCallAccepted(byId, byName) {
  currentPeer = byId;
  setText(peerEl, byName);
  setText(callStatus, 'Connecting…');
  setText(lobbyStatus, '');

  callIdleEl?.classList.add('hidden');
  callActiveEl?.classList.remove('hidden');

  await createPeerConnection();

  const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: false });
  await pc.setLocalDescription(offer);

  send({ type: 'signal', to: currentPeer, payload: { kind: 'offer', sdp: offer } });
}

async function onIncomingCall(from, fromName) {
  pendingIncomingFrom = from;
  setText(callerNameEl, fromName);
  showIncoming(true);
  startRingtone();
}

async function acceptIncoming() {
  stopRingtone();
  showIncoming(false);

  if (!pendingIncomingFrom) return;
  currentPeer = pendingIncomingFrom;

  setText(peerEl, callerNameEl.textContent);
  setText(callStatus, 'Connecting…');

  callIdleEl?.classList.add('hidden');
  callActiveEl?.classList.remove('hidden');

  send({ type: 'callAccept', from: pendingIncomingFrom });
}

function rejectIncoming() {
  stopRingtone();
  showIncoming(false);
  if (pendingIncomingFrom) send({ type: 'callReject', from: pendingIncomingFrom });
  pendingIncomingFrom = null;
  currentPeer = null;
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
  setView('setup');
}

joinBtn.addEventListener('click', async () => {
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
  });

  ws.addEventListener('message', async (ev) => {
    const msg = JSON.parse(ev.data);

    if (msg.type === 'hello') {
      myId = msg.id;
      iceConfig = msg.turn;

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

      // Request mic access only after joining
      try {
        await ensureMic();
      } catch {
        setText(lobbyStatus, 'Microphone permission is required.');
      }
      return;
    }

    if (msg.type === 'presence') {
      renderUsers(msg.users ?? []);
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
      return;
    }

    if (msg.type === 'incomingCall') {
      logDebug('incomingCall', { from: msg.from, fromName: msg.fromName });
      await onIncomingCall(msg.from, msg.fromName);
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

    if (msg.type === 'callAccepted') {
      logDebug('callAccepted', { by: msg.by, byName: msg.byName });
      await onCallAccepted(msg.by, msg.byName);
      return;
    }

    if (msg.type === 'callRejected') {
      setText(lobbyStatus, 'Call rejected.');
      resetCallState();
      return;
    }

    if (msg.type === 'callEnded') {
      setText(lobbyStatus, 'Call ended.');
      resetCallState();
      return;
    }

    if (msg.type === 'signal') {
      const payload = msg.payload;
      if (!payload || !payload.kind) return;

      logDebug('signal', { kind: payload.kind, from: msg.from, fromName: msg.fromName });

      if (payload.kind === 'offer') {
        if (!currentPeer) currentPeer = msg.from;
        if (!pc) await createPeerConnection();

        await pc.setRemoteDescription(payload.sdp);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        send({ type: 'signal', to: currentPeer, payload: { kind: 'answer', sdp: answer } });
        return;
      }

      if (payload.kind === 'answer') {
        if (!pc) return;
        await pc.setRemoteDescription(payload.sdp);
        setText(callStatus, 'Connected');
        return;
      }

      if (payload.kind === 'ice') {
        if (!pc) return;
        logDebug('remote ICE candidate', parseCandidateType(payload.candidate?.candidate));
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

leaveBtn.addEventListener('click', leave);
hangupBtn.addEventListener('click', hangup);

acceptBtn.addEventListener('click', acceptIncoming);
rejectBtn.addEventListener('click', rejectIncoming);

// Best-effort cleanup: server also removes presence on WS close.
window.addEventListener('beforeunload', () => {
  try { ws?.close(); } catch {}
});

chatSendBtn?.addEventListener('click', sendChat);
chatInput?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendChat();
});

filterPrivateEl?.addEventListener('change', applyChatFilter);
filterPublicEl?.addEventListener('change', applyChatFilter);
filterSystemEl?.addEventListener('change', applyChatFilter);

setView('setup');

applyTheme('system');

themeToggleSetupBtn?.addEventListener('click', cycleTheme);
themeToggleHeaderBtn?.addEventListener('click', cycleTheme);

if (debugEnabled && debugPanel) {
  debugPanel.classList.remove('hidden');
  logDebug('debug enabled');
}
