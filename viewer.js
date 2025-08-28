// 📹 viewer.js (UPDATED WORLD-READY)
const socket = io();

let peer = null;
let localStream = null;
let roomId = '';
let viewerName = '';
let isMicMuted = false;

// 🌍 ICE servers for global reliability (incl. China/UAE/corporate firewalls)
// Replace turn.your-domain.com / YOUR_TURN_USER / YOUR_TURN_PASS with your real TURN service.
const ICE_SERVERS = [
  // Your own STUN (same host as TURN is fine)
  { urls: ['stun:turn.your-domain.com:3478', 'stun:turn.your-domain.com:5349'] },

  // TURN over TLS on 443 (best chance through strict firewalls)
  {
    urls: [
      'turns:turn.your-domain.com:443?transport=tcp',
      'turns:turn.your-domain.com:5349?transport=tcp'
    ],
    username: 'YOUR_TURN_USER',
    credential: 'YOUR_TURN_PASS'
  },

  // Optional: classic TURN on 3478 for networks that allow UDP
  {
    urls: [
      'turn:turn.your-domain.com:3478?transport=udp',
      'turn:turn.your-domain.com:3478?transport=tcp'
    ],
    username: 'YOUR_TURN_USER',
    credential: 'YOUR_TURN_PASS'
  },

  // (Optional fallback) Google STUN — often blocked in some countries
  { urls: 'stun:stun.l.google.com:19302' }
];

// DOM Elements
const mainVideo = document.getElementById('mainVideo');  // broadcaster stream (UNMUTED)
const selfVideo = document.getElementById('selfVideo');  // local preview (MUTED)
const chatBox = document.getElementById('chat-box');
const chatInput = document.getElementById('chat-input');
const viewerCountDisplay = document.getElementById('viewerCount');
const streamModeLabel = document.getElementById('streamMode');
const micToggleBtn = document.getElementById('micToggleBtn');

// Helpers
function appendMessage(msg) {
  chatBox.value += msg + '\n';
  chatBox.scrollTop = chatBox.scrollHeight;
}

function ensurePeer() {
  if (peer) return peer;

  // Build the SimplePeer once, when we first receive a signal from the broadcaster
  peer = new SimplePeer({
    initiator: false,          // broadcaster is offering in this flow
    trickle: true,             // allow incremental ICE
    stream: localStream,       // send our mic/cam to broadcaster
    config: { iceServers: ICE_SERVERS }
  });

  // Forward our answer/ICE to the broadcaster (server infers viewerId from socket.id)
  peer.on('signal', (outSignal) => {
    if (!roomId) return;
    socket.emit('signal', { roomId, signal: outSignal });
  });

  // Broadcaster stream arrives here
  peer.on('stream', (remoteStream) => {
    mainVideo.srcObject = remoteStream;
    // Ensure audio actually starts; may need a user gesture on some browsers
    mainVideo.play().catch(() => {});
  });

  peer.on('connect', () => {
    console.log('✅ Viewer connected to broadcaster');
  });

  peer.on('error', (err) => {
    console.warn('❌ Viewer peer error:', err);
  });

  peer.on('close', () => {
    peer = null;
    mainVideo.srcObject = null;
  });

  return peer;
}

// Join Broadcast
async function joinBroadcast() {
  roomId = document.getElementById('roomId')?.value.trim();
  viewerName = document.getElementById('viewerName')?.value.trim() || 'Anonymous';
  if (!roomId) return alert('Please enter Room ID');

  try {
    // Capture local media (muted locally to satisfy autoplay)
    localStream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });
    selfVideo.srcObject = localStream;
    selfVideo.play().catch(() => {});

    // Start with mic ON for broadcaster to hear you (you can toggle)
    const audioTrack = localStream.getAudioTracks()[0];
    if (audioTrack) audioTrack.enabled = true;
    isMicMuted = false;
    micToggleBtn.innerText = '🎧 Mute';

    // Tell server we joined as a viewer
    socket.emit('watcher', { roomId, viewerName });
  } catch (err) {
    alert('Error accessing camera/mic: ' + err.message);
  }
}

// Incoming WebRTC signal from broadcaster → feed into our peer
socket.on('signal', ({ viewerId, signal }) => {
  // viewerId is informative; server already routes correctly
  const p = ensurePeer();
  try {
    p.signal(signal);
  } catch (e) {
    console.warn('signal apply error:', e);
  }
});

// Stream mode label updates
socket.on('stream-mode', (mode) => {
  streamModeLabel.innerText = mode === 'event' ? '📺 Mode: Event' : '📺 Mode: Slides';
});

// Viewer count
socket.on('viewer-count', (count) => {
  viewerCountDisplay.innerText = `👥 Viewers: ${count}`;
});

// Chat
socket.on('chat', ({ sender, msg }) => {
  appendMessage(`💬 ${sender}: ${msg}`);
});
function sendMessage() {
  const msg = chatInput.value.trim();
  if (!msg) return;
  socket.emit('chat', { roomId, msg, sender: viewerName });
  appendMessage(`🟢 ${viewerName}: ${msg}`); // server doesn't echo back to sender
  chatInput.value = '';
}

// Emojis
socket.on('emoji', ({ sender, emoji }) => {
  appendMessage(`🎉 ${sender}: ${emoji}`);
});
function sendEmoji(emoji) {
  socket.emit('emoji', { roomId, emoji, sender: viewerName });
  appendMessage(`🟢 ${viewerName}: ${emoji}`); // server doesn't echo back to sender
}

// Raise hand
function raiseHand() {
  socket.emit('raise-hand', { roomId, sender: viewerName });
  appendMessage('✋ You raised your hand');
}
socket.on('raise-hand', ({ sender }) => {
  appendMessage(`✋ ${sender} raised hand`);
});

// Broadcaster grants mic (optional UI feedback—mic is already controllable locally)
socket.on('grant-mic', () => {
  if (localStream) {
    const t = localStream.getAudioTracks()[0];
    if (t) t.enabled = true;
  }
  isMicMuted = false;
  micToggleBtn.innerText = '🎧 Mute';
  appendMessage('🎤 You were granted mic permission');
});

// Toggle mic
function toggleMic() {
  if (!localStream) return;
  const t = localStream.getAudioTracks()[0];
  if (!t) return;
  isMicMuted = !isMicMuted;
  t.enabled = !isMicMuted;
  micToggleBtn.innerText = isMicMuted ? '🔇 Mic Off' : '🎧 Mute';
  appendMessage(isMicMuted ? '🔇 You muted your mic' : '🎤 You unmuted your mic');
}

// Kicked by broadcaster
socket.on('kick-viewer', () => {
  alert('You have been removed by the broadcaster.');
  try { if (peer) peer.destroy(); } catch {}
  peer = null;
  mainVideo.srcObject = null;
  window.location.reload();
});

// Broadcaster disconnect cleanup
socket.on('disconnectPeer', () => {
  try { if (peer) peer.destroy(); } catch {}
  peer = null;
  mainVideo.srcObject = null;
  appendMessage('❌ Broadcaster disconnected.');
});

// Expose functions for HTML buttons
window.joinBroadcast = joinBroadcast;
window.sendMessage = sendMessage;
window.sendEmoji = sendEmoji;
window.raiseHand = raiseHand;
window.toggleMic = toggleMic;
