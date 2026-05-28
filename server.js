const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(__dirname));

const MAP_SIZE = 21;
const BLOCK_SIZE = 4;
const keyScaling = {2:12, 3:14, 4:16, 5:20, 6:26, 7:28, 8:32};

const lobbies = {}; // roomId -> lobbyData

function generateId() { return Math.random().toString(36).substring(2, 9); }

function getEmptySpots(mapData) {
    let spots = [];
    for(let z=1; z<MAP_SIZE-1; z++) {
        for(let x=1; x<MAP_SIZE-1; x++) { if(mapData[z][x] === 0) spots.push({x: x, z: z}); }
    }
    return spots.sort(() => Math.random() - 0.5);
}

function generateServerMap() {
    let mapData = Array(MAP_SIZE).fill(0).map(() => Array(MAP_SIZE).fill(1));
    let stack = []; let startX = 1, startZ = 1; mapData[startZ][startX] = 0; stack.push({x: startX, z: startZ});
    while(stack.length > 0) {
        let curr = stack[stack.length - 1]; let neighbors = []; const dirs = [[0, -2], [0, 2], [-2, 0], [2, 0]];
        for(let d of dirs) {
            let nx = curr.x + d[0]; let nz = curr.z + d[1];
            if(nx > 0 && nx < MAP_SIZE-1 && nz > 0 && nz < MAP_SIZE-1 && mapData[nz][nx] === 1) neighbors.push({x: nx, z: nz, dx: d[0]/2, dz: d[1]/2});
        }
        if(neighbors.length > 0) {
            let next = neighbors[Math.floor(Math.random() * neighbors.length)]; mapData[curr.z + next.dz][curr.x + next.dx] = 0; mapData[next.z][next.x] = 0; stack.push({x: next.x, z: next.z});
        } else stack.pop();
    }
    for(let z=1; z<MAP_SIZE-1; z++) for(let x=1; x<MAP_SIZE-1; x++) if(mapData[z][x] === 1 && Math.random() < 0.25) {
        let open = 0; if(mapData[z-1][x]===0) open++; if(mapData[z+1][x]===0) open++; if(mapData[z][x-1]===0) open++; if(mapData[z][x+1]===0) open++;
        if (open >= 2) mapData[z][x] = 0; 
    }
    return mapData;
}

function getLobbiesList() {
    let list = {};
    for(let id in lobbies) {
        if(lobbies[id].state === 'waiting') {
            list[id] = { name: lobbies[id].name, hasPass: !!lobbies[id].password, playersCount: Object.keys(lobbies[id].players).length, max: lobbies[id].max };
        }
    }
    return list;
}

function processModeVote(room) {
    let counts = { normal: 0, monster: 0 };
    for(let pid in room.votesMode) counts[room.votesMode[pid]]++;
    let max = -1; let winners = [];
    for(let k in counts) { if(counts[k] > max) max = counts[k]; }
    for(let k in counts) { if(counts[k] === max) winners.push(k); }
    room.mode = winners[Math.floor(Math.random() * winners.length)];

    if(room.mode === 'monster') {
        let pIds = Object.keys(room.players);
        room.monsterId = pIds[Math.floor(Math.random() * pIds.length)];
        room.state = 'voting_diff';
        io.to(room.id).emit('phaseChange', {phase: 'voting_diff', monsterName: room.players[room.monsterId].name});
        let t = 20;
        room.timer = setInterval(() => {
            t--; io.to(room.id).emit('timerUpdate', {type: 'diff', val: t});
            if(t<=0) { clearInterval(room.timer); processDiffVoteAndStart(room); }
        }, 1000);
    } else {
        processDiffVoteAndStart(room); // Normal defaults diff
    }
}

function processDiffVoteAndStart(room) {
    if(room.mode === 'monster') {
        let counts = { easy:0, normal:0, hard:0, extreme:0 };
        for(let pid in room.votesDiff) counts[room.votesDiff[pid]]++;
        let max = -1; let winners = [];
        for(let k in counts) { if(counts[k] > max) max = counts[k]; }
        for(let k in counts) { if(counts[k] === max) winners.push(k); }
        if(winners.length > 0 && max > 0) room.difficulty = winners[Math.floor(Math.random() * winners.length)];
        else { let arr = ['normal', 'hard', 'extreme']; room.difficulty = arr[Math.floor(Math.random()*arr.length)]; }
    } else room.difficulty = 'normal';

    startGame(room);
}

function startGame(room) {
    room.state = 'playing';
    room.mapData = generateServerMap();
    let spots = getEmptySpots(room.mapData);
    let pCount = Object.keys(room.players).length;
    room.keysNeeded = keyScaling[pCount] || 8;
    room.keysCollected = 0;

    let keys = [];
    for(let i=0; i<room.keysNeeded; i++) { let s = spots.pop(); keys.push({id: i, x: s.x, z: s.z, active: true}); }
    let exitSpot = spots.pop();
    let pSpot = spots.pop();
    room.monster = {x:0, z:0};
    if(room.mode === 'normal') {
        let mSpot = spots.find(s => Math.hypot(s.x - pSpot.x, s.z - pSpot.z) > 10) || spots.pop();
        room.monster.x = mSpot.x * BLOCK_SIZE; room.monster.z = mSpot.z * BLOCK_SIZE;
    }

    const colors = [0xff0000, 0x00ff00, 0x0000ff, 0xffff00, 0xff00ff, 0x00ffff, 0xff8800, 0xffffff]; let idx=0;
    for (let id in room.players) {
        room.players[id].x = pSpot.x * BLOCK_SIZE; room.players[id].z = pSpot.z * BLOCK_SIZE;
        room.players[id].isDead = false; room.players[id].color = colors[idx % colors.length]; room.players[id].isRunning = false;
        idx++;
    }

    io.to(room.id).emit('gameStarted', {
        mapData: room.mapData, keys, exitDoor: {x: exitSpot.x, z: exitSpot.z, active: false},
        players: room.players, difficulty: room.difficulty, monster: room.monster, mode: room.mode, monsterId: room.monsterId, keysNeeded: room.keysNeeded
    });

    if(room.mode === 'monster') {
        room.radarTimer = setInterval(() => { io.to(room.id).emit('radarPing'); }, 15000);
    }
}

function checkGameEnd(room) {
    if(room.state !== 'playing') return;
    let survivors = 0; let mDead = false;
    for(let id in room.players) {
        if(id === room.monsterId) { if(room.players[id].isDead) mDead = true; }
        else if(!room.players[id].isDead) survivors++;
    }
    
    if (survivors === 0 || mDead) {
        room.state = 'waiting';
        if(room.radarTimer) clearInterval(room.radarTimer);
        io.to(room.id).emit('gameEnded', 'Все мертвы');
    }
}

io.on('connection', (socket) => {
    socket.on('requestLobbies', () => { socket.emit('lobbiesList', getLobbiesList()); });

    socket.on('createLobby', (data) => {
        let roomId = generateId();
        lobbies[roomId] = {
            id: roomId, name: data.name, password: data.pass, max: data.max, state: 'waiting', adminId: socket.id,
            players: {}, votesMode: {}, votesDiff: {}, mode: 'normal', monsterId: null, keysNeeded: 8, keysCollected: 0
        };
        socket.join(roomId);
        lobbies[roomId].players[socket.id] = { id: socket.id, name: data.playerName, isDead: false };
        socket.emit('lobbyJoined', { roomId, lobby: { name: lobbies[roomId].name, max: lobbies[roomId].max, playersCount: 1, players: lobbies[roomId].players, adminId: socket.id } });
        io.emit('lobbiesList', getLobbiesList());
    });

    socket.on('joinLobby', (data) => {
        let room = lobbies[data.roomId];
        if(!room) return socket.emit('lobbyError', 'Лобби не найдено');
        if(room.state !== 'waiting') return socket.emit('lobbyError', 'Игра уже идет');
        if(Object.keys(room.players).length >= room.max) return socket.emit('lobbyError', 'Лобби заполнено');
        if(room.password && room.password !== data.pass) return socket.emit('lobbyError', 'Неверный пароль');

        let nameExists = Object.values(room.players).some(p => p.name === data.playerName);
        if(nameExists) return socket.emit('lobbyError', 'Этот ник уже занят в лобби');

        socket.join(room.id);
        room.players[socket.id] = { id: socket.id, name: data.playerName, isDead: false };
        io.to(room.id).emit('lobbyUpdate', { name: room.name, max: room.max, playersCount: Object.keys(room.players).length, players: room.players, adminId: room.adminId });
        io.emit('lobbiesList', getLobbiesList());
    });

    socket.on('leaveLobby', () => { handleDisconnect(socket); });

    socket.on('adminStartGame', (roomId) => {
        let room = lobbies[roomId];
        if(room && room.adminId === socket.id && Object.keys(room.players).length >= 2 && room.state === 'waiting') {
            room.state = 'voting_mode'; room.votesMode = {}; room.votesDiff = {};
            io.to(roomId).emit('phaseChange', {phase: 'voting_mode'});
            let t = 15;
            room.timer = setInterval(() => {
                t--; io.to(roomId).emit('timerUpdate', {type: 'mode', val: t});
                if(t <= 0) { clearInterval(room.timer); processModeVote(room); }
            }, 1000);
        }
    });

    socket.on('vote', (data) => {
        let room = lobbies[data.roomId]; if(!room) return;
        if(data.type === 'mode' && room.state === 'voting_mode') { room.votesMode[socket.id] = data.val; }
        if(data.type === 'diff' && room.state === 'voting_diff') { room.votesDiff[socket.id] = data.val; }
        
        let counts = {}; let target = data.type === 'mode' ? room.votesMode : room.votesDiff;
        for(let pid in target) { counts[target[pid]] = (counts[target[pid]] || 0) + 1; }
        io.to(room.id).emit('voteUpdate', {type: data.type, votes: counts});
    });

    socket.on('playerMove', (data) => {
        let room = getRoom(socket.id); if(!room || !room.players[socket.id] || room.players[socket.id].isDead) return;
        room.players[socket.id].x = data.x; room.players[socket.id].z = data.z; room.players[socket.id].isRunning = data.isRunning; room.players[socket.id].yaw = data.yaw;
        socket.to(room.id).emit('playersUpdate', room.players);
    });

    socket.on('monsterMoveAI', (data) => { let room = lobbies[data.roomId]; if(room) socket.to(room.id).emit('monsterUpdateAI', data); });
    
    socket.on('monsterKillPlayer', (data) => {
        let room = lobbies[data.roomId];
        if(room && room.players[data.targetId] && !room.players[data.targetId].isDead) {
            room.players[data.targetId].isDead = true; io.to(room.id).emit('playerDiedEvent', data.targetId); checkGameEnd(room);
        }
    });

    socket.on('requestTeleport', (roomId) => {
        let room = lobbies[roomId];
        if(room && room.monsterId === socket.id && room.state === 'playing') {
            let spots = getEmptySpots(room.mapData); let pIds = Object.keys(room.players).filter(i => i!==socket.id && !room.players[i].isDead);
            if(pIds.length > 0) {
                let targetId = pIds[Math.floor(Math.random()*pIds.length)]; let tP = room.players[targetId];
                let bestSpot = spots[0]; let okSpots = spots.filter(s => Math.hypot(s.x*BLOCK_SIZE - tP.x, s.z*BLOCK_SIZE - tP.z) > 8 && Math.hypot(s.x*BLOCK_SIZE - tP.x, s.z*BLOCK_SIZE - tP.z) < 15);
                if(okSpots.length > 0) bestSpot = okSpots[Math.floor(Math.random()*okSpots.length)];
                if(bestSpot) {
                    room.players[socket.id].x = bestSpot.x*BLOCK_SIZE; room.players[socket.id].z = bestSpot.z*BLOCK_SIZE;
                    socket.emit('teleported', {x: room.players[socket.id].x, z: room.players[socket.id].z});
                }
            }
        }
    });

    socket.on('keyCollected', (keyId) => {
        let room = getRoom(socket.id); if(!room) return;
        room.keysCollected++; io.to(room.id).emit('keyUpdate', { id: keyId, count: room.keysCollected });
        if (room.keysCollected >= room.keysNeeded) io.to(room.id).emit('exitOpened');
    });

    socket.on('playerEscaped', () => {
        let room = getRoom(socket.id);
        if (room && room.state === 'playing' && room.players[socket.id]) {
            room.state = 'waiting'; if(room.radarTimer) clearInterval(room.radarTimer);
            io.to(room.id).emit('gameWon', room.players[socket.id].name);
        }
    });

    socket.on('disconnect', () => { handleDisconnect(socket); });
});

function getRoom(socketId) { for(let id in lobbies) { if(lobbies[id].players[socketId]) return lobbies[id]; } return null; }

function handleDisconnect(socket) {
    let room = getRoom(socket.id);
    if(room) {
        delete room.players[socket.id]; socket.leave(room.id);
        if(Object.keys(room.players).length === 0) {
            if(room.timer) clearInterval(room.timer); if(room.radarTimer) clearInterval(room.radarTimer); delete lobbies[room.id];
        } else {
            if(room.adminId === socket.id) room.adminId = Object.keys(room.players)[0]; // Передача админки
            if(room.state === 'playing') {
                io.to(room.id).emit('playerDiedEvent', socket.id); checkGameEnd(room);
            } else {
                io.to(room.id).emit('lobbyUpdate', { name: room.name, max: room.max, playersCount: Object.keys(room.players).length, players: room.players, adminId: room.adminId });
            }
        }
        io.emit('lobbiesList', getLobbiesList());
    }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
