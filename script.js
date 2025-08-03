const socket = io();
let peerConnections = {};
let localStream;
let roomId;
let isBroadcaster = false;
let currentMode = "slides"; // "slides" or "event"

const videoElement = document.getElementById('mainVideo');
const chatBox = document.getElementById('chat-box');
const chatInput = document.getElementById('chat-input');
const streamModeLabel = document.getElementById('streamMode');
const viewerCountDisplay = document.getElementById('viewerCount');
const bgMusic = document.getElementById('bgMusic');

// For viewers
const selfVideo = document.getElementById('selfVideo');
let viewerStream = null;

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
    document.getElementById('backBtn').style.display = "none";
  } catch (err) {
    alert("Error sharing screen: " + err.message);
  }
}

async function shareEvent() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: true });
    setLocalStream(localStream);
    streamModeLabel.innerText = "📺 Mode: Event";
    currentMode = "event";
    document.getElementById('backBtn').style.display = "inline-block";
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
    pc.replaceTrack(pc.streams[0].getVideoTracks()[0], stream.getVideoTracks()[0], pc.streams[0]);
    pc.replaceTrack(pc.streams[0].getAudioTracks()[0], stream.getAudioTracks()[0], pc.streams[0]);
  }
}

// ---------- VIEWER FUNCTIONS ----------
async function joinBroadcast() {
  roomId = document.getElementById('roomId').value.trim();
  if (!roomId) return alert("Enter Room ID");

  try {
    viewerStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    if (selfVideo) {
      selfVideo.srcObject = viewerStream;
    }
    socket.emit('watcher', roomId);
  } catch (err) {
    alert("Camera/Mic access denied: " + err.message);
  }
}

function sendMessage() {
  const msg = chatInput.value.trim();
  if (!msg) return;
  socket.emit('chat', { roomId, msg, sender: isBroadcaster ? 'Amiim' : 'Viewer' });
  appendMessage("Me: " + msg);
  chatInput.value = "";
}

function appendMessage(msg) {
  chatBox.value += msg + '\n';
  chatBox.scrollTop = chatBox.scrollHeight;
}

function sendEmoji(emoji) {
  socket.emit('emoji', { roomId, emoji });
  appendMessage(`You: ${emoji}`);
}

function raiseHand() {
  socket.emit('raise-hand', roomId);
  appendMessage("You raised your hand ✋");
}

function toggleMusic() {
  if (bgMusic.paused) {
    bgMusic.play();
  } else {
    bgMusic.pause();
  }
}

// ---------- SOCKET EVENTS ----------
socket.on('offer', (id, desc) => {
  const peer = new SimplePeer({ initiator: false, trickle: false });
  peer.on('signal', data => socket.emit('answer', id, data));
  peer.on('stream', stream => {
    if (isBroadcaster) {
      const video = document.createElement('video');
      video.autoplay = true;
      video.playsInline = true;
      video.srcObject = stream;
      video.setAttribute('data-peer', id);
      document.getElementById('viewerStreams')?.appendChild(video);
    } else {
      videoElement.srcObject = stream;
    }
  });
  peer.signal(desc);
  peerConnections[id] = peer;
});

socket.on('answer', (id, desc) => {
  peerConnections[id]?.signal(desc);
});

socket.on('watcher', id => {
  if (!isBroadcaster) return;

  const peer = new SimplePeer({
    initiator: true,
    trickle: false,
    stream: localStream
  });

  peer.on('signal', data => socket.emit('offer', id, data));
  peer.on('close', () => {
    delete peerConnections[id];
    const video = document.querySelector(`video[data-peer="${id}"]`);
    if (video) video.remove();
  });

  peerConnections[id] = peer;
});

socket.on('chat', ({ sender, msg }) => {
  appendMessage(`${sender}: ${msg}`);
});

socket.on('emoji', ({ emoji }) => {
  appendMessage(`👋 ${emoji} from someone`);
});

socket.on('raise-hand', () => {
  appendMessage("✋ A viewer raised their hand");
});

socket.on('viewer-count', count => {
  if (viewerCountDisplay) viewerCountDisplay.innerText = `👥 Viewers: ${count}`;
});

socket.on('stream-mode', mode => {
  streamModeLabel.innerText = mode === 'event' ? "📺 Mode: Event" : "📺 Mode: Slides";
});

socket.on('disconnectPeer', id => {
  if (peerConnections[id]) {
    peerConnections[id].destroy();
    delete peerConnections[id];
    const video = document.querySelector(`video[data-peer="${id}"]`);
    if (video) {
      video.remove();
    }
  }
});
