const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Указываем серверу раздавать файлы из текущей папки
app.use(express.static(__dirname));

// Хранилище всех подключенных игроков
const players = {};

io.on('connection', (socket) => {
    console.log('Новый игрок подключился: ' + socket.id);

    // Создаем нового игрока со случайным цветом
    players[socket.id] = {
        id: socket.id,
        x: 0,
        y: 0.5, // Центр куба находится на высоте 0.5, чтобы он стоял на земле
        z: 0,
        color: Math.random() * 0xffffff 
    };

    // Отправляем новому игроку данные обо всех уже существующих игроках
    socket.emit('currentPlayers', players);

    // Сообщаем всем остальным игрокам о появлении нового
    socket.broadcast.emit('newPlayer', players[socket.id]);

    // Обработка движения игрока
    socket.on('playerMovement', (movementData) => {
        if (players[socket.id]) {
            players[socket.id].x = movementData.x;
            players[socket.id].z = movementData.z;
            
            // Рассылаем новые координаты всем остальным
            socket.broadcast.emit('playerMoved', players[socket.id]);
        }
    });

    // Обработка отключения
    socket.on('disconnect', () => {
        console.log('Игрок отключился: ' + socket.id);
        delete players[socket.id];
        io.emit('playerDisconnected', socket.id);
    });
});

// Запуск сервера
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
});
