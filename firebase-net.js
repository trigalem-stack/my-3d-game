/* =========================================================
   firebase-net.js — Сетевой слой на Firebase Realtime Database
   Короткие имена полей, округление координат, троттлинг, хост-логика.
   Пути в БД (однобуквенные — экономим трафик):
     L/                     список лобби
     L/<roomId>/n           название комнаты
     L/<roomId>/pa          есть ли пароль (true/false)
     L/<roomId>/pw          хеш/пароль (если pa=true) — в открытом виде для простоты, но лучше включить защиту через Security Rules
     L/<roomId>/mx          максимум игроков
     L/<roomId>/h           ключ хоста (игрока, кто создал)
     L/<roomId>/g           gameState: waiting | voting_mode | voting_reveal | voting_diff | playing | over
     L/<roomId>/s           votingStage
     L/<roomId>/t           таймер голосования
     L/<roomId>/v           голоса {normal:N, monster:N, easy:N, normal:N, hard:N, extreme:N}
     L/<roomId>/pv          кто за что проголосовал {uid: voteKey}
     L/<roomId>/cm          выбранный режим ('normal'/'monster')
     L/<roomId>/mn          имя монстра (для режима monster)
     L/<roomId>/mid         ключ игрока-монстра
     L/<roomId>/df          сложность
     L/<roomId>/ft          кол-во папок для сбора
     L/<roomId>/seed        сид карты (для детерминированной генерации на клиентах)
     L/<roomId>/P/<uid>/    данные игрока: n, x, z, r(running), d(dead), m(isMonster), c(color)
     L/<roomId>/M/          данные монстра (ИИ-монстр в normal mode): x, z, dx, dz
     L/<roomId>/K/<i>/a     ключ i собран? (a=active boolean)
     L/<roomId>/Kc          собрано ключей
     L/<roomId>/E/a         выход открыт?
     L/<roomId>/w           победитель ('monster'/'survivors')
     L/<roomId>/tp          доступность телепорта монстру (a, sec)
     L/<roomId>/rp          флаг радар-пинга (monster vision)
   ========================================================= */

const NET = {
    SEND_EVERY_MS: 150,     // ~6.5 раз/сек (не слишком часто)
    COORD_DECIMALS: 1,      // округляем координаты до 1 знака (≈40 см — визуально незаметно)
    lastSentX: null, lastSentZ: null, lastSentR: null,
    lastSentMX: null, lastSentMZ: null, lastSentMDX: null, lastSentMDZ: null,
    myUid: null,
    connected: false
};

function fbInit() {
    if (NET.connected && NET.db) return NET.db;
    if (!firebaseConfig || !firebaseConfig.apiKey || String(firebaseConfig.apiKey).startsWith('ВСТАВЬТЕ')) {
        alert('❌ Вставьте свой firebaseConfig в начало index.html!\n\nОткройте index.html в блокноте, найдите "const firebaseConfig = {" и вставьте туда значения из консоли Firebase.');
        throw new Error('firebaseConfig не настроен');
    }
    if (!firebaseConfig.databaseURL) {
        alert('❌ В firebaseConfig НЕТ databaseURL!\n\nСоздайте Realtime Database (не Firestore!) и выберите регион eur3 (Europe-West).\nВ консоли Firebase → Realtime Database → вверху будет адрес вида:\nhttps://ВАШ-ПРОЕКТ-default-rtdb.europe-west1.firebasedatabase.app\n\nЕго нужно вставить в поле databaseURL внутри firebaseConfig в index.html.');
        throw new Error('databaseURL отсутствует');
    }
    try {
        if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
        NET.db = firebase.database();
    } catch(e) {
        console.error('Firebase init error:', e);
        alert('❌ Ошибка инициализации Firebase:\n' + e.message);
        throw e;
    }

    // Индикатор подключения (смотрим в консоль браузера)
    try {
        const cr = NET.db.ref('.info/connected');
        cr.off('value', NET._connCb);
        NET._connCb = (snap) => {
            if (snap.val() === true) console.log('%c[Firebase] ✓ Подключено', 'color:#0a0; font-weight:bold');
            else console.warn('[Firebase] Нет соединения (возможно, домен не в Authorized domains)');
        };
        cr.on('value', NET._connCb);
    } catch(e) { console.warn(e); }

    NET.connected = true;
    return NET.db;
}

function fbRound(v) { return Math.round(v * 10) / 10; }

// ---------- Лобби ----------
function fbSubscribeLobbies(renderCallback) {
    const ref = NET.db.ref('L');
    ref.on('value', (snap) => {
        const val = snap.val() || {};
        const list = [];
        for (const id in val) {
            const r = val[id];
            // Не показываем лобби в статусе over и старые (upkeep на хосте удаляет их)
            if (r.g === 'over') continue;
            const players = r.P || {};
            const pc = Object.keys(players).length;
            list.push({
                id,
                name: r.n || 'Без названия',
                hasPassword: !!r.pa,
                maxPlayers: r.mx || 8,
                playerCount: pc,
                gameState: r.g || 'waiting'
            });
        }
        renderCallback(list);
    });
    NET._lobRef = ref;
}

function fbUnsubscribeLobbies() {
    if (NET._lobRef) { NET._lobRef.off(); NET._lobRef = null; }
}

function fbCreateLobby({ name, password, maxPlayers, playerName, onJoin, onPlayers, onDismiss, onStateChange }) {
    fbInit();
    const roomId = 'r' + Math.random().toString(36).slice(2, 9);
    const uid = 'u' + Math.random().toString(36).slice(2, 9);
    NET.myUid = uid;
    const color = 0xd4b848; // хост жёлтый
    const ref = NET.db.ref('L/' + roomId);

    const room = {
        n: name,
        pa: !!password,
        mx: maxPlayers,
        h: uid,
        g: 'waiting',
        s: '',
        t: 0,
        v: {},
        pv: {},
        cm: '',
        mn: '',
        mid: '',
        df: 'normal',
        ft: 8,
        seed: 0,
        Kc: 0,
        E: { a: false },
        M: { x: 0, z: 0, dx: 0, dz: 0 },
        w: '',
        tp: { a: false, s: 0 },
        rp: 0,
        P: {
            [uid]: { n: playerName, x: 0, z: 0, r: false, d: false, m: false, c: color, ts: Date.now() }
        }
    };
    if (password) room.pw = password;

    ref.set(room, (err) => {
        if (err) {
            console.error('Create lobby error:', err);
            let msg = '❌ Не удалось создать лобби:\n' + err.message + '\n\n';
            if (err.code === 'PERMISSION_DENIED') {
                msg += 'Причина: в Firebase не опубликованы правила БД из database.rules.json.\nОткройте Firebase → Realtime Database → Rules и вставьте содержимое файла database.rules.json, затем нажмите Publish.';
            } else {
                msg += 'Проверьте:\n• Realtime Database создана (не перепутайте с Firestore)\n• Регион eur3 (Europe-West)\n• Опубликованы правила из database.rules.json\n• Сайт открыт через http://localhost или github.io (не file:// — дважды клик по index.html в папке НЕ РАБОТАЕТ! Нужно открывать через сервер)';
            }
            alert(msg);
            return;
        }
        fbAttachRoom({ roomId, uid, onJoin, onPlayers, onDismiss, onStateChange });
    });
    return roomId;
}

function fbJoinLobby({ roomId, password, playerName, onJoin, onPlayers, onDismiss, onStateChange, onPassword, onError }) {
    fbInit();
    const ref = NET.db.ref('L/' + roomId);
    ref.once('value', (snap) => {
        const room = snap.val();
        if (!room) { onError('Лобби не существует'); return; }
        if (room.g !== 'waiting') { onError('Игра уже началась'); return; }
        const players = room.P || {};
        const pc = Object.keys(players).length;
        if (pc >= (room.mx || 8)) { onError('Лобби заполнено'); return; }
        if (room.pa && room.pw !== password) { onPassword && onPassword(roomId); return; }
        for (const k in players) if (players[k].n === playerName) { onError('Этот ник уже занят'); return; }

        const uid = 'u' + Math.random().toString(36).slice(2, 9);
        NET.myUid = uid;
        const color = Math.floor(Math.random() * 0xffffff);
        ref.child('P/' + uid).set({ n: playerName, x: 0, z: 0, r: false, d: false, m: false, c: color, ts: Date.now() }, (err) => {
            if (err) { onError(err.message); return; }
            fbAttachRoom({ roomId, uid, onJoin, onPlayers, onDismiss, onStateChange });
        });
    });
}

function fbAttachRoom({ roomId, uid, onJoin, onPlayers, onDismiss, onStateChange }) {
    NET.roomId = roomId;
    NET.roomRef = NET.db.ref('L/' + roomId);
    NET.myUid = uid;

    // Следим, существует ли комната (если хост всех выгнал)
    NET.roomRef.on('value', (snap) => {
        const room = snap.val();
        if (!room) { onDismiss && onDismiss(); return; }

        // Считаем себя админом/хостом
        const isH = room.h === uid;
        NET.isHost = isH;

        // Уведомляем о входе (только 1 раз)
        if (!NET.joined) {
            NET.joined = true;
            onJoin && onJoin({ id: roomId, name: room.n, creatorId: room.h, maxPlayers: room.mx });
        }

        // Список игроков
        const plist = [];
        for (const k in (room.P || {})) {
            const p = room.P[k];
            plist.push({ id: k, name: p.n, x: p.x, z: p.z, isDead: p.d, isMonsterPlayer: p.m, color: p.c, isRunning: p.r });
        }
        onPlayers && onPlayers({
            players: plist,
            creatorId: room.h,
            maxPlayers: room.mx
        });

        onStateChange && onStateChange(room);
    });

    // При отключении — удаляем себя
    const myPRef = NET.db.ref('L/' + roomId + '/P/' + uid);
    myPRef.onDisconnect().remove();
    NET.myPRef = myPRef;

    // Если хост отвалился — удалить всю комнату (на серверном onDisconnect)
    // (ставим отложенное удаление и переустанавливаем его в каждом onValue, т.к. хост назначается динамически)
    if (NET.isHost) {
        NET.roomRef.onDisconnect().remove();
    }
}

function fbLeaveLobby() {
    if (NET.myPRef) { NET.myPRef.remove(); NET.myPRef.onDisconnect().cancel(); NET.myPRef = null; }
    if (NET.roomRef) { NET.roomRef.off(); NET.roomRef = null; }
    NET.joined = false;
    NET.isHost = false;
    NET.roomId = null;
    fbUnsubscribeLobbies();
}

function fbDismissLobby() {
    if (!NET.roomRef) return;
    NET.roomRef.remove();
    fbLeaveLobby();
}

// ---------- Голосование / старт матча ----------
function fbSubmitVote(voteKey) {
    if (!NET.roomRef) return;
    NET.roomRef.transaction((room) => {
        if (!room) return room;
        if (!room.pv) room.pv = {};
        if (room.pv[NET.myUid]) return; // уже голосовал
        const sg = room.g;
        const okMode = sg === 'voting_mode' && (voteKey === 'normal' || voteKey === 'monster');
        const okDiff = sg === 'voting_diff' && ['easy','normal','hard','extreme'].indexOf(voteKey) !== -1;
        if (!okMode && !okDiff) return;
        room.pv[NET.myUid] = voteKey;
        if (!room.v) room.v = {};
        room.v[voteKey] = (room.v[voteKey] || 0) + 1;
        return room;
    });
}

function fbStartVoting() {
    if (!NET.isHost || !NET.roomRef) return;
    NET.roomRef.update({ g: 'voting_mode', s: 'mode', t: 15, v: {normal:0,monster:0}, pv: {} });
    fbClearTimer('vote');
    NET.voteTicker = setInterval(() => {
        if (!NET.roomRef) return;
        NET.roomRef.transaction((room) => {
            if (!room) return room;
            if (['voting_mode','voting_diff','voting_reveal'].indexOf(room.g) === -1) return room;
            room.t = (room.t || 0) - 1;
            if (room.t <= 0) {
                // переходим на следующий этап
                if (room.g === 'voting_mode') {
                    const mv = (room.v && room.v.monster) || 0, nv = (room.v && room.v.normal) || 0;
                    let chosen = 'normal';
                    if (mv > nv) chosen = 'monster';
                    else if (mv === nv) chosen = Math.random() < 0.5 ? 'monster' : 'normal';
                    room.cm = chosen;
                    room.mid = ''; room.mn = '';
                    if (chosen === 'monster') {
                        const pids = Object.keys(room.P || {});
                        const mid = pids[Math.floor(Math.random()*pids.length)];
                        room.mid = mid;
                        room.mn = room.P[mid].n;
                        room.P[mid].m = true;
                    }
                    room.g = 'voting_reveal'; room.s = 'reveal'; room.t = 8;
                    room.v = {}; room.pv = {};
                } else if (room.g === 'voting_reveal') {
                    if (room.cm === 'monster') {
                        const diffs = ['normal','hard','extreme'];
                        room.df = diffs[Math.floor(Math.random()*diffs.length)];
                        fbStartMatch(room); // переходит к playing
                        return room;
                    } else {
                        room.g = 'voting_diff'; room.s = 'diff'; room.t = 15;
                        room.v = {easy:0,normal:0,hard:0,extreme:0}; room.pv = {};
                    }
                } else if (room.g === 'voting_diff') {
                    let best = 'normal', bestC = -1;
                    for (const k of ['easy','normal','hard','extreme']) {
                        const c = (room.v && room.v[k]) || 0;
                        if (c > bestC) { bestC = c; best = k; }
                    }
                    room.df = best;
                    fbStartMatch(room);
                }
            }
            return room;
        });
    }, 1000);
}

function fbStopTimer() { if (NET.voteTicker) { clearInterval(NET.voteTicker); NET.voteTicker = null; } }

// Детерминированный PRNG по seed чтобы у всех клиентов была одна карта
function fbMulberry32(seed) {
    return function() {
        seed |= 0; seed = seed + 0x6D2B79F5 | 0;
        let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

function fbStartMatch(room) {
    // Инициализация карты и ключей (вызывается хостом внутри транзакции)
    const seed = Math.floor(Math.random()*1e9);
    room.seed = seed;
    room.g = 'playing';
    room.s = ''; room.t = 0; room.v = {}; room.pv = {};
    room.Kc = 0; room.E = {a:false}; room.w = '';
    room.tp = {a:false, s:0}; room.rp = 0;

    // Генерируем карту на хосте и записываем базовые позиции
    const rng = fbMulberry32(seed);
    const MS = 21, BS = 4;
    const map = Array(MS).fill(0).map(()=>Array(MS).fill(1));
    const stack = []; map[1][1] = 0; stack.push({x:1,z:1});
    const dirs = [[0,-2],[0,2],[-2,0],[2,0]];
    while (stack.length) {
        const cur = stack[stack.length-1]; const nb = [];
        for (const d of dirs) {
            const nx = cur.x + d[0], nz = cur.z + d[1];
            if (nx>0 && nx<MS-1 && nz>0 && nz<MS-1 && map[nz][nx]===1) nb.push({x:nx,z:nz,dx:d[0]/2,dz:d[1]/2});
        }
        if (nb.length) {
            const n = nb[Math.floor(rng()*nb.length)];
            map[cur.z+n.dz][cur.x+n.dx] = 0; map[n.z][n.x] = 0;
            stack.push({x:n.x,z:n.z});
        } else stack.pop();
    }
    for (let z=1; z<MS-1; z++) for (let x=1; x<MS-1; x++) {
        if (map[z][x]===1 && rng()<0.25) {
            let c=0;
            if (map[z-1][x]===0) c++; if (map[z+1][x]===0) c++;
            if (map[z][x-1]===0) c++; if (map[z][x+1]===0) c++;
            if (c>=2) map[z][x]=0;
        }
    }
    for (let i=0; i<MS; i++) { map[0][i]=1; map[MS-1][i]=1; map[i][0]=1; map[i][MS-1]=1; }

    const empty = [];
    for (let z=1; z<MS-1; z++) for (let x=1; x<MS-1; x++) if (map[z][x]===0) empty.push({x,z});
    for (let i=empty.length-1; i>0; i--) { const j=Math.floor(rng()*(i+1)); [empty[i],empty[j]]=[empty[j],empty[i]]; }

    const pSpot = empty.pop();
    const keys = [];
    for (let i=0; i<room.ft; i++) { const s = empty.pop(); keys.push({x:s.x,z:s.z,a:true}); }
    // Выход — случайное место далеко от спавна
    let eSpot = empty.find(s => Math.hypot(s.x-pSpot.x, s.z-pSpot.z) > 10) || empty[0] || {x:MS-2,z:MS-2};
    // Позиция монстра (если режим normal — ИИ)
    let mSpot = empty.find(s => Math.hypot(s.x-pSpot.x, s.z-pSpot.z) > 10) || {x:MS-3,z:MS-3};

    room.K = {};
    keys.forEach((k,i) => { room.K[i] = {x:k.x,z:k.z,a:true}; });
    room.E.x = eSpot.x; room.E.z = eSpot.z; room.E.a = false;
    room.M = { x: mSpot.x*BS, z: mSpot.z*BS, dx:1, dz:0 };

    // Расставляем игроков по разным точкам
    let pCount = 0;
    for (const pid in room.P) {
        let sp;
        if (room.cm === 'monster' && pid === room.mid) {
            sp = mSpot; // монстр появляется там же, где ИИ
        } else {
            sp = empty.length > 0 ? empty.pop() : pSpot;
        }
        room.P[pid].x = sp.x*BS; room.P[pid].z = sp.z*BS;
        room.P[pid].d = false; room.P[pid].r = false;
        pCount++;
    }
    return room;
}

// ---------- Игровые эвенты от клиентов ----------
function fbSendMove(x, z, isRunning) {
    if (!NET.myPRef) return;
    const rx = fbRound(x), rz = fbRound(z);
    // Шлём ТОЛЬКО если координаты изменились (с учётом округления)
    if (rx === NET.lastSentX && rz === NET.lastSentRZ && isRunning === NET.lastSentR) return;
    NET.lastSentX = rx; NET.lastSentRZ = rz; NET.lastSentR = isRunning;
    NET.myPRef.update({ x: rx, z: rz, r: !!isRunning, ts: firebase.database.ServerValue.TIMESTAMP });
}

function fbSendMonsterMove(x, z, dx, dz) {
    if (!NET.roomRef || !NET.myPRef) return;
    const rx = fbRound(x), rz = fbRound(z), rdx = fbRound(dx), rdz = fbRound(dz);
    if (rx===NET.lastSentMX && rz===NET.lastSentMZ && rdx===NET.lastSentMDX && rdz===NET.lastSentMDZ) return;
    NET.lastSentMX = rx; NET.lastSentMZ = rz; NET.lastSentMDX = rdx; NET.lastSentMDZ = rdz;
    // Обновляем монстра (в режиме monster игрок-монстр управляет)
    NET.roomRef.child('M').update({ x: rx, z: rz, dx: rdx, dz: rdz });
    NET.myPRef.update({ x: rx, z: rz });
}

function fbSendKeyCollected(idx) {
    if (!NET.roomRef) return;
    NET.roomRef.transaction((room) => {
        if (!room || room.g !== 'playing') return room;
        if (!room.K[idx] || !room.K[idx].a) return;
        room.K[idx].a = false;
        room.Kc = (room.Kc||0) + 1;
        if (room.Kc >= room.ft) room.E.a = true;
        return room;
    });
}

function fbSendPlayerDied() {
    if (!NET.myPRef) return;
    NET.myPRef.update({ d: true });
}

function fbSendPlayerEscaped() {
    if (!NET.roomRef) return;
    NET.roomRef.update({ w: 'survivors', g: 'over' });
}

function fbSendMonsterTeleportRequest() {
    if (!NET.roomRef) return;
    NET.roomRef.child('tp_req').set({ u: NET.myUid, t: firebase.database.ServerValue.TIMESTAMP });
}

// ---------- Подписки на игровые события ----------
function fbOnPlayersUpdate(cb) {
    if (!NET.roomRef) return;
    const ref = NET.roomRef.child('P');
    ref.on('value', (snap) => { cb(snap.val() || {}); });
    NET._puRef = ref;
}
function fbOnMonsterUpdate(cb) {
    if (!NET.roomRef) return;
    const ref = NET.roomRef.child('M');
    ref.on('value', (snap) => { const v = snap.val(); if (v) cb(v); });
    NET._muRef = ref;
}
function fbOnKeysUpdate(cb) {
    if (!NET.roomRef) return;
    const ref = NET.roomRef.child('K');
    ref.on('value', (snap) => { cb(snap.val() || {}); });
    NET._kuRef = ref;
}
function fbOnKeyCount(cb) {
    if (!NET.roomRef) return;
    const ref = NET.roomRef.child('Kc');
    ref.on('value', (snap) => { cb(snap.val() || 0); });
    NET._kcRef = ref;
}
function fbOnExitOpened(cb) {
    if (!NET.roomRef) return;
    const ref = NET.roomRef.child('E/a');
    ref.on('value', (snap) => { if (snap.val()) cb(); });
    NET._exRef = ref;
}
function fbOnGameResult(cb) {
    if (!NET.roomRef) return;
    const ref = NET.roomRef.child('w');
    ref.on('value', (snap) => { const w = snap.val(); if (w) cb(w); });
    NET._wrRef = ref;
}
function fbOnMonsterRadar(cb) {
    if (!NET.roomRef) return;
    const ref = NET.roomRef.child('rp');
    ref.on('value', (snap) => { if (snap.val() && snap.val() > Date.now()-3000) cb(); });
    NET._rpRef = ref;
}
function fbOnTpAvailable(cb) {
    if (!NET.roomRef) return;
    const ref = NET.roomRef.child('tp/a');
    ref.on('value', (snap) => { cb(!!snap.val()); });
    NET._tpRef = ref;
}

// экспорт
window.NET = NET;
window.fbInit = fbInit;
window.fbSubscribeLobbies = fbSubscribeLobbies;
window.fbUnsubscribeLobbies = fbUnsubscribeLobbies;
window.fbCreateLobby = fbCreateLobby;
window.fbJoinLobby = fbJoinLobby;
window.fbLeaveLobby = fbLeaveLobby;
window.fbDismissLobby = fbDismissLobby;
window.fbSubmitVote = fbSubmitVote;
window.fbStartVoting = fbStartVoting;
window.fbStopTimer = fbStopTimer;
window.fbSendMove = fbSendMove;
window.fbSendMonsterMove = fbSendMonsterMove;
window.fbSendKeyCollected = fbSendKeyCollected;
window.fbSendPlayerDied = fbSendPlayerDied;
window.fbSendPlayerEscaped = fbSendPlayerEscaped;
window.fbSendMonsterTeleportRequest = fbSendMonsterTeleportRequest;
window.fbOnPlayersUpdate = fbOnPlayersUpdate;
window.fbOnMonsterUpdate = fbOnMonsterUpdate;
window.fbOnKeysUpdate = fbOnKeysUpdate;
window.fbOnKeyCount = fbOnKeyCount;
window.fbOnExitOpened = fbOnExitOpened;
window.fbOnGameResult = fbOnGameResult;
window.fbOnMonsterRadar = fbOnMonsterRadar;
window.fbOnTpAvailable = fbOnTpAvailable;
window.fbMulberry32 = fbMulberry32;
