// server.js
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Room tracking
const rooms = {};  // roomId => { broadcaster, viewers: Set }

io.on('connection', socket => {
  console.log("🔌 New client connected:", socket.id);

  socket.on('broadcaster', roomId => {
    socket.join(roomId);
    rooms[roomId] = rooms[roomId] || { broadcaster: null, viewers: new Set() };
    rooms[roomId].broadcaster = socket.id;
    console.log(`🎥 Broadcaster joined room ${roomId}: ${socket.id}`);
  });

  socket.on('watcher', roomId => {
    socket.join(roomId);
    if (!rooms[roomId]) rooms[roomId] = { broadcaster: null, viewers: new Set() };
    rooms[roomId].viewers.add(socket.id);

    const broadcasterId = rooms[roomId].broadcaster;
    if (broadcasterId) {
      io.to(broadcasterId).emit('watcher', socket.id);
    }

    // Send updated viewer count
    io.to(roomId).emit('viewer-count', rooms[roomId].viewers.size);
  });

  socket.on('offer', (id, message) => {
    io.to(id).emit('offer', socket.id, message);
  });

  socket.on('answer', (id, message) => {
    io.to(id).emit('answer', socket.id, message);
  });

  socket.on('chat', ({ roomId, msg, sender }) => {
    io.to(roomId).emit('chat', { sender, msg });
  });

  socket.on('emoji', ({ roomId, emoji }) => {
    io.to(roomId).emit('emoji', { emoji });
  });

  socket.on('raise-hand', roomId => {
    io.to(roomId).emit('raise-hand');
  });

  socket.on('disconnect', () => {
    for (const roomId in rooms) {
      const room = rooms[roomId];

      if (room.broadcaster === socket.id) {
        console.log(`❌ Broadcaster left room ${roomId}`);
        io.to(roomId).emit('disconnectPeer', socket.id);
        for (const viewerId of room.viewers) {
          io.to(viewerId).emit('disconnectPeer', viewerId);
        }
        delete rooms[roomId];
      } else if (room.viewers.has(socket.id)) {
        console.log(`👤 Viewer left room ${roomId}`);
        room.viewers.delete(socket.id);
        io.to(room.broadcaster).emit('disconnectPeer', socket.id);
        io.to(roomId).emit('viewer-count', room.viewers.size);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
