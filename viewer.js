// 📹 viewer.js
const socket = io();
let peer = null;
let localStream = null;
let roomId = '';
let viewerName = '';
let isMicMuted = false;

// DOM Elements
const mainVideo = document.getElementById('mainVideo');
const selfVideo = document.getElementById('selfVideo');
const chatBox = document.getElementById('chat-box');
const chatInput = document.getElementById('chat-input');
const viewerCountDisplay = document.getElementById('viewerCount');
const streamModeLabel = document.getElementById('streamMode');
const micToggleBtn = document.getElementById('micToggleBtn');

// Helper
function appendMessage(msg) {
  chatBox.value += msg + '\n';
  chatBox.scrollTop = chatBox.scrollHeight;
}

// Join Broadcast
async function joinBroadcast() {
  roomId = document.getElementById('roomId')?.value.trim();
  viewerName = document.getElementById('viewerName')?.value.trim() || 'Anonymous';
  if (!roomId) return alert("Please enter Room ID");

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    selfVideo.srcObject = localStream;
    socket.emit('watcher', { roomId, viewerName });
  } catch (err) {
    alert("Error accessing camera/mic: " + err.message);
  }
}

// Incoming WebRTC signal
socket.on('signal', ({ viewerId, signal }) => {
  if (!peer) {
    peer = new SimplePeer({ initiator: false, trickle: false, stream: localStream });

    peer.on('signal', signal => {
      socket.emit('signal', { roomId, viewerId, signal });
    });

    peer.on('stream', stream => {
      mainVideo.srcObject = stream;
    });

    peer.on('error', err => console.error('Peer error:', err));
    peer.on('close', () => {
      peer = null;
      mainVideo.srcObject = null;
    });
  }
  peer.signal(signal);
});

// Stream mode label
socket.on('stream-mode', mode => {
  streamModeLabel.innerText = mode === 'event' ? '📺 Mode: Event' : '📺 Mode: Slides';
});

// Viewer count
socket.on('viewer-count', count => {
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
  appendMessage(`🟢 ${viewerName}: ${msg}`);
  chatInput.value = '';
}

// Emoji
socket.on('emoji', ({ sender, emoji }) => {
  appendMessage(`🎉 ${sender}: ${emoji}`);
});
function sendEmoji(emoji) {
  socket.emit('emoji', { roomId, emoji, sender: viewerName });
  appendMessage(`🟢 ${viewerName}: ${emoji}`);
}

// Raise hand
function raiseHand() {
  socket.emit('raise-hand', { roomId, sender: viewerName });
  appendMessage(`✋ You raised your hand`);
}
socket.on('raise-hand', ({ sender }) => {
  appendMessage(`✋ ${sender} raised hand`);
});

// Grant mic
socket.on('grant-mic', () => {
  if (localStream) {
    const audioTrack = localStream.getAudioTracks()[0];
    if (audioTrack) audioTrack.enabled = true;
    appendMessage('🎤 You were granted mic permission');
  }
});

// Toggle mic
function toggleMic() {
  if (!localStream) return;
  const audioTrack = localStream.getAudioTracks()[0];
  if (!audioTrack) return;
  isMicMuted = !isMicMuted;
  audioTrack.enabled = !isMicMuted;
  micToggleBtn.innerText = isMicMuted ? '🔇 Mic Off' : '🎤 Mic On';
  appendMessage(isMicMuted ? '🔇 You muted your mic' : '🎤 You unmuted your mic');
}

// Kick
socket.on('kick-viewer', () => {
  alert("You have been removed by the broadcaster.");
  window.location.reload();
});

// Broadcaster disconnect
socket.on('disconnectPeer', () => {
  if (peer) peer.destroy();
  peer = null;
  mainVideo.srcObject = null;
  appendMessage('❌ Broadcaster disconnected.');
});
