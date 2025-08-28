// server.js — Amiim Live Events (socket.io + express)
// ---------------------------------------------------
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server); // same-origin default

// --- Static assets ---
app.use(express.static(path.join(__dirname))); // serve project root
app.use('/lib', express.static(path.join(__dirname, 'node_modules'))); // /lib/simple-peer/...

// Basic body parser in case you later POST JSON to routes
app.use(express.json());

// --- Routes ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/viewer', (req, res) => res.sendFile(path.join(__dirname, 'viewer.html')));

// Quick health endpoint for Render/uptime checks
app.get('/health', (_req, res) => res.status(200).send('OK'));

// Status with room and viewer counts
app.get('/status', (_req, res) => {
  const snapshot = {};
  for (const [roomId, room] of Object.entries(rooms)) {
    snapshot[roomId] = {
      broadcaster: room.broadcaster,
      mode: room.mode,
      viewers: Array.from(room.viewers.entries()).map(([id, name]) => ({ id, name }))
    };
  }
  res.json({ rooms: snapshot, serverTime: new Date().toISOString() });
});

// --- Room state ---
// rooms[roomId] = {
//   broadcaster: <socketId|null>,
//   broadcasterName: <string>,
//   viewers: Map<socketId, displayName>,
//   mode: 'slides' | 'event',
//   feedback: Array<{ ts, from, role, text, env?, lastConsole? }>
// }
const rooms = {};

// --- Helper: safe emit to target socket id ---
function safeEmit(targetId, event, payload) {
  if (!targetId) return;
  const target = io.sockets.sockets.get(targetId);
  if (target) target.emit(event, payload);
}

// --- Helper: broadcast room viewer list & count ---
function broadcastRoomState(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  const viewerList = Array.from(room.viewers.entries()).map(([id, name]) => ({ id, name }));
  io.to(roomId).emit('viewer-count', room.viewers.size);
  io.to(roomId).emit('viewer-list', viewerList);
}

// --- Socket.IO wiring ---
io.on('connection', (socket) => {
  console.log('🔌 Connected:', socket.id);

  // ---- Broadcaster joins ----
  socket.on('broadcaster', ({ roomId, broadcasterName }) => {
    if (!roomId) return;
    socket.join(roomId);

    if (!rooms[roomId]) {
      rooms[roomId] = {
        broadcaster: null,
        broadcasterName: 'Broadcaster',
        viewers: new Map(),
        mode: 'slides',
        feedback: []
      };
    }

    rooms[roomId].broadcaster = socket.id;
    rooms[roomId].broadcasterName = broadcasterName || 'Broadcaster';
    socket.roomId = roomId;
    socket.role = 'broadcaster';
    socket.displayName = rooms[roomId].broadcasterName;

    console.log(`🎥 Broadcaster "${socket.displayName}" joined room: ${roomId}`);

    // Sync initial state
    broadcastRoomState(roomId);
    io.to(roomId).emit('stream-mode', rooms[roomId].mode || 'slides');
  });

  // ---- Viewer joins ----
  socket.on('watcher', ({ roomId, viewerName }) => {
    if (!roomId) return;
    socket.join(roomId);

    if (!rooms[roomId]) {
      rooms[roomId] = {
        broadcaster: null,
        broadcasterName: 'Broadcaster',
        viewers: new Map(),
        mode: 'slides',
        feedback: []
      };
    }

    const name = viewerName || 'Anonymous';
    rooms[roomId].viewers.set(socket.id, name);
    socket.roomId = roomId;
    socket.role = 'viewer';
    socket.displayName = name;

    // Ask broadcaster to create a peer for this viewer
    const broadcasterId = rooms[roomId].broadcaster;
    if (broadcasterId) {
      safeEmit(broadcasterId, 'watcher', { viewerId: socket.id, viewerName: name });
      // greet viewer; sync stream mode
      socket.emit('chat', { sender: 'System', msg: '🎉 Welcome to Eng. Amiim Live Broadcast Site, enjoy!' });
      socket.emit('stream-mode', rooms[roomId].mode || 'slides');
    }

    broadcastRoomState(roomId);
    console.log(`👀 Viewer "${name}" joined room: ${roomId}`);
  });

  // ---- WebRTC signaling ----
  // Supports:
  //  - Broadcaster -> Viewer: { roomId, viewerId, signal }
  //  - Viewer -> Broadcaster: { roomId, signal }
  //  - Legacy direct (broadcaster only): { targetId, signal }
  socket.on('signal', (payload = {}) => {
    try {
      const { roomId } = payload;
      const room = roomId ? rooms[roomId] : rooms[socket.roomId];

      // Broadcaster → Viewer
      if (room && room.broadcaster === socket.id && payload.viewerId && payload.signal) {
        safeEmit(payload.viewerId, 'signal', { viewerId: payload.viewerId, signal: payload.signal });
        return;
      }

      // Viewer → Broadcaster
      if (room && room.viewers?.has(socket.id) && payload.signal) {
        if (room.broadcaster) {
          safeEmit(room.broadcaster, 'signal', { viewerId: socket.id, signal: payload.signal });
        }
        return;
      }

      // Legacy direct (broadcaster only)
      if (room && room.broadcaster === socket.id && payload.targetId && payload.signal) {
        safeEmit(payload.targetId, 'signal', { viewerId: socket.id, signal: payload.signal });
        return;
      }

      console.warn('⚠️ Unhandled signal payload:', payload);
    } catch (e) {
      console.error('signal handler error:', e);
    }
  });

  // ---- Chat / Emoji / Raise-hand (no echo to sender) ----
  socket.on('chat', ({ roomId, msg, sender }) => {
    if (!roomId) return;
    socket.to(roomId).emit('chat', { sender, msg });
  });
  socket.on('emoji', ({ roomId, emoji, sender }) => {
    if (!roomId) return;
    socket.to(roomId).emit('emoji', { sender, emoji });
  });
  socket.on('raise-hand', ({ roomId, sender }) => {
    if (!roomId) return;
    socket.to(roomId).emit('raise-hand', { sender });
  });

  // ---- Mic permission (broadcaster only) ----
  socket.on('grant-mic', (viewerId) => {
    const roomId = socket.roomId;
    const room = rooms[roomId];
    if (!room || room.broadcaster !== socket.id) return; // guard
    if (viewerId) safeEmit(viewerId, 'grant-mic');
  });

  // ---- Kick viewer (broadcaster only) ----
  socket.on('kick-viewer', (viewerId) => {
    const roomId = socket.roomId;
    const room = rooms[roomId];
    if (!viewerId || !room || room.broadcaster !== socket.id) return; // guard

    safeEmit(viewerId, 'kick-viewer');
    room.viewers.delete(viewerId);

    broadcastRoomState(roomId);
    // also notify broadcaster to tear down peer
    safeEmit(room.broadcaster, 'disconnectPeer', viewerId);
  });

  // ---- Stream mode change (anyone can reflect, but we keep it simple: broadcaster sets mode) ----
  socket.on('stream-mode', ({ roomId, mode }) => {
    if (!roomId || !rooms[roomId]) return;
    // Only allow broadcaster to change the canonical mode
    if (rooms[roomId].broadcaster !== socket.id) return;
    rooms[roomId].mode = mode === 'event' ? 'event' : 'slides';
    io.to(roomId).emit('stream-mode', rooms[roomId].mode);
    console.log(`🔄 Stream mode in ${roomId} → ${rooms[roomId].mode}`);
  });

  // ---- Optional: collect client feedback / logs (from your “Send Feedback” button) ----
  // payload: { text, env, lastConsole }
  socket.on('clientFeedback', (payload = {}) => {
    const roomId = socket.roomId;
    if (!roomId || !rooms[roomId]) return;
    const entry = {
      ts: new Date().toISOString(),
      from: socket.displayName || socket.id,
      role: socket.role || 'unknown',
      text: payload.text || '',
      env: payload.env || null,
      lastConsole: payload.lastConsole || null
    };
    rooms[roomId].feedback.push(entry);
    // keep last 100 feedback entries
    if (rooms[roomId].feedback.length > 100) rooms[roomId].feedback.shift();
    console.log('📝 Feedback:', roomId, entry);
    safeEmit(rooms[roomId].broadcaster, 'feedback', entry);
  });

  // ---- Disconnect handling ----
  socket.on('disconnect', () => {
    const roomId = socket.roomId;
    if (!roomId || !rooms[roomId]) return;

    const room = rooms[roomId];

    // Broadcaster left → clear room and notify viewers
    if (room.broadcaster === socket.id) {
      console.log(`❌ Broadcaster "${room.broadcasterName}" left room: ${roomId}`);
      for (const viewerId of room.viewers.keys()) {
        safeEmit(viewerId, 'disconnectPeer', viewerId);
      }
      io.to(roomId).emit('viewer-count', 0);
      delete rooms[roomId];
      return;
    }

    // Viewer left
    if (room.viewers.has(socket.id)) {
      console.log(`👤 Viewer "${room.viewers.get(socket.id)}" left room: ${roomId}`);
      room.viewers.delete(socket.id);

      // tell broadcaster to remove peer/tile
      if (room.broadcaster) safeEmit(room.broadcaster, 'disconnectPeer', socket.id);

      broadcastRoomState(roomId);
    }
  });
});

// --- Boot ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
