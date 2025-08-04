const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Serve static files
app.use(express.static(path.join(__dirname)));

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/viewer', (req, res) => {
  res.sendFile(path.join(__dirname, 'viewer.html'));
});

// Room structure
const rooms = {}; // { roomId: { broadcaster: socketId, viewers: Map<socketId, name>, mode: 'slides' | 'event' } }

io.on('connection', (socket) => {
  console.log('🔌 New connection:', socket.id);

  // Broadcaster joins
  socket.on('broadcaster', ({ roomId, broadcasterName }) => {
    socket.join(roomId);
    rooms[roomId] = rooms[roomId] || { broadcaster: null, viewers: new Map(), mode: 'slides' };
    rooms[roomId].broadcaster = socket.id;
    socket.roomId = roomId;
    socket.broadcasterName = broadcasterName || 'Broadcaster';
    console.log(`🎥 Broadcaster "${socket.broadcasterName}" joined room: ${roomId}`);
  });

  // Viewer joins
  socket.on('watcher', ({ roomId, viewerName }) => {
    socket.join(roomId);
    rooms[roomId] = rooms[roomId] || { broadcaster: null, viewers: new Map(), mode: 'slides' };
    rooms[roomId].viewers.set(socket.id, viewerName || 'Anonymous');
    socket.roomId = roomId;
    socket.viewerName = viewerName || 'Anonymous';

    const broadcasterId = rooms[roomId].broadcaster;
    if (broadcasterId) {
      io.to(broadcasterId).emit('watcher', { viewerId: socket.id, viewerName });
      socket.emit('chat', { sender: 'System', msg: `🎉 Welcome to Eng. Amiim Live Broadcast Site, enjoy!` });
      socket.emit('stream-mode', rooms[roomId].mode || 'slides');
    }

    io.to(roomId).emit('viewer-count', rooms[roomId].viewers.size);

    const viewerList = Array.from(rooms[roomId].viewers.entries()).map(([id, name]) => ({ id, name }));
    io.to(roomId).emit('viewer-list', viewerList);

    console.log(`👀 Viewer "${socket.viewerName}" joined room: ${roomId}`);
  });

  // ✅ Updated WebRTC signaling (two-way)
  socket.on('signal', ({ targetId, signal }) => {
    io.to(targetId).emit('signal', { fromId: socket.id, signal });
  });

  // Chat messages
  socket.on('chat', ({ roomId, msg, sender }) => {
    io.to(roomId).emit('chat', { sender, msg });
  });

  // Emoji reaction
  socket.on('emoji', ({ roomId, emoji, sender }) => {
    io.to(roomId).emit('emoji', { sender, emoji });
  });

  // Raise hand
  socket.on('raise-hand', ({ roomId, sender }) => {
    io.to(roomId).emit('raise-hand', { sender });
  });

  // Grant mic permission
  socket.on('grant-mic', (viewerId) => {
    io.to(viewerId).emit('grant-mic');
  });

  // Kick viewer
  socket.on('kick-viewer', (viewerId) => {
    io.to(viewerId).emit('kick-viewer');
    const roomId = socket.roomId;
    if (rooms[roomId]) {
      rooms[roomId].viewers.delete(viewerId);
      io.to(roomId).emit('viewer-count', rooms[roomId].viewers.size);

      const viewerList = Array.from(rooms[roomId].viewers.entries()).map(([id, name]) => ({ id, name }));
      io.to(roomId).emit('viewer-list', viewerList);
    }
  });

  // Stream mode toggle
  socket.on('stream-mode', ({ roomId, mode }) => {
    if (rooms[roomId]) {
      rooms[roomId].mode = mode;
      io.to(roomId).emit('stream-mode', mode);
      console.log(`🔄 Stream mode changed in room ${roomId} → ${mode}`);
    }
  });

  // Handle disconnect
  socket.on('disconnect', () => {
    const roomId = socket.roomId;
    if (!roomId || !rooms[roomId]) return;

    const room = rooms[roomId];

    if (room.broadcaster === socket.id) {
      console.log(`❌ Broadcaster "${socket.broadcasterName}" left room: ${roomId}`);
      for (const viewerId of room.viewers.keys()) {
        io.to(viewerId).emit('disconnectPeer', viewerId);
      }
      io.to(roomId).emit('viewer-count', 0);
      delete rooms[roomId];
    } else if (room.viewers.has(socket.id)) {
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
