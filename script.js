const socket = io();
let peers = {};
let localStream = null;
let currentRoomId = '';
let streamMode = 'slides';
let isMicMuted = false;
let activeSpeaker = null;

// DOM references
const mainVideo = document.getElementById('mainVideo');
const selfPreview = document.getElementById('selfPreview');
const chatBox = document.getElementById('chat-box');
const chatInput = document.getElementById('chat-input');
const viewerCountDisplay = document.getElementById('viewerCount');
const streamModeLabel = document.getElementById('streamMode');
const backBtn = document.getElementById('backBtn');
const viewerList = document.getElementById('viewerList');

function getRoomId() {
  return document.getElementById('roomId')?.value.trim();
}

function getBroadcasterName() {
  return document.getElementById('broadcasterName')?.value.trim() || 'Amiim';
}

function appendMessage(msg) {
  chatBox.value += msg + '\n';
  chatBox.scrollTop = chatBox.scrollHeight;
}

// Start broadcast
async function startBroadcast() {
  const roomId = getRoomId();
  const adminPassword = prompt("Enter Admin Password");
  if (adminPassword !== 'amiim2025') return alert("Access Denied");
  if (!roomId) return alert("Please enter Room ID");

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    handleNewStream(stream);
    currentRoomId = roomId;
    socket.emit('broadcaster', { roomId, broadcasterName: getBroadcasterName() });
  } catch (err) {
    alert("Media access denied: " + err.message);
  }
}

// Share screen
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

// Show event/camera
async function shareEvent() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: true });
    streamMode = 'event';
    streamModeLabel.innerText = '📺 Mode: Event';
    handleNewStream(stream);
    socket.emit('stream-mode', { roomId: currentRoomId, mode: streamMode });
    backBtn.style.display = 'inline-block';
  } catch (err) {
    alert('Camera switch error: ' + err.message);
  }
}

function backToSlides() {
  shareScreen();
}

function handleNewStream(newStream) {
  if (!newStream) return;

  mainVideo.srcObject = newStream;
  selfPreview.srcObject = newStream;
  localStream = newStream;

  for (const viewerId in peers) {
    const peer = peers[viewerId];
    const senders = peer._pc.getSenders();
    const newVideoTrack = newStream.getVideoTracks()[0];
    const newAudioTrack = newStream.getAudioTracks()[0];

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

// Watcher joins
socket.on('watcher', ({ viewerId, viewerName }) => {
  if (peers[viewerId]) {
    peers[viewerId].destroy();
    delete peers[viewerId];
    document.getElementById(viewerId)?.remove();
  }
  if (!localStream) return;

  const peer = new SimplePeer({ initiator: true, trickle: false, stream: localStream });

  peer.on('signal', signal => {
    if (signal.type === 'offer' || signal.candidate) {
      socket.emit('signal', { roomId: currentRoomId, viewerId, signal });
    }
  });

  peer.on('connect', () => console.log(`✅ Connected to ${viewerName}`));
  peer.on('error', err => console.error(`❌ Peer error:`, err));
  peer.on('close', () => {
    delete peers[viewerId];
    document.getElementById(viewerId)?.remove();
  });

  peers[viewerId] = peer;
  const li = document.createElement('li');
  li.id = viewerId;
  li.innerHTML = `${viewerName} <span id="mic-${viewerId}"></span> <button onclick="grantMic('${viewerId}')">🎤 Allow Mic</button> <button onclick="kickViewer('${viewerId}')">❌ Kick</button>`;
  viewerList.appendChild(li);
});

socket.on('signal', ({ viewerId, signal }) => {
  if (peers[viewerId]) peers[viewerId].signal(signal);
});

socket.on('disconnectPeer', viewerId => {
  if (peers[viewerId]) {
    peers[viewerId].destroy();
    delete peers[viewerId];
    document.getElementById(viewerId)?.remove();
  }
});

socket.on('viewer-count', count => {
  viewerCountDisplay.innerText = `👥 Viewers: ${count}`;
});

socket.on('emoji', ({ sender, emoji }) => appendMessage(`🎉 ${sender}: ${emoji}`));
socket.on('raise-hand', ({ sender }) => appendMessage(`✋ ${sender} raised hand`));
socket.on('chat', ({ sender, msg }) => appendMessage(`💬 ${sender}: ${msg}`));

function toggleMic() {
  if (!localStream) return;
  const audioTrack = localStream.getAudioTracks()[0];
  if (!audioTrack) return;
  isMicMuted = !isMicMuted;
  audioTrack.enabled = !isMicMuted;
  appendMessage(isMicMuted ? '🔇 Mic muted' : '🎤 Mic unmuted');
}

function sendMessage() {
  const msg = chatInput.value.trim();
  if (!msg) return;
  socket.emit('chat', { roomId: currentRoomId, msg, sender: getBroadcasterName() });
  appendMessage(`🟢 ${getBroadcasterName()}: ${msg}`);
  chatInput.value = '';
}

function sendEmoji(emoji) {
  socket.emit('emoji', { roomId: currentRoomId, emoji, sender: getBroadcasterName() });
  appendMessage(`🟢 ${getBroadcasterName()}: ${emoji}`);
}

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
