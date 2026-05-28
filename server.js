const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(__dirname));

const MAP_SIZE = 21; const BLOCK_SIZE = 4;
let lobbies = {}; 
const keysMap = { 2:12, 3:14, 4:16, 5:20, 6:26, 7:28, 8:32 };

function generateServerMap() {
    let mapData = Array(MAP_SIZE).fill(0).map(() => Array(MAP_SIZE).fill(1)); let stack = []; let startX = 1, startZ = 1; mapData[startZ][startX] = 0; stack.push({x: startX, z: startZ});
    while(stack.length > 0) {
        let curr = stack[stack.length - 1]; let neighbors = []; const dirs = [[0, -2], [0, 2], [-2, 0], [2, 0]];
        for(let d of dirs) { let nx = curr.x + d[0]; let nz = curr.z + d[1]; if(nx > 0 && nx < MAP_SIZE-1 && nz > 0 && nz < MAP_SIZE-1 && mapData[nz][nx] === 1) { neighbors.push({x: nx, z: nz, dx: d[0]/2, dz: d[1]/2}); } }
        if(neighbors.length > 0) { let next = neighbors[Math.floor(Math.random() * neighbors.length)]; mapData[curr.z + next.dz][curr.x + next.dx] = 0; mapData[next.z][next.x] = 0; stack.push({x: next.x, z: next.z}); } else stack.pop();
    }
    for(let z=1; z<MAP_SIZE-1; z++) for(let x=1; x<MAP_SIZE-1; x++) if(mapData[z][x] === 1 && Math.random() < 0.25) { let op=0; if(mapData[z-1][x]===0)op++; if(mapData[z+1][x]===0)op++; if(mapData[z][x-1]===0)op++; if(mapData[z][x+1]===0)op++; if(op>=2) mapData[z][x]=0; }
    return mapData;
}
function getEmptySpots(mapData) { let spots = []; for(let z=1; z<MAP_SIZE-1; z++) for(let x=1; x<MAP_SIZE-1; x++) if(mapData[z][x] === 0) spots.push({x: x, z: z}); return spots.sort(() => Math.random() - 0.5); }

function getWinnerVote(votes, fallbackOptions) {
    let max = -1; let winners = [];
    for(let k in votes) { if(votes[k] > max) max = votes[k]; }
    for(let k in votes) { if(votes[k] === max) winners.push(k); }
    if(winners.length === 0 || max === 0) return fallbackOptions[Math.floor(Math.random() * fallbackOptions.length)];
    return winners[Math.floor(Math.random() * winners.length)];
}

function startGameFlow(lobbyId) {
    let l = lobbies[lobbyId]; if(!l) return;
    
    // Начало голосования за режим
    l.state = 'voting_mode';
    io.to(lobbyId).emit('voteModeStart');
    
    startTimer(lobbyId, 15, () => {
        let pIds = Object.keys(l.players);
        l.mode = getWinnerVote(l.votesMode, ['normal', 'monster']);
        
        if (l.mode === 'monster') {
            l.monsterId = pIds[Math.floor(Math.random() * pIds.length)];
            io.to(lobbyId).emit('monsterRevealed', l.players[l.monsterId].name);
            // Ждем 3 секунды чтобы показать кто монстр, затем запускаем таймер сложности на 20 сек
            setTimeout(() => { 
                l.state = 'voting_diff'; 
                io.to(lobbyId).emit('voteDiffStart'); 
                startTimer(lobbyId, 20, () => finalizeGame(lobbyId)); 
            }, 3000);
        } else {
            l.state = 'voting_diff'; 
            io.to(lobbyId).emit('voteDiffStart'); 
            startTimer(lobbyId, 20, () => finalizeGame(lobbyId));
        }
    });
}

function finalizeGame(lobbyId) {
    let l = lobbies[lobbyId]; if(!l) return;
    l.state = 'playing'; l.difficulty = getWinnerVote(l.votesDiff, ['easy', 'normal', 'hard', 'extreme']);
    l.mapData = generateServerMap(); let spots = getEmptySpots(l.mapData);
    
    let pCount = Object.keys(l.players).length; l.maxKeys = keysMap[pCount] || 8;
    l.keys = []; for(let i=0; i<l.maxKeys; i++) { let s = spots.pop(); l.keys.push({id: i, x: s.x, z: s.z, active: true}); }
    
    let exitSpot = spots.pop(); 
    let pSpot = spots.pop(); 
    // Гарантируем спавн монстра в минимум 6 блоках от игроков
    let mSpot = spots.find(s => Math.hypot(s.x - pSpot.x, s.z - pSpot.z) >= 6) || spots.pop();

    const colors = [0xff0000, 0x00ff00, 0x0000ff, 0xffff00, 0xff00ff, 0x00ffff, 0xff8800, 0xffffff]; let idx = 0;
    for (let id in l.players) { l.players[id].x = pSpot.x * BLOCK_SIZE; l.players[id].z = pSpot.z * BLOCK_SIZE; l.players[id].isDead = false; l.players[id].color = colors[idx % colors.length]; idx++; }

    if (l.mode === 'monster' && l.monsterId) { l.players[l.monsterId].x = mSpot.x * BLOCK_SIZE; l.players[l.monsterId].z = mSpot.z * BLOCK_SIZE; }

    io.to(lobbyId).emit('gameStarted', { mapData: l.mapData, keys: l.keys, exitDoor: {x: exitSpot.x, z: exitSpot.z, active: false}, maxKeys: l.maxKeys, players: l.players, difficulty: l.difficulty, mode: l.mode, host: l.host, monsterSpawn: {x: mSpot.x * BLOCK_SIZE, z: mSpot.z * BLOCK_SIZE}, monsterPlayerId: l.monsterId });
    
    if (l.mode === 'monster') { l.highlightInterval = setInterval(() => { io.to(l.monsterId).emit('highlightPlayers'); }, 15000); }
}

function startTimer(lobbyId, time, callback) {
    let l = lobbies[lobbyId]; if(!l) return; clearInterval(l.timerInt); l.timeLeft = time;
    io.to(lobbyId).emit('voteTimerUpdate', l.timeLeft);
    l.timerInt = setInterval(() => { l.timeLeft--; io.to(lobbyId).emit('voteTimerUpdate', l.timeLeft); if(l.timeLeft <= 0) { clearInterval(l.timerInt); callback(); } }, 1000);
}

function checkGameEnd(lobbyId) {
    let l = lobbies[lobbyId]; if(!l || l.state !== 'playing') return;
    let alivePlayers = Object.values(l.players).filter(p => !p.isDead && p.id !== l.monsterId).length;
    if (alivePlayers === 0) { l.state = 'waiting'; resetLobby(l); io.to(lobbyId).emit('gameEndedMonsterWin'); }
}
function resetLobby(l) { l.votesMode = {normal:0, monster:0}; l.votesDiff = {easy:0, normal:0, hard:0, extreme:0}; l.keysCollected=0; clearInterval(l.timerInt); clearInterval(l.highlightInterval); }

io.on('connection', (socket) => {
    socket.on('getLobbies', () => {
        let list = Object.values(lobbies).map(l => ({ id: l.id, name: l.name, hasPass: !!l.password, max: l.max, count: Object.keys(l.players).length }));
        socket.emit('lobbiesList', list);
    });

    socket.on('createLobby', data => {
        if(Object.values(lobbies).some(l => l.name === data.name)) return socket.emit('joinError', 'Лобби с таким именем уже существует');
        
        let id = Math.random().toString(36).substr(2, 6);
        lobbies[id] = { id: id, name: data.name, password: data.pass, max: data.maxPlayers, players: {}, host: socket.id, state: 'waiting', votesMode: {normal:0, monster:0}, votesDiff: {easy:0, normal:0, hard:0, extreme:0}, keysCollected: 0 };
        
        // Автоматически подключаем создателя в лобби без перезагрузки экрана
        socket.join(id); socket.lobbyId = id;
        lobbies[id].players[socket.id] = { id: socket.id, name: data.playerName, x:0, z:0, isDead: false, color: 0xffffff };
        
        socket.emit('lobbyJoined', { id: id, name: data.name, host: socket.id });
        io.to(id).emit('lobbyUpdate', { players: Object.values(lobbies[id].players), host: socket.id, state: 'waiting', max: data.maxPlayers });
        io.emit('lobbiesList', Object.values(lobbies).map(l => ({ id: l.id, name: l.name, hasPass: !!l.password, max: l.max, count: Object.keys(l.players).length })));
    });

    socket.on('joinLobby', data => {
        let l = lobbies[data.id];
        if(!l) return socket.emit('joinError', 'Лобби не найдено');
        if(l.password && l.password !== data.pass) return socket.emit('joinError', 'Неверный пароль');
        if(Object.keys(l.players).length >= l.max) return socket.emit('joinError', 'Лобби заполнено');
        if(l.state !== 'waiting') return socket.emit('joinError', 'Игра уже идет');
        
        socket.join(data.id); socket.lobbyId = data.id;
        l.players[socket.id] = { id: socket.id, name: data.playerName, x:0, z:0, isDead: false, color: 0xffffff };
        socket.emit('lobbyJoined', { id: l.id, name: l.name, host: l.host });
        io.to(l.id).emit('lobbyUpdate', { players: Object.values(l.players), host: l.host, state: l.state, max: l.max });
    });

    socket.on('leaveLobby', () => {
        let id = socket.lobbyId; let l = lobbies[id]; if(!l) return;
        delete l.players[socket.id]; socket.leave(id); socket.lobbyId = null;
        if(Object.keys(l.players).length === 0) { delete lobbies[id]; } else { if(l.host === socket.id) l.host = Object.keys(l.players)[0]; io.to(id).emit('lobbyUpdate', { players: Object.values(l.players), host: l.host, state: l.state, max: l.max }); }
    });

    socket.on('hostStartVoteMode', () => { 
        let l = lobbies[socket.lobbyId]; 
        if(l && l.host === socket.id && l.state === 'waiting' && Object.keys(l.players).length >= 2) { 
            startGameFlow(l.id); 
        } 
    });
    
    socket.on('voteMode', mode => { let l = lobbies[socket.lobbyId]; if(l && l.state === 'voting_mode' && l.votesMode[mode]!==undefined) l.votesMode[mode]++; });
    socket.on('voteDiff', diff => { let l = lobbies[socket.lobbyId]; if(l && l.state === 'voting_diff' && l.votesDiff[diff]!==undefined) l.votesDiff[diff]++; });

    socket.on('playerMove', data => { let l = lobbies[socket.lobbyId]; if (l && l.players[socket.id] && !l.players[socket.id].isDead) { l.players[socket.id].x = data.x; l.players[socket.id].z = data.z; socket.to(l.id).emit('playersUpdate', l.players); } });
    socket.on('monsterMove', data => { let l = lobbies[socket.lobbyId]; if(l) socket.to(l.id).emit('monsterUpdate', data); });
    
    socket.on('requestMonsterTp', targetId => {
        let l = lobbies[socket.lobbyId]; if(!l || socket.id !== l.monsterId) return;
        let t = l.players[targetId]; if(!t) return;
        let validSpots = []; let px = t.x; let pz = t.z;
        // Телепорт монстра от 5 до 10 блоков (чтобы не прямо в лицо)
        for(let z=1; z<MAP_SIZE-1; z++) for(let x=1; x<MAP_SIZE-1; x++) if(l.mapData[z][x] === 0) { let dist = Math.hypot(x*BLOCK_SIZE - px, z*BLOCK_SIZE - pz); if(dist >= 5 && dist <= 10) validSpots.push({x: x*BLOCK_SIZE, z: z*BLOCK_SIZE}); }
        if(validSpots.length > 0) { let spot = validSpots[Math.floor(Math.random() * validSpots.length)]; io.to(l.id).emit('monsterTeleported', spot); }
    });

    socket.on('keyCollected', kid => { let l = lobbies[socket.lobbyId]; if(l) { l.keysCollected++; io.to(l.id).emit('keyUpdate', { id: kid, count: l.keysCollected }); if(l.keysCollected >= l.maxKeys) io.to(l.id).emit('exitOpened'); }});
    socket.on('playerDied', () => { let l = lobbies[socket.lobbyId]; if(l && l.players[socket.id]) { l.players[socket.id].isDead = true; io.to(l.id).emit('playerDiedEvent', socket.id); checkGameEnd(l.id); }});
    socket.on('monsterKilledPlayer', pid => { let l = lobbies[socket.lobbyId]; if(l && l.players[pid] && !l.players[pid].isDead) { l.players[pid].isDead = true; io.to(l.id).emit('playerDiedEvent', pid); checkGameEnd(l.id); }});
    socket.on('playerEscaped', () => { let l = lobbies[socket.lobbyId]; if (l && l.state === 'playing') { l.state = 'waiting'; resetLobby(l); io.to(l.id).emit('gameWon', l.players[socket.id].name); } });

    socket.on('disconnect', () => {
        let id = socket.lobbyId; let l = lobbies[id]; if(!l) return; delete l.players[socket.id];
        if(Object.keys(l.players).length === 0) { delete lobbies[id]; } else { if(l.host === socket.id) l.host = Object.keys(l.players)[0]; io.to(id).emit('lobbyUpdate', { players: Object.values(l.players), host: l.host, state: l.state, max: l.max }); io.to(id).emit('playerDiedEvent', socket.id); checkGameEnd(id); }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
