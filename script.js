// ✅ script.js (Updated Full Version with Grant Mic, Kick, Speaker Icon)

const socket = io();
let peerConnections = {};
let localStream;
let roomId;
let isBroadcaster = false;
let currentMode = "slides";
let isMicMuted = false;

const videoElement = document.getElementById('mainVideo');
const chatBox = document.getElementById('chat-box');
const chatInput = document.getElementById('chat-input');
const streamModeLabel = document.getElementById('streamMode');
const viewerCountDisplay = document.getElementById('viewerCount');
const selfVideo = document.getElementById('selfVideo');
let viewerStream = null;

const viewerName = prompt("Enter your name:") || "Anonymous";
const iceConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    {
      urls: 'turn:openrelay.metered.ca:80',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    }
  ]
};

// ---------- BROADCASTER FUNCTIONS ----------
async function startBroadcast() {
  roomId = document.getElementById('roomId').value.trim();
  if (!roomId) return alert("Enter Room ID");

  isBroadcaster = true;
  socket.emit('broadcaster', roomId);
  await shareScreen();
}

async function shareScreen() {
  try {
    localStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    setLocalStream(localStream);
    streamModeLabel.innerText = "📺 Mode: Slides";
    currentMode = "slides";
    document.getElementById('backBtn')?.style?.display = "none";
  } catch (err) {
    alert("Error sharing screen: " + err.message);
  }
}

async function shareEvent() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" },
      audio: true
    });
    setLocalStream(localStream);
    streamModeLabel.innerText = "📺 Mode: Event";
    currentMode = "event";
    document.getElementById('backBtn')?.style?.display = "inline-block";
  } catch (err) {
    alert("Error accessing camera: " + err.message);
  }
}

function backToSlides() {
  shareScreen();
}

function setLocalStream(stream) {
  videoElement.srcObject = stream;
  for (let id in peerConnections) {
    const pc = peerConnections[id];
    const oldStream = pc.streams[0];
    const newVideoTrack = stream.getVideoTracks()[0];
    const newAudioTrack = stream.getAudioTracks()[0];

    if (oldStream && newVideoTrack) {
      const oldVideoTrack = oldStream.getVideoTracks()[0];
      if (oldVideoTrack) pc.replaceTrack(oldVideoTrack, newVideoTrack, oldStream);
    }
    if (oldStream && newAudioTrack) {
      const oldAudioTrack = oldStream.getAudioTracks()[0];
      if (oldAudioTrack) pc.replaceTrack(oldAudioTrack, newAudioTrack, oldStream);
    }
  }
}

function grantMicToViewer(viewerId) {
  socket.emit('grant-mic', viewerId);
}

function kickViewer(viewerId) {
  socket.emit('kick-viewer', viewerId);
}

function createViewerControls(viewerId) {
  const container = document.createElement('div');
  container.id = `viewer-controls-${viewerId}`;
  container.innerHTML = `
    <button onclick="grantMicToViewer('${viewerId}')">🎤 Grant Mic</button>
    <button onclick="kickViewer('${viewerId}')">❌ Kick</button>
  `;
  document.getElementById('viewerStreams')?.appendChild(container);
}

// ---------- VIEWER FUNCTIONS ----------
async function joinBroadcast() {
  roomId = document.getElementById('roomId').value.trim();
  if (!roomId) return alert("Enter Room ID");

  try {
    viewerStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    if (selfVideo) selfVideo.srcObject = viewerStream;
    viewerStream.getAudioTracks().forEach(track => (track.enabled = false));
    socket.emit('watcher', roomId);
  } catch (err) {
    alert("Camera/Mic access denied: " + err.message);
  }
}

function sendMessage() {
  const msg = chatInput.value.trim();
  if (!msg) return;
  socket.emit('chat', { roomId, msg, sender: isBroadcaster ? '🟡 Amiim' : `🟢 ${viewerName}` });
  appendMessage(`Me: ${msg}`);
  chatInput.value = "";
}

function appendMessage(msg) {
  chatBox.value += msg + '\n';
  chatBox.scrollTop = chatBox.scrollHeight;
}

function sendEmoji(emoji) {
  socket.emit('emoji', { roomId, emoji, sender: `🟢 ${viewerName}` });
  appendMessage(`You: ${emoji}`);
}

function raiseHand() {
  socket.emit('raise-hand', roomId);
  appendMessage("✋ You raised your hand");
}

function toggleMic() {
  if (!viewerStream) return;
  const audioTrack = viewerStream.getAudioTracks()[0];
  if (!audioTrack) return;
  isMicMuted = !isMicMuted;
  audioTrack.enabled = !isMicMuted;
  appendMessage(isMicMuted ? "🔇 Mic muted" : "🎙️ Mic unmuted");
}

// ---------- SOCKET EVENTS ----------
socket.on('offer', (id, desc) => {
  const peer = new SimplePeer({ initiator: false, trickle: false, config: iceConfig });
  peer.on('signal', data => socket.emit('answer', id, data));
  peer.on('stream', stream => {
    if (isBroadcaster) {
      const video = document.createElement('video');
      video.autoplay = true;
      video.playsInline = true;
      video.srcObject = stream;
      video.setAttribute('data-peer', id);
      document.getElementById('viewerStreams')?.appendChild(video);
      createViewerControls(id);
    } else {
      videoElement.srcObject = stream;
    }
  });
  peerConnections[id] = peer;
  peer.signal(desc);
});

socket.on('answer', (id, desc) => {
  peerConnections[id]?.signal(desc);
});

socket.on('watcher', id => {
  if (!isBroadcaster) return;
  const peer = new SimplePeer({ initiator: true, trickle: false, stream: localStream, config: iceConfig });
  peer.on('signal', data => socket.emit('offer', id, data));
  peer.on('close', () => {
    delete peerConnections[id];
    document.querySelector(`video[data-peer="${id}"]`)?.remove();
    document.getElementById(`viewer-controls-${id}`)?.remove();
  });
  peerConnections[id] = peer;
});

socket.on('chat', ({ sender, msg }) => appendMessage(`${sender}: ${msg}`));
socket.on('emoji', ({ emoji, sender }) => appendMessage(`${sender}: ${emoji}`));
socket.on('raise-hand', () => appendMessage("✋ A viewer raised their hand"));
socket.on('viewer-count', count => viewerCountDisplay.innerText = `👥 Viewers: ${count}`);
socket.on('stream-mode', mode => streamModeLabel.innerText = mode === 'event' ? "📺 Mode: Event" : "📺 Mode: Slides");
socket.on('disconnectPeer', id => {
  peerConnections[id]?.destroy();
  delete peerConnections[id];
  document.querySelector(`video[data-peer="${id}"]`)?.remove();
  document.getElementById(`viewer-controls-${id}`)?.remove();
});

// 🎤 Grant mic to viewer
socket.on('grant-mic', () => {
  if (viewerStream) {
    viewerStream.getAudioTracks().forEach(track => (track.enabled = true));
    appendMessage("🎤 Mic granted by broadcaster");
  }
});

// ❌ Kick viewer
socket.on('kick-viewer', () => {
  alert("You have been removed by the broadcaster.");
  window.location.reload();
});
