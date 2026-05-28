const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));

const players = {};

io.on('connection', (socket) => {
    console.log('Пользователь зашел на страницу: ' + socket.id);

    // Игрок нажал кнопку "Играть"
    socket.on('joinGame', () => {
        players[socket.id] = {
            id: socket.id,
            x: 0,
            y: 0.5,
            z: 0,
            color: Math.random() * 0xffffff 
        };

        // Отправляем подключившемуся все текущие кубы
        socket.emit('currentPlayers', players);

        // Говорим всем остальным, что появился новый игрок
        socket.broadcast.emit('newPlayer', players[socket.id]);
        console.log('Игрок вошел в игру: ' + socket.id);
    });

    socket.on('playerMovement', (movementData) => {
        if (players[socket.id]) {
            players[socket.id].x = movementData.x;
            players[socket.id].z = movementData.z;
            socket.broadcast.emit('playerMoved', players[socket.id]);
        }
    });

    socket.on('disconnect', () => {
        if (players[socket.id]) {
            console.log('Игрок вышел: ' + socket.id);
            delete players[socket.id];
            io.emit('playerDisconnected', socket.id);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
});