const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

const PORT = process.env.PORT || 3000;

// Game state constants
const MAP_WIDTH = 2400;
const MAP_HEIGHT = 1200;
const TICK_RATE = 60; // 60 FPS update rate

// Multi-tiered platforms definition
const PLATFORMS = [
    { x: 0, y: 1100, width: 2400, height: 100, color: '#334155', type: 'ground' }, // Main Floor
    { x: 300, y: 900, width: 400, height: 20, color: '#475569', type: 'platform' },
    { x: 900, y: 850, width: 600, height: 25, color: '#475569', type: 'platform' },
    { x: 1700, y: 900, width: 400, height: 20, color: '#475569', type: 'platform' },
    { x: 500, y: 650, width: 450, height: 20, color: '#475569', type: 'platform' },
    { x: 1450, y: 650, width: 450, height: 20, color: '#475569', type: 'platform' },
    { x: 1000, y: 450, width: 400, height: 20, color: '#475569', type: 'platform' }
];

let players = {};
const PLAYER_COLORS = ['#ef4444', '#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4'];

function createPlayer(id, name) {
    const randomColor = PLAYER_COLORS[Math.floor(Math.random() * PLAYER_COLORS.length)];
    return {
        id: id,
        name: name || `Fighter_${id.slice(0, 4)}`,
        x: 400 + Math.random() * 1600,
        y: 800,
        vx: 0,
        vy: 0,
        width: 40,
        height: 60,
        color: randomColor,
        hp: 100,
        maxHp: 100,
        kills: 0,
        deaths: 0,
        facing: 1, // 1 for right, -1 for left
        isGrounded: false,
        isShielding: false,
        shieldCooldown: 0,
        attackCooldown: 0,
        specialCooldown: 0,
        isAttacking: false,
        attackTimer: 0,
        isSpecialActive: false,
        flyMode: false,
        inputs: { left: false, right: false, up: false, down: false, attack: false, special: false, shield: false }
    };
}

io.on('connection', (socket) => {
    console.log(`Player connected: ${socket.id}`);

    // Register player
    socket.on('joinGame', (data) => {
        players[socket.id] = createPlayer(socket.id, data?.name);
        socket.emit('init', {
            id: socket.id,
            map: { width: MAP_WIDTH, height: MAP_HEIGHT, platforms: PLATFORMS }
        });
    });

    // Receive player controls input
    socket.on('playerInput', (inputs) => {
        if (players[socket.id]) {
            players[socket.id].inputs = inputs;
        }
    });

    // Secret Admin Fly toggle verification
    socket.on('verifyAdminCode', (code) => {
        if (code === "2014" && players[socket.id]) {
            players[socket.id].flyMode = !players[socket.id].flyMode;
            socket.emit('adminFlyStatus', { success: true, flyMode: players[socket.id].flyMode });
        } else {
            socket.emit('adminFlyStatus', { success: false, message: "Invalid Code" });
        }
    });

    socket.on('disconnect', () => {
        console.log(`Player disconnected: ${socket.id}`);
        delete players[socket.id];
    });
});

// Server Physics and Combat Update Loop
setInterval(() => {
    let combatEvents = [];

    Object.keys(players).forEach(id => {
        const p = players[id];
        
        // Cooldowns tick
        if (p.attackCooldown > 0) p.attackCooldown--;
        if (p.specialCooldown > 0) p.specialCooldown--;
        if (p.shieldCooldown > 0) p.shieldCooldown--;

        if (p.attackTimer > 0) {
            p.attackTimer--;
            if (p.attackTimer === 0) p.isAttacking = false;
        }

        p.isShielding = p.inputs.shield && p.shieldCooldown === 0;

        // Facing direction update
        if (p.inputs.left) p.facing = -1;
        if (p.inputs.right) p.facing = 1;

        // --- FLY MODE LOGIC ---
        if (p.flyMode) {
            const flySpeed = 12;
            p.vx = 0;
            p.vy = 0;
            if (p.inputs.left) p.vx = -flySpeed;
            if (p.inputs.right) p.vx = flySpeed;
            if (p.inputs.up) p.vy = -flySpeed;
            if (p.inputs.down) p.vy = flySpeed;

            p.x += p.vx;
            p.y += p.vy;
        } else {
            // --- STANDARD PHYSICS LOGIC ---
            const accel = 1.2;
            const maxSpeed = 8;
            const friction = 0.82;
            const gravity = 0.8;

            if (p.inputs.left) p.vx -= accel;
            if (p.inputs.right) p.vx += accel;

            p.vx *= friction;
            if (Math.abs(p.vx) > maxSpeed) p.vx = Math.sign(p.vx) * maxSpeed;

            // Jump handling
            if (p.inputs.up && p.isGrounded) {
                p.vy = -16;
                p.isGrounded = false;
            }

            p.vy += gravity;

            // Apply displacement
            p.x += p.vx;
            p.y += p.vy;

            // Collision with Platforms
            p.isGrounded = false;
            PLATFORMS.forEach(plat => {
                if (p.x + p.width > plat.x && p.x < plat.x + plat.width) {
                    // Landing on top of platform
                    if (p.y + p.height >= plat.y && p.y + p.height - p.vy <= plat.y + 15 && p.vy >= 0) {
                        p.y = plat.y - p.height;
                        p.vy = 0;
                        p.isGrounded = true;
                    }
                }
            });
        }

        // Map Boundaries
        p.x = Math.max(0, Math.min(MAP_WIDTH - p.width, p.x));
        if (p.y > MAP_HEIGHT) { // Respawn if fallen
            p.hp = 0;
        }

        // --- ATTACK EXECUTION ---
        if (p.inputs.attack && p.attackCooldown === 0 && !p.isShielding) {
            p.isAttacking = true;
            p.attackTimer = 10;
            p.attackCooldown = 25;

            // Attack Hitbox Calculation
            const hitBox = {
                x: p.facing === 1 ? p.x + p.width : p.x - 60,
                y: p.y,
                width: 60,
                height: p.height
            };

            // Check damage on opponents
            Object.keys(players).forEach(targetId => {
                if (targetId === id) return;
                const target = players[targetId];

                if (hitBox.x < target.x + target.width &&
                    hitBox.x + hitBox.width > target.x &&
                    hitBox.y < target.y + target.height &&
                    hitBox.y + hitBox.height > target.y) {
                    
                    let dmg = 15;
                    if (target.isShielding) dmg = 3; // Shield reduces damage
                    
                    target.hp -= dmg;
                    target.vx += p.facing * (target.isShielding ? 4 : 12);
                    target.vy -= 4;

                    combatEvents.push({ type: 'hit', x: target.x + target.width/2, y: target.y, dmg, isShield: target.isShielding });

                    if (target.hp <= 0) {
                        p.kills++;
                        target.deaths++;
                        target.hp = target.maxHp;
                        target.x = 400 + Math.random() * 1600;
                        target.y = 200;
                        combatEvents.push({ type: 'kill', killer: p.name, victim: target.name });
                    }
                }
            });
        }

        // --- SPECIAL ATTACK ---
        if (p.inputs.special && p.specialCooldown === 0 && !p.isShielding) {
            p.specialCooldown = 180; // 3 sec cooldown
            combatEvents.push({ type: 'specialEffect', x: p.x + p.width/2, y: p.y + p.height/2, facing: p.facing });

            // Radial Blast Attack
            Object.keys(players).forEach(targetId => {
                if (targetId === id) return;
                const target = players[targetId];
                const dx = (target.x + target.width/2) - (p.x + p.width/2);
                const dy = (target.y + target.height/2) - (p.y + p.height/2);
                const dist = Math.sqrt(dx * dx + dy * dy);

                if (dist < 180) {
                    let dmg = 30;
                    if (target.isShielding) dmg = 8;

                    target.hp -= dmg;
                    const angle = Math.atan2(dy, dx);
                    target.vx = Math.cos(angle) * 18;
                    target.vy = Math.sin(angle) * 18 - 5;

                    combatEvents.push({ type: 'hit', x: target.x + target.width/2, y: target.y, dmg, isShield: target.isShielding });

                    if (target.hp <= 0) {
                        p.kills++;
                        target.deaths++;
                        target.hp = target.maxHp;
                        target.x = 400 + Math.random() * 1600;
                        target.y = 200;
                        combatEvents.push({ type: 'kill', killer: p.name, victim: target.name });
                    }
                }
            });
        }
    });

    // Broadcast world state to all connected sockets
    io.emit('stateUpdate', { players, combatEvents });
}, 1000 / TICK_RATE);

app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>Multiplayer Arena Brawler</title>
    <script src="/socket.io/socket.io.js"></script>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        * { user-select: none; -webkit-user-select: none; touch-action: none; }
        body, html { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background-color: #0f172a; font-family: sans-serif; }
        canvas { display: block; width: 100vw; height: 100vh; }
        .touch-btn {
            background: rgba(255, 255, 255, 0.15);
            backdrop-filter: blur(8px);
            border: 2px solid rgba(255, 255, 255, 0.3);
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            color: white;
            font-weight: bold;
            box-shadow: 0 4px 12px rgba(0,0,0,0.4);
            active { background: rgba(255, 255, 255, 0.4); transform: scale(0.95); }
        }
    </style>
</head>
<body class="relative text-white">

    <!-- Canvas Engine -->
    <canvas id="gameCanvas"></canvas>

    <!-- UI Overlay Leaderboard -->
    <div class="absolute top-4 left-4 bg-slate-900/80 backdrop-blur border border-slate-700 p-3 rounded-xl min-w-[200px] pointer-events-none">
        <h3 class="text-xs font-bold uppercase tracking-wider text-slate-400 mb-2">Leaderboard</h3>
        <div id="leaderboard" class="text-sm space-y-1"></div>
    </div>

    <!-- Admin Fly Trigger Button (Top-Right Secret Icon) -->
    <button id="adminBtn" class="absolute top-3 right-3 opacity-30 hover:opacity-100 transition-opacity p-2 bg-slate-800 rounded-full border border-slate-600 text-xs text-yellow-400 focus:outline-none">
        ⚡
    </button>

    <!-- Admin Modal -->
    <div id="adminModal" class="hidden fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50">
        <div class="bg-slate-800 border border-slate-700 p-6 rounded-2xl w-80 text-center shadow-2xl">
            <h2 class="text-lg font-bold text-slate-100 mb-4">Secret Admin Control</h2>
            <div id="codeForm">
                <input id="adminCodeInput" type="password" placeholder="Enter Code" class="w-full px-4 py-2 bg-slate-900 border border-slate-700 rounded-lg text-center text-white mb-4 focus:outline-none focus:border-indigo-500">
                <div class="flex gap-2">
                    <button id="submitAdminCode" class="flex-1 bg-indigo-600 hover:bg-indigo-500 py-2 rounded-lg font-semibold">Submit</button>
                    <button id="closeAdminModal" class="flex-1 bg-slate-700 hover:bg-slate-600 py-2 rounded-lg font-semibold">Cancel</button>
                </div>
            </div>
            <div id="adminControls" class="hidden">
                <p class="text-sm text-slate-300 mb-4">Admin privileges granted!</p>
                <button id="toggleFlyBtn" class="w-full py-3 bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded-xl shadow-lg transition">
                    TOGGLE FLY: OFF
                </button>
                <button id="closeAdminModal2" class="w-full mt-3 py-2 bg-slate-700 hover:bg-slate-600 text-sm rounded-lg font-semibold">Close</button>
            </div>
        </div>
    </div>

    <!-- TOUCH CONTROLS OVERLAY (Automatically enabled on mobile/touch devices) -->
    <div id="touchControls" class="hidden fixed inset-0 pointer-events-none select-none z-40">
        <!-- Left Virtual Joystick D-Pad Zone -->
        <div class="absolute bottom-6 left-6 w-40 h-40 pointer-events-auto relative">
            <button id="btnLeft" class="touch-btn absolute left-0 top-12 w-14 h-14 text-xl">◀</button>
            <button id="btnRight" class="touch-btn absolute right-0 top-12 w-14 h-14 text-xl">▶</button>
            <button id="btnUp" class="touch-btn absolute top-0 left-12 w-14 h-14 text-xl">▲</button>
            <button id="btnDown" class="touch-btn absolute bottom-0 left-12 w-14 h-14 text-xl">▼</button>
        </div>

        <!-- Right Action Buttons Zone -->
        <div class="absolute bottom-6 right-6 w-52 h-52 pointer-events-auto relative">
            <button id="btnAttack" class="touch-btn absolute bottom-2 right-2 w-16 h-16 bg-red-500/30 border-red-400 text-lg">⚔️</button>
            <button id="btnSpecial" class="touch-btn absolute top-4 right-12 w-14 h-14 bg-yellow-500/30 border-yellow-400 text-base">💥</button>
            <button id="btnShield" class="touch-btn absolute bottom-12 left-2 w-14 h-14 bg-blue-500/30 border-blue-400 text-base">🛡️</button>
        </div>
    </div>

    <!-- Client Engine Script -->
    <script>
        const socket = io();
        const canvas = document.getElementById('gameCanvas');
        const ctx = canvas.getContext('2d');

        let myId = null;
        let gameState = { players: {} };
        let mapConfig = { width: 2400, height: 1200, platforms: [] };
        let particles = [];
        let floatingTexts = [];
        let isFlyActive = false;

        // Auto Detection for Touch Support
        const isTouchDevice = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
        if (isTouchDevice) {
            document.getElementById('touchControls').classList.remove('hidden');
        }

        // Resize Canvas dynamically
        function resizeCanvas() {
            canvas.width = window.innerWidth;
            canvas.height = window.innerHeight;
        }
        window.addEventListener('resize', resizeCanvas);
        resizeCanvas();

        // Control Inputs State
        const inputs = {
            left: false,
            right: false,
            up: false,
            down: false,
            attack: false,
            special: false,
            shield: false
        };

        // Name prompt
        const playerName = prompt("Enter your Fighter Name:", "Player_" + Math.floor(Math.random()*1000)) || "Fighter";
        socket.emit('joinGame', { name: playerName });

        socket.on('init', (data) => {
            myId = data.id;
            mapConfig = data.map;
        });

        socket.on('stateUpdate', (data) => {
            gameState = data;
            
            // Handle combat visual updates
            if (data.combatEvents) {
                data.combatEvents.forEach(evt => {
                    if (evt.type === 'hit') {
                        createHitParticles(evt.x, evt.y);
                        floatingTexts.push({
                            x: evt.x, y: evt.y, text: \`-\${evt.dmg}\`, color: evt.isShield ? '#3b82f6' : '#ef4444', opacity: 1, vy: -2
                        });
                    } else if (evt.type === 'specialEffect') {
                        createSpecialWave(evt.x, evt.y, evt.facing);
                    }
                });
            }

            updateLeaderboard();
        });

        // Key Mapping for Desktop
        const keyMap = {
            'KeyA': 'left', 'ArrowLeft': 'left',
            'KeyD': 'right', 'ArrowRight': 'right',
            'KeyW': 'up', 'ArrowUp': 'up',
            'KeyS': 'down', 'ArrowDown': 'down',
            'Space': 'attack', 'KeyJ': 'attack',
            'KeyK': 'special',
            'ShiftLeft': 'shield', 'KeyL': 'shield'
        };

        window.addEventListener('keydown', (e) => {
            if (keyMap[e.code]) {
                inputs[keyMap[e.code]] = true;
                sendInputs();
            }
        });

        window.addEventListener('keyup', (e) => {
            if (keyMap[e.code]) {
                inputs[keyMap[e.code]] = false;
                sendInputs();
            }
        });

        // Touch Control Listeners Helper
        function bindTouchButton(btnId, inputKey) {
            const btn = document.getElementById(btnId);
            if (!btn) return;

            const startAction = (e) => {
                e.preventDefault();
                inputs[inputKey] = true;
                sendInputs();
            };

            const endAction = (e) => {
                e.preventDefault();
                inputs[inputKey] = false;
                sendInputs();
            };

            btn.addEventListener('touchstart', startAction);
            btn.addEventListener('touchend', endAction);
            btn.addEventListener('touchcancel', endAction);
        }

        bindTouchButton('btnLeft', 'left');
        bindTouchButton('btnRight', 'right');
        bindTouchButton('btnUp', 'up');
        bindTouchButton('btnDown', 'down');
        bindTouchButton('btnAttack', 'attack');
        bindTouchButton('btnSpecial', 'special');
        bindTouchButton('btnShield', 'shield');

        function sendInputs() {
            socket.emit('playerInput', inputs);
        }

        const adminBtn = document.getElementById('adminBtn');
        const adminModal = document.getElementById('adminModal');
        const submitAdminCode = document.getElementById('submitAdminCode');
        const closeAdminModal = document.getElementById('closeAdminModal');
        const closeAdminModal2 = document.getElementById('closeAdminModal2');
        const toggleFlyBtn = document.getElementById('toggleFlyBtn');

        adminBtn.addEventListener('click', () => {
            adminModal.classList.remove('hidden');
        });

        closeAdminModal.addEventListener('click', () => adminModal.classList.add('hidden'));
        closeAdminModal2.addEventListener('click', () => adminModal.classList.add('hidden'));

        submitAdminCode.addEventListener('click', () => {
            const code = document.getElementById('adminCodeInput').value;
            socket.emit('verifyAdminCode', code);
        });

        socket.on('adminFlyStatus', (res) => {
            if (res.success) {
                document.getElementById('codeForm').classList.add('hidden');
                document.getElementById('adminControls').classList.remove('hidden');
                isFlyActive = res.flyMode;
                toggleFlyBtn.innerText = `TOGGLE FLY: ${isFlyActive ? 'ON' : 'OFF'}`;
                toggleFlyBtn.className = isFlyActive 
                    ? "w-full py-3 bg-red-600 hover:bg-red-500 text-white font-bold rounded-xl shadow-lg transition" 
                    : "w-full py-3 bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded-xl shadow-lg transition";
            } else {
                alert(res.message || "Invalid Code!");
            }
        });

        toggleFlyBtn.addEventListener('click', () => {
            socket.emit('verifyAdminCode', '2014'); // Toggle status
        });

        function createHitParticles(x, y) {
            for (let i = 0; i < 12; i++) {
                particles.push({
                    x, y,
                    vx: (Math.random() - 0.5) * 10,
                    vy: (Math.random() - 0.5) * 10,
                    size: Math.random() * 5 + 2,
                    color: '#f59e0b',
                    life: 1.0
                });
            }
        }

        function createSpecialWave(x, y, facing) {
            for (let i = 0; i < 24; i++) {
                const angle = Math.random() * Math.PI * 2;
                const speed = Math.random() * 8 + 4;
                particles.push({
                    x, y,
                    vx: Math.cos(angle) * speed,
                    vy: Math.sin(angle) * speed,
                    size: Math.random() * 6 + 3,
                    color: '#a855f7',
                    life: 1.0
                });
            }
        }

        function updateLeaderboard() {
            const lb = document.getElementById('leaderboard');
            const sorted = Object.values(gameState.players).sort((a,b) => b.kills - a.kills);
            lb.innerHTML = sorted.map(p => `
                <div class="flex justify-between items-center ${p.id === myId ? 'text-yellow-400 font-bold' : 'text-slate-300'}">
                    <span class="truncate max-w-[120px]">${p.name} ${p.flyMode ? '🛸' : ''}</span>
                    <span>${p.kills} K / ${p.deaths} D</span>
                </div>
            `).join('');
        }

        // --- MAIN CANVAS RENDER LOOP ---
        function render() {
            ctx.clearRect(0, 0, canvas.width, canvas.height);

            const myPlayer = gameState.players[myId];
            
            // Camera position centering on player
            let cameraX = 0;
            let cameraY = 0;
            if (myPlayer) {
                cameraX = myPlayer.x + myPlayer.width / 2 - canvas.width / 2;
                cameraY = myPlayer.y + myPlayer.height / 2 - canvas.height / 2;
                cameraX = Math.max(0, Math.min(mapConfig.width - canvas.width, cameraX));
                cameraY = Math.max(0, Math.min(mapConfig.height - canvas.height, cameraY));
            }

            ctx.save();
            ctx.translate(-cameraX, -cameraY);

            // Background Grid Lines
            ctx.strokeStyle = 'rgba(255,255,255,0.03)';
            ctx.lineWidth = 2;
            for (let x = 0; x < mapConfig.width; x += 100) {
                ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, mapConfig.height); ctx.stroke();
            }
            for (let y = 0; y < mapConfig.height; y += 100) {
                ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(mapConfig.width, y); ctx.stroke();
            }

            // Draw Map Platforms
            mapConfig.platforms.forEach(plat => {
                ctx.fillStyle = plat.color;
                ctx.shadowColor = 'rgba(0,0,0,0.5)';
                ctx.shadowBlur = 10;
                ctx.fillRect(plat.x, plat.y, plat.width, plat.height);
                ctx.shadowBlur = 0;
            });

            // Draw Players
            Object.values(gameState.players).forEach(p => {
                // Shield aura
                if (p.isShielding) {
                    ctx.fillStyle = 'rgba(59, 130, 246, 0.4)';
                    ctx.beginPath();
                    ctx.arc(p.x + p.width/2, p.y + p.height/2, 45, 0, Math.PI * 2);
                    ctx.fill();
                }

                // Fly mode halo
                if (p.flyMode) {
                    ctx.strokeStyle = '#f59e0b';
                    ctx.lineWidth = 3;
                    ctx.beginPath();
                    ctx.arc(p.x + p.width/2, p.y - 10, 12, 0, Math.PI * 2);
                    ctx.stroke();
                }

                // Player Body
                ctx.fillStyle = p.color;
                ctx.fillRect(p.x, p.y, p.width, p.height);

                // Eyes / Facing direction
                ctx.fillStyle = '#ffffff';
                const eyeOffset = p.facing === 1 ? p.width - 12 : 4;
                ctx.fillRect(p.x + eyeOffset, p.y + 12, 8, 8);

                // Attack Slash Visual
                if (p.isAttacking) {
                    ctx.fillStyle = 'rgba(239, 68, 68, 0.6)';
                    const slashX = p.facing === 1 ? p.x + p.width : p.x - 50;
                    ctx.fillRect(slashX, p.y, 50, p.height);
                }

                // Health Bar Header
                const barW = 50;
                const barH = 6;
                const barX = p.x + (p.width - barW) / 2;
                const barY = p.y - 18;

                ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
                ctx.fillRect(barX, barY, barW, barH);
                ctx.fillStyle = p.hp > 30 ? '#10b981' : '#ef4444';
                ctx.fillRect(barX, barY, barW * (p.hp / p.maxHp), barH);

                // Player Name
                ctx.fillStyle = '#f8fafc';
                ctx.font = '12px sans-serif';
                ctx.textAlign = 'center';
                ctx.fillText(p.name, p.x + p.width / 2, p.y - 24);
            });

            // Draw Particles
            particles.forEach((pt, index) => {
                pt.x += pt.vx;
                pt.y += pt.vy;
                pt.life -= 0.03;
                if (pt.life <= 0) {
                    particles.splice(index, 1);
                } else {
                    ctx.fillStyle = pt.color;
                    ctx.globalAlpha = pt.life;
                    ctx.beginPath();
                    ctx.arc(pt.x, pt.y, pt.size, 0, Math.PI * 2);
                    ctx.fill();
                    ctx.globalAlpha = 1.0;
                }
            });

            // Draw Floating Combat Text
            floatingTexts.forEach((ft, index) => {
                ft.y += ft.vy;
                ft.opacity -= 0.02;
                if (ft.opacity <= 0) {
                    floatingTexts.splice(index, 1);
                } else {
                    ctx.fillStyle = ft.color;
                    ctx.globalAlpha = ft.opacity;
                    ctx.font = 'bold 16px sans-serif';
                    ctx.fillText(ft.text, ft.x, ft.y);
                    ctx.globalAlpha = 1.0;
                }
            });

            ctx.restore();
            requestAnimationFrame(render);
        }

        requestAnimationFrame(render);
    </script>
</body>
</html>
    `);
});

server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});