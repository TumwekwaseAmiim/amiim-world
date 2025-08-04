const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Serve static files (HTML, JS, CSS)
app.use(express.static(path.join(__dirname)));

// Pages
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});
app.get('/viewer', (req, res) => {
  res.sendFile(path.join(__dirname, 'viewer.html'));
});

// Room management
const rooms = {}; // roomId => { broadcaster: socketId, viewers: Set }

io.on('connection', (socket) => {
  console.log('🔌 New connection:', socket.id);

  // Broadcaster joins room
  socket.on('broadcaster', (roomId) => {
    socket.join(roomId);
    rooms[roomId] = rooms[roomId] || { broadcaster: null, viewers: new Set() };
    rooms[roomId].broadcaster = socket.id;
    socket.roomId = roomId;
    console.log(`🎥 Broadcaster joined room ${roomId}: ${socket.id}`);
  });

  // Viewer joins room
  socket.on('watcher', (roomId) => {
    socket.join(roomId);
    rooms[roomId] = rooms[roomId] || { broadcaster: null, viewers: new Set() };
    rooms[roomId].viewers.add(socket.id);
    socket.roomId = roomId;

    const broadcaster = rooms[roomId].broadcaster;
    if (broadcaster) {
      io.to(broadcaster).emit('watcher', socket.id);
    }

    io.to(roomId).emit('viewer-count', rooms[roomId].viewers.size);
  });

  // WebRTC signaling
  socket.on('offer', (id, message) => {
    io.to(id).emit('offer', socket.id, message);
  });

  socket.on('answer', (id, message) => {
    io.to(id).emit('answer', socket.id, message);
  });

  // Chat messages
  socket.on('chat', ({ roomId, msg, sender }) => {
    io.to(roomId).emit('chat', { sender, msg });
  });

  // Emoji reactions
  socket.on('emoji', ({ roomId, emoji, sender }) => {
    io.to(roomId).emit('emoji', { emoji, sender });
  });

  // Raise hand
  socket.on('raise-hand', (roomId) => {
    io.to(roomId).emit('raise-hand');
  });

  // ✅ Grant mic to specific viewer
  socket.on('grant-mic', (viewerId) => {
    io.to(viewerId).emit('grant-mic');
  });

  // ✅ Kick specific viewer
  socket.on('kick-viewer', (viewerId) => {
    io.to(viewerId).emit('kick-viewer');
    const roomId = socket.roomId;
    if (rooms[roomId]) {
      rooms[roomId].viewers.delete(viewerId);
      io.to(roomId).emit('viewer-count', rooms[roomId].viewers.size);
    }
  });

  // Disconnection logic
  socket.on('disconnect', () => {
    const roomId = socket.roomId;
    if (!roomId || !rooms[roomId]) return;

    const room = rooms[roomId];

    // Broadcaster leaves
    if (room.broadcaster === socket.id) {
      console.log(`❌ Broadcaster disconnected from ${roomId}`);
      io.to(roomId).emit('disconnectPeer', socket.id);
      for (const viewerId of room.viewers) {
        io.to(viewerId).emit('disconnectPeer', viewerId);
      }
      delete rooms[roomId];
    }

    // Viewer leaves
    else if (room.viewers.has(socket.id)) {
      console.log(`👤 Viewer disconnected from ${roomId}`);
      room.viewers.delete(socket.id);
      if (room.broadcaster) {
        io.to(room.broadcaster).emit('disconnectPeer', socket.id);
      }
      io.to(roomId).emit('viewer-count', room.viewers.size);
    }
  });
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
