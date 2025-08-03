const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// ✅ Serve static files from the root (so index.html, script.js etc. load)
app.use(express.static(path.join(__dirname)));

// ✅ Send index.html at root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// 🔁 Track rooms and participants
const rooms = {}; // roomId => { broadcaster, viewers: Set }

io.on('connection', (socket) => {
  console.log('🔌 Connected:', socket.id);

  // 📡 Broadcaster joins
  socket.on('broadcaster', (roomId) => {
    socket.join(roomId);
    rooms[roomId] = rooms[roomId] || { broadcaster: null, viewers: new Set() };
    rooms[roomId].broadcaster = socket.id;
    console.log(`🎥 Broadcaster joined ${roomId}: ${socket.id}`);
  });

  // 👁️ Viewer joins
  socket.on('watcher', (roomId) => {
    socket.join(roomId);
    rooms[roomId] = rooms[roomId] || { broadcaster: null, viewers: new Set() };
    rooms[roomId].viewers.add(socket.id);

    const broadcaster = rooms[roomId].broadcaster;
    if (broadcaster) {
      io.to(broadcaster).emit('watcher', socket.id);
    }

    io.to(roomId).emit('viewer-count', rooms[roomId].viewers.size);
  });

  // 🔁 Signal exchange
  socket.on('offer', (id, message) => {
    io.to(id).emit('offer', socket.id, message);
  });

  socket.on('answer', (id, message) => {
    io.to(id).emit('answer', socket.id, message);
  });

  // 💬 Chat messages
  socket.on('chat', ({ roomId, msg, sender }) => {
    io.to(roomId).emit('chat', { sender, msg });
  });

  // 🎉 Emojis
  socket.on('emoji', ({ roomId, emoji }) => {
    io.to(roomId).emit('emoji', { emoji });
  });

  // ✋ Raise hand
  socket.on('raise-hand', (roomId) => {
    io.to(roomId).emit('raise-hand');
  });

  // ❌ Disconnect handling
  socket.on('disconnect', () => {
    for (const roomId in rooms) {
      const room = rooms[roomId];
      if (!room) continue;

      // Broadcaster disconnect
      if (room.broadcaster === socket.id) {
        console.log(`❌ Broadcaster disconnected from ${roomId}`);
        io.to(roomId).emit('disconnectPeer', socket.id);
        for (const viewerId of room.viewers) {
          io.to(viewerId).emit('disconnectPeer', viewerId);
        }
        delete rooms[roomId];
        return;
      }

      // Viewer disconnect
      if (room.viewers.has(socket.id)) {
        console.log(`👤 Viewer disconnected from ${roomId}`);
        room.viewers.delete(socket.id);
        if (room.broadcaster) {
          io.to(room.broadcaster).emit('disconnectPeer', socket.id);
        }
        io.to(roomId).emit('viewer-count', room.viewers.size);
      }
    }
  });
});

// 🔁 Render-compatible port
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server is running on http://localhost:${PORT}`);
});
