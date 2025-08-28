const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server); // same-origin, no special CORS needed

// Serve static files (project root)
app.use(express.static(path.join(__dirname)));

// ✅ Serve node_modules at /lib (SimplePeer is /lib/simple-peer/simplepeer.min.js)
app.use('/lib', express.static(path.join(__dirname, 'node_modules')));

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});
app.get('/viewer', (req, res) => {
  res.sendFile(path.join(__dirname, 'viewer.html'));
});

// rooms[roomId] = { broadcaster: <socketId|null>, viewers: Map<socketId, name>, mode: 'slides'|'event' }
const rooms = {};

io.on('connection', (socket) => {
  console.log('🔌 New connection:', socket.id);

  // Broadcaster joins a room
  socket.on('broadcaster', ({ roomId, broadcasterName }) => {
    if (!roomId) return;
    socket.join(roomId);
    if (!rooms[roomId]) rooms[roomId] = { broadcaster: null, viewers: new Map(), mode: 'slides' };
    rooms[roomId].broadcaster = socket.id;
    socket.roomId = roomId;
    socket.broadcasterName = broadcasterName || 'Broadcaster';
    console.log(`🎥 Broadcaster "${socket.broadcasterName}" joined room: ${roomId}`);

    // Sync initial counts/lists
    io.to(roomId).emit('viewer-count', rooms[roomId].viewers.size);
    const viewerList = Array.from(rooms[roomId].viewers.entries()).map(([id, name]) => ({ id, name }));
    io.to(roomId).emit('viewer-list', viewerList);
    io.to(roomId).emit('stream-mode', rooms[roomId].mode || 'slides');
  });

  // Viewer joins a room
  socket.on('watcher', ({ roomId, viewerName }) => {
    if (!roomId) return;
    socket.join(roomId);
    if (!rooms[roomId]) rooms[roomId] = { broadcaster: null, viewers: new Map(), mode: 'slides' };
    rooms[roomId].viewers.set(socket.id, viewerName || 'Anonymous');
    socket.roomId = roomId;
    socket.viewerName = viewerName || 'Anonymous';

    const broadcasterId = rooms[roomId].broadcaster;
    if (broadcasterId) {
      // notify broadcaster to create a peer for this viewer
      io.to(broadcasterId).emit('watcher', { viewerId: socket.id, viewerName });
      // greet viewer; sync stream mode
      socket.emit('chat', { sender: 'System', msg: `🎉 Welcome to Eng. Amiim Live Broadcast Site, enjoy!` });
      socket.emit('stream-mode', rooms[roomId].mode || 'slides');
    }

    // update viewer count & list to everyone
    io.to(roomId).emit('viewer-count', rooms[roomId].viewers.size);
    const viewerList = Array.from(rooms[roomId].viewers.entries()).map(([id, name]) => ({ id, name }));
    io.to(roomId).emit('viewer-list', viewerList);

    console.log(`👀 Viewer "${socket.viewerName}" joined room: ${roomId}`);
  });

  /**
   * ✅ WebRTC signaling (two-way, compatible with your client code)
   * Supports BOTH:
   *  - { roomId, viewerId, signal }  (broadcaster -> viewer)
   *  - { roomId, signal }            (viewer -> broadcaster)
   *  - { targetId, signal }          (legacy direct; restricted to broadcaster)
   */
  socket.on('signal', (payload = {}) => {
    try {
      const { roomId } = payload;
      const room = roomId ? rooms[roomId] : rooms[socket.roomId];

      // Broadcaster → Viewer
      if (room && room.broadcaster === socket.id && payload.viewerId && payload.signal) {
        io.to(payload.viewerId).emit('signal', { viewerId: payload.viewerId, signal: payload.signal });
        return;
      }

      // Viewer → Broadcaster
      if (room && room.viewers?.has(socket.id) && payload.signal) {
        if (room.broadcaster) {
          io.to(room.broadcaster).emit('signal', { viewerId: socket.id, signal: payload.signal });
        }
        return;
      }

      // Legacy direct (only allow broadcaster to use it)
      if (room && room.broadcaster === socket.id && payload.targetId && payload.signal) {
        io.to(payload.targetId).emit('signal', { viewerId: socket.id, signal: payload.signal });
        return;
      }

      console.warn('⚠️ Unhandled signal payload:', payload);
    } catch (e) {
      console.error('signal handler error:', e);
    }
  });

  // Chat / Emoji / Raise hand — do NOT echo to sender (prevents duplicates)
  socket.on('chat', ({ roomId, msg, sender }) => {
    if (!roomId) return;
    socket.to(roomId).emit('chat', { sender, msg }); // everyone except sender
  });
  socket.on('emoji', ({ roomId, emoji, sender }) => {
    if (!roomId) return;
    socket.to(roomId).emit('emoji', { sender, emoji }); // everyone except sender
  });
  socket.on('raise-hand', ({ roomId, sender }) => {
    if (!roomId) return;
    socket.to(roomId).emit('raise-hand', { sender }); // everyone except sender
  });

  // Grant mic permission — restrict to broadcaster
  socket.on('grant-mic', (viewerId) => {
    const roomId = socket.roomId;
    const room = rooms[roomId];
    if (!room || room.broadcaster !== socket.id) return; // guard
    if (viewerId) io.to(viewerId).emit('grant-mic');
  });

  // Kick viewer — restrict to broadcaster
  socket.on('kick-viewer', (viewerId) => {
    const roomId = socket.roomId;
    const room = rooms[roomId];
    if (!viewerId || !room || room.broadcaster !== socket.id) return; // guard

    io.to(viewerId).emit('kick-viewer');
    room.viewers.delete(viewerId);

    io.to(roomId).emit('viewer-count', room.viewers.size);
    const viewerList = Array.from(room.viewers.entries()).map(([id, name]) => ({ id, name }));
    io.to(roomId).emit('viewer-list', viewerList);

    // also notify broadcaster to tear down the peer
    io.to(room.broadcaster).emit('disconnectPeer', viewerId);
  });

  // Stream mode broadcast
  socket.on('stream-mode', ({ roomId, mode }) => {
    if (roomId && rooms[roomId]) {
      rooms[roomId].mode = mode;
      io.to(roomId).emit('stream-mode', mode);
      console.log(`🔄 Stream mode changed in room ${roomId} → ${mode}`);
    }
  });

  // Handle disconnects
  socket.on('disconnect', () => {
    const roomId = socket.roomId;
    if (!roomId || !rooms[roomId]) return;

    const room = rooms[roomId];

    // Broadcaster gone → clear room and notify viewers
    if (room.broadcaster === socket.id) {
      console.log(`❌ Broadcaster "${socket.broadcasterName}" left room: ${roomId}`);
      for (const viewerId of room.viewers.keys()) {
        io.to(viewerId).emit('disconnectPeer', viewerId);
      }
      io.to(roomId).emit('viewer-count', 0);
      delete rooms[roomId];
      return;
    }

    // Viewer gone
    if (room.viewers.has(socket.id)) {
      console.log(`👤 Viewer "${room.viewers.get(socket.id)}" left room: ${roomId}`);
      room.viewers.delete(socket.id);

      if (room.broadcaster) {
        io.to(room.broadcaster).emit('disconnectPeer', socket.id);
      }

      io.to(roomId).emit('viewer-count', room.viewers.size);
      const viewerList = Array.from(room.viewers.entries()).map(([id, name]) => ({ id, name }));
      io.to(roomId).emit('viewer-list', viewerList);
    }
  });
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
