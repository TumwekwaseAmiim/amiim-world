// ====== Broadcaster-side script.js (FIXED + RECORDING) ======
const socket = io();
let peers = {};                  // viewerId -> SimplePeer
let localStream = null;
let currentRoomId = '';
let streamMode = 'slides';
let isMicMuted = false;
let activeSpeaker = null;

/**
 * 🌍 ICE servers for global reliability (replace with your TURN creds in production)
 * For quick tests you can keep only the Google STUN line below.
 */
const ICE_SERVERS = [
  // Your STUN/TURN (replace placeholders when ready)
  { urls: ['stun:turn.your-domain.com:3478', 'stun:turn.your-domain.com:5349'] },
  {
    urls: [
      'turns:turn.your-domain.com:443?transport=tcp',
      'turns:turn.your-domain.com:5349?transport=tcp'
    ],
    username: 'YOUR_TURN_USER',
    credential: 'YOUR_TURN_PASS'
  },
  {
    urls: [
      'turn:turn.your-domain.com:3478?transport=udp',
      'turn:turn.your-domain.com:3478?transport=tcp'
    ],
    username: 'YOUR_TURN_USER',
    credential: 'YOUR_TURN_PASS'
  },
  // (Optional fallback) Often blocked in some regions but fine for testing
  { urls: 'stun:stun.l.google.com:19302' }
];

// DOM references
const mainVideo = document.getElementById('mainVideo');
const selfPreview = document.getElementById('selfPreview');
const chatBox = document.getElementById('chat-box');
const chatInput = document.getElementById('chat-input');
const viewerCountDisplay = document.getElementById('viewerCount');
const streamModeLabel = document.getElementById('streamMode');
const backBtn = document.getElementById('backBtn');
const viewerList = document.getElementById('viewerList');

// Ensure a grid container exists for remote viewer tiles (audio ON there)
let viewerTiles = document.getElementById('viewerTiles');
if (!viewerTiles) {
  viewerTiles = document.createElement('section');
  viewerTiles.id = 'viewerTiles';
  viewerTiles.style.display = 'grid';
  viewerTiles.style.gridTemplateColumns = 'repeat(auto-fit, minmax(220px, 1fr))';
  viewerTiles.style.gap = '12px';
  viewerTiles.style.marginBlock = '12px';
  document.body.appendChild(viewerTiles);
}

// ---- helpers ----
function getRoomId() {
  return document.getElementById('roomId')?.value.trim();
}
function getBroadcasterName() {
  return document.getElementById('broadcasterName')?.value.trim() || 'Amiim';
}
function appendMessage(msg) {
  if (!chatBox) return;
  chatBox.value += msg + '\n';
  chatBox.scrollTop = chatBox.scrollHeight;
}

// ---------- viewer tiles ----------
function makeViewerTile(viewerId, remoteStream) {
  const existing = document.getElementById(`viewer-card-${viewerId}`);
  if (existing) existing.remove();

  const card = document.createElement('div');
  card.id = `viewer-card-${viewerId}`;
  card.style.border = '1px solid #2b2b2b';
  card.style.borderRadius = '10px';
  card.style.padding = '8px';
  card.style.background = '#0e0e0e';

  const vid = document.createElement('video');
  vid.id = `viewer-video-${viewerId}`;
  vid.autoplay = true;
  vid.playsInline = true;
  vid.muted = false;     // hear the viewer
  vid.controls = true;   // you can locally mute them if needed
  vid.srcObject = remoteStream;

  const label = document.createElement('div');
  label.id = `viewer-label-${viewerId}`;
  label.textContent = `🎙️ Viewer: ${viewerId}`;
  label.style.fontSize = '12px';
  label.style.marginTop = '6px';
  label.style.color = '#00ffcc';

  card.appendChild(vid);
  card.appendChild(label);
  viewerTiles.appendChild(card);

  vid.play?.().catch(() => {});
}
function removeViewerTile(viewerId) {
  const el = document.getElementById(`viewer-card-${viewerId}`);
  if (el) el.remove();
}

// ---------- Start broadcast ----------
async function startBroadcast() {
  const roomId = getRoomId();
  const adminPassword = prompt('Enter Admin Password');
  if (adminPassword !== 'amiim2025') return alert('Access Denied');
  if (!roomId) return alert('Please enter Room ID');

  // HTTPS requirement reminder
  if (location.protocol !== 'https:' && location.hostname !== 'localhost') {
    appendMessage('⚠️ Tip: Use HTTPS for mic/camera permissions on the web.');
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
    handleNewStream(stream);
    currentRoomId = roomId;
    socket.emit('broadcaster', { roomId, broadcasterName: getBroadcasterName() });
  } catch (err) {
    alert('Media access denied: ' + err.message);
  }
}

// ---------- Share screen ----------
async function shareScreen() {
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    streamMode = 'slides';
    streamModeLabel.innerText = '📺 Mode: Slides';
    handleNewStream(stream);
    socket.emit('stream-mode', { roomId: currentRoomId, mode: streamMode });
    backBtn.style.display = 'none';
  } catch (err) {
    alert('Screen share error: ' + err.message);
  }
}

// ---------- Show event/camera (back camera on phones) ----------
async function shareEvent() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment' },
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
    streamMode = 'event';
    streamModeLabel.innerText = '📺 Mode: Event';
    handleNewStream(stream);
    socket.emit('stream-mode', { roomId: currentRoomId, mode: streamMode });
    backBtn.style.display = 'inline-block';
  } catch (err) {
    alert('Camera switch error: ' + err.message);
  }
}
function backToSlides() { shareScreen(); }

/** 🔄 One-tap front/back camera toggle (mobile friendly) */
async function switchCamera() {
  try {
    const current = localStream?.getVideoTracks()[0];
    const isBack = current?.getSettings()?.facingMode === 'environment';
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: isBack ? 'user' : 'environment' },
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
    handleNewStream(stream);
  } catch (e) {
    console.warn('switchCamera error', e);
    alert('Could not switch camera: ' + e.message);
  }
}

// ---------- Replace tracks on all peers ----------
function handleNewStream(newStream) {
  if (!newStream) return;

  // local previews (muted in HTML)
  mainVideo.srcObject = newStream;
  selfPreview.srcObject = newStream;
  mainVideo.play?.().catch(() => {});
  selfPreview.play?.().catch(() => {});
  localStream = newStream;

  // Replace tracks for connected peers
  const newVideoTrack = newStream.getVideoTracks()[0] || null;
  const newAudioTrack = newStream.getAudioTracks()[0] || null;

  for (const viewerId in peers) {
    const peer = peers[viewerId];
    const senders = peer?._pc?.getSenders?.() || [];

    if (newVideoTrack) {
      const videoSender = senders.find(s => s.track?.kind === 'video');
      if (videoSender) videoSender.replaceTrack(newVideoTrack);
    }
    if (newAudioTrack) {
      const audioSender = senders.find(s => s.track?.kind === 'audio');
      if (audioSender) audioSender.replaceTrack(newAudioTrack);
    }
  }
}

// ---------- A viewer (watcher) appears ----------
socket.on('watcher', ({ viewerId, viewerName }) => {
  // If an old peer existed, drop it
  if (peers[viewerId]) {
    try { peers[viewerId].destroy(); } catch {}
    delete peers[viewerId];
    document.getElementById(viewerId)?.remove();
    removeViewerTile(viewerId);
  }
  if (!localStream) return; // not broadcasting yet

  const peer = new SimplePeer({
    initiator: true,           // broadcaster creates the offer
    trickle: true,             // send ICE incrementally (more reliable/faster)
    stream: localStream,
    config: { iceServers: ICE_SERVERS }
  });

  // Send our offer/ICE to this viewer
  peer.on('signal', signal => {
    socket.emit('signal', { roomId: currentRoomId, viewerId, signal });
  });

  // Viewer’s mic/video arrives here → attach UNMUTED tile
  peer.on('stream', (remoteStream) => {
    makeViewerTile(viewerId, remoteStream);
    const label = document.getElementById(`viewer-label-${viewerId}`);
    if (label && viewerName) label.textContent = `🎙️ ${viewerName}`;
  });

  peer.on('connect', () => console.log(`✅ Connected to ${viewerName || viewerId}`));
  peer.on('error', err => console.warn('❌ Peer error:', err));

  peer.on('close', () => {
    try { peer.destroy(); } catch {}
    delete peers[viewerId];
    removeViewerTile(viewerId);
    document.getElementById(viewerId)?.remove();
  });

  // Small control row in your existing list
  peers[viewerId] = peer;
  const li = document.createElement('li');
  li.id = viewerId;
  li.innerHTML = `
    ${viewerName || viewerId}
    <span id="mic-${viewerId}"></span>
    <button onclick="grantMic('${viewerId}')">🎤 Allow Mic</button>
    <button onclick="kickViewer('${viewerId}')">❌ Kick</button>`;
  viewerList.appendChild(li);
});

// ---------- Incoming signals from server (answer/ICE from viewer) ----------
socket.on('signal', ({ viewerId, signal }) => {
  if (peers[viewerId]) {
    try { peers[viewerId].signal(signal); } catch (e) { console.warn('signal error', e); }
  }
});

// ---------- Viewer disconnect / kick cleanup ----------
socket.on('disconnectPeer', viewerId => {
  if (peers[viewerId]) {
    try { peers[viewerId].destroy(); } catch {}
    delete peers[viewerId];
  }
  removeViewerTile(viewerId);
  document.getElementById(viewerId)?.remove();
});

// ---------- Live counters / chat / emoji / raise-hand ----------
socket.on('viewer-count', count => {
  if (viewerCountDisplay) viewerCountDisplay.innerText = `👥 Viewers: ${count}`;
});
socket.on('emoji', ({ sender, emoji }) => appendMessage(`🎉 ${sender}: ${emoji}`));
socket.on('raise-hand', ({ sender }) => appendMessage(`✋ ${sender} raised hand`));
socket.on('chat', ({ sender, msg }) => appendMessage(`💬 ${sender}: ${msg}`));

// ---------- Broadcaster mic toggle ----------
function toggleMic() {
  if (!localStream) return;
  const audioTrack = localStream.getAudioTracks()[0];
  if (!audioTrack) return;
  isMicMuted = !isMicMuted;
  audioTrack.enabled = !isMicMuted;
  appendMessage(isMicMuted ? '🔇 Mic muted' : '🎤 Mic unmuted');
}

// ---------- Chat senders ----------
function sendMessage() {
  const msg = chatInput.value.trim();
  if (!msg) return;
  socket.emit('chat', { roomId: currentRoomId, msg, sender: getBroadcasterName() });
  appendMessage(`🟢 ${getBroadcasterName()}: ${msg}`); // server doesn't echo to sender
  chatInput.value = '';
}
function sendEmoji(emoji) {
  socket.emit('emoji', { roomId: currentRoomId, emoji, sender: getBroadcasterName() });
  appendMessage(`🟢 ${getBroadcasterName()}: ${emoji}`); // server doesn't echo to sender
}

// ---------- Viewer admin controls ----------
function grantMic(viewerId) {
  socket.emit('grant-mic', viewerId);
  highlightSpeaker(viewerId);
}
function kickViewer(viewerId) {
  socket.emit('kick-viewer', viewerId);
}
function highlightSpeaker(viewerId) {
  if (activeSpeaker && document.getElementById(`mic-${activeSpeaker}`)) {
    document.getElementById(`mic-${activeSpeaker}`).innerText = '';
  }
  activeSpeaker = viewerId;
  const micSpan = document.getElementById(`mic-${viewerId}`);
  if (micSpan) micSpan.innerText = '🔊';
}

// ====== RECORDING MODULE ======
let mediaRecorder = null;
let recChunks = [];
let recTimerId = null;
let recStartTs = 0;
let recBytes = 0;
let recStream = null;

// UI
const elRecSource   = document.getElementById('recordSource');
const elRecBitrate  = document.getElementById('recordBitrate');
const elRecMix      = document.getElementById('recordAudioMix');
const elRecAutoSave = document.getElementById('recordAutoSave');
const btnRecStart   = document.getElementById('btnRecStart');
const btnRecPause   = document.getElementById('btnRecPause');
const btnRecResume  = document.getElementById('btnRecResume');
const btnRecStop    = document.getElementById('btnRecStop');
const elRecStatus   = document.getElementById('recStatus');
const elRecTimer    = document.getElementById('recTimer');
const elRecSize     = document.getElementById('recSize');
const elRecDl       = document.getElementById('recDownload');
const elRecVuBar    = document.getElementById('recVuBar');

function hhmmss(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return (h ? String(h).padStart(2,'0') + ':' : '') + String(m).padStart(2,'0') + ':' + String(ss).padStart(2,'0');
}

function setRecUI({ status, running }) {
  if (status) elRecStatus.textContent = `Status: ${status}`;
  btnRecStart.disabled  = running;
  btnRecPause.disabled  = !running;
  btnRecResume.disabled = true;
  btnRecStop.disabled   = !running;
}

function updateSize(bytes) {
  elRecSize.textContent = (bytes / (1024*1024)).toFixed(1) + ' MB';
}

function startTimer() {
  recStartTs = Date.now();
  recTimerId = setInterval(() => {
    const elapsed = (Date.now() - recStartTs) / 1000;
    elRecTimer.textContent = hhmmss(elapsed);
  }, 250);
}

function stopTimer() {
  clearInterval(recTimerId);
  recTimerId = null;
}

let recAudioCtx, recAnalyser, recData, recRAF;
function attachRecVU(stream) {
  try {
    cancelAnimationFrame(recRAF);
    if (recAudioCtx) {
      try { recAudioCtx.close(); } catch {}
    }
    if (!stream.getAudioTracks().length) {
      elRecVuBar.style.width = '0%';
      return;
    }
    recAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const src = recAudioCtx.createMediaStreamSource(stream);
    recAnalyser = recAudioCtx.createAnalyser();
    recAnalyser.fftSize = 256;
    src.connect(recAnalyser);
    recData = new Uint8Array(recAnalyser.frequencyBinCount);

    function tick() {
      recAnalyser.getByteTimeDomainData(recData);
      let peak = 0;
      for (let i = 0; i < recData.length; i++) {
        peak = Math.max(peak, Math.abs(recData[i] - 128));
      }
      const pct = Math.min(100, Math.floor((peak / 64) * 100));
      elRecVuBar.style.width = pct + '%';
      recRAF = requestAnimationFrame(tick);
    }
    tick();
  } catch (e) {
    console.warn('rec VU init failed', e);
  }
}

async function getCameraStreamForRec() {
  return await navigator.mediaDevices.getUserMedia({
    video: { width: {ideal: 1280}, height: {ideal: 720}, frameRate: {ideal: 30} },
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
  });
}

async function getScreenStreamForRec(withSystemAudio = true, mixMicIfNoAudio = true) {
  const screen = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: 30 },
    audio: withSystemAudio
  });

  const hasAudio = screen.getAudioTracks().some(t => t.readyState === 'live');
  if (!hasAudio && mixMicIfNoAudio) {
    // Mix mic into screen
    const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const destination = ctx.createMediaStreamDestination();
    ctx.createMediaStreamSource(mic).connect(destination);

    const merged = new MediaStream([
      ...screen.getVideoTracks(),
      ...destination.stream.getAudioTracks()
    ]);

    // propagate end
    screen.getVideoTracks().forEach(t => t.onended = () => merged.getTracks().forEach(x => x.stop()));
    return merged;
  }
  return screen;
}

async function pickRecordingStream() {
  const src = elRecSource?.value || 'main';
  if (src === 'main') {
    if (!localStream) throw new Error('No active main stream to record. Start broadcast first.');
    return localStream;
  }
  if (src === 'camera') {
    return await getCameraStreamForRec();
  }
  if (src === 'screen') {
    const mix = !!elRecMix?.checked;
    return await getScreenStreamForRec(true, mix);
  }
  // fallback
  if (!localStream) throw new Error('No stream available for recording.');
  return localStream;
}

function pickMimeType() {
  // Try VP9, then VP8, then generic webm
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm'
  ];
  for (const t of candidates) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return ''; // let browser decide
}

function wireTrackGuardsForRec(stream) {
  for (const t of stream.getTracks()) {
    t.onended    = () => elRecStatus.textContent = `Status: track ended (${t.kind})`;
    t.oninactive = () => elRecStatus.textContent = `Status: track inactive (${t.kind})`;
    t.onmute     = () => elRecStatus.textContent = `Status: ${t.kind} muted`;
    t.onunmute   = () => elRecStatus.textContent = `Status: ${t.kind} unmuted`;
  }
}

// --- Recording control handlers ---
async function recStart() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') return;

  try {
    recStream = await pickRecordingStream();
  } catch (e) {
    alert(e.message);
    return;
  }

  attachRecVU(recStream);
  wireTrackGuardsForRec(recStream);

  const kbps = parseInt(elRecBitrate?.value || '1200000', 10);
  const bitsPerSec = isNaN(kbps) ? 1200000 : kbps;

  const mimeType = pickMimeType();
  try {
    mediaRecorder = new MediaRecorder(recStream, {
      mimeType: mimeType || undefined,
      videoBitsPerSecond: bitsPerSec
    });
  } catch (e) {
    alert('MediaRecorder init failed: ' + e.message);
    return;
  }

  recChunks = [];
  recBytes = 0;

  mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size) {
      recChunks.push(e.data);
      recBytes += e.data.size;
      updateSize(recBytes);
    }
  };

  mediaRecorder.onstart = () => {
    setRecUI({ status: 'recording', running: true });
    startTimer();
    elRecDl.style.display = 'none';
  };
  mediaRecorder.onpause = () => {
    elRecStatus.textContent = 'Status: paused';
  };
  mediaRecorder.onresume = () => {
    elRecStatus.textContent = 'Status: recording';
  };
  mediaRecorder.onstop = () => {
    stopTimer();
    setRecUI({ status: 'stopped', running: false });
    const blob = new Blob(recChunks, { type: mimeType || 'video/webm' });
    const url = URL.createObjectURL(blob);
    elRecDl.href = url;
    elRecDl.download = `amiim-recording-${Date.now()}.webm`;
    elRecDl.style.display = 'inline-block';

    if (elRecAutoSave?.checked) {
      // auto click to download
      elRecDl.click();
    }

    // cleanup extra tracks if source was camera/screen (not main)
    const src = elRecSource?.value || 'main';
    if (src !== 'main') {
      try { recStream.getTracks().forEach(t => t.stop()); } catch {}
    }
    recStream = null;
  };

  try {
    mediaRecorder.start(1000); // collect chunks every second
  } catch (e) {
    alert('Recorder start failed: ' + e.message);
    return;
  }

  btnRecPause.disabled = false;
  btnRecStop.disabled = false;
}

function recPause() {
  if (!mediaRecorder) return;
  if (mediaRecorder.state === 'recording') {
    mediaRecorder.pause();
    btnRecPause.disabled = true;
    btnRecResume.disabled = false;
  }
}

function recResume() {
  if (!mediaRecorder) return;
  if (mediaRecorder.state === 'paused') {
    mediaRecorder.resume();
    btnRecPause.disabled = false;
    btnRecResume.disabled = true;
  }
}

function recStop() {
  if (!mediaRecorder) return;
  if (mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
  btnRecPause.disabled = true;
  btnRecResume.disabled = true;
  btnRecStop.disabled = true;
  btnRecStart.disabled = false;

  try { cancelAnimationFrame(recRAF); } catch {}
  if (recAudioCtx) { try { recAudioCtx.close(); } catch {} }
  elRecVuBar.style.width = '0%';
}

// Wire recording buttons (if present in DOM)
if (btnRecStart)  btnRecStart.addEventListener('click', recStart);
if (btnRecPause)  btnRecPause.addEventListener('click', recPause);
if (btnRecResume) btnRecResume.addEventListener('click', recResume);
if (btnRecStop)   btnRecStop.addEventListener('click', recStop);

// Expose functions used by buttons in index.html
window.startBroadcast = startBroadcast;
window.shareScreen = shareScreen;
window.shareEvent = shareEvent;
window.backToSlides = backToSlides;
window.switchCamera = switchCamera;   // optional button if you add it in HTML
window.toggleMic = toggleMic;
window.sendMessage = sendMessage;
window.sendEmoji = sendEmoji;
window.grantMic = grantMic;
window.kickViewer = kickViewer;
