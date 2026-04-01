// Socket connection
const socket = io({
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 1000
});

// State
let connected = false;
let currentMode = 'aggressive';
let trustChart = null;
let trustHistory = [28, 32, 38, 42, 45];

// DOM Elements
const connStatus = document.getElementById('connStatus');
const connectBtn = document.getElementById('connectBtn');
const startWarmupBtn = document.getElementById('startWarmupBtn');
const stopWarmupBtn = document.getElementById('stopWarmupBtn');
const qrContainer = document.getElementById('qrContainer');
const qrDisplay = document.getElementById('qrDisplay');
const qrPlaceholder = document.querySelector('.qr-placeholder');
const trustScoreSpan = document.getElementById('trustScore');
const trustFill = document.getElementById('trustFill');
const banRiskSpan = document.getElementById('banRisk');
const accountStatusSpan = document.getElementById('accountStatus');
const activityScoreSpan = document.getElementById('activityScore');
const wavesCountSpan = document.getElementById('wavesCount');
const logContainer = document.getElementById('logContainer');

// Helper Functions
function addLog(message, type = 'info') {
    const time = new Date().toLocaleTimeString();
    const logLine = document.createElement('div');
    logLine.className = `log-line ${type}`;
    logLine.innerHTML = `<span class="log-time">[${time}]</span> ${message}`;
    logContainer.appendChild(logLine);
    logLine.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    
    while (logContainer.children.length > 100) {
        logContainer.removeChild(logContainer.firstChild);
    }
}

function updateTrustDisplay(trust, banRisk, status, activity, waves) {
    trustScoreSpan.innerText = `${Math.round(trust)}%`;
    trustFill.style.width = `${trust}%`;
    banRiskSpan.innerText = `${banRisk}%`;
    accountStatusSpan.innerText = status;
    activityScoreSpan.innerText = activity;
    wavesCountSpan.innerText = waves;
    
    // Update risk badge color
    const riskBadge = document.querySelector('.risk-value');
    if (riskBadge) {
        if (banRisk <= 15) riskBadge.style.color = '#10b981';
        else if (banRisk <= 45) riskBadge.style.color = '#f59e0b';
        else riskBadge.style.color = '#ef4444';
    }
    
    // Update trust history for chart
    trustHistory.push(trust);
    if (trustHistory.length > 10) trustHistory.shift();
    
    if (trustChart) {
        trustChart.data.datasets[0].data = [...trustHistory];
        trustChart.update();
    }
}

// Socket Events
socket.on('connect', () => {
    addLog('✓ Connected to server', 'success');
    connStatus.innerHTML = '<span class="status-dot"></span> Connected';
    connStatus.classList.add('connected');
});

socket.on('disconnect', () => {
    addLog('⚠️ Disconnected from server', 'warning');
    connStatus.innerHTML = '<span class="status-dot"></span> Disconnected';
    connStatus.classList.remove('connected');
    connected = false;
});

socket.on('qr_code', (data) => {
    qrPlaceholder.style.display = 'none';
    qrDisplay.style.display = 'block';
    qrDisplay.innerHTML = `<img src="${data.qr}" alt="QR Code">`;
    addLog('📱 QR Code generated. Scan with WhatsApp → Settings → Linked Devices', 'success');
});

socket.on('whatsapp_ready', (data) => {
    connected = true;
    startWarmupBtn.disabled = false;
    addLog(`✓ ${data.message} Phone: ${data.phoneNumber}`, 'success');
    updateTrustDisplay(data.trustScore, data.banRisk, data.status, 0, 0);
});

socket.on('auth_failure', (data) => {
    addLog(`❌ ${data.message}`, 'error');
});

socket.on('error', (data) => {
    addLog(`⚠️ ${data.message}`, 'error');
});

socket.on('warmup_started', (data) => {
    addLog(`🔥 ${data.message}`, 'success');
    startWarmupBtn.disabled = true;
    stopWarmupBtn.disabled = false;
});

socket.on('warmup_stopped', (data) => {
    addLog(`⏸ ${data.message}`, 'warning');
    startWarmupBtn.disabled = false;
    stopWarmupBtn.disabled = true;
});

socket.on('warmup_update', (data) => {
    updateTrustDisplay(data.trustScore, data.banRisk, data.status, data.activityScore, data.wavesCompleted);
    addLog(`${data.message} | Trust: +${data.trustIncrease}% (${data.trustScore}%)`, 'success');
});

socket.on('warmup_complete', (data) => {
    updateTrustDisplay(data.trustScore, 5, 'Clean', data.activityScore || 800, data.wavesCompleted);
    addLog(`🎉 ${data.message}`, 'success');
    startWarmupBtn.disabled = false;
    stopWarmupBtn.disabled = true;
});

socket.on('warmup_failed', (data) => {
    addLog(`⚠️ ${data.message}`, 'error');
    startWarmupBtn.disabled = false;
    stopWarmupBtn.disabled = true;
});

socket.on('status_update', (data) => {
    updateTrustDisplay(data.trustScore, data.banRisk, data.status, data.activityScore, data.wavesCompleted);
    if (data.warmUpActive) {
        startWarmupBtn.disabled = true;
        stopWarmupBtn.disabled = false;
    }
});

// UI Event Handlers
connectBtn.addEventListener('click', () => {
    addLog('🔄 Initializing WhatsApp connection...', 'info');
    qrPlaceholder.style.display = 'flex';
    qrDisplay.style.display = 'none';
    socket.emit('init_whatsapp', { phoneNumber: '', connectionType: 'qr' });
});

startWarmupBtn.addEventListener('click', () => {
    if (!connected) {
        addLog('Please connect WhatsApp first', 'error');
        return;
    }
    socket.emit('start_warmup', { mode: currentMode });
});

stopWarmupBtn.addEventListener('click', () => {
    socket.emit('stop_warmup');
});

document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentMode = btn.getAttribute('data-mode');
        addLog(`Mode changed to: ${currentMode.toUpperCase()}`, 'info');
    });
});

// Initialize Chart
const ctx = document.getElementById('trustChart').getContext('2d');
trustChart = new Chart(ctx, {
    type: 'line',
    data: {
        labels: ['-5', '-4', '-3', '-2', '-1', 'Now'],
        datasets: [{
            label: 'Trust Score',
            data: trustHistory,
            borderColor: '#06b6d4',
            backgroundColor: 'rgba(6,182,212,0.05)',
            borderWidth: 2.5,
            fill: true,
            tension: 0.3,
            pointRadius: 3,
            pointBackgroundColor: '#8b5cf6',
            pointBorderColor: 'white',
            pointBorderWidth: 1.5
        }]
    },
    options: {
        responsive: true,
        maintainAspectRatio: true,
        plugins: {
            legend: { display: false },
            tooltip: {
                backgroundColor: '#1e293b',
                titleColor: '#f1f5f9',
                bodyColor: '#cbd5e1',
                borderColor: '#06b6d4',
                borderWidth: 1
            }
        },
        scales: {
            y: {
                min: 0,
                max: 100,
                grid: { color: '#e2e8f0', drawBorder: false },
                title: { display: true, text: 'Trust Score %', color: '#94a3b8', font: { size: 10 } }
            },
            x: {
                grid: { display: false },
                ticks: { color: '#94a3b8', font: { size: 10 } }
            }
        }
    }
});

// Initial log
addLog('WhatsApp Warmer Pro v4.0 ready', 'success');
addLog('Click "Generate QR Code" to connect your WhatsApp account', 'info');
