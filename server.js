const express = express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

// Раздаем статику (наш index.html)
app.use(express.static(path.join(__dirname, 'public')));

// Состояния игры
const STATES = {
    LOBBY: 'LOBBY',
    PLAYING: 'PLAYING',
    ENDING: 'ENDING'
};

let gameState = STATES.LOBBY;
let players = {};
let lobbyTimer = null;
let lobbyTimeLeft = 10;

io.on('connection', (socket) => {
    console.log(`Игрок подключился: ${socket.id}`);

    // Пинг для расчета задержки
    socket.on('ping', () => socket.emit('pong'));

    // Подключение игрока
    socket.on('join', (data) => {
        players[socket.id] = {
            id: socket.id,
            nick: data.nick || 'Player',
            model: data.model || 'box',
            x: Math.random() * 10 - 5,
            y: 2,
            z: Math.random() * 10 - 5,
            rotation: 0,
            isAlive: true
        };

        socket.emit('gameState', { state: gameState, players });
        socket.broadcast.emit('playerJoined', players[socket.id]);

        checkLobbyCondition();
    });

    // Обновление позиции от клиента
    socket.on('updatePos', (data) => {
        if (players[socket.id] && players[socket.id].isAlive) {
            players[socket.id].x = data.x;
            players[socket.id].y = data.y;
            players[socket.id].z = data.z;
            players[socket.id].rotation = data.rotation;
        }
    });

    // Смерть игрока (упал с платформы)
    socket.on('died', () => {
        if (players[socket.id] && gameState === STATES.PLAYING) {
            players[socket.id].isAlive = false;
            io.emit('playerDied', socket.id);
            checkWinCondition();
        }
    });

    // Отключение
    socket.on('disconnect', () => {
        console.log(`Игрок отключился: ${socket.id}`);
        delete players[socket.id];
        io.emit('playerLeft', socket.id);
        
        if (gameState === STATES.PLAYING) {
            checkWinCondition();
        } else if (gameState === STATES.LOBBY) {
            checkLobbyCondition();
        }
    });
});

// Логика Лобби: старт игры если >= 2 игроков
function checkLobbyCondition() {
    if (gameState !== STATES.LOBBY) return;

    const playerCount = Object.keys(players).length;
    
    if (playerCount >= 2 && !lobbyTimer) {
        lobbyTimeLeft = 10;
        io.emit('lobbyTimer', lobbyTimeLeft);
        
        lobbyTimer = setInterval(() => {
            lobbyTimeLeft--;
            io.emit('lobbyTimer', lobbyTimeLeft);
            
            if (lobbyTimeLeft <= 0) {
                clearInterval(lobbyTimer);
                lobbyTimer = null;
                startGame();
            }
        }, 1000);
    } else if (playerCount < 2 && lobbyTimer) {
        clearInterval(lobbyTimer);
        lobbyTimer = null;
        io.emit('lobbyTimer', -1); // Отмена таймера
    }
}

function startGame() {
    gameState = STATES.PLAYING;
    // Сброс позиций
    Object.values(players).forEach(p => {
        p.isAlive = true;
        p.x = Math.random() * 10 - 5;
        p.y = 2;
        p.z = Math.random() * 10 - 5;
    });
    io.emit('gameStart', players);
}

function checkWinCondition() {
    const alivePlayers = Object.values(players).filter(p => p.isAlive);
    
    if (alivePlayers.length <= 1 && Object.keys(players).length > 1) {
        gameState = STATES.ENDING;
        const winner = alivePlayers.length === 1 ? alivePlayers[0].nick : "НИКТО";
        
        io.emit('gameOver', { winner });
        
        // Через 5 секунд возвращаемся в лобби
        setTimeout(() => {
            gameState = STATES.LOBBY;
            io.emit('resetToLobby');
            checkLobbyCondition();
        }, 5000);
    }
}

// Tick loop (Отправка позиций всем клиентам 20 раз в секунду)
setInterval(() => {
    if (gameState === STATES.PLAYING) {
        // Отправляем только живых
        const updateData = {};
        for(let id in players) {
            if(players[id].isAlive) updateData[id] = players[id];
        }
        io.emit('stateUpdate', updateData);
    }
}, 1000 / 20);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});