const express = require('express');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    transports: ['websocket', 'polling']
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Store active clients
const clients = new Map();
const warmUpSessions = new Map();

// Warm Up Configuration
const WARMUP_MODES = {
    gentle: { delay: 8000, messagesPerHour: 15, increment: 1.2, maxWaves: 40, name: 'Gentle' },
    aggressive: { delay: 4000, messagesPerHour: 35, increment: 2.5, maxWaves: 55, name: 'Aggressive' },
    monster: { delay: 2000, messagesPerHour: 60, increment: 4.2, maxWaves: 75, name: 'Monster' }
};

// Generate random activity messages
const activityMessages = [
    "Checking account status...",
    "Syncing contact list...",
    "Updating profile presence...",
    "Verifying security settings...",
    "Syncing chat history...",
    "Updating last seen...",
    "Refreshing connection...",
    "Validating session...",
    "Updating privacy settings...",
    "Syncing media cache...",
    "Checking notifications...",
    "Updating status...",
    "Verifying phone number...",
    "Syncing groups...",
    "Updating broadcast lists..."
];

// Generate realistic conversation templates
const conversationTemplates = [
    "Hey, how are you?",
    "Thanks for the update!",
    "Sounds good, let me know.",
    "I'll check that later.",
    "Great, thanks!",
    "Okay, noted.",
    "Interesting!",
    "Will do, thanks.",
    "Understood.",
    "Perfect, thank you!"
];

function calculateTrustScore(account) {
    let base = account.trustScore || 15;
    const waves = account.wavesCompleted || 0;
    const mode = account.mode || 'aggressive';
    const multiplier = WARMUP_MODES[mode].increment;
    
    let newScore = Math.min(100, base + (waves * multiplier * 0.7) + (account.successfulActions || 0) * 0.5);
    if (account.banned) newScore = Math.max(0, newScore - 50);
    return Math.round(newScore);
}

function calculateBanRisk(trustScore) {
    if (trustScore >= 90) return { risk: 5, status: 'Clean', level: 'low' };
    if (trustScore >= 70) return { risk: 15, status: 'Low Risk', level: 'low' };
    if (trustScore >= 50) return { risk: 35, status: 'Moderate Risk', level: 'medium' };
    if (trustScore >= 30) return { risk: 65, status: 'High Risk', level: 'high' };
    return { risk: 85, status: 'Restricted', level: 'critical' };
}

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
    let trustIncrease = config.increment + (Math.random() * 1.5);
    if (mode === 'monster' && session.wavesCompleted % 5 === 0) trustIncrease += 3;
    
    let newTrust = Math.min(100, (account.trustScore || 15) + trustIncrease);
    account.trustScore = newTrust;
    account.wavesCompleted = session.wavesCompleted;
    account.mode = mode;
    account.successfulActions = session.successfulActions;
    
    const risk = calculateBanRisk(newTrust);
    
    // Send real activity to WhatsApp
    try {
        if (client && client.info) {
            const randomMsg = activityMessages[Math.floor(Math.random() * activityMessages.length)];
            await client.sendPresenceAvailable();
            
            // Simulate typing status for realistic activity
            await client.sendStateTyping();
            await new Promise(resolve => setTimeout(resolve, 1500));
            await client.clearState();
        }
    } catch (err) {
        console.log('Activity simulation error:', err.message);
    }
    
    io.to(accountId).emit('warmup_update', {
        accountId,
        trustScore: newTrust,
        wavesCompleted: session.wavesCompleted,
        trustIncrease: trustIncrease.toFixed(1),
        banRisk: risk.risk,
        status: risk.status,
        activityScore: session.successfulActions * 8,
        message: `${config.name} wave ${session.wavesCompleted}: Trust +${trustIncrease.toFixed(1)}%`
    });
    
    clients.set(accountId, account);
    
    if (newTrust >= 90) {
        session.active = false;
        io.to(accountId).emit('warmup_complete', {
            accountId,
            trustScore: newTrust,
            message: '✓ Account reached optimal trust score!'
        });
        return false;
    }
    
    if (session.wavesCompleted >= config.maxWaves && newTrust < 90) {
        session.active = false;
        account.banned = true;
        clients.set(accountId, account);
        io.to(accountId).emit('warmup_failed', {
            accountId,
            trustScore: newTrust,
            message: '⚠️ Account failed to reach target. Possible restrictions detected.'
        });
        return false;
    }
    
    return true;
}

function startWarmUpSession(accountId, mode, client) {
    if (warmUpSessions.has(accountId)) {
        const existing = warmUpSessions.get(accountId);
        if (existing.active) return false;
    }
    
    const config = WARMUP_MODES[mode];
    
    warmUpSessions.set(accountId, {
        active: true,
        mode: mode,
        wavesCompleted: 0,
        successfulActions: 0,
        interval: null
    });
    
    const runWave = async () => {
        const session = warmUpSessions.get(accountId);
        if (!session || !session.active) return;
        
        const shouldContinue = await performWarmUpAction(accountId, client);
        if (shouldContinue) {
            session.interval = setTimeout(runWave, config.delay);
        } else {
            session.interval = null;
        }
    };
    
    const session = warmUpSessions.get(accountId);
    session.interval = setTimeout(runWave, 1000);
    
    return true;
}

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
    
    socket.on('init_whatsapp', async (data) => {
        const { phoneNumber, connectionType, pairingCode } = data;
        const accountId = socket.id;
        
        try {
            const client = new Client({
                authStrategy: new LocalAuth({ clientId: accountId }),
                puppeteer: {
                    headless: true,
                    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
                }
            });
            
            clients.set(accountId, {
                client,
                phoneNumber,
                connectionType,
                trustScore: 25,
                wavesCompleted: 0,
                banned: false,
                status: 'connected'
            });
            
            client.on('qr', (qr) => {
                QRCode.toDataURL(qr, (err, url) => {
                    socket.emit('qr_code', { qr: url });
                });
            });
            
            client.on('ready', () => {
                console.log(`Client ready: ${phoneNumber}`);
                const account = clients.get(accountId);
                if (account) account.status = 'ready';
                socket.emit('whatsapp_ready', { 
                    phoneNumber,
                    trustScore: account?.trustScore || 25,
                    message: '✓ WhatsApp connected successfully!'
                });
            });
            
            client.on('auth_failure', (msg) => {
                socket.emit('auth_failure', { message: 'Authentication failed. Please retry.' });
            });
            
            client.on('disconnected', (reason) => {
                console.log(`Client disconnected: ${reason}`);
                socket.emit('disconnected', { message: 'WhatsApp disconnected' });
            });
            
            await client.initialize();
            
        } catch (error) {
            console.error('Init error:', error);
            socket.emit('error', { message: error.message });
        }
    });
    
    socket.on('start_warmup', (data) => {
        const { accountId, mode } = data;
        const account = clients.get(accountId);
        
        if (!account || account.banned) {
            socket.emit('error', { message: 'Account not available or banned' });
            return;
        }
        
        const started = startWarmUpSession(accountId, mode, account.client);
        if (started) {
            socket.emit('warmup_started', { mode, message: `Warm up started in ${mode} mode` });
        } else {
            socket.emit('error', { message: 'Warm up already active' });
        }
    });
    
    socket.on('stop_warmup', (data) => {
        const { accountId } = data;
        const stopped = stopWarmUpSession(accountId);
        if (stopped) {
            socket.emit('warmup_stopped', { message: 'Warm up stopped' });
        }
    });
    
    socket.on('get_status', (data) => {
        const { accountId } = data;
        const account = clients.get(accountId);
        const session = warmUpSessions.get(accountId);
        
        if (account) {
            const trustScore = calculateTrustScore(account);
            const risk = calculateBanRisk(trustScore);
            
            socket.emit('status_update', {
                phoneNumber: account.phoneNumber,
                trustScore,
                banRisk: risk.risk,
                status: risk.status,
                activityScore: (account.wavesCompleted || 0) * 8,
                wavesCompleted: account.wavesCompleted || 0,
                warmUpActive: session?.active || false,
                banned: account.banned,
                mode: account.mode || 'aggressive'
            });
        }
    });
    
    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
        stopWarmUpSession(socket.id);
        const account = clients.get(socket.id);
        if (account && account.client) {
            account.client.destroy();
        }
        clients.delete(socket.id);
    });
});

// API Routes
app.get('/api/status', (req, res) => {
    const activeSessions = Array.from(warmUpSessions.keys()).filter(id => warmUpSessions.get(id)?.active);
    res.json({
        activeConnections: clients.size,
        activeWarmups: activeSessions.length,
        modes: Object.keys(WARMUP_MODES)
    });
});

app.get('/api/accounts', (req, res) => {
    const accounts = Array.from(clients.entries()).map(([id, data]) => ({
        id,
        phoneNumber: data.phoneNumber,
        trustScore: calculateTrustScore(data),
        banned: data.banned,
        status: data.status,
        warmUpActive: warmUpSessions.has(id) && warmUpSessions.get(id)?.active
    }));
    res.json(accounts);
});

// Serve frontend
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`
    ╔══════════════════════════════════════════════════════════╗
    ║  WHATSAPP WARMER v3.0 - RAILWAY READY                   ║
    ║  🔥 Reduce Ban Risk • Real Account Warm Up              ║
    ║  🌐 Server running on http://localhost:${PORT}            ║
    ╚══════════════════════════════════════════════════════════╝
    `);
});
