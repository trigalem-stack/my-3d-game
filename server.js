const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(__dirname));

const MAP_SIZE = 21;
const BLOCK_SIZE = 4;
let globalPlayers = {}; // { socketId: name }
let lobbies = {}; // roomId: { ... }

function generateServerMap() {
    let mapData = Array(MAP_SIZE).fill(0).map(() => Array(MAP_SIZE).fill(1));
    let stack = []; let startX = 1, startZ = 1; mapData[startZ][startX] = 0; stack.push({x: startX, z: startZ});
    while(stack.length > 0) {
        let curr = stack[stack.length - 1]; let neighbors = []; const dirs = [[0, -2], [0, 2], [-2, 0], [2, 0]];
        for(let d of dirs) { let nx = curr.x + d[0]; let nz = curr.z + d[1]; if(nx > 0 && nx < MAP_SIZE-1 && nz > 0 && nz < MAP_SIZE-1 && mapData[nz][nx] === 1) { neighbors.push({x: nx, z: nz, dx: d[0]/2, dz: d[1]/2}); } }
        if(neighbors.length > 0) { let next = neighbors[Math.floor(Math.random() * neighbors.length)]; mapData[curr.z + next.dz][curr.x + next.dx] = 0; mapData[next.z][next.x] = 0; stack.push({x: next.x, z: next.z}); } else { stack.pop(); }
    }
    for(let z=1; z<MAP_SIZE-1; z++) for(let x=1; x<MAP_SIZE-1; x++) if(mapData[z][x] === 1 && Math.random() < 0.25) { let openNeighbors = 0; if(mapData[z-1][x] === 0) openNeighbors++; if(mapData[z+1][x] === 0) openNeighbors++; if(mapData[z][x-1] === 0) openNeighbors++; if(mapData[z][x+1] === 0) openNeighbors++; if (openNeighbors >= 2) mapData[z][x] = 0; }
    return mapData;
}

function getEmptySpots(mapData) {
    let spots = [];
    for(let z=1; z<MAP_SIZE-1; z++) for(let x=1; x<MAP_SIZE-1; x++) if(mapData[z][x] === 0) spots.push({x: x, z: z});
    return spots.sort(() => Math.random() - 0.5);
}

function emitLobbiesList(target = io) {
    let list = {};
    for(let id in lobbies) {
        let l = lobbies[id];
        list[id] = { name: l.name, max: l.max, playersCount: Object.keys(l.players).length, hasPassword: l.password !== '', state: l.state };
    }
    target.emit('lobbiesList', list);
}

function getWinnerVote(votesObj, defaults) {
    let max = -1; let winners = [];
    for(let k in votesObj) { if(votesObj[k] > max) max = votesObj[k]; }
    if (max === -1 || max === 0) return defaults[Math.floor(Math.random() * defaults.length)];
    for(let k in votesObj) { if(votesObj[k] === max) winners.push(k); }
    return winners[Math.floor(Math.random() * winners.length)]; // Рандом при ничьей
}

function startVoting(roomId) {
    let room = lobbies[roomId]; if(!room) return;
    room.state = 'voting_mode';
    room.votes = { normal: 0, monster: 0 };
    room.playerVoted = {};
    let timeLeft = 15;
    emitLobbiesList();

    io.to(roomId).emit('voteStarted', { type: 'mode', time: timeLeft });
    room.timer = setInterval(() => {
        timeLeft--;
        if (timeLeft <= 0) {
            clearInterval(room.timer);
            let chosenMode = getWinnerVote(room.votes, ['normal', 'monster']);
            room.gameMode = chosenMode;
            
            if (chosenMode === 'monster') {
                let pIds = Object.keys(room.players);
                room.monsterId = pIds[Math.floor(Math.random() * pIds.length)];
                io.to(roomId).emit('showMonster', room.players[room.monsterId].name);
                setTimeout(() => startDiffVoting(roomId), 3000); // Показываем 3 сек
            } else {
                startDiffVoting(roomId);
            }
        } else {
            io.to(roomId).emit('voteStarted', { type: 'mode', time: timeLeft });
        }
    }, 1000);
}

function startDiffVoting(roomId) {
    let room = lobbies[roomId]; if(!room) return;
    room.state = 'voting_diff';
    room.votes = { easy: 0, normal: 0, hard: 0, extreme: 0 };
    room.playerVoted = {};
    let timeLeft = 20;

    io.to(roomId).emit('voteStarted', { type: 'diff', time: timeLeft });
    room.timer = setInterval(() => {
        timeLeft--;
        if (timeLeft <= 0) {
            clearInterval(room.timer);
            room.difficulty = getWinnerVote(room.votes, ['easy', 'normal', 'hard', 'extreme']);
            startGame(roomId);
        } else {
            io.to(roomId).emit('voteStarted', { type: 'diff', time: timeLeft });
        }
    }, 1000);
}

function startGame(roomId) {
    let room = lobbies[roomId]; if(!room) return;
    room.state = 'playing';
    room.keysCollected = 0;
    room.mapData = generateServerMap();
    let spots = getEmptySpots(room.mapData);
    
    let pCount = Object.keys(room.players).length;
    // Динамическое количество папок (2-8 игроков)
    let folderCounts = {2:12, 3:14, 4:16, 5:20, 6:26, 7:28, 8:32};
    let keyAmount = folderCounts[pCount] || 12;
    
    room.keys = [];
    for(let i=0; i<keyAmount; i++) { let s = spots.pop(); room.keys.push({id: i, x: s.x, z: s.z, active: true}); }
    
    let exitSpot = spots.pop();
    room.exitDoor = {x: exitSpot.x, z: exitSpot.z, active: false};

    let mSpot = spots.find(s => Math.hypot(s.x - spots[0].x, s.z - spots[0].z) > 10) || spots.pop();
    room.monsterAI = { x: mSpot.x * BLOCK_SIZE, z: mSpot.z * BLOCK_SIZE, dirX: 1, dirZ: 0 };

    let idx = 0; const colors = [0xff0000, 0x00ff00, 0x0000ff, 0xffff00, 0xff00ff, 0x00ffff, 0xff8800, 0xffffff];
    let pSpot = spots.pop();

    for (let id in room.players) {
        let isM = (room.gameMode === 'monster' && id === room.monsterId);
        let spawn = isM ? mSpot : pSpot; // Игрок-монстр спавнится далеко (6+ блоков от pSpot)
        
        room.players[id].x = spawn.x * BLOCK_SIZE;
        room.players[id].z = spawn.z * BLOCK_SIZE;
        room.players[id].isDead = false;
        room.players[id].color = colors[idx % colors.length]; 
        room.players[id].isRunning = false;
        room.players[id].isMoving = false;
        room.players[id].isMonster = isM;
        if(isM) room.players[id].color = 0xff0000; // Красный
        idx++;
    }

    io.to(roomId).emit('gameStarted', {
        mapData: room.mapData, keys: room.keys, exitDoor: room.exitDoor,
        players: room.players, difficulty: room.difficulty, gameMode: room.gameMode,
        monsterAI: room.monsterAI, monsterId: room.monsterId
    });

    // Если игрок-монстр, запускаем таймер подсветки
    if (room.gameMode === 'monster') {
        room.highlightTimer = setInterval(() => {
            if(room.state === 'playing') io.to(roomId).emit('highlightPlayers');
        }, 15000);
    }
}

function checkGameEnd(roomId) {
    let room = lobbies[roomId]; if(!room) return;
    let alivePlayers = 0;
    for (let id in room.players) { if (!room.players[id].isMonster && !room.players[id].isDead) alivePlayers++; }
    
    if (alivePlayers === 0 && room.state === 'playing') {
        room.state = 'waiting';
        clearInterval(room.timer); clearInterval(room.highlightTimer);
        io.to(roomId).emit('gameEnded', 'Монстр победил!');
        emitLobbiesList();
    }
}

function checkAutoStart(roomId) {
    let room = lobbies[roomId]; if(!room) return;
    let pCount = Object.keys(room.players).length;
    if (room.state === 'waiting' && pCount >= room.max) {
        startVoting(roomId);
    } else if (room.state === 'waiting' && pCount >= 2 && !room.startTimeout) {
        room.startTimeout = setTimeout(() => {
            if(lobbies[roomId] && Object.keys(lobbies[roomId].players).length >= 2) startVoting(roomId);
        }, 10000); // Автостарт если 2+ игрока 10 сек ждут
    } else if (pCount < 2 && room.startTimeout) {
        clearTimeout(room.startTimeout); room.startTimeout = null;
    }
}

io.on('connection', (socket) => {
    socket.on('setName', (name) => { globalPlayers[socket.id] = name; });
    socket.on('getLobbies', () => emitLobbiesList(socket));

    socket.on('createRoom', (data) => {
        let roomId = 'room_' + Date.now();
        lobbies[roomId] = {
            id: roomId, name: data.name, password: data.password, max: data.max,
            players: {}, admin: socket.id, state: 'waiting'
        };
        socket.emit('roomJoined', lobbies[roomId]);
        socket.join(roomId); socket.roomId = roomId;
        lobbies[roomId].players[socket.id] = { name: globalPlayers[socket.id], x: 0, z: 0, isDead: false };
        io.to(roomId).emit('roomUpdated', lobbies[roomId]);
        emitLobbiesList();
        checkAutoStart(roomId);
    });

    socket.on('joinRoom', (data) => {
        let room = lobbies[data.roomId];
        if (!room) return socket.emit('joinError', 'Лобби не найдено');
        if (room.state !== 'waiting') return socket.emit('joinError', 'Игра уже идет');
        if (Object.keys(room.players).length >= room.max) return socket.emit('joinError', 'Лобби заполнено');
        if (room.password && room.password !== data.password) return socket.emit('joinError', 'Неверный пароль');

        socket.join(data.roomId); socket.roomId = data.roomId;
        room.players[socket.id] = { name: globalPlayers[socket.id], x: 0, z: 0, isDead: false };
        io.to(data.roomId).emit('roomUpdated', room);
        emitLobbiesList();
        checkAutoStart(data.roomId);
    });

    socket.on('leaveRoom', () => {
        if (socket.roomId && lobbies[socket.roomId]) {
            let room = lobbies[socket.roomId];
            delete room.players[socket.id];
            socket.leave(socket.roomId);
            if (Object.keys(room.players).length === 0) {
                clearTimeout(room.startTimeout); clearInterval(room.timer); clearInterval(room.highlightTimer);
                delete lobbies[socket.roomId];
            } else {
                if (room.admin === socket.id) room.admin = Object.keys(room.players)[0];
                io.to(socket.roomId).emit('roomUpdated', room);
                checkGameEnd(socket.roomId);
            }
            socket.roomId = null;
            emitLobbiesList();
        }
    });

    socket.on('kickPlayer', (id) => {
        if (socket.roomId && lobbies[socket.roomId] && lobbies[socket.roomId].admin === socket.id) {
            io.to(id).emit('joinError', 'Вас кикнули'); // Используем joinError как универсальный alert
            io.sockets.sockets.get(id).leave(socket.roomId);
            delete lobbies[socket.roomId].players[id];
            io.to(socket.roomId).emit('roomUpdated', lobbies[socket.roomId]);
            io.sockets.sockets.get(id).emit('lobbiesList', lobbies); // обновить ему список
        }
    });

    socket.on('vote', (data) => {
        let room = lobbies[socket.roomId];
        if (room && !room.playerVoted[socket.id] && room.votes[data.val] !== undefined) {
            room.playerVoted[socket.id] = true;
            room.votes[data.val]++;
            io.to(socket.roomId).emit('voteUpdated', room.votes);
        }
    });

    socket.on('playerMove', (data) => {
        let room = lobbies[socket.roomId];
        if (room && room.players[socket.id] && !room.players[socket.id].isDead) {
            room.players[socket.id].x = data.x; room.players[socket.id].z = data.z;
            room.players[socket.id].isRunning = data.isRunning;
            room.players[socket.id].isMoving = data.isMoving;
            room.players[socket.id].dirX = data.dirX; room.players[socket.id].dirZ = data.dirZ;
            socket.to(socket.roomId).emit('playersUpdate', room.players);
        }
    });

    socket.on('monsterAIMove', (data) => {
        let room = lobbies[socket.roomId];
        if (room && room.admin === socket.id) { socket.to(socket.roomId).emit('monsterAIUpdate', data); }
    });

    socket.on('keyCollected', (keyId) => {
        let room = lobbies[socket.roomId];
        if (room && room.state === 'playing' && !room.players[socket.id].isMonster) {
            room.keysCollected++;
            io.to(socket.roomId).emit('keyUpdate', { id: keyId, count: room.keysCollected });
            if (room.keysCollected >= room.keys.length) io.to(socket.roomId).emit('exitOpened');
        }
    });

    socket.on('playerDied', () => {
        let room = lobbies[socket.roomId];
        if(room && room.players[socket.id]) {
            room.players[socket.id].isDead = true;
            io.to(socket.roomId).emit('playerDiedEvent', socket.id);
            checkGameEnd(socket.roomId);
        }
    });

    socket.on('playerEscaped', () => {
        let room = lobbies[socket.roomId];
        if (room && room.state === 'playing' && room.players[socket.id]) {
            room.state = 'waiting'; clearInterval(room.timer); clearInterval(room.highlightTimer);
            io.to(socket.roomId).emit('gameWon', room.players[socket.id].name);
            emitLobbiesList();
        }
    });

    socket.on('requestTeleport', () => {
        let room = lobbies[socket.roomId];
        if (room && room.state === 'playing' && room.monsterId === socket.id) {
            // Найти выжившего
            let targets = [];
            for (let id in room.players) { if (!room.players[id].isMonster && !room.players[id].isDead) targets.push(room.players[id]); }
            if (targets.length > 0) {
                let t = targets[Math.floor(Math.random() * targets.length)];
                let validSpots = [];
                for(let z=1; z<MAP_SIZE-1; z++) for(let x=1; x<MAP_SIZE-1; x++) if(room.mapData[z][x] === 0) {
                    let dist = Math.hypot(x*BLOCK_SIZE - t.x, z*BLOCK_SIZE - t.z);
                    if(dist >= 8 && dist <= 12) validSpots.push({x: x*BLOCK_SIZE, z: z*BLOCK_SIZE});
                }
                if (validSpots.length > 0) {
                    let spot = validSpots[Math.floor(Math.random() * validSpots.length)];
                    room.players[socket.id].x = spot.x; room.players[socket.id].z = spot.z;
                    socket.emit('teleported', spot);
                }
            }
        }
    });

    socket.on('disconnect', () => {
        if (socket.roomId && lobbies[socket.roomId]) {
            let room = lobbies[socket.roomId];
            delete room.players[socket.id];
            if (Object.keys(room.players).length === 0) {
                clearTimeout(room.startTimeout); clearInterval(room.timer); clearInterval(room.highlightTimer);
                delete lobbies[socket.roomId];
            } else {
                if (room.admin === socket.id) room.admin = Object.keys(room.players)[0];
                io.to(socket.roomId).emit('roomUpdated', room);
                checkGameEnd(socket.roomId);
            }
            emitLobbiesList();
        }
        delete globalPlayers[socket.id];
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
