// ====== Broadcaster-side script.js (FIXED) ======
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
    document.getElementById(viewerId)?.remove();   // ✅ fixed typo here
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
