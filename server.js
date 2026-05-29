const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));

const MAP_SIZE = 21;
const BLOCK_SIZE = 4;

let lobbies = {};

const folderScalingMap = {
    2: 12, 3: 14, 4: 16, 5: 20, 6: 26, 7: 28, 8: 32
};

const monsterSpeeds = {
    easy: 3.5, normal: 4.8, hard: 5.8, extreme: 7.0
};

// --- ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ДЛЯ A* ПОИСКА ПУТИ (СЕРВЕР) ---
function worldToGrid(wx, wz) { 
    return { x: Math.round(wx / BLOCK_SIZE), z: Math.round(wz / BLOCK_SIZE) }; 
}

function gridNeighbors(node, mapData) {
    const dirs = [[1,0],[-1,0],[0,1],[0,-1]]; 
    const res = [];
    for (let d of dirs) {
        const nx = node.x + d[0], nz = node.z + d[1];
        if (nx >= 1 && nx < MAP_SIZE-1 && nz >= 1 && nz < MAP_SIZE-1 && mapData[nz][nx] === 0) {
            res.push({x: nx, z: nz});
        }
    }
    return res;
}

function heuristic(a, b) { 
    return Math.abs(a.x - b.x) + Math.abs(a.z - b.z); 
}

function astar(start, goal, mapData, maxNodes = 1500) {
    const key = (n) => `${n.x},${n.z}`;
    let open = [{node: start, f: heuristic(start, goal), g:0}];
    let cameFrom = {}; let gScore = {}; gScore[key(start)] = 0;
    let closed = new Set(); let nodesProcessed = 0;
    
    while (open.length > 0 && nodesProcessed < maxNodes) {
        open.sort((a,b) => a.f - b.f); 
        let current = open.shift().node; 
        nodesProcessed++;
        
        if (current.x === goal.x && current.z === goal.z) {
            let path = []; let curKey = key(current);
            while (cameFrom[curKey]) { 
                path.push(current); 
                current = cameFrom[curKey]; 
                curKey = key(current); 
            }
            path.reverse(); 
            return path;
        }
        
        closed.add(key(current));
        
        for (let neigh of gridNeighbors(current, mapData)) {
            let nkey = key(neigh); 
            if (closed.has(nkey)) continue;
            
            let tentativeG = gScore[key(current)] + 1;
            if (gScore[nkey] === undefined || tentativeG < gScore[nkey]) {
                cameFrom[nkey] = current; 
                gScore[nkey] = tentativeG;
                let f = tentativeG + heuristic(neigh, goal);
                if (!open.some(o => o.node.x===neigh.x && o.node.z===neigh.z)) {
                    open.push({node: neigh, f: f, g: tentativeG});
                }
            }
        }
    } 
    return [];
}
// -----------------------------------------------------------

function generateServerMap() {
    let mapData = Array(MAP_SIZE).fill(0).map(() => Array(MAP_SIZE).fill(1));
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
    
    for(let z=1; z<MAP_SIZE-1; z++) {
        for(let x=1; x<MAP_SIZE-1; x++) {
            if(mapData[z][x] === 1 && Math.random() < 0.22) {
                let openNeighbors = 0;
                if(mapData[z-1][x] === 0) openNeighbors++;
                if(mapData[z+1][x] === 0) openNeighbors++;
                if(mapData[z][x-1] === 0) openNeighbors++;
                if(mapData[z][x+1] === 0) openNeighbors++;
                if (openNeighbors >= 2) mapData[z][x] = 0; 
            }
        }
    }
    return mapData;
}

function getEmptySpots(mapData) {
    let spots = [];
    for(let z=1; z<MAP_SIZE-1; z++) {
        for(let x=1; x<MAP_SIZE-1; x++) {
            if(mapData[z][x] === 0) spots.push({x: x, z: z});
        }
    }
    return spots.sort(() => Math.random() - 0.5);
}

function checkServerWallCollision(mapData, nx, nz, radius) {
    let col = Math.round(nx / BLOCK_SIZE);
    let row = Math.round(nz / BLOCK_SIZE);
    if(col < 0 || col >= MAP_SIZE || row < 0 || row >= MAP_SIZE) return true;
    for(let z = row-1; z <= row+1; z++) {
        for(let x = col-1; x <= col+1; x++) {
            if(x >= 0 && x < MAP_SIZE && z >= 0 && z < MAP_SIZE && mapData[z][x] === 1) {
                let wallX = x * BLOCK_SIZE; let wallZ = z * BLOCK_SIZE; let hs = BLOCK_SIZE / 2;
                if (nx + radius > wallX - hs && nx - radius < wallX + hs && nz + radius > wallZ - hs && nz - radius < wallZ + hs) return true;
            }
        }
    }
    return false;
}

function broadcastLobbiesList() {
    let list = Object.values(lobbies).map(r => ({
        id: r.id,
        name: r.name,
        maxPlayers: r.maxPlayers,
        playerCount: Object.keys(r.players).length,
        hasPassword: r.password.length > 0,
        gameState: r.gameState
    }));
    io.emit('lobbiesListUpdate', list);
}

function runVotingOrchestrator(room) {
    room.gameState = 'voting_mode';
    room.votingStage = 'mode';
    room.votingTimer = 15;
    room.votes = { normal: 0, monster: 0 };
    room.playerVotes = {};

    io.to(room.id).emit('startVotingStage', {
        stage: 'mode',
        timeLeft: room.votingTimer,
        stateData: {}
    });

    room.intervalId = setInterval(() => {
        room.votingTimer--;
        io.to(room.id).emit('votingTimerUpdate', { timeLeft: room.votingTimer, votesData: room.votes });

        if(room.votingTimer <= 0) {
            clearInterval(room.intervalId);
            evaluateModeVoting(room);
        }
    }, 1000);
}

function evaluateModeVoting(room) {
    let chosenMode = 'normal';
    if(room.votes.monster > room.votes.normal) {
        chosenMode = 'monster';
    } else if(room.votes.monster === room.votes.normal) {
        chosenMode = Math.random() > 0.5 ? 'monster' : 'normal';
    }

    room.chosenMode = chosenMode;
    let monsterSocketId = null;
    let monsterName = '';

    if (chosenMode === 'monster') {
        let pIds = Object.keys(room.players);
        monsterSocketId = pIds[Math.floor(Math.random() * pIds.length)];
        room.monsterId = monsterSocketId;
        room.players[monsterSocketId].isMonsterPlayer = true;
        monsterName = room.players[monsterSocketId].name;
    }

    room.gameState = 'voting_reveal';
    room.votingStage = 'reveal';
    room.votingTimer = 8;

    io.to(room.id).emit('startVotingStage', {
        stage: 'reveal',
        timeLeft: room.votingTimer,
        stateData: { chosenMode, monsterName }
    });

    room.intervalId = setInterval(() => {
        room.votingTimer--;
        io.to(room.id).emit('votingTimerUpdate', { timeLeft: room.votingTimer });

        if(room.votingTimer <= 0) {
            clearInterval(room.intervalId);
            runDifficultyVoting(room);
        }
    }, 1000);
}

function runDifficultyVoting(room) {
    if (room.chosenMode === 'monster') {
        let diffs = ['normal', 'hard', 'extreme'];
        room.difficulty = diffs[Math.floor(Math.random() * diffs.length)];
        finalizeAndStartMatch(room);
        return;
    }

    room.gameState = 'voting_diff';
    room.votingStage = 'difficulty';
    room.votingTimer = 15;
    room.votes = { easy: 0, normal: 0, hard: 0, extreme: 0 };
    room.playerVotes = {};

    io.to(room.id).emit('startVotingStage', {
        stage: 'difficulty',
        timeLeft: room.votingTimer,
        stateData: {}
    });

    room.intervalId = setInterval(() => {
        room.votingTimer--;
        io.to(room.id).emit('votingTimerUpdate', { timeLeft: room.votingTimer, votesData: room.votes });

        if(room.votingTimer <= 0) {
            clearInterval(room.intervalId);
            finalizeAndStartMatch(room);
        }
    }, 1000);
}

function finalizeAndStartMatch(room) {
    room.gameState = 'playing';
    
    let finalDifficulty = 'normal';
    if (room.chosenMode !== 'monster') {
        let maxVotes = -1;
        let candidates = [];
        
        for(let diff in room.votes) {
            if(room.votes[diff] > maxVotes) {
                maxVotes = room.votes[diff];
                candidates = [diff];
            } else if(room.votes[diff] === maxVotes) {
                candidates.push(diff);
            }
        }

        if(maxVotes === 0) {
            let pool = ['normal', 'hard', 'extreme'];
            finalDifficulty = pool[Math.floor(Math.random() * pool.length)];
        } else {
            if(candidates.length > 1) {
                let filteredPool = candidates.filter(c => c !== 'easy');
                if (filteredPool.length > 0) {
                    finalDifficulty = filteredPool[Math.floor(Math.random() * filteredPool.length)];
                } else {
                    finalDifficulty = candidates[Math.floor(Math.random() * candidates.length)];
                }
            } else {
                finalDifficulty = candidates[0];
            }
        }
        room.difficulty = finalDifficulty;
    }

    room.mapData = generateServerMap();
    let spots = getEmptySpots(room.mapData);

    let pCount = Object.keys(room.players).length;
    let foldersCount = folderScalingMap[pCount] || 16;
    room.maxKeys = foldersCount;
    room.keysCollected = 0;

    let keys = [];
    for(let i=0; i<foldersCount; i++) {
        let s = spots.pop();
        keys.push({id: i, x: s.x, z: s.z, active: true});
    }
    room.keys = keys;

    let exitSpot = spots.pop();
    room.exitDoor = {x: exitSpot.x, z: exitSpot.z, active: false};

    let pSpot = spots.pop();
    
    let mSpot = null;
    for(let i=0; i<spots.length; i++) {
        let s = spots[i];
        let blockDist = Math.hypot(s.x - pSpot.x, s.z - pSpot.z);
        if (blockDist >= 6) {
            mSpot = s;
            spots.splice(i, 1);
            break;
        }
    }
    if(!mSpot) mSpot = spots.pop();

    room.monster = {
        x: mSpot.x * BLOCK_SIZE,
        z: mSpot.z * BLOCK_SIZE,
        dirX: 1, dirZ: 0,
        teleportTimer: 0,
        targetId: null,
        path: [],
        pathIndex: 0,
        lastPGrid: null
    };

    const colors = [0x33ff33, 0x33ffff, 0xffff33, 0xff33ff, 0xff9900, 0xffffff, 0x8888ff, 0xaaaaaa];
    let idx = 0;

    for(let id in room.players) {
        let p = room.players[id];
        if (p.isMonsterPlayer) {
            p.x = room.monster.x;
            p.z = room.monster.z;
        } else {
            p.x = pSpot.x * BLOCK_SIZE + (Math.random() - 0.5) * 1.5;
            p.z = pSpot.z * BLOCK_SIZE + (Math.random() - 0.5) * 1.5;
        }
        p.isDead = false;
        p.color = colors[idx % colors.length];
        p.isRunning = false;
        idx++;
    }

    startMatchLoops(room);

    io.to(room.id).emit('gameStarted', {
        mapData: room.mapData,
        keys: room.keys,
        exitDoor: room.exitDoor,
        players: room.players,
        difficulty: room.difficulty,
        foldersTarget: room.maxKeys,
        monster: { x: room.monster.x, z: room.monster.z },
        mode: room.chosenMode,
        monsterSpeed: monsterSpeeds[room.difficulty]
    });
    
    broadcastLobbiesList();
}

function startMatchLoops(room) {
    room.radarInterval = setInterval(() => {
        if (room.gameState !== 'playing') return;
        io.to(room.id).emit('monsterRadarPing');
    }, 15000);

    room.teleportCheckTimer = 0;
    
    // Server Tick = 500ms
    room.matchLogicInterval = setInterval(() => {
        if (room.gameState !== 'playing') return;

        if (room.chosenMode === 'monster' && room.monsterId) {
            let allFar = true;
            for(let id in room.players) {
                let p = room.players[id];
                if(!p.isDead && !p.isMonsterPlayer) {
                    let d = Math.hypot(p.x - room.monster.x, p.z - room.monster.z);
                    if (d <= 26) { allFar = false; break; } 
                }
            }

            if(allFar) {
                room.teleportCheckTimer += 0.5;
                if(room.teleportCheckTimer >= 5.0) {
                    io.to(room.monsterId).emit('teleportCooldownUpdate', { available: true });
                }
            } else {
                room.teleportCheckTimer = 0;
                io.to(room.monsterId).emit('teleportCooldownUpdate', { available: false });
            }

            for(let id in room.players) {
                let p = room.players[id];
                if(!p.isDead && !p.isMonsterPlayer) {
                    let d = Math.hypot(p.x - room.monster.x, p.z - room.monster.z);
                    if(d < 1.3) {
                        p.isDead = true;
                        io.to(room.id).emit('playerDiedEvent', id);
                        checkMatchEndConditions(room);
                        break;
                    }
                }
            }
        }

        // НОВЫЙ A* ИИ ДЛЯ ОБЫЧНОГО РЕЖИМА
        if (room.chosenMode === 'normal') {
            let target = null;
            
            if (room.monster.targetId && room.players[room.monster.targetId] && !room.players[room.monster.targetId].isDead) {
                target = room.players[room.monster.targetId];
            } else {
                let minDist = Infinity;
                for(let id in room.players) {
                    let p = room.players[id];
                    if(!p.isDead) {
                        let d = Math.hypot(p.x - room.monster.x, p.z - room.monster.z);
                        if(d < minDist) { minDist = d; target = p; room.monster.targetId = id; }
                    }
                }
            }

            if (target) {
                let dt = 0.5; // Tick is 500ms
                let moveDist = monsterSpeeds[room.difficulty] * dt;

                let mGrid = worldToGrid(room.monster.x, room.monster.z);
                let pGrid = worldToGrid(target.x, target.z);

                // Если пути нет, или цель сильно сместилась -> перерасчёт
                if (!room.monster.path || room.monster.path.length === 0 || heuristic(pGrid, room.monster.lastPGrid || pGrid) >= 2) {
                    room.monster.path = astar(mGrid, pGrid, room.mapData);
                    room.monster.pathIndex = 0;
                    room.monster.lastPGrid = pGrid;
                }

                if (room.monster.path && room.monster.pathIndex < room.monster.path.length) {
                    let nextNode = room.monster.path[room.monster.pathIndex];
                    let targetX = nextNode.x * BLOCK_SIZE;
                    let targetZ = nextNode.z * BLOCK_SIZE;

                    let mdx = targetX - room.monster.x;
                    let mdz = targetZ - room.monster.z;
                    let dist = Math.hypot(mdx, mdz);

                    if (dist > 0.1) {
                        let step = Math.min(moveDist, dist);
                        room.monster.x += (mdx / dist) * step;
                        room.monster.z += (mdz / dist) * step;
                        room.monster.dirX = mdx / dist;
                        room.monster.dirZ = mdz / dist;
                    }

                    if (dist <= moveDist) {
                        room.monster.pathIndex++;
                    }

                    io.to(room.id).emit('monsterUpdate', room.monster);
                }

                // Проверка на убийство
                if (Math.hypot(target.x - room.monster.x, target.z - room.monster.z) < 1.3) {
                    target.isDead = true;
                    io.to(room.id).emit('playerDiedEvent', target.id);
                    room.monster.targetId = null; // Сброс цели для следующего тика
                    checkMatchEndConditions(room);
                }
            }
        }

    }, 500);
}

function checkMatchEndConditions(room) {
    if (room.gameState !== 'playing') return;

    let totalHumans = Object.values(room.players).filter(p => !p.isMonsterPlayer);
    let aliveHumans = totalHumans.filter(p => !p.isDead).length;

    if (room.chosenMode === 'monster') {
        if(aliveHumans === 0) {
            endMatchSession(room, 'monster');
        }
    } else {
        let totalAlive = Object.values(room.players).filter(p => !p.isDead).length;
        if(totalAlive === 0) {
            endMatchSession(room, 'monster');
        }
    }
}

function endMatchSession(room, winningTeam) {
    room.gameState = 'waiting';
    clearInterval(room.radarInterval);
    clearInterval(room.matchLogicInterval);
    if(room.intervalId) clearInterval(room.intervalId);

    io.to(room.id).emit('gameResultEvent', { winner: winningTeam });
    
    for(let id in room.players) {
        room.players[id].isDead = false;
        room.players[id].isMonsterPlayer = false;
    }
    room.monsterId = null;
    broadcastLobbiesList();
}

io.on('connection', (socket) => {
    
    socket.on('getLobbiesList', () => { broadcastLobbiesList(); });

    socket.on('createLobby', (data) => {
        let roomId = 'room_' + Math.random().toString(36).substr(2, 9);
        lobbies[roomId] = {
            id: roomId,
            name: data.name,
            password: data.password || '',
            maxPlayers: data.maxPlayers,
            creatorId: socket.id,
            players: {},
            gameState: 'waiting',
            votingStage: '',
            votingTimer: 0,
            votes: {},
            playerVotes: {}
        };

        lobbies[roomId].players[socket.id] = {
            id: socket.id,
            name: data.playerName,
            x: 0, z: 0, isDead: false, isMonsterPlayer: false, color: 0xffffff
        };

        socket.join(roomId);
        socket.emit('joinSuccess', lobbies[roomId]);
        
        io.to(roomId).emit('lobbyPlayersUpdate', {
            players: Object.values(lobbies[roomId].players),
            creatorId: lobbies[roomId].creatorId,
            maxPlayers: lobbies[roomId].maxPlayers
        });

        broadcastLobbiesList();
    });

    socket.on('joinLobby', (data) => {
        let room = lobbies[data.roomId];
        if(!room) return socket.emit('joinError', 'Лобби не существует.');
        
        if(room.gameState !== 'waiting') return socket.emit('joinError', 'Игра в этой комнате уже началась.');
        
        let pCount = Object.keys(room.players).length;
        if(pCount >= room.maxPlayers) return socket.emit('joinError', 'Лобби полностью заполнено.');

        if(room.password.length > 0 && room.password !== data.password) {
            if(data.password === undefined) { return socket.emit('passwordRequired', room.id); } 
            else { return socket.emit('joinError', 'Неверный пароль лобби.'); }
        }

        let nameExists = Object.values(room.players).some(p => p.name === data.name);
        if(nameExists) return socket.emit('joinError', 'Этот ник уже занят в комнате!');

        room.players[socket.id] = {
            id: socket.id,
            name: data.name,
            x: 0, z: 0, isDead: false, isMonsterPlayer: false, color: 0xffffff
        };

        socket.join(room.id);
        socket.emit('joinSuccess', room);
        
        io.to(room.id).emit('lobbyPlayersUpdate', {
            players: Object.values(room.players),
            creatorId: room.creatorId,
            maxPlayers: room.maxPlayers
        });

        broadcastLobbiesList();
    });

    socket.on('adminTriggerStart', () => {
        let room = Object.values(lobbies).find(r => r.creatorId === socket.id && r.gameState === 'waiting');
        if(room && Object.keys(room.players).length >= 2) {
            runVotingOrchestrator(room);
            broadcastLobbiesList();
        }
    });

    socket.on('adminDismissLobby', () => {
        let room = Object.values(lobbies).find(r => r.creatorId === socket.id);
        if(room) {
            io.to(room.id).emit('lobbyDismissed');
            if(room.intervalId) clearInterval(room.intervalId);
            clearInterval(room.radarInterval);
            clearInterval(room.matchLogicInterval);
            delete lobbies[room.id];
            broadcastLobbiesList();
        }
    });

    socket.on('submitMatchVote', (voteType) => {
        let room = Object.values(lobbies).find(r => r.players[socket.id] !== undefined);
        if(!room || room.playerVotes[socket.id]) return;

        if((room.gameState === 'voting_mode' && (voteType === 'normal' || voteType === 'monster')) ||
           (room.gameState === 'voting_diff' && ['easy','normal','hard','extreme'].includes(voteType))) {
            
            room.playerVotes[socket.id] = voteType;
            if(room.votes[voteType] !== undefined) {
                room.votes[voteType]++;
            }
            io.to(room.id).emit('votingTimerUpdate', { timeLeft: room.votingTimer, votesData: room.votes });
        }
    });

    socket.on('playerMove', (data) => {
        let room = Object.values(lobbies).find(r => r.players[socket.id] !== undefined);
        if (room && room.gameState === 'playing' && room.players[socket.id]) {
            room.players[socket.id].x = data.x;
            room.players[socket.id].z = data.z;
            room.players[socket.id].isRunning = data.isRunning;
            socket.to(room.id).emit('playersUpdate', room.players);
        }
    });

    socket.on('monsterMove', (data) => {
        let room = Object.values(lobbies).find(r => r.players[socket.id] !== undefined);
        if (room && room.gameState === 'playing' && room.monsterId === socket.id) {
            room.monster.x = data.x;
            room.monster.z = data.z;
            room.monster.dirX = data.dirX;
            room.monster.dirZ = data.dirZ;
            socket.to(room.id).emit('monsterUpdate', room.monster);
        }
    });

    socket.on('requestMonsterTeleport', () => {
        let room = Object.values(lobbies).find(r => r.players[socket.id] !== undefined);
        if (room && room.gameState === 'playing' && room.monsterId === socket.id && room.teleportCheckTimer >= 5.0) {
            let humanTargets = Object.values(room.players).filter(p => !p.isMonsterPlayer && !p.isDead);
            if(humanTargets.length > 0) {
                let randomHuman = humanTargets[Math.floor(Math.random() * humanTargets.length)];
                
                let validSpots = [];
                let pg = {x: Math.floor(randomHuman.x/BLOCK_SIZE), z: Math.floor(randomHuman.z/BLOCK_SIZE)};
                for(let z = Math.max(1, pg.z - 6); z <= Math.min(MAP_SIZE-2, pg.z + 6); z++) {
                    for(let x = Math.max(1, pg.x - 6); x <= Math.min(MAP_SIZE-2, pg.x + 6); x++) {
                        if(room.mapData[z][x] === 0) {
                            let dist = Math.hypot(x - pg.x, z - pg.z);
                            if(dist >= 4.0 && dist <= 5.5) { 
                                validSpots.push({x: x, z: z});
                            }
                        }
                    }
                }
                
                if(validSpots.length > 0) {
                    let spot = validSpots[Math.floor(Math.random() * validSpots.length)];
                    room.monster.x = spot.x * BLOCK_SIZE;
                    room.monster.z = spot.z * BLOCK_SIZE;
                } else {
                    room.monster.x = randomHuman.x - 16; 
                    room.monster.z = randomHuman.z - 16;
                }
                
                room.teleportCheckTimer = 0;
                io.to(room.id).emit('monsterUpdate', room.monster);
                io.to(room.monsterId).emit('teleportCooldownUpdate', { available: false });
            }
        }
    });

    socket.on('keyCollected', (keyId) => {
        let room = Object.values(lobbies).find(r => r.players[socket.id] !== undefined);
        if (room && room.gameState === 'playing' && room.keys[keyId] && room.keys[keyId].active) {
            room.keys[keyId].active = false;
            room.keysCollected++;
            io.to(room.id).emit('keyUpdate', { id: keyId, count: room.keysCollected });
            if (room.keysCollected >= room.maxKeys) {
                room.exitDoor.active = true;
                io.to(room.id).emit('exitOpened');
            }
        }
    });

    socket.on('playerDied', () => {
        let room = Object.values(lobbies).find(r => r.players[socket.id] !== undefined);
        if (room && room.gameState === 'playing' && room.players[socket.id]) {
            room.players[socket.id].isDead = true;
            io.to(room.id).emit('playerDiedEvent', socket.id);
            checkMatchEndConditions(room);
        }
    });
    
    socket.on('playerEscaped', () => {
        let room = Object.values(lobbies).find(r => r.players[socket.id] !== undefined);
        if (room && room.gameState === 'playing' && room.players[socket.id] && !room.players[socket.id].isMonsterPlayer) {
            endMatchSession(room, 'survivors');
        }
    });

    socket.on('leaveLobby', () => { handleUserDisconnection(socket); });
    socket.on('disconnect', () => { handleUserDisconnection(socket); });
});

function handleUserDisconnection(socket) {
    for (let roomId in lobbies) {
        let room = lobbies[roomId];
        if (room.players[socket.id]) {
            let wasMonster = (room.monsterId === socket.id);
            delete room.players[socket.id];
            
            socket.leave(room.id);

            if (Object.keys(room.players).length === 0) {
                clearInterval(room.radarInterval);
                clearInterval(room.matchLogicInterval);
                if(room.intervalId) clearInterval(room.intervalId);
                delete lobbies[roomId];
            } else {
                if (room.creatorId === socket.id) {
                    let nextAdmin = Object.keys(room.players)[0];
                    room.creatorId = nextAdmin;
                }

                if (room.gameState === 'playing') {
                    if (wasMonster) {
                        endMatchSession(room, 'survivors');
                    } else {
                        checkMatchEndConditions(room);
                    }
                } else {
                    io.to(room.id).emit('lobbyPlayersUpdate', {
                        players: Object.values(room.players),
                        creatorId: room.creatorId,
                        maxPlayers: room.maxPlayers
                    });
                }
            }
            broadcastLobbiesList();
            break;
        }
    }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
