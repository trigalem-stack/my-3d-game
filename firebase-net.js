/* firebase-net.js — Сетевой слой Firebase Realtime Database.
   Самостоятельно загружает Firebase SDK с нескольких резервных CDN,
   перебирая их по очереди если какой-то не открылся.
   Конфиг вшит напрямую под проект my-new-server-3d-game (европейский регион). */

const firebaseConfig = {
    apiKey: "AIzaSyAUcbIWTZXpcR78sNLPgAewA3y8bAzQRp8",
    authDomain: "my-new-server-3d-game.firebaseapp.com",
    // ПРАВИЛЬНЫЙ адрес базы (проверен напрямую — отвечает 200 и пишет):
    databaseURL: "https://my-new-server-3d-game-default-rtdb.europe-west1.firebasedatabase.app",
    projectId: "my-new-server-3d-game",
    storageBucket: "my-new-server-3d-game.appspot.com",
    messagingSenderId: "617198460097",
    appId: "1:617198460097:web:afb51d5e14906ec86b4840"
};

const NET = {
    SEND_EVERY_MS: 150,
    COORD_DECIMALS: 1,
    lastSentX: null, lastSentZ: null, lastSentR: null,
    lastSentMX: null, lastSentMZ: null, lastSentMDX: null, lastSentMDZ: null,
    myUid: null, connected: false,
    db: null, roomId: null, roomRef: null, myPRef: null, isHost: false, joined: false
};

function fbSetStatus(text, color, bg) {
    const el = document.getElementById('fbStatusBox');
    if (!el) { setTimeout(()=>fbSetStatus(text,color,bg),100); return; }
    el.textContent = text;
    el.style.color = color || '#aaa';
    el.style.background = bg || '#222';
}

// ================= ДИНАМИЧЕСКАЯ ЗАГРУЗКА FIREBASE SDK v8 ====================
const FB_CDN_SOURCES = [
    "https://www.gstatic.com/firebasejs/8.10.1/firebase-app.js",
    "https://www.gstatic.com/firebasejs/8.10.1/firebase-database.js",
    "https://cdn.jsdelivr.net/npm/firebase@8.10.1/firebase-app.js",
    "https://cdn.jsdelivr.net/npm/firebase@8.10.1/firebase-database.js",
    "https://cdnjs.cloudflare.com/ajax/libs/firebase/8.10.1/firebase-app.min.js",
    "https://cdnjs.cloudflare.com/ajax/libs/firebase/8.10.1/firebase-database.min.js",
    "https://unpkg.com/firebase@8.10.1/firebase-app.js",
    "https://unpkg.com/firebase@8.10.1/firebase-database.js"
];

function loadScript(src) {
    return new Promise((resolve, reject) => {
        if (document.querySelector('script[src="' + src + '"]')) { resolve(); return; }
        const s = document.createElement('script');
        s.src = src; s.async = false;
        s.onload = () => resolve();
        s.onerror = () => reject(new Error('CDN fail: ' + src));
        document.head.appendChild(s);
    });
}

async function fbLoadSDK() {
    fbSetStatus('⏳ Загрузка Firebase SDK...');
    // Пробуем пары (app+db) по порядку - сначала gstatic, потом jsdelivr, cdnjs, unpkg
    const pairs = [];
    for (let i = 0; i < FB_CDN_SOURCES.length; i += 2) {
        pairs.push([FB_CDN_SOURCES[i], FB_CDN_SOURCES[i+1]]);
    }
    // Также пробуем локальные файлы первым делом (если они есть рядом с index.html)
    pairs.unshift(['firebase-app.js', 'firebase-database.js']);

    let lastErr;
    for (let i = 0; i < pairs.length; i++) {
        const [appUrl, dbUrl] = pairs[i];
        const cdnName = appUrl.includes('gstatic') ? 'Google (gstatic)'
                      : appUrl.includes('jsdelivr') ? 'jsDelivr'
                      : appUrl.includes('cdnjs') ? 'cdnjs'
                      : appUrl.includes('unpkg') ? 'unpkg'
                      : 'локальные файлы';
        fbSetStatus('⏳ Пробуем ' + cdnName + ' (' + (i+1) + '/' + pairs.length + ')...', '#ffcc00', '#332a00');
        try {
            await loadScript(appUrl);
            await loadScript(dbUrl);
            if (window.firebase && firebase.database) {
                console.log('[Firebase SDK] загружен с', cdnName);
                return true;
            }
        } catch (e) {
            lastErr = e;
            console.warn('CDN не сработал:', cdnName, e.message);
        }
    }
    fbSetStatus('❌ Все CDN не отвечают. Проверь интернет или включи VPN.', '#ff4444', '#330000');
    alert('❌ Не удалось загрузить Firebase SDK ни с одного сервера.\n\nВозможно твой провайдер блокирует гугловые и популярные CDN. Попробуй:\n1. Включить VPN на 1 минуту, чтобы скрипты подгрузились\n2. Открыть игру с мобильного интернета\n3. Потом снова отключи VPN (сама база firebasedatabase.app работает без VPN)');
    return false;
}

function fbRound(v) { return Math.round(v * 10) / 10; }

function fbInit() {
    if (NET.db) return NET.db;
    if (!window.firebase || !firebase.database) {
        fbSetStatus('❌ SDK не загружен', '#ff4444', '#330000');
        throw new Error('Firebase SDK не загружен');
    }
    try {
        if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
        NET.db = firebase.database();
    } catch(e) {
        fbSetStatus('❌ ' + e.message, '#ff4444', '#330000');
        alert('❌ Ошибка инициализации Firebase:\n' + e.message);
        throw e;
    }
    // Проверка записи в БД
    fbSetStatus('⏳ Проверка связи с базой...', '#ffcc00', '#332a00');
    const testRef = NET.db.ref('__ping__');
    testRef.set(firebase.database.ServerValue.TIMESTAMP, (err) => {
        if (err) {
            fbSetStatus('❌ База отвечает, но запись запрещена (опубликуй правила в Rules!)', '#ff4444', '#330000');
            console.error('Firebase write error:', err);
        } else {
            fbSetStatus('● Firebase подключён (Европа, Бельгия) — онлайн работает', '#00ff66', '#003311');
            testRef.remove();
        }
    });
    const cr = NET.db.ref('.info/connected');
    cr.on('value', s => {
        if (s.val() === true) console.log('%c[Firebase] ✓ Online', 'color:#0a0; font-weight:bold');
    });
    NET.connected = true;
    return NET.db;
}

// Автозагрузка при старте страницы
window.addEventListener('load', async () => {
    // Ждём, пока fbStatusBox появится в DOM
    await new Promise(r => { if (document.getElementById('fbStatusBox')) r(); else setTimeout(()=>{ if(document.getElementById('fbStatusBox')) r(); else setTimeout(r,100);}, 50); });
    const loaded = await fbLoadSDK();
    if (loaded) {
        try { fbInit(); } catch(e) {}
    }
});

// ---------- Лобби ----------
function fbSubscribeLobbies(renderCallback) {
    const ref = NET.db.ref('L');
    ref.on('value', (snap) => {
        const val = snap.val() || {};
        const list = [];
        for (const id in val) {
            const r = val[id];
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
    }, err => {
        if (err.code === 'PERMISSION_DENIED') {
            alert('❌ Правила БД не опубликованы! Зайди в Firebase → Realtime Database → Rules и вставь:\n\n{\n  "rules": { ".read": true, ".write": true }\n}\n\nи нажми Publish.');
        }
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
    const color = 0xd4b848;
    const ref = NET.db.ref('L/' + roomId);
    const room = {
        n: name, pa: !!password, mx: maxPlayers, h: uid,
        g: 'waiting', s: '', t: 0, v: {}, pv: {}, cm: '', mn: '', mid: '',
        df: 'normal', ft: 8, seed: 0, Kc: 0,
        E: { a: false, x:0, z:0 },
        M: { x: 0, z: 0, dx: 0, dz: 0 },
        w: '', tp: { a: false, s: 0 }, rp: 0,
        P: { [uid]: { n: playerName, x: 0, z: 0, r: false, d: false, m: false, c: color, ts: Date.now() } }
    };
    if (password) room.pw = password;
    ref.set(room, (err) => {
        if (err) { alert('❌ Не удалось создать лобби:\n' + err.message); return; }
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
    NET.roomRef.on('value', (snap) => {
        const room = snap.val();
        if (!room) { onDismiss && onDismiss(); return; }
        const isH = room.h === uid;
        NET.isHost = isH;
        if (!NET.joined) {
            NET.joined = true;
            onJoin && onJoin({ id: roomId, name: room.n, creatorId: room.h, maxPlayers: room.mx });
        }
        const plist = [];
        for (const k in (room.P || {})) {
            const p = room.P[k];
            plist.push({ id: k, name: p.n, x: p.x, z: p.z, isDead: !!p.d, isMonsterPlayer: !!p.m, color: p.c, isRunning: !!p.r });
        }
        onPlayers && onPlayers({ players: plist, creatorId: room.h, maxPlayers: room.mx });
        onStateChange && onStateChange(room);
    });
    const myPRef = NET.db.ref('L/' + roomId + '/P/' + uid);
    myPRef.onDisconnect().remove();
    NET.myPRef = myPRef;
    if (NET.isHost) NET.roomRef.onDisconnect().remove();
}

function fbLeaveLobby() {
    if (NET.myPRef) { NET.myPRef.remove(); NET.myPRef.onDisconnect().cancel(); NET.myPRef = null; }
    if (NET.roomRef) { NET.roomRef.off(); NET.roomRef = null; }
    fbStopHostTicker(); fbStopTimer();
    NET.joined = false; NET.isHost = false; NET.roomId = null;
    fbUnsubscribeLobbies();
}
function fbDismissLobby() {
    if (NET.roomRef) NET.roomRef.remove();
    fbLeaveLobby();
}

function fbSubmitVote(voteKey) {
    if (!NET.roomRef) return;
    NET.roomRef.transaction((room) => {
        if (!room) return room;
        if (!room.pv) room.pv = {};
        if (room.pv[NET.myUid]) return;
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
    fbStopTimer();
    NET.voteTicker = setInterval(() => {
        if (!NET.roomRef) return;
        NET.roomRef.transaction((room) => {
            if (!room) return room;
            if (['voting_mode','voting_diff','voting_reveal'].indexOf(room.g) === -1) return room;
            room.t = (room.t || 0) - 1;
            if (room.t <= 0) {
                if (room.g === 'voting_mode') {
                    const mv = (room.v && room.v.monster) || 0, nv = (room.v && room.v.normal) || 0;
                    let chosen = 'normal';
                    if (mv > nv) chosen = 'monster';
                    else if (mv === nv) chosen = Math.random() < 0.5 ? 'monster' : 'normal';
                    room.cm = chosen; room.mid = ''; room.mn = '';
                    if (chosen === 'monster') {
                        const pids = Object.keys(room.P || {});
                        const mid = pids[Math.floor(Math.random()*pids.length)];
                        room.mid = mid; room.mn = room.P[mid].n; room.P[mid].m = true;
                    }
                    room.g = 'voting_reveal'; room.s = 'reveal'; room.t = 8; room.v = {}; room.pv = {};
                } else if (room.g === 'voting_reveal') {
                    if (room.cm === 'monster') {
                        const diffs = ['normal','hard','extreme'];
                        room.df = diffs[Math.floor(Math.random()*diffs.length)];
                        return fbStartMatch(room);
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
                    return fbStartMatch(room);
                }
            }
            return room;
        });
    }, 1000);
}
function fbStopTimer() { if (NET.voteTicker) { clearInterval(NET.voteTicker); NET.voteTicker = null; } }

function fbMulberry32(seed) {
    return function() {
        seed |= 0; seed = seed + 0x6D2B79F5 | 0;
        let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

function fbStartMatch(room) {
    const seed = Math.floor(Math.random()*1e9);
    room.seed = seed; room.g = 'playing'; room.s=''; room.t=0; room.v={}; room.pv={};
    room.Kc = 0; room.E = {a:false,x:0,z:0}; room.w='';
    room.tp = {a:false,s:0}; room.rp = 0;
    const rng = fbMulberry32(seed);
    const MS = 21, BS = 4;
    const map = Array(MS).fill(0).map(()=>Array(MS).fill(1));
    const stack = []; map[1][1] = 0; stack.push({x:1,z:1});
    const dirs = [[0,-2],[0,2],[-2,0],[2,0]];
    while (stack.length) {
        const cur = stack[stack.length-1]; const nb = [];
        for (const d of dirs) {
            const nx = cur.x+d[0], nz = cur.z+d[1];
            if (nx>0 && nx<MS-1 && nz>0 && nz<MS-1 && map[nz][nx]===1) nb.push({x:nx,z:nz,dx:d[0]/2,dz:d[1]/2});
        }
        if (nb.length) {
            const n = nb[Math.floor(rng()*nb.length)];
            map[cur.z+n.dz][cur.x+n.dx]=0; map[n.z][n.x]=0; stack.push({x:n.x,z:n.z});
        } else stack.pop();
    }
    for (let z=1; z<MS-1; z++) for (let x=1; x<MS-1; x++) {
        if (map[z][x]===1 && rng()<0.25) {
            let c=0;
            if (map[z-1][x]===0)c++; if (map[z+1][x]===0)c++;
            if (map[z][x-1]===0)c++; if (map[z][x+1]===0)c++;
            if (c>=2) map[z][x]=0;
        }
    }
    for (let i=0; i<MS; i++) { map[0][i]=1;map[MS-1][i]=1;map[i][0]=1;map[i][MS-1]=1; }
    const empty = [];
    for (let z=1; z<MS-1; z++) for (let x=1; x<MS-1; x++) if (map[z][x]===0) empty.push({x,z});
    for (let i=empty.length-1; i>0; i--) { const j=Math.floor(rng()*(i+1)); [empty[i],empty[j]]=[empty[j],empty[i]]; }
    const pSpot = empty.pop();
    const keys = [];
    for (let i=0; i<room.ft; i++) { const s=empty.pop(); keys.push({x:s.x,z:s.z,a:true}); }
    let eSpot = empty.find(s=>Math.hypot(s.x-pSpot.x,s.z-pSpot.z)>10)||empty[0]||{x:MS-2,z:MS-2};
    let mSpot = empty.find(s=>Math.hypot(s.x-pSpot.x,s.z-pSpot.z)>10)||{x:MS-3,z:MS-3};
    room.K = {};
    keys.forEach((k,i)=>{ room.K[i] = {x:k.x,z:k.z,a:true}; });
    room.E.x=eSpot.x; room.E.z=eSpot.z; room.E.a=false;
    room.M = {x:mSpot.x*BS,z:mSpot.z*BS,dx:1,dz:0};
    for (const pid in room.P) {
        let sp;
        if (room.cm==='monster' && pid===room.mid) sp=mSpot;
        else sp = empty.length>0 ? empty.pop() : pSpot;
        room.P[pid].x=sp.x*BS; room.P[pid].z=sp.z*BS;
        room.P[pid].d=false; room.P[pid].r=false;
    }
    return room;
}

function fbSendMove(x, z, isRunning) {
    if (!NET.myPRef) return;
    const rx=fbRound(x), rz=fbRound(z);
    if (rx===NET.lastSentX && rz===NET.lastSentZ && isRunning===NET.lastSentR) return;
    NET.lastSentX=rx; NET.lastSentRZ=rz; NET.lastSentR=isRunning;
    NET.myPRef.update({x:rx,z:rz,r:!!isRunning,ts:firebase.database.ServerValue.TIMESTAMP});
}
function fbSendMonsterMove(x,z,dx,dz) {
    if (!NET.roomRef||!NET.myPRef) return;
    const rx=fbRound(x),rz=fbRound(z),rdx=fbRound(dx),rdz=fbRound(dz);
    if (rx===NET.lastSentMX&&rz===NET.lastSentMZ&&rdx===NET.lastSentMDX&&rdz===NET.lastSentMDZ) return;
    NET.lastSentMX=rx;NET.lastSentMZ=rz;NET.lastSentMDX=rdx;NET.lastSentMDZ=rdz;
    NET.roomRef.child('M').update({x:rx,z:rz,dx:rdx,dz:rdz});
    NET.myPRef.update({x:rx,z:rz});
}
function fbSendKeyCollected(idx) {
    if (!NET.roomRef) return;
    NET.roomRef.transaction(r => {
        if(!r||r.g!=='playing')return r;
        if(!r.K[idx]||!r.K[idx].a)return;
        r.K[idx].a=false; r.Kc=(r.Kc||0)+1;
        if(r.Kc>=r.ft)r.E.a=true;
        return r;
    });
}
function fbSendPlayerDied() { if(NET.myPRef) NET.myPRef.update({d:true}); }
function fbSendPlayerEscaped() { if(NET.roomRef) NET.roomRef.update({w:'survivors',g:'over'}); }
function fbSendMonsterTeleportRequest() { if(NET.roomRef) NET.roomRef.child('tp_req').set({u:NET.myUid,t:firebase.database.ServerValue.TIMESTAMP}); }

function fbOnPlayersUpdate(cb) { if(NET.roomRef) NET.roomRef.child('P').on('value',s=>cb(s.val()||{})); }
function fbOnMonsterUpdate(cb) { if(NET.roomRef) NET.roomRef.child('M').on('value',s=>{const v=s.val();if(v)cb(v);}); }
function fbOnKeyCount(cb) { if(NET.roomRef) NET.roomRef.child('Kc').on('value',s=>cb(s.val()||0)); }
function fbOnKeysUpdate(cb) { if(NET.roomRef) NET.roomRef.child('K').on('value',s=>cb(s.val()||{})); }
function fbOnExitOpened(cb) { if(NET.roomRef) NET.roomRef.child('E/a').on('value',s=>{if(s.val())cb();}); }
function fbOnGameResult(cb) { if(NET.roomRef) NET.roomRef.child('w').on('value',s=>{const w=s.val();if(w)cb(w);}); }
function fbOnMonsterRadar(cb) { if(NET.roomRef) NET.roomRef.child('rp').on('value',s=>{if(s.val()&&s.val()>Date.now()-3000)cb();}); }
function fbOnTpAvailable(cb) { if(NET.roomRef) NET.roomRef.child('tp/a').on('value',s=>cb(!!s.val())); }

let hostTickerId=null;
function startHostGameTicker() {
    fbStopHostTicker();
    let lastTick = performance.now();
    let radarTimer=25.0, tpCd=0;
    if(NET.roomRef) NET.roomRef.update({'tp/a':false});
    hostTickerId = setInterval(()=>{
        if(!NET.roomRef){fbStopHostTicker();return;}
        NET.roomRef.once('value', snap=>{
            const room = snap.val();
            if(!room||room.g!=='playing')return;
            const now=performance.now(); let dt=(now-lastTick)/1000;
            if(dt>0.2)dt=0.2; lastTick=now;
            const M=room.M||{x:0,z:0,dx:0,dz:-1};
            monster.x=M.x;monster.z=M.z;monster.dirX=M.dx;monster.dirZ=M.dz;
            monster.speed=({easy:4.0,normal:4.5,hard:5.0,extreme:5.6})[room.df]||4.5;
            const updates={};
            const players=room.P||{};
            const monsterIsAI=(room.cm!=='monster');
            const survivors=[];
            for(const id in players){const p=players[id];if(!p.d&&!p.m)survivors.push({id,x:p.x,z:p.z});}
            if(survivors.length===0){updates.g='over';updates.w='monster';NET.roomRef.update(updates);return;}
            if(monsterIsAI){
                let nearest=null,nd=Infinity;
                for(const s of survivors){const d=Math.hypot(s.x-M.x,s.z-M.z);if(d<nd){nd=d;nearest=s;}}
                let target=null;
                if(nearest){
                    const sees = hasLineOfSight(M.x,M.z,nearest.x,nearest.z)&&nd<25;
                    const hears = nd<12;
                    if(sees||hears)target={x:nearest.x,z:nearest.z};
                }
                if(target){
                    const dx=target.x-M.x,dz=target.z-M.z,d=Math.hypot(dx,dz)||1;
                    const ux=dx/d,uz=dz/d;
                    let nx=M.x+ux*monster.speed*dt,nz=M.z+uz*monster.speed*dt;
                    if(canMoveTo(nx,M.z,0.6))M.x=nx;
                    if(canMoveTo(M.x,nz,0.6))M.z=nz;
                    M.dx=ux;M.dz=uz;
                } else {
                    if(!monster._wander){
                        const sg=worldToGrid(M.x,M.z);let tries=0,tx,tz;
                        do{tx=1+Math.floor(Math.random()*(MAP_SIZE-2));tz=1+Math.floor(Math.random()*(MAP_SIZE-2));tries++;}
                        while((mapData[tz]&&mapData[tz][tx]===1)||tries<30);
                        const path=astar(sg,{x:tx,z:tz},mapData,500);
                        monster._wander=path&&path.length>0?path:null;monster._wi=0;
                    }
                    if(monster._wander&&monster._wi<monster._wander.length){
                        const w=monster._wander[monster._wi];
                        const wx=w.x*BLOCK_SIZE,wz=w.z*BLOCK_SIZE;
                        const dx=wx-M.x,dz=wz-M.z,d=Math.hypot(dx,dz)||1;
                        if(d<1)monster._wi++;
                        else{
                            const ux=dx/d,uz=dz/d;
                            let nx=M.x+ux*monster.speed*0.5*dt,nz=M.z+uz*monster.speed*0.5*dt;
                            if(canMoveTo(nx,M.z,0.6))M.x=nx;
                            if(canMoveTo(M.x,nz,0.6))M.z=nz;
                            M.dx=ux;M.dz=uz;
                        }
                    } else monster._wander=null;
                }
                updates['M/x']=Math.round(M.x*10)/10;updates['M/z']=Math.round(M.z*10)/10;
                updates['M/dx']=Math.round(M.dx*10)/10;updates['M/dz']=Math.round(M.dz*10)/10;
            }
            const killR=1.4;
            for(const s of survivors){const d=Math.hypot(s.x-M.x,s.z-M.z);if(d<killR)updates['P/'+s.id+'/d']=true;}
            radarTimer-=dt;
            if(radarTimer<=0){radarTimer=25;updates.rp=Date.now();setTimeout(()=>{if(NET.roomRef)NET.roomRef.update({rp:0});},2800);}
            tpCd-=dt;if(tpCd<0)tpCd=0;
            updates['tp/a']=tpCd<=0;
            if(room.tp_req&&room.tp_req.u&&tpCd<=0&&room.cm==='monster'){
                const rid=room.tp_req.u;
                if(players[rid]&&players[rid].m){
                    const tgt=survivors[Math.floor(Math.random()*survivors.length)];
                    if(tgt){
                        let spots=[];const pg={x:Math.floor(tgt.x/BLOCK_SIZE),z:Math.floor(tgt.z/BLOCK_SIZE)};
                        for(let zz=Math.max(1,pg.z-6);zz<=Math.min(MAP_SIZE-2,pg.z+6);zz++)for(let xx=Math.max(1,pg.x-6);xx<=Math.min(MAP_SIZE-2,pg.x+6);xx++){
                            if(mapData[zz][xx]===0){const d=Math.hypot(xx-pg.x,zz-pg.z);if(d>=4&&d<=5.5)spots.push({x:xx,z:zz});}
                        }
                        if(spots.length>0){const s=spots[Math.floor(Math.random()*spots.length)];updates['M/x']=s.x*BLOCK_SIZE;updates['M/z']=s.z*BLOCK_SIZE;updates['P/'+rid+'/x']=s.x*BLOCK_SIZE;updates['P/'+rid+'/z']=s.z*BLOCK_SIZE;}
                    }
                    tpCd=20;updates['tp/a']=false;updates.tp_req=null;
                }
            }
            if(Object.keys(updates).length>0)NET.roomRef.update(updates);
        });
    },150);
}
function fbStopHostTicker(){if(hostTickerId){clearInterval(hostTickerId);hostTickerId=null;}}

window.NET=NET;
window.fbInit=fbInit;
window.fbLoadSDK=fbLoadSDK;
window.fbSubscribeLobbies=fbSubscribeLobbies;
window.fbUnsubscribeLobbies=fbUnsubscribeLobbies;
window.fbCreateLobby=fbCreateLobby;
window.fbJoinLobby=fbJoinLobby;
window.fbLeaveLobby=fbLeaveLobby;
window.fbDismissLobby=fbDismissLobby;
window.fbSubmitVote=fbSubmitVote;
window.fbStartVoting=fbStartVoting;
window.fbStopTimer=fbStopTimer;
window.fbSendMove=fbSendMove;
window.fbSendMonsterMove=fbSendMonsterMove;
window.fbSendKeyCollected=fbSendKeyCollected;
window.fbSendPlayerDied=fbSendPlayerDied;
window.fbSendPlayerEscaped=fbSendPlayerEscaped;
window.fbSendMonsterTeleportRequest=fbSendMonsterTeleportRequest;
window.fbOnPlayersUpdate=fbOnPlayersUpdate;
window.fbOnMonsterUpdate=fbOnMonsterUpdate;
window.fbOnKeysUpdate=fbOnKeysUpdate;
window.fbOnKeyCount=fbOnKeyCount;
window.fbOnExitOpened=fbOnExitOpened;
window.fbOnGameResult=fbOnGameResult;
window.fbOnMonsterRadar=fbOnMonsterRadar;
window.fbOnTpAvailable=fbOnTpAvailable;
window.fbMulberry32=fbMulberry32;
window.startHostGameTicker=startHostGameTicker;
window.fbStopHostTicker=fbStopHostTicker;
