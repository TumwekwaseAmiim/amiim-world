// 📹 viewer.js (FORCE TURN + AUTOPLAY + DIAGNOSTICS + QUICK REJOIN)
const socket = io();

let peer = null;
let localStream = null;
let roomId = '';
let viewerName = '';
let isMicMuted = false;

// ===== Console ring buffer (for feedback) =====
const CONSOLE_BUF = [];
const MAX_LOGS = 200;
['log', 'warn', 'error'].forEach((level) => {
  const orig = console[level];
  console[level] = (...args) => {
    try {
      const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${args.map(a => {
        try { return typeof a === 'string' ? a : JSON.stringify(a); } catch { return String(a); }
      }).join(' ')}`;
      CONSOLE_BUF.push(line);
      if (CONSOLE_BUF.length > MAX_LOGS) CONSOLE_BUF.shift();
    } catch {}
    orig.apply(console, args);
  };
});

// 🌍 ICE servers (hard-coded Metered.ca)
const ICE_SERVERS = [
  { urls: 'stun:stun.relay.metered.ca:80' },
  { urls: 'turn:global.relay.metered.ca:80',                 username: 'c10fef4f728d103ac4fb86a5', credential: 'nYWUZ4YNEIggzGKM' },
  { urls: 'turn:global.relay.metered.ca:80?transport=tcp',   username: 'c10fef4f728d103ac4fb86a5', credential: 'nYWUZ4YNEIggzGKM' },
  { urls: 'turn:global.relay.metered.ca:443',                username: 'c10fef4f728d103ac4fb86a5', credential: 'nYWUZ4YNEIggzGKM' },
  { urls: 'turns:global.relay.metered.ca:443?transport=tcp', username: 'c10fef4f728d103ac4fb86a5', credential: 'nYWUZ4YNEIggzGKM' },
];
const ICE_POLICY = 'relay'; // 🔒 force TURN for reliability
const iceReady = Promise.resolve(); // keep any await paths happy

// ===== DOM =====
const mainVideo = document.getElementById('mainVideo');   // broadcaster stream (will start muted)
const selfVideo = document.getElementById('selfVideo');   // local preview (muted)
const chatBox = document.getElementById('chat-box');
const chatInput = document.getElementById('chat-input');
const viewerCountDisplay = document.getElementById('viewerCount');
const streamModeLabel = document.getElementById('streamMode');
const micToggleBtn = document.getElementById('micToggleBtn');
const unmuteBtn = document.getElementById('unmuteBtn');
const banner = document.getElementById('banner');
const micGranted = document.getElementById('micGranted');
const selfVuBar = document.getElementById('selfVuBar');
const iceStateEl = document.getElementById('iceState');
const connStateEl = document.getElementById('connState');

// ===== Helpers =====
function appendMessage(msg) {
  chatBox.value += msg + '\n';
  chatBox.scrollTop = chatBox.scrollHeight;
}
function showBanner(text, ttlMs = 4000) {
  if (!banner) return;
  banner.textContent = text;
  banner.style.display = 'block';
  clearTimeout(banner._t);
  banner._t = setTimeout(() => (banner.style.display = 'none'), ttlMs);
}
function setDiag(ice, conn) {
  if (iceStateEl) iceStateEl.textContent = `ICE: ${ice ?? '-'}`;
  if (connStateEl) connStateEl.textContent = `Peer: ${conn ?? '-'}`;
}

// ===== Autoplay-safe audio: start muted, let user unmute =====
function ensureMainPlayback() {
  if (!mainVideo) return;
  mainVideo.muted = true; // start muted to satisfy autoplay
  mainVideo.play?.().catch(() => {}); // try autoplay
  if (unmuteBtn) unmuteBtn.style.display = 'inline-block';
}
function unmuteMain() {
  if (!mainVideo) return;
  mainVideo.muted = false;
  mainVideo.play?.().catch(() => {});
  if (unmuteBtn) unmuteBtn.style.display = 'none';
}
window.unmuteMain = unmuteMain;

// ===== VU meter for self mic =====
let vuCtx, vuAnalyser, vuData, vuRAF;
function attachSelfVU(stream) {
  try { cancelAnimationFrame(vuRAF); } catch {}
  try { vuCtx?.close?.(); } catch {}
  if (!stream.getAudioTracks().length) {
    if (selfVuBar) selfVuBar.style.width = '0%';
    return;
  }
  vuCtx = new (window.AudioContext || window.webkitAudioContext)();
  const src = vuCtx.createMediaStreamSource(stream);
  vuAnalyser = vuCtx.createAnalyser();
  vuAnalyser.fftSize = 256;
  src.connect(vuAnalyser);
  vuData = new Uint8Array(vuAnalyser.frequencyBinCount);

  function tick() {
    vuAnalyser.getByteTimeDomainData(vuData);
    let peak = 0;
    for (let i = 0; i < vuData.length; i++) peak = Math.max(peak, Math.abs(vuData[i] - 128));
    const pct = Math.min(100, Math.floor((peak / 64) * 100));
    if (selfVuBar) selfVuBar.style.width = pct + '%';
    vuRAF = requestAnimationFrame(tick);
  }
  tick();
}

/* ===== QUICK REJOIN support ===== */
let rejoinTries = 0;
let rejoinTimer = null;

function clearRejoin() {
  rejoinTries = 0;
  clearTimeout(rejoinTimer);
  rejoinTimer = null;
}

function fullRejoin(reason = 'rejoin') {
  console.warn('Rejoining due to:', reason);
  try { peer?.destroy(); } catch {}
  peer = null;
  setDiag('-', 'rejoining');
  // create a fresh RTCPeerConnection and announce presence so broadcaster offers again
  ensurePeer();
  if (roomId) socket.emit('watcher', { roomId, viewerName });
}

function scheduleRejoin(reason) {
  clearTimeout(rejoinTimer);
  rejoinTries = Math.min(rejoinTries + 1, 6);
  const delay = Math.min(5000, 800 * rejoinTries); // backoff up to 5s
  rejoinTimer = setTimeout(() => fullRejoin(reason), delay);
}

// ===== Peer lifecycle =====
function ensurePeer() {
  if (peer) return peer;

  peer = new SimplePeer({
    initiator: false,          // viewer = not initiator
    trickle: true,
    stream: localStream,
    config: {
      iceServers: ICE_SERVERS,
      iceTransportPolicy: ICE_POLICY, // 🚦 force TURN
    }
  });

  // send our answer/ICE to server
  peer.on('signal', (outSignal) => {
    if (!roomId) return;
    socket.emit('signal', { roomId, signal: outSignal });
  });

  // receive broadcaster media
  peer.on('stream', (remoteStream) => {
    mainVideo.srcObject = remoteStream;
    ensureMainPlayback?.();
  });

  peer.on('connect', () => {
    console.log('✅ Viewer connected to broadcaster');
    setDiag(undefined, 'connected');
    clearRejoin();
  });

  peer.on('error', (err) => {
    console.warn('❌ Viewer peer error:', err);
    showBanner('Network issue with the live stream. Reconnecting…');
    scheduleRejoin('peer-error');
  });

  peer.on('close', () => {
    setDiag(undefined, 'closed');
    peer = null;
    mainVideo.srcObject = null;
    showBanner('Connection dropped. Reconnecting…');
    scheduleRejoin('peer-close');
  });

  // Diagnostics + ICE restart try, then full rejoin
  setTimeout(() => {
    const pc = peer?._pc;
    if (!pc) return;
    setDiag(pc.iceConnectionState, pc.connectionState);
    pc.oniceconnectionstatechange = () => {
      setDiag(pc.iceConnectionState, pc.connectionState);
      const st = pc.iceConnectionState;
      if (st === 'failed' || st === 'disconnected') {
        try { pc.restartIce && pc.restartIce(); } catch {}
        scheduleRejoin('ice-state-' + st);
      }
    };
    pc.onconnectionstatechange = () => {
      setDiag(pc.iceConnectionState, pc.connectionState);
      const st = pc.connectionState;
      if (st === 'failed' || st === 'disconnected') {
        try { pc.restartIce && pc.restartIce(); } catch {}
        scheduleRejoin('conn-state-' + st);
      }
    };
  }, 0);

  return peer;
}

// ===== Join Broadcast =====
async function joinBroadcast() {
  await iceReady;

  roomId = document.getElementById('roomId')?.value.trim();
  viewerName = document.getElementById('viewerName')?.value.trim() || 'Anonymous';
  if (!roomId) return alert('Please enter Room ID');

  try {
    // mobile-friendly capture (keeps uplink light)
    localStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: 'user',
        width:  { ideal: 640, max: 960 },
        height: { ideal: 360, max: 540 },
        frameRate: { ideal: 20, max: 24 }
      },
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });

    selfVideo.srcObject = localStream;
    selfVideo.play?.().catch(() => {});

    // Start with mic ON (host can mute you / you can toggle)
    const a = localStream.getAudioTracks()[0];
    if (a) a.enabled = true;
    isMicMuted = false;
    if (micToggleBtn) micToggleBtn.innerText = '🎧 Mute';

    attachSelfVU(localStream);

    // Prepare peer first, then announce to get an offer
    ensurePeer();
    socket.emit('watcher', { roomId, viewerName });
    showBanner('Joining room…');

  } catch (err) {
    alert('Error accessing camera/mic: ' + err.message);
  }
}

// ===== Signaling from broadcaster → feed into peer =====
socket.on('signal', ({ viewerId, signal }) => {
  const p = ensurePeer();
  try {
    p.signal(signal);
  } catch (e) {
    console.warn('signal apply error:', e);
    scheduleRejoin('signal-error');
  }
});

// ===== Stream mode & counts =====
socket.on('stream-mode', (mode) => {
  streamModeLabel.innerText = mode === 'event' ? '📺 Mode: Event' : '📺 Mode: Slides';
});
socket.on('viewer-count', (count) => {
  viewerCountDisplay.innerText = `👥 Viewers: ${count}`;
});

// ===== Chat & Emoji =====
socket.on('chat', ({ sender, msg }) => appendMessage(`💬 ${sender}: ${msg}`));
function sendMessage() {
  const msg = chatInput.value.trim();
  if (!msg) return;
  socket.emit('chat', { roomId, msg, sender: viewerName });
  appendMessage(`🟢 ${viewerName}: ${msg}`);
  chatInput.value = '';
}
socket.on('emoji', ({ sender, emoji }) => appendMessage(`🎉 ${sender}: ${emoji}`));
function sendEmoji(emoji) {
  socket.emit('emoji', { roomId, emoji, sender: viewerName });
  appendMessage(`🟢 ${viewerName}: ${emoji}`);
}

// ===== Raise hand =====
function raiseHand() {
  socket.emit('raise-hand', { roomId, sender: viewerName });
  appendMessage('✋ You raised your hand');
}
socket.on('raise-hand', ({ sender }) => appendMessage(`✋ ${sender} raised hand`));

// ===== Mic permission from broadcaster =====
socket.on('grant-mic', () => {
  if (localStream) {
    const t = localStream.getAudioTracks()[0];
    if (t) t.enabled = true;
  }
  isMicMuted = false;
  if (micToggleBtn) micToggleBtn.innerText = '🎧 Mute';
  if (micGranted) { micGranted.style.display = 'block'; setTimeout(() => micGranted.style.display = 'none', 3000); }
  appendMessage('🎤 You were granted mic permission');
});

// ===== Toggle mic =====
function toggleMic() {
  if (!localStream) return;
  const t = localStream.getAudioTracks()[0];
  if (!t) return;
  isMicMuted = !isMicMuted;
  t.enabled = !isMicMuted;
  if (micToggleBtn) micToggleBtn.innerText = isMicMuted ? '🔇 Mic Off' : '🎧 Mute';
  appendMessage(isMicMuted ? '🔇 You muted your mic' : '🎤 You unmuted your mic');
}

// ===== Kicked / disconnect handling =====
socket.on('kick-viewer', () => {
  alert('You have been removed by the broadcaster.');
  try { if (peer) peer.destroy(); } catch {}
  peer = null;
  mainVideo.srcObject = null;
  window.location.reload();
});
socket.on('disconnectPeer', () => {
  try { if (peer) peer.destroy(); } catch {}
  peer = null;
  mainVideo.srcObject = null;
  appendMessage('❌ Broadcaster disconnected.');
  scheduleRejoin('broadcaster-disconnect');
});

// ===== Feedback sender =====
function sendFeedback() {
  const text = prompt('Describe the issue or feedback:');
  if (text == null) return;
  const env = {
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    lang: navigator.language,
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
  const lastConsole = CONSOLE_BUF.slice(-100);
  socket.emit('clientFeedback', { text, env, lastConsole });
  showBanner('Thanks! Feedback sent.');
}

// ===== Expose for HTML =====
window.joinBroadcast = joinBroadcast;
window.sendMessage = sendMessage;
window.sendEmoji = sendEmoji;
window.raiseHand = raiseHand;
window.toggleMic = toggleMic;
window.sendFeedback = sendFeedback;
window.unmuteMain = unmuteMain;

// Try to keep the main player ready for autoplay policies
ensureMainPlayback();
