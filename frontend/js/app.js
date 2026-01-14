// Aplicacion principal
let chart;
let currentSessionId = null;
let cvDataPoints = [];
let selectedWifiSSID = null;
let cvScanStatus = 'not_started'; // 'not_started', 'running', 'completed'

// ============================================
// INICIALIZACION
// ============================================

window.onload = function() {
    initChart();
    setupMQTTCallbacks();
    loadConnectionSettings();  // Load saved MQTT settings
    checkBackendHealth();
    loadWifiStatus();
    loadTransmissionStats();
    loadDatabaseStats();

    // Actualizar estadisticas periodicamente
    setInterval(loadTransmissionStats, 10000);
    setInterval(loadDatabaseStats, 30000);
    setInterval(loadWifiStatus, 15000);

    // Cerrar dropdown al hacer clic fuera
    document.addEventListener('click', function(e) {
        if (!e.target.closest('.dropdown')) {
            closeAllDropdowns();
        }
    });
};

// Inicializar Chart.js
function initChart() {
    const ctx = document.getElementById('cvChart').getContext('2d');
    chart = new Chart(ctx, {
        type: 'line',
        data: {
            datasets: [{
                label: 'Current vs Voltage',
                data: [],
                borderColor: '#667eea',
                backgroundColor: 'rgba(102, 126, 234, 0.1)',
                tension: 0.4,
                pointRadius: 2,
                borderWidth: 2
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                x: {
                    type: 'linear',
                    title: {
                        display: true,
                        text: 'Voltage (V)',
                        font: { size: 14, weight: 'bold' }
                    }
                },
                y: {
                    title: {
                        display: true,
                        text: 'Current (µA)',
                        font: { size: 14, weight: 'bold' }
                    },
                    ticks: {
                        callback: function(value) {
                            return value.toFixed(2);
                        }
                    }
                }
            },
            plugins: {
                legend: {
                    display: true,
                    position: 'top'
                },
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            return `V: ${context.parsed.x.toFixed(3)} V, I: ${context.parsed.y.toFixed(2)} µA`;
                        }
                    }
                }
            },
            animation: {
                duration: 0
            }
        }
    });
}

// Configurar callbacks de MQTT
function setupMQTTCallbacks() {
    MQTTClient.onConnect = () => {
        addLog('MQTT connected successfully', 'success');
        updateMqttStatusBar(true);
        document.getElementById('transmissionPanel').classList.add('mqtt-active');
    };

    MQTTClient.onDisconnect = () => {
        addLog('MQTT disconnected', 'error');
        updateMqttStatusBar(false);
        document.getElementById('transmissionPanel').classList.remove('mqtt-active');
    };

    MQTTClient.onMessage = (topic, data) => {
        handleMQTTMessage(topic, data);
    };
}

// ============================================
// MQTT HANDLERS
// ============================================

// ============================================
// CONNECTION SETTINGS
// ============================================

/**
 * Load saved connection settings into the form
 */
function loadConnectionSettings() {
    // Try to load from localStorage first
    const saved = localStorage.getItem('mqttConfig');
    if (saved) {
        try {
            const config = JSON.parse(saved);
            document.getElementById('mqttBroker').value = config.broker || '';
            document.getElementById('mqttPort').value = config.port || 8884;
            document.getElementById('mqttUsername').value = config.username || '';
            document.getElementById('mqttPassword').value = config.password || '';
            document.getElementById('mqttSSL').checked = config.useSSL !== false;

            // Also update MQTTClient
            MQTTClient.loadSavedConfig();
            addLog('Loaded saved MQTT configuration', 'info');
        } catch (e) {
            console.warn('Could not load saved settings:', e);
        }
    }
}

/**
 * Save connection settings to localStorage
 */
function saveConnectionSettings() {
    const broker = document.getElementById('mqttBroker').value.trim();
    const port = parseInt(document.getElementById('mqttPort').value) || 8884;
    const username = document.getElementById('mqttUsername').value.trim();
    const password = document.getElementById('mqttPassword').value;
    const useSSL = document.getElementById('mqttSSL').checked;

    if (!broker) {
        addLog('Please enter a broker URL', 'error');
        return;
    }

    // Configure MQTTClient
    MQTTClient.configure(broker, port, username, password, useSSL);

    // Save to localStorage
    MQTTClient.saveConfig();

    addLog('Connection settings saved', 'success');
}

/**
 * Connect to MQTT using form values
 */
async function connectMQTT() {
    try {
        // Get values from form
        const broker = document.getElementById('mqttBroker').value.trim();
        const port = parseInt(document.getElementById('mqttPort').value) || 8884;
        const username = document.getElementById('mqttUsername').value.trim();
        const password = document.getElementById('mqttPassword').value;
        const useSSL = document.getElementById('mqttSSL').checked;

        if (!broker) {
            addLog('Please enter a broker URL', 'error');
            return;
        }

        // Configure MQTTClient with form values
        MQTTClient.configure(broker, port, username, password, useSSL);

        const protocol = useSSL ? 'wss' : 'ws';
        addLog(`Connecting to ${protocol}://${broker}:${port}...`);

        await MQTTClient.connect();
    } catch (error) {
        addLog('Failed to connect to MQTT: ' + error.message, 'error');
    }
}

function handleMQTTMessage(topic, data) {
    switch (topic) {
        case 'potentiostat/cv_data':
            handleCVData(data);
            break;

        case 'sensor/heartrate':
            handleHeartRate(data);
            break;

        case 'sensor/spo2':
            handleSpO2(data);
            break;

        case 'sensor/stress_laccase':
            handleStress(data);
            break;

        case 'potentiostat/status':
            addLog(`Potentiostat: ${JSON.stringify(data)}`, 'info');
            // Auto-detect scan completion from ESP32
            if (data.scan_active !== undefined) {
                if (data.scan_active === false && cvScanStatus === 'running') {
                    updateCVStatus('completed');
                    addLog('CV scan completed by potentiostat', 'success');
                } else if (data.scan_active === true && cvScanStatus !== 'running') {
                    updateCVStatus('running');
                }
            }
            break;

        case 'device/esp32/status':
            // Check if this is a credentials status message
            if (data.status === 'credentials_status') {
                handleEsp32CredentialsStatus(data);
            } else {
                addLog(`ESP32: ${JSON.stringify(data)}`, 'info');
            }
            // Update ESP32 status chip
            if (data.wifi && data.wifi.connected !== undefined) {
                document.getElementById('esp32StatusText').textContent = data.wifi.connected ? 'Online' : 'Offline';
            }
            break;
    }
}

function handleCVData(data) {
    if (data.voltage !== undefined && data.current !== undefined) {
        cvDataPoints.push({
            x: data.voltage,
            y: data.current
        });

        // Limitar puntos para performance
        if (cvDataPoints.length > 2000) {
            cvDataPoints.shift();
        }

        chart.data.datasets[0].data = cvDataPoints;
        chart.update('none');

        updatePointCount();
    }
}

function handleHeartRate(data) {
    // Check if data is valid (valid flag = 1 and bpm > 0)
    if (data.valid && data.bpm > 0) {
        document.getElementById('bpmValue').textContent = data.bpm.toFixed(1) + ' BPM';
        if (data.avg_bpm) {
            document.getElementById('avgBpmValue').textContent = 'Avg: ' + data.avg_bpm.toFixed(1);
        }
        addBioLog('Heart: ' + data.bpm.toFixed(1) + ' BPM');
    } else {
        document.getElementById('bpmValue').textContent = '-- BPM';
        document.getElementById('avgBpmValue').textContent = 'Avg: --';
    }
}

function handleSpO2(data) {
    // Check if data is valid (valid flag = 1 and spo2 > 0)
    if (data.valid && data.spo2 > 0) {
        document.getElementById('spo2Value').textContent = data.spo2.toFixed(1) + ' %';
        if (data.avg_spo2) {
            document.getElementById('avgSpo2Value').textContent = 'Avg: ' + data.avg_spo2.toFixed(1) + '%';
        }
        addBioLog('SpO2: ' + data.spo2.toFixed(1) + '%');
    } else {
        document.getElementById('spo2Value').textContent = '-- %';
        document.getElementById('avgSpo2Value').textContent = 'Avg: --';
    }
}

function handleStress(data) {
    document.getElementById('stressValue').textContent = data.stress_laccase.toFixed(2);
    addBioLog('Stress: ' + data.stress_laccase.toFixed(2));
}

// ============================================
// CONTROL FUNCTIONS
// ============================================

async function startScan() {
    if (!MQTTClient.isConnected()) {
        alert('Please connect to MQTT first');
        return;
    }

    try {
        // Obtener parametros
        const params = {
            userAlias: document.getElementById('userAlias').value || 'default_user',
            startPoint: parseFloat(document.getElementById('startPoint').value),
            firstVertex: parseFloat(document.getElementById('firstVertex').value),
            secondVertex: parseFloat(document.getElementById('secondVertex').value),
            zeroCrosses: parseInt(document.getElementById('zeroCrosses').value),
            scanRate: parseFloat(document.getElementById('scanRate').value)
        };

        // Crear sesion en backend
        const response = await API.startSession(params);
        currentSessionId = response.sessionId;

        updateSessionStatus(true);
        addLog(`Session started: ${currentSessionId}`, 'success');

        // Enviar parametros via MQTT (formato ESP32)
        const esp32Params = {
            sp: params.startPoint,
            fv: params.firstVertex,
            sv: params.secondVertex,
            zc: params.zeroCrosses,
            sr: params.scanRate
        };
        MQTTClient.publish('potentiostat/params', esp32Params);

        // Enviar comando START
        MQTTClient.publish('potentiostat/command', 'START');

        // Limpiar grafica
        cvDataPoints = [];
        chart.data.datasets[0].data = [];
        chart.update();
        updatePointCount();

        // Expand chart area when scanning
        document.querySelector('.chart-container').classList.add('active');
        document.querySelector('.card.full-width').classList.add('scanning');

        // Update CV status indicator
        updateCVStatus('running');

    } catch (error) {
        addLog('Error starting scan: ' + error.message, 'error');
    }
}

async function stopScan() {
    try {
        // Enviar comando STOP via MQTT
        MQTTClient.publish('potentiostat/command', 'STOP');

        // Finalizar sesion en backend
        if (currentSessionId) {
            await API.stopSession(currentSessionId);
            addLog(`Session stopped: ${currentSessionId}`, 'success');
            currentSessionId = null;
            updateSessionStatus(false);
        }

        // Remove scanning state
        document.querySelector('.chart-container').classList.remove('active');
        document.querySelector('.card.full-width').classList.remove('scanning');

        // Update CV status indicator
        updateCVStatus('completed');

    } catch (error) {
        addLog('Error stopping scan: ' + error.message, 'error');
    }
}

function clearChart() {
    cvDataPoints = [];
    chart.data.datasets[0].data = [];
    chart.update();
    updatePointCount();
    updateCVStatus('not_started');
    addLog('Chart cleared');
}

// HR Monitoring Control Functions
function startHRMonitoring() {
    if (!MQTTClient.isConnected()) {
        alert('Please connect to MQTT first');
        return;
    }

    MQTTClient.publish('device/esp32/config', JSON.stringify({ hr_monitoring: true }));
    addLog('HR monitoring started', 'success');
}

function stopHRMonitoring() {
    if (!MQTTClient.isConnected()) {
        alert('Please connect to MQTT first');
        return;
    }

    MQTTClient.publish('device/esp32/config', JSON.stringify({ hr_monitoring: false }));
    addLog('HR monitoring stopped', 'info');

    // Reset display to default values
    document.getElementById('bpmValue').textContent = '-- BPM';
    document.getElementById('avgBpmValue').textContent = 'Avg: --';
    document.getElementById('spo2Value').textContent = '-- %';
    document.getElementById('avgSpo2Value').textContent = 'Avg: --';
    document.getElementById('stressValue').textContent = '--';
}

// ============================================
// ESP32 CONFIGURATION FUNCTIONS
// ============================================

function showEsp32ConfigModal() {
    document.getElementById('esp32ConfigModal').classList.add('show');
    document.getElementById('esp32ConfigStatus').innerHTML = '';

    // Pre-fill with current MQTT broker settings from the connection form
    document.getElementById('esp32MqttBroker').value = document.getElementById('mqttBroker').value || '';
    document.getElementById('esp32MqttPort').value = document.getElementById('mqttPort').value || '8883';
    document.getElementById('esp32MqttUsername').value = document.getElementById('mqttUsername').value || '';
}

function closeEsp32ConfigModal() {
    document.getElementById('esp32ConfigModal').classList.remove('show');
}

function requestEsp32Status() {
    if (!MQTTClient.isConnected()) {
        showEsp32ConfigStatus('Please connect to MQTT first', 'error');
        return;
    }

    // Request current credentials status from ESP32
    MQTTClient.publish('device/esp32/config', JSON.stringify({ request_status: true }));
    showEsp32ConfigStatus('Requesting current configuration...', 'info');
    addLog('Requested ESP32 configuration status', 'info');
}

function sendEsp32Credentials(applyNow) {
    if (!MQTTClient.isConnected()) {
        showEsp32ConfigStatus('Please connect to MQTT first', 'error');
        return;
    }

    const credentials = {};

    // Collect WiFi credentials if provided
    const wifiSsid = document.getElementById('esp32WifiSsid').value.trim();
    const wifiPassword = document.getElementById('esp32WifiPassword').value;

    if (wifiSsid) {
        credentials.wifi_ssid = wifiSsid;
    }
    if (wifiPassword) {
        credentials.wifi_password = wifiPassword;
    }

    // Collect MQTT credentials if provided
    const mqttBroker = document.getElementById('esp32MqttBroker').value.trim();
    const mqttPort = parseInt(document.getElementById('esp32MqttPort').value);
    const mqttClientId = document.getElementById('esp32MqttClientId').value.trim();
    const mqttUsername = document.getElementById('esp32MqttUsername').value.trim();
    const mqttPassword = document.getElementById('esp32MqttPassword').value;

    if (mqttBroker) {
        credentials.mqtt_broker = mqttBroker;
    }
    if (mqttPort > 0) {
        credentials.mqtt_port = mqttPort;
    }
    if (mqttClientId) {
        credentials.mqtt_client_id = mqttClientId;
    }
    if (mqttUsername) {
        credentials.mqtt_username = mqttUsername;
    }
    if (mqttPassword) {
        credentials.mqtt_password = mqttPassword;
    }

    // Check if any credentials were provided
    if (Object.keys(credentials).length === 0) {
        showEsp32ConfigStatus('Please enter at least one credential to update', 'error');
        return;
    }

    // Add apply_now flag
    credentials.apply_now = applyNow;

    // Send credentials to ESP32
    MQTTClient.publish('device/esp32/credentials', JSON.stringify(credentials));

    if (applyNow) {
        showEsp32ConfigStatus('Credentials sent. Device will apply changes...', 'success');
        addLog('ESP32 credentials sent with apply_now=true', 'success');
    } else {
        showEsp32ConfigStatus('Credentials saved to ESP32 flash. Restart device to apply.', 'success');
        addLog('ESP32 credentials saved (restart required)', 'info');
    }
}

function showEsp32ConfigStatus(message, type) {
    const statusDiv = document.getElementById('esp32ConfigStatus');
    statusDiv.innerHTML = `<div class="config-message ${type}">${message}</div>`;
}

function handleEsp32CredentialsStatus(data) {
    // Handle credentials_status messages from ESP32
    if (data.status === 'credentials_status') {
        if (data.wifi) {
            document.getElementById('esp32WifiSsid').value = data.wifi.ssid || '';
            document.getElementById('esp32StatusText').textContent = data.wifi.connected ? 'Online' : 'Offline';
        }
        if (data.mqtt) {
            document.getElementById('esp32MqttBroker').value = data.mqtt.broker || '';
            document.getElementById('esp32MqttPort').value = data.mqtt.port || 8883;
            document.getElementById('esp32MqttClientId').value = data.mqtt.client_id || '';
            document.getElementById('esp32MqttUsername').value = data.mqtt.username || '';
        }
        showEsp32ConfigStatus('Current configuration loaded from ESP32', 'success');
        addLog('ESP32 configuration received', 'info');
    }
}

// ============================================
// DOWNLOAD FUNCTIONS
// ============================================

function toggleDownloadMenu() {
    const dropdown = document.querySelector('.dropdown');
    dropdown.classList.toggle('open');
}

function closeAllDropdowns() {
    document.querySelectorAll('.dropdown').forEach(d => d.classList.remove('open'));
}

async function downloadCSV() {
    closeAllDropdowns();
    if (!currentSessionId) {
        alert('No active session to download');
        return;
    }

    try {
        await API.exportSessionCSV(currentSessionId);
        addLog('CSV download started', 'success');
    } catch (error) {
        addLog('Error downloading CSV: ' + error.message, 'error');
    }
}

async function downloadTXT() {
    closeAllDropdowns();
    if (!currentSessionId) {
        alert('No active session to download');
        return;
    }

    try {
        await API.exportSessionTXT(currentSessionId);
        addLog('TXT download started', 'success');
    } catch (error) {
        addLog('Error downloading TXT: ' + error.message, 'error');
    }
}

async function downloadXLSX() {
    closeAllDropdowns();
    if (!currentSessionId) {
        alert('No active session to download');
        return;
    }

    try {
        await API.exportSessionXLSX(currentSessionId);
        addLog('Excel (XLSX) download started', 'success');
    } catch (error) {
        addLog('Error downloading XLSX: ' + error.message, 'error');
    }
}

async function downloadJSON() {
    closeAllDropdowns();
    if (!currentSessionId) {
        alert('No active session to download');
        return;
    }

    try {
        await API.exportSessionJSON(currentSessionId);
        addLog('JSON download started', 'success');
    } catch (error) {
        addLog('Error downloading JSON: ' + error.message, 'error');
    }
}

function downloadCurrentData() {
    closeAllDropdowns();
    if (cvDataPoints.length === 0) {
        alert('No data in chart to export');
        return;
    }

    // Exportar datos actuales del grafico
    let content = 'Index,Voltage (V),Current (A)\n';
    cvDataPoints.forEach((point, idx) => {
        content += `${idx + 1},${point.x},${point.y}\n`;
    });

    const blob = new Blob([content], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cv_chart_data_${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.csv`;
    a.click();
    URL.revokeObjectURL(url);

    addLog('Current chart data exported', 'success');
}

// ============================================
// WIFI MANAGEMENT
// ============================================

function toggleWifiPanel() {
    const panel = document.getElementById('wifiPanel');
    panel.scrollIntoView({ behavior: 'smooth' });
}

async function loadWifiStatus() {
    try {
        const response = await API.getWifiStatus();
        const status = response.data;

        const ssidEl = document.getElementById('currentWifiSSID');
        const signalEl = document.getElementById('currentWifiSignal');
        const ipEl = document.getElementById('currentWifiIP');
        const chipText = document.getElementById('wifiStatusText');
        const chip = document.getElementById('wifiStatusChip');

        // Get Connection Settings status elements
        const wifiStatusIndicator = document.getElementById('wifiStatusIndicator');
        const wifiConnectionText = document.getElementById('wifiConnectionText');

        if (status.connected) {
            ssidEl.textContent = status.ssid || 'Connected';
            signalEl.textContent = status.signal ? `(${status.signal}%)` : '';
            ipEl.textContent = status.ip ? `IP: ${status.ip}` : '';
            chipText.textContent = status.ssid || 'Connected';
            chip.classList.add('connected');
            chip.classList.remove('disconnected');
            // Update Connection Settings WiFi status
            wifiStatusIndicator.classList.add('connected');
            wifiStatusIndicator.classList.remove('disconnected');
            wifiConnectionText.textContent = 'Connected';
        } else {
            ssidEl.textContent = 'Not connected';
            signalEl.textContent = '';
            ipEl.textContent = '';
            chipText.textContent = 'Disconnected';
            chip.classList.add('disconnected');
            chip.classList.remove('connected');
            // Update Connection Settings WiFi status
            wifiStatusIndicator.classList.add('disconnected');
            wifiStatusIndicator.classList.remove('connected');
            wifiConnectionText.textContent = 'Disconnected';
        }

        // Cargar redes guardadas
        loadSavedNetworks();
    } catch (error) {
        console.error('Error loading WiFi status:', error);
    }
}

async function scanWifiNetworks() {
    const listEl = document.getElementById('wifiNetworksList');
    listEl.innerHTML = '<div class="wifi-placeholder">Scanning networks...</div>';

    try {
        const response = await API.scanWifiNetworks();
        const networks = response.data;

        if (networks.length === 0) {
            listEl.innerHTML = '<div class="wifi-placeholder">No networks found</div>';
            return;
        }

        listEl.innerHTML = networks.map(network => `
            <div class="wifi-network-item" onclick="openWifiConnect('${network.ssid}', '${network.security}')">
                <div class="wifi-network-info">
                    <span class="wifi-network-name">${network.ssid}</span>
                    <span class="wifi-network-security">${network.security}</span>
                </div>
                <div class="wifi-network-signal">
                    ${renderSignalBars(network.signal)}
                    <span>${network.signal}%</span>
                </div>
            </div>
        `).join('');

        addLog(`Found ${networks.length} WiFi networks`, 'info');
    } catch (error) {
        listEl.innerHTML = '<div class="wifi-placeholder">Error scanning networks</div>';
        addLog('Error scanning WiFi: ' + error.message, 'error');
    }
}

function renderSignalBars(signal) {
    const bars = 4;
    const activeBars = Math.ceil((signal / 100) * bars);

    let html = '<div class="signal-bars">';
    for (let i = 1; i <= bars; i++) {
        html += `<div class="signal-bar ${i <= activeBars ? 'active' : ''}"></div>`;
    }
    html += '</div>';
    return html;
}

function openWifiConnect(ssid, security) {
    selectedWifiSSID = ssid;
    document.getElementById('modalWifiSSID').textContent = ssid;
    document.getElementById('wifiPassword').value = '';

    if (security === 'Open' || security === 'open') {
        // Red abierta, conectar directamente
        submitWifiConnect();
    } else {
        document.getElementById('wifiPasswordModal').classList.add('show');
    }
}

function closeWifiModal() {
    document.getElementById('wifiPasswordModal').classList.remove('show');
    selectedWifiSSID = null;
}

async function submitWifiConnect() {
    const password = document.getElementById('wifiPassword').value;

    try {
        addLog(`Connecting to ${selectedWifiSSID}...`);
        closeWifiModal();

        const response = await API.connectWifi(selectedWifiSSID, password);

        if (response.success) {
            addLog(`Connected to ${selectedWifiSSID}`, 'success');
            loadWifiStatus();
        } else {
            addLog(`Failed to connect: ${response.message}`, 'error');
        }
    } catch (error) {
        addLog('Error connecting to WiFi: ' + error.message, 'error');
    }
}

async function disconnectWifi() {
    try {
        await API.disconnectWifi();
        addLog('WiFi disconnected', 'info');
        loadWifiStatus();
    } catch (error) {
        addLog('Error disconnecting WiFi: ' + error.message, 'error');
    }
}

async function loadSavedNetworks() {
    try {
        const response = await API.getSavedWifiNetworks();
        const networks = response.data;
        const listEl = document.getElementById('wifiSavedList');

        if (networks.length === 0) {
            listEl.innerHTML = '<div class="wifi-placeholder">No saved networks</div>';
            return;
        }

        listEl.innerHTML = networks.map(network => `
            <div class="wifi-network-item">
                <div class="wifi-network-info">
                    <span class="wifi-network-name">${network.ssid}</span>
                    <span class="wifi-network-security">Last: ${new Date(network.lastConnected).toLocaleDateString()}</span>
                </div>
                <button class="wifi-forget-btn" onclick="forgetWifiNetwork('${network.ssid}')">Forget</button>
            </div>
        `).join('');
    } catch (error) {
        console.error('Error loading saved networks:', error);
    }
}

async function forgetWifiNetwork(ssid) {
    if (!confirm(`Forget network "${ssid}"?`)) return;

    try {
        await API.forgetWifiNetwork(ssid);
        addLog(`Network ${ssid} forgotten`, 'info');
        loadSavedNetworks();
    } catch (error) {
        addLog('Error forgetting network: ' + error.message, 'error');
    }
}

async function saveCurrentWifiNetwork() {
    try {
        const response = await API.saveCurrentWifiNetwork();
        if (response.success) {
            addLog(response.message || 'Network saved', 'info');
            loadSavedNetworks();
        } else {
            addLog(response.message || 'Error saving network', 'error');
        }
    } catch (error) {
        addLog('Error saving network: ' + error.message, 'error');
    }
}

// ============================================
// TRANSMISSION & DATABASE STATUS
// ============================================

async function loadTransmissionStats() {
    try {
        const response = await API.getTransmissionStatus();
        const data = response.data;

        // Actualizar estadisticas
        document.getElementById('msgReceived').textContent = data.messageStats?.received || 0;
        document.getElementById('msgProcessed').textContent = data.messageStats?.processed || 0;
        document.getElementById('dataSaved').textContent = data.transmission?.dataPointsSaved || 0;
        document.getElementById('txErrors').textContent = data.messageStats?.errors || 0;

        // Actualizar uptime
        if (data.transmission?.uptime) {
            document.getElementById('systemUptime').textContent = data.transmission.uptime.formatted;
        }

        // Actualizar chip de transmision
        const txChip = document.getElementById('transmissionChip');
        const txText = document.getElementById('txStatusText');
        txText.textContent = `${data.messageStats?.received || 0} msg`;

        if (data.mqtt?.connected) {
            txChip.classList.add('connected');
            txChip.classList.remove('disconnected');
        } else {
            txChip.classList.add('disconnected');
            txChip.classList.remove('connected');
        }

    } catch (error) {
        console.error('Error loading transmission stats:', error);
    }
}

async function loadDatabaseStats() {
    try {
        // Estado de conexion
        const statusResponse = await API.checkDatabaseConnection();
        const status = statusResponse.data;

        const dbChip = document.getElementById('dbStatusChip');
        const dbChipText = document.getElementById('dbStatusText');
        const dbConnection = document.getElementById('dbConnection');
        const dbHost = document.getElementById('dbHost');

        if (status.connected) {
            dbChip.classList.add('connected');
            dbChip.classList.remove('disconnected');
            dbChipText.textContent = 'Connected';
            dbConnection.textContent = 'Connected';
            dbConnection.classList.add('connected');
            dbConnection.classList.remove('disconnected');
            dbHost.textContent = status.host + ':' + status.port;
        } else {
            dbChip.classList.add('disconnected');
            dbChip.classList.remove('connected');
            dbChipText.textContent = 'Disconnected';
            dbConnection.textContent = 'Disconnected';
            dbConnection.classList.add('disconnected');
            dbConnection.classList.remove('connected');
            dbHost.textContent = '--';
        }

        // Estadisticas de la base de datos
        try {
            const statsResponse = await API.getDatabaseStats();
            const stats = statsResponse.data;

            document.getElementById('dbUsers').textContent = stats.users || 0;
            document.getElementById('dbMeasurements').textContent = stats.measurements || 0;
            document.getElementById('dbCvPoints').textContent = stats.cvDataPoints || 0;
        } catch (e) {
            // DB stats no disponibles
        }

    } catch (error) {
        console.error('Error loading database stats:', error);
        document.getElementById('dbStatusText').textContent = 'Error';
        document.getElementById('dbConnection').textContent = 'Error';
    }
}

function showDatabaseDetails() {
    const panel = document.getElementById('transmissionPanel');
    panel.scrollIntoView({ behavior: 'smooth' });
}

function showTransmissionDetails() {
    document.getElementById('transmissionModal').classList.add('show');
    refreshTransmissionDetails();
}

function closeTransmissionModal() {
    document.getElementById('transmissionModal').classList.remove('show');
}

async function refreshTransmissionDetails() {
    const detailsEl = document.getElementById('transmissionDetails');
    detailsEl.innerHTML = '<div class="spinner"></div> Loading...';

    try {
        const response = await API.getTransmissionStatus();
        const data = response.data;

        let html = `
            <div class="db-info">
                <div class="db-item">
                    <span class="db-label">MQTT Connected:</span>
                    <span class="db-value ${data.mqtt?.connected ? 'connected' : 'disconnected'}">
                        ${data.mqtt?.connected ? 'Yes' : 'No'}
                    </span>
                </div>
                <div class="db-item">
                    <span class="db-label">Broker:</span>
                    <span class="db-value">${data.mqtt?.broker || '--'}</span>
                </div>
                <div class="db-item">
                    <span class="db-label">Current Measurement:</span>
                    <span class="db-value">${data.mqtt?.currentMeasurement || 'None'}</span>
                </div>
                <div class="db-item">
                    <span class="db-label">Messages Received:</span>
                    <span class="db-value">${data.messageStats?.received || 0}</span>
                </div>
                <div class="db-item">
                    <span class="db-label">Messages Processed:</span>
                    <span class="db-value">${data.messageStats?.processed || 0}</span>
                </div>
                <div class="db-item">
                    <span class="db-label">Errors:</span>
                    <span class="db-value error">${data.messageStats?.errors || 0}</span>
                </div>
                <div class="db-item">
                    <span class="db-label">System Uptime:</span>
                    <span class="db-value">${data.transmission?.uptime?.formatted || '--'}</span>
                </div>
            </div>
        `;

        // Topics stats
        if (data.messageStats?.byTopic) {
            html += '<h4 style="margin-top: 15px;">Messages by Topic</h4><div class="db-info">';
            for (const [topic, count] of Object.entries(data.messageStats.byTopic)) {
                html += `
                    <div class="db-item">
                        <span class="db-label">${topic}</span>
                        <span class="db-value">${count}</span>
                    </div>
                `;
            }
            html += '</div>';
        }

        detailsEl.innerHTML = html;
    } catch (error) {
        detailsEl.innerHTML = `<div class="error">Error loading details: ${error.message}</div>`;
    }
}

// ============================================
// UI HELPERS
// ============================================

function updateSessionStatus(active) {
    const statusDot = document.querySelector('#sessionStatus .status-dot');
    const statusText = document.getElementById('sessionText');

    if (statusDot && statusText) {
        if (active) {
            statusDot.classList.add('active');
            statusText.textContent = 'Active';
        } else {
            statusDot.classList.remove('active');
            statusText.textContent = 'Inactive';
        }
    }
}

function updateMqttStatusBar(connected) {
    const chip = document.getElementById('mqttStatusChip');
    const text = document.getElementById('mqttStatusBarText');

    if (connected) {
        chip.classList.add('connected');
        chip.classList.remove('disconnected');
        text.textContent = 'Connected';
    } else {
        chip.classList.add('disconnected');
        chip.classList.remove('connected');
        text.textContent = 'Disconnected';
    }
}

function updatePointCount() {
    const countElement = document.getElementById('pointCount');
    if (countElement) {
        countElement.textContent = cvDataPoints.length;
    }
}

function updateCVStatus(status) {
    cvScanStatus = status;
    const indicator = document.getElementById('cvStatusIndicator');
    const statusText = document.getElementById('cvStatusText');

    if (!indicator || !statusText) return;

    // Remove all status classes
    indicator.classList.remove('running', 'completed');

    switch (status) {
        case 'running':
            indicator.classList.add('running');
            statusText.textContent = 'Running';
            break;
        case 'completed':
            indicator.classList.add('completed');
            statusText.textContent = 'Completed';
            break;
        default:
            statusText.textContent = 'Not Started';
    }
}

function addLog(message, type = '') {
    const logDiv = document.getElementById('systemLog');
    const entry = document.createElement('div');
    entry.className = 'log-entry' + (type ? ' ' + type : '');

    const time = new Date().toLocaleTimeString();
    entry.innerHTML = `<span class="timestamp">[${time}]</span> ${message}`;

    logDiv.insertBefore(entry, logDiv.firstChild);

    // Limitar entradas
    while (logDiv.children.length > 100) {
        logDiv.removeChild(logDiv.lastChild);
    }
}

function addBioLog(message) {
    const logDiv = document.getElementById('bioLog');
    const entry = document.createElement('div');
    entry.className = 'log-entry';

    const time = new Date().toLocaleTimeString();
    entry.innerHTML = `<span class="timestamp">[${time}]</span> ${message}`;

    logDiv.insertBefore(entry, logDiv.firstChild);

    // Limitar entradas
    while (logDiv.children.length > 50) {
        logDiv.removeChild(logDiv.lastChild);
    }
}

// ============================================
// HEALTH CHECK
// ============================================

async function checkBackendHealth() {
    try {
        const health = await API.health();
        addLog('Backend connected', 'success');

        if (health.services) {
            if (health.services.database === 'connected') {
                addLog('Database connected', 'success');
            } else {
                addLog('Database disconnected', 'error');
            }

            if (health.services.mqtt === 'connected') {
                addLog('MQTT broker connected', 'success');
            }
        }

        if (health.session) {
            currentSessionId = health.session;
            updateSessionStatus(true);
            addLog(`Resumed session: ${currentSessionId}`, 'info');
        }
    } catch (error) {
        addLog('Backend not available: ' + error.message, 'error');
    }
}
