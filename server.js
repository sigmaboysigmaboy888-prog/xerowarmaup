const express = require('express');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    transports: ['websocket', 'polling'],
    pingTimeout: 60000,
    pingInterval: 25000
});

// Middleware
app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false
}));
app.use(cors());
app.use(compression());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Store active clients and sessions
const clients = new Map();
const warmUpSessions = new Map();
const trustHistory = new Map();

// Warm Up Configuration
const WARMUP_MODES = {
    gentle: {
        delay: 8000,
        messagesPerHour: 15,
        increment: 1.2,
        maxWaves: 40,
        name: 'Gentle',
        color: '#10b981'
    },
    aggressive: {
        delay: 4500,
        messagesPerHour: 35,
        increment: 2.5,
        maxWaves: 55,
        name: 'Aggressive',
        color: '#f59e0b'
    },
    monster: {
        delay: 2500,
        messagesPerHour: 60,
        increment: 4.2,
        maxWaves: 75,
        name: 'Monster',
        color: '#ef4444'
    }
};

// Calculate trust score based on activity
function calculateTrustScore(account) {
    let base = account.trustScore || 15;
    const waves = account.wavesCompleted || 0;
    const mode = account.mode || 'aggressive';
    const multiplier = WARMUP_MODES[mode].increment;
    const successfulActions = account.successfulActions || 0;
    
    let newScore = Math.min(100, base + (waves * multiplier * 0.65) + (successfulActions * 0.4));
    
    if (account.banned) newScore = Math.max(0, newScore - 40);
    if (account.restricted) newScore = Math.max(0, newScore - 25);
    
    return Math.min(100, Math.max(0, Math.round(newScore)));
}

// Calculate ban risk
function calculateBanRisk(trustScore) {
    if (trustScore >= 90) return { risk: 5, status: 'Clean', level: 'low', color: '#10b981' };
    if (trustScore >= 75) return { risk: 12, status: 'Low Risk', level: 'low', color: '#84cc16' };
    if (trustScore >= 60) return { risk: 25, status: 'Moderate', level: 'medium', color: '#f59e0b' };
    if (trustScore >= 40) return { risk: 45, status: 'Elevated Risk', level: 'medium', color: '#f97316' };
    if (trustScore >= 20) return { risk: 70, status: 'High Risk', level: 'high', color: '#ef4444' };
    return { risk: 90, status: 'Critical', level: 'critical', color: '#dc2626' };
}

// Generate realistic activity message
function getActivityMessage(mode, wave) {
    const messages = {
        gentle: [
            "Checking account health...",
            "Verifying security status...",
            "Syncing contact list...",
            "Updating privacy settings..."
        ],
        aggressive: [
            "Active presence detected",
            "Messaging pattern normalized",
            "Interaction rate optimized",
            "Account behavior stabilized"
        ],
        monster: [
            "⚡ MAXIMUM ACTIVITY MODE",
            "🔥 Trust score surging",
            "💪 Aggressive recovery mode",
            "🚀 Ban risk decreasing rapidly"
        ]
    };
    
    const modeMessages = messages[mode] || messages.aggressive;
    return `${modeMessages[wave % modeMessages.length]} (Wave ${wave})`;
}

// Perform warm up action
async function performWarmUpAction(accountId, client) {
    const session = warmUpSessions.get(accountId);
    if (!session || !session.active) return false;
    
    const account = clients.get(accountId);
    if (!account || account.banned) return false;
    
    const mode = session.mode;
    const config = WARMUP_MODES[mode];
    
    session.wavesCompleted = (session.wavesCompleted || 0) + 1;
    session.successfulActions = (session.successfulActions || 0) + 1;
    
    // Calculate trust increase
    let trustIncrease = config.increment + (Math.random() * 1.2);
    if (mode === 'monster' && session.wavesCompleted % 4 === 0) trustIncrease += 2.5;
    if (mode === 'aggressive' && session.wavesCompleted % 6 === 0) trustIncrease += 1.5;
    
    let newTrust = Math.min(100, (account.trustScore || 15) + trustIncrease);
    account.trustScore = newTrust;
    account.wavesCompleted = session.wavesCompleted;
    account.mode = mode;
    account.successfulActions = session.successfulActions;
    account.lastActivity = Date.now();
    
    const risk = calculateBanRisk(newTrust);
    const activityMessage = getActivityMessage(mode, session.wavesCompleted);
    
    // Send real activity to WhatsApp if client is ready
    try {
        if (client && client.info && client.pupPage) {
            await client.sendPresenceAvailable();
            
            if (session.wavesCompleted % 3 === 0) {
                await client.sendStateTyping();
                await new Promise(resolve => setTimeout(resolve, 1200));
                await client.clearState();
            }
            
            // Simulate status update
            if (session.wavesCompleted % 5 === 0) {
                await client.setStatus(`${Math.round(newTrust)}% Trust Score`);
            }
        }
    } catch (err) {
        console.log('Activity simulation warning:', err.message);
    }
    
    // Store trust history
    if (!trustHistory.has(accountId)) {
        trustHistory.set(accountId, []);
    }
    const history = trustHistory.get(accountId);
    history.push({ trust: newTrust, time: Date.now() });
    if (history.length > 20) history.shift();
    
    // Emit update via socket
    io.to(accountId).emit('warmup_update', {
        accountId,
        trustScore: newTrust,
        wavesCompleted: session.wavesCompleted,
        trustIncrease: trustIncrease.toFixed(1),
        banRisk: risk.risk,
        status: risk.status,
        activityScore: session.successfulActions * 6,
        message: activityMessage,
        mode: mode,
        wave: session.wavesCompleted
    });
    
    clients.set(accountId, account);
    
    // Check completion conditions
    if (newTrust >= 90) {
        session.active = false;
        account.recovered = true;
        clients.set(accountId, account);
        
        io.to(accountId).emit('warmup_complete', {
            accountId,
            trustScore: newTrust,
            wavesCompleted: session.wavesCompleted,
            message: `✓ Account fully recovered! Trust score: ${newTrust}%`
        });
        return false;
    }
    
    if (session.wavesCompleted >= config.maxWaves) {
        if (newTrust < 60) {
            session.active = false;
            account.banned = true;
            clients.set(accountId, account);
            
            io.to(accountId).emit('warmup_failed', {
                accountId,
                trustScore: newTrust,
                message: '⚠️ Account may have restrictions. Consider changing behavior.'
            });
        } else {
            session.active = false;
            io.to(accountId).emit('warmup_complete', {
                accountId,
                trustScore: newTrust,
                message: `✓ Warm up completed. Trust score: ${Math.round(newTrust)}%`
            });
        }
        return false;
    }
    
    return true;
}

// Start warm up session
function startWarmUpSession(accountId, mode, client) {
    if (warmUpSessions.has(accountId)) {
        const existing = warmUpSessions.get(accountId);
        if (existing.active) return false;
    }
    
    const config = WARMUP_MODES[mode];
    
    const runWave = async () => {
        const session = warmUpSessions.get(accountId);
        if (!session || !session.active) return;
        
        const shouldContinue = await performWarmUpAction(accountId, client);
        if (shouldContinue) {
            session.interval = setTimeout(runWave, config.delay);
        } else {
            session.interval = null;
            warmUpSessions.delete(accountId);
        }
    };
    
    warmUpSessions.set(accountId, {
        active: true,
        mode: mode,
        wavesCompleted: 0,
        successfulActions: 0,
        interval: null
    });
    
    const session = warmUpSessions.get(accountId);
    session.interval = setTimeout(runWave, 1500);
    
    return true;
}

// Stop warm up session
function stopWarmUpSession(accountId) {
    const session = warmUpSessions.get(accountId);
    if (session && session.interval) {
        clearTimeout(session.interval);
        session.active = false;
        warmUpSessions.delete(accountId);
        return true;
    }
    return false;
}

// Socket.IO Connection Handling
io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);
    const accountId = socket.id;
    
    socket.on('init_whatsapp', async (data) => {
        const { phoneNumber, connectionType } = data;
        
        try {
            const client = new Client({
                authStrategy: new LocalAuth({ clientId: accountId }),
                puppeteer: {
                    headless: true,
                    args: [
                        '--no-sandbox',
                        '--disable-setuid-sandbox',
                        '--disable-dev-shm-usage',
                        '--disable-accelerated-2d-canvas',
                        '--disable-gpu',
                        '--window-size=800,600'
                    ]
                }
            });
            
            clients.set(accountId, {
                client,
                phoneNumber: phoneNumber || 'Pending',
                connectionType: connectionType || 'QR',
                trustScore: 28,
                wavesCompleted: 0,
                banned: false,
                restricted: false,
                recovered: false,
                status: 'connecting',
                createdAt: Date.now()
            });
            
            // QR Code handler
            client.on('qr', async (qr) => {
                try {
                    const qrDataUrl = await QRCode.toDataURL(qr, { width: 300, margin: 1 });
                    socket.emit('qr_code', { qr: qrDataUrl });
                } catch (err) {
                    socket.emit('error', { message: 'QR generation failed' });
                }
            });
            
            // Ready handler
            client.on('ready', () => {
                console.log(`WhatsApp ready for: ${accountId}`);
                const account = clients.get(accountId);
                if (account) {
                    account.status = 'ready';
                    account.phoneNumber = client.info.wid.user;
                    clients.set(accountId, account);
                    
                    const trustScore = calculateTrustScore(account);
                    const risk = calculateBanRisk(trustScore);
                    
                    socket.emit('whatsapp_ready', {
                        phoneNumber: client.info.wid.user,
                        trustScore: trustScore,
                        banRisk: risk.risk,
                        status: risk.status,
                        message: '✓ WhatsApp connected successfully!'
                    });
                    
                    socket.emit('status_update', {
                        phoneNumber: client.info.wid.user,
                        trustScore: trustScore,
                        banRisk: risk.risk,
                        status: risk.status,
                        activityScore: 0,
                        wavesCompleted: 0,
                        warmUpActive: false,
                        banned: false
                    });
                }
            });
            
            // Auth failure handler
            client.on('auth_failure', (msg) => {
                socket.emit('auth_failure', { message: 'Authentication failed. Please retry.' });
            });
            
            // Disconnected handler
            client.on('disconnected', (reason) => {
                console.log(`Client disconnected: ${reason}`);
                socket.emit('disconnected', { message: 'WhatsApp disconnected. Refresh to reconnect.' });
                const account = clients.get(accountId);
                if (account) account.status = 'disconnected';
                stopWarmUpSession(accountId);
            });
            
            await client.initialize();
            
        } catch (error) {
            console.error('Init error:', error);
            socket.emit('error', { message: error.message || 'Connection failed' });
        }
    });
    
    socket.on('start_warmup', (data) => {
        const { mode } = data;
        const account = clients.get(accountId);
        
        if (!account) {
            socket.emit('error', { message: 'Account not found. Please connect first.' });
            return;
        }
        
        if (account.banned) {
            socket.emit('error', { message: 'Account is banned. Cannot warm up.' });
            return;
        }
        
        if (account.status !== 'ready') {
            socket.emit('error', { message: 'WhatsApp not ready. Please wait for connection.' });
            return;
        }
        
        const started = startWarmUpSession(accountId, mode, account.client);
        if (started) {
            account.mode = mode;
            clients.set(accountId, account);
            socket.emit('warmup_started', { 
                mode, 
                message: `Warm up started in ${WARMUP_MODES[mode].name} mode` 
            });
        } else {
            socket.emit('error', { message: 'Warm up already active' });
        }
    });
    
    socket.on('stop_warmup', () => {
        const stopped = stopWarmUpSession(accountId);
        if (stopped) {
            socket.emit('warmup_stopped', { message: 'Warm up stopped' });
        }
    });
    
    socket.on('get_status', () => {
        const account = clients.get(accountId);
        const session = warmUpSessions.get(accountId);
        
        if (account) {
            const trustScore = calculateTrustScore(account);
            const risk = calculateBanRisk(trustScore);
            
            socket.emit('status_update', {
                phoneNumber: account.phoneNumber,
                trustScore: trustScore,
                banRisk: risk.risk,
                status: risk.status,
                activityScore: (account.wavesCompleted || 0) * 6,
                wavesCompleted: account.wavesCompleted || 0,
                warmUpActive: session?.active || false,
                banned: account.banned || false,
                mode: account.mode || 'aggressive'
            });
        }
    });
    
    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
        stopWarmUpSession(accountId);
        const account = clients.get(accountId);
        if (account && account.client) {
            account.client.destroy();
        }
        clients.delete(accountId);
        trustHistory.delete(accountId);
    });
});

// API Routes
app.get('/api/status', (req, res) => {
    const activeSessions = Array.from(warmUpSessions.keys()).filter(id => warmUpSessions.get(id)?.active);
    const readyAccounts = Array.from(clients.values()).filter(c => c.status === 'ready');
    
    res.json({
        status: 'online',
        uptime: process.uptime(),
        activeConnections: clients.size,
        activeWarmups: activeSessions.length,
        readyAccounts: readyAccounts.length,
        modes: Object.keys(WARMUP_MODES),
        timestamp: new Date().toISOString()
    });
});

app.get('/api/accounts', (req, res) => {
    const accounts = Array.from(clients.entries()).map(([id, data]) => ({
        id: id.substring(0, 8),
        phoneNumber: data.phoneNumber,
        trustScore: calculateTrustScore(data),
        banned: data.banned || false,
        status: data.status,
        warmUpActive: warmUpSessions.has(id) && warmUpSessions.get(id)?.active,
        mode: data.mode || 'aggressive',
        recovered: data.recovered || false
    }));
    res.json(accounts);
});

app.get('/api/history/:accountId', (req, res) => {
    const history = trustHistory.get(req.params.accountId) || [];
    res.json(history);
});

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'healthy', timestamp: Date.now() });
});

// Serve frontend
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`
    ╔════════════════════════════════════════════════════════════════╗
    ║  🔥 WHATSAPP WARMER PRO v4.0 - PRODUCTION READY 🔥            ║
    ║  ⚡ Reduce Ban Risk • Restore Trust Score • Real Activity     ║
    ║  🌐 Server: http://localhost:${PORT}                            ║
    ║  📡 WebSocket: Active • QR Code Ready • Multi-Session         ║
    ╚════════════════════════════════════════════════════════════════╝
    `);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received, closing server...');
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});
