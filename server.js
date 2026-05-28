const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));

const MAP_SIZE = 21;
const BLOCK_SIZE = 4;
let mapData = [];
let players = {};
let gameState = 'waiting'; // waiting, playing
let votes = { easy: 0, normal: 0, hard: 0, extreme: 0 };
let monster = { x: 0, z: 0, target: null };
let keysCollected = 0;

function generateServerMap() {
    mapData = Array(MAP_SIZE).fill(0).map(() => Array(MAP_SIZE).fill(1));
    let stack = [];
    let startX = 1, startZ = 1;
    mapData[startZ][startX] = 0;
    stack.push({x: startX, z: startZ});

    while(stack.length > 0) {
        let curr = stack[stack.length - 1];
        let neighbors = [];
        const dirs = [[0, -2], [0, 2], [-2, 0], [2, 0]];
        for(let d of dirs) {
            let nx = curr.x + d[0]; let nz = curr.z + d[1];
            if(nx > 0 && nx < MAP_SIZE-1 && nz > 0 && nz < MAP_SIZE-1 && mapData[nz][nx] === 1) {
                neighbors.push({x: nx, z: nz, dx: d[0]/2, dz: d[1]/2});
            }
        }
        if(neighbors.length > 0) {
            let next = neighbors[Math.floor(Math.random() * neighbors.length)];
            mapData[curr.z + next.dz][curr.x + next.dx] = 0; 
            mapData[next.z][next.x] = 0; 
            stack.push({x: next.x, z: next.z});
        } else {
            stack.pop();
        }
    }
    
    // Доп. проходы (комнаты)
    for(let z=1; z<MAP_SIZE-1; z++) {
        for(let x=1; x<MAP_SIZE-1; x++) {
            if(mapData[z][x] === 1 && Math.random() < 0.25) {
                let openNeighbors = 0;
                if(mapData[z-1][x] === 0) openNeighbors++;
                if(mapData[z+1][x] === 0) openNeighbors++;
                if(mapData[z][x-1] === 0) openNeighbors++;
                if(mapData[z][x+1] === 0) openNeighbors++;
                if (openNeighbors >= 2) mapData[z][x] = 0; 
            }
        }
    }
}

function getEmptySpots() {
    let spots = [];
    for(let z=1; z<MAP_SIZE-1; z++) {
        for(let x=1; x<MAP_SIZE-1; x++) {
            if(mapData[z][x] === 0) spots.push({x: x, z: z});
        }
    }
    return spots.sort(() => Math.random() - 0.5);
}

function startGame() {
    if (Object.keys(players).length < 2) return;
    gameState = 'playing';
    keysCollected = 0;
    generateServerMap();
    let spots = getEmptySpots();
    
    let keys = [];
    for(let i=0; i<8; i++) {
        let s = spots.pop();
        keys.push({id: i, x: s.x, z: s.z, active: true});
    }
    
    let exitSpot = spots.pop();
    let mSpot = spots.pop();
    monster.x = mSpot.x * BLOCK_SIZE;
    monster.z = mSpot.z * BLOCK_SIZE;

    let highestVote = Object.keys(votes).reduce((a, b) => votes[a] > votes[b] ? a : b);

    let idx = 0;
    const colors = [0xff0000, 0x00ff00, 0x0000ff, 0xffff00, 0xff00ff, 0x00ffff, 0xff8800, 0xffffff];
    
    for (let id in players) {
        let pSpot = spots.pop();
        players[id].x = pSpot.x * BLOCK_SIZE;
        players[id].z = pSpot.z * BLOCK_SIZE;
        players[id].isDead = false;
        players[id].color = colors[idx % colors.length];
        idx++;
    }

    io.emit('gameStarted', {
        mapData, keys, exitDoor: {x: exitSpot.x, z: exitSpot.z, active: false},
        players, difficulty: highestVote, monster
    });
}

function checkGameEnd() {
    let aliveCount = Object.values(players).filter(p => !p.isDead).length;
    if (aliveCount === 0 && gameState === 'playing') {
        gameState = 'waiting';
        io.emit('gameEnded', 'Монстр победил!');
    }
}

io.on('connection', (socket) => {
    socket.on('joinLobby', (data) => {
        if (Object.keys(players).length >= 8 || gameState !== 'waiting') {
            socket.emit('error', 'Лобби заполнено или игра уже идет');
            return;
        }
        players[socket.id] = { id: socket.id, name: data.name, x: 0, z: 0, isDead: false, color: 0xffffff };
        votes[data.vote]++;
        
        io.emit('lobbyUpdate', {
            players: Object.values(players),
            count: Object.keys(players).length
        });

        if (Object.keys(players).length >= 2 && Object.keys(players).length <= 8) {
            // Если набралось 2+ игрока, можно дать хосту кнопку или просто запустить через 5 сек
            setTimeout(() => {
                if (gameState === 'waiting' && Object.keys(players).length >= 2) {
                    startGame();
                }
            }, 5000);
        }
    });

    socket.on('playerMove', (data) => {
        if (players[socket.id] && !players[socket.id].isDead) {
            players[socket.id].x = data.x;
            players[socket.id].z = data.z;
            socket.broadcast.emit('playersUpdate', players);
        }
    });

    socket.on('keyCollected', (keyId) => {
        keysCollected++;
        io.emit('keyUpdate', { id: keyId, count: keysCollected });
        if (keysCollected >= 8) {
            io.emit('exitOpened');
        }
    });

    socket.on('playerDied', () => {
        if(players[socket.id]) {
            players[socket.id].isDead = true;
            io.emit('playerDiedEvent', socket.id);
            checkGameEnd();
        }
    });

    socket.on('monsterMove', (data) => {
        // Простая синхронизация монстра от первого игрока (упрощенный серверный ИИ)
        monster.x = data.x;
        monster.z = data.z;
        socket.broadcast.emit('monsterUpdate', monster);
    });

    socket.on('disconnect', () => {
        if (players[socket.id]) {
            delete players[socket.id];
            io.emit('lobbyUpdate', { players: Object.values(players), count: Object.keys(players).length });
            io.emit('playerDisconnected', socket.id);
            checkGameEnd();
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
