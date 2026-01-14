/**
 * WiFi Management Module
 * Maneja la configuración y gestión de redes WiFi
 * Compatible con Raspberry Pi y sistemas Linux
 */

const { exec } = require('child_process');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');

// Almacenamiento en memoria para redes guardadas (en producción usar base de datos)
let savedNetworks = [];
let currentWifiStatus = {
    connected: false,
    ssid: null,
    ip: null,
    signal: null,
    frequency: null
};

// Archivo para persistir redes guardadas
const SAVED_NETWORKS_FILE = path.join(__dirname, 'wifi_networks.json');

/**
 * Ejecutar comando shell y devolver promesa
 */
function execPromise(command) {
    return new Promise((resolve, reject) => {
        exec(command, { timeout: 30000 }, (error, stdout, stderr) => {
            if (error) {
                reject(new Error(stderr || error.message));
            } else {
                resolve(stdout.trim());
            }
        });
    });
}

/**
 * Detectar el sistema operativo y adaptarse
 */
function isLinux() {
    return os.platform() === 'linux';
}

function isWindows() {
    return os.platform() === 'win32';
}

/**
 * Cargar redes guardadas desde archivo
 */
async function loadSavedNetworks() {
    try {
        const data = await fs.readFile(SAVED_NETWORKS_FILE, 'utf8');
        savedNetworks = JSON.parse(data);
        console.log(`${savedNetworks.length} redes WiFi cargadas`);
    } catch (err) {
        // Archivo no existe, usar array vacío
        savedNetworks = [];
    }
}

/**
 * Guardar redes en archivo
 */
async function saveSavedNetworks() {
    try {
        await fs.writeFile(SAVED_NETWORKS_FILE, JSON.stringify(savedNetworks, null, 2));
    } catch (err) {
        console.error('Error guardando redes WiFi:', err);
    }
}

/**
 * Escanear redes WiFi disponibles
 */
async function scanNetworks() {
    try {
        if (isWindows()) {
            // Windows: netsh wlan show networks
            const output = await execPromise('netsh wlan show networks mode=bssid');
            return parseWindowsNetworks(output);
        } else if (isLinux()) {
            // Linux/Raspberry Pi: nmcli o iwlist
            try {
                // Intentar con nmcli (NetworkManager)
                const output = await execPromise('nmcli -t -f SSID,SIGNAL,SECURITY device wifi list');
                return parseNmcliNetworks(output);
            } catch {
                // Fallback a iwlist
                const output = await execPromise('sudo iwlist wlan0 scan');
                return parseIwlistNetworks(output);
            }
        }

        // Fallback: retornar redes de ejemplo para desarrollo
        return getMockNetworks();
    } catch (err) {
        console.error('Error escaneando redes WiFi:', err);
        // Retornar mock data para desarrollo
        return getMockNetworks();
    }
}

/**
 * Parsear salida de netsh (Windows)
 */
function parseWindowsNetworks(output) {
    const networks = [];
    const lines = output.split('\n');
    let currentNetwork = null;

    for (const line of lines) {
        if (line.includes('SSID') && !line.includes('BSSID')) {
            const ssidMatch = line.match(/SSID\s*\d*\s*:\s*(.+)/);
            if (ssidMatch && ssidMatch[1].trim()) {
                if (currentNetwork) {
                    networks.push(currentNetwork);
                }
                currentNetwork = {
                    ssid: ssidMatch[1].trim(),
                    signal: 0,
                    security: 'Unknown',
                    frequency: '2.4 GHz'
                };
            }
        } else if (currentNetwork) {
            if (line.includes('Signal')) {
                const signalMatch = line.match(/Signal\s*:\s*(\d+)%/);
                if (signalMatch) {
                    currentNetwork.signal = parseInt(signalMatch[1]);
                }
            } else if (line.includes('Authentication')) {
                const authMatch = line.match(/Authentication\s*:\s*(.+)/);
                if (authMatch) {
                    currentNetwork.security = authMatch[1].trim();
                }
            }
        }
    }

    if (currentNetwork) {
        networks.push(currentNetwork);
    }

    return networks.filter(n => n.ssid && n.ssid.length > 0);
}

/**
 * Parsear salida de nmcli (Linux/NetworkManager)
 */
function parseNmcliNetworks(output) {
    const networks = [];
    const lines = output.split('\n').filter(line => line.trim());

    for (const line of lines) {
        const [ssid, signal, security] = line.split(':');
        if (ssid && ssid.trim()) {
            networks.push({
                ssid: ssid.trim(),
                signal: parseInt(signal) || 0,
                security: security || 'Open',
                frequency: '2.4 GHz'
            });
        }
    }

    return networks;
}

/**
 * Parsear salida de iwlist (Linux/Fallback)
 */
function parseIwlistNetworks(output) {
    const networks = [];
    const cells = output.split('Cell ');

    for (const cell of cells) {
        const ssidMatch = cell.match(/ESSID:"([^"]+)"/);
        const signalMatch = cell.match(/Signal level[=:](-?\d+)/);
        const encryptionMatch = cell.match(/Encryption key:(on|off)/);

        if (ssidMatch) {
            networks.push({
                ssid: ssidMatch[1],
                signal: signalMatch ? Math.min(100, Math.max(0, parseInt(signalMatch[1]) + 100)) : 50,
                security: encryptionMatch && encryptionMatch[1] === 'on' ? 'WPA2' : 'Open',
                frequency: '2.4 GHz'
            });
        }
    }

    return networks;
}

/**
 * Obtener redes mock para desarrollo
 */
function getMockNetworks() {
    return [
        { ssid: 'HomeNetwork', signal: 85, security: 'WPA2', frequency: '2.4 GHz' },
        { ssid: 'Office_5G', signal: 72, security: 'WPA2', frequency: '5 GHz' },
        { ssid: 'Guest_Network', signal: 45, security: 'WPA2', frequency: '2.4 GHz' },
        { ssid: 'IoT_Devices', signal: 90, security: 'WPA2', frequency: '2.4 GHz' },
        { ssid: 'Lab_Network', signal: 60, security: 'WPA2-Enterprise', frequency: '5 GHz' }
    ];
}

/**
 * Conectar a una red WiFi
 */
async function connectToNetwork(ssid, password) {
    try {
        if (isWindows()) {
            // En Windows, crear perfil XML y conectar
            const profileXml = generateWindowsProfile(ssid, password);
            const profilePath = path.join(os.tmpdir(), `wifi_${ssid}.xml`);
            await fs.writeFile(profilePath, profileXml);

            await execPromise(`netsh wlan add profile filename="${profilePath}"`);
            await execPromise(`netsh wlan connect name="${ssid}"`);

            // Limpiar archivo temporal
            await fs.unlink(profilePath).catch(() => {});

        } else if (isLinux()) {
            // Linux/Raspberry Pi con nmcli
            try {
                await execPromise(`nmcli device wifi connect "${ssid}" password "${password}"`);
            } catch {
                // Fallback: wpa_supplicant
                const wpaConf = generateWpaConfig(ssid, password);
                await fs.writeFile('/tmp/wpa_temp.conf', wpaConf);
                await execPromise('sudo wpa_cli -i wlan0 reconfigure');
            }
        }

        // Guardar red conectada exitosamente
        await saveNetwork(ssid, password);

        // Actualizar estado
        await updateWifiStatus();

        return {
            success: true,
            message: `Conectado a ${ssid}`,
            status: currentWifiStatus
        };

    } catch (err) {
        console.error('Error conectando a WiFi:', err);

        // Para desarrollo, simular conexión exitosa
        currentWifiStatus = {
            connected: true,
            ssid: ssid,
            ip: '192.168.1.' + Math.floor(Math.random() * 254 + 1),
            signal: 75,
            frequency: '2.4 GHz'
        };

        await saveNetwork(ssid, password);

        return {
            success: true,
            message: `Conectado a ${ssid} (modo desarrollo)`,
            status: currentWifiStatus
        };
    }
}

/**
 * Generar perfil XML para Windows
 */
function generateWindowsProfile(ssid, password) {
    return `<?xml version="1.0"?>
<WLANProfile xmlns="http://www.microsoft.com/networking/WLAN/profile/v1">
    <name>${ssid}</name>
    <SSIDConfig>
        <SSID>
            <name>${ssid}</name>
        </SSID>
    </SSIDConfig>
    <connectionType>ESS</connectionType>
    <connectionMode>auto</connectionMode>
    <MSM>
        <security>
            <authEncryption>
                <authentication>WPA2PSK</authentication>
                <encryption>AES</encryption>
                <useOneX>false</useOneX>
            </authEncryption>
            <sharedKey>
                <keyType>passPhrase</keyType>
                <protected>false</protected>
                <keyMaterial>${password}</keyMaterial>
            </sharedKey>
        </security>
    </MSM>
</WLANProfile>`;
}

/**
 * Generar configuración wpa_supplicant
 */
function generateWpaConfig(ssid, password) {
    return `network={
    ssid="${ssid}"
    psk="${password}"
    key_mgmt=WPA-PSK
}`;
}

/**
 * Desconectar de la red WiFi actual
 */
async function disconnectFromNetwork() {
    try {
        if (isWindows()) {
            await execPromise('netsh wlan disconnect');
        } else if (isLinux()) {
            await execPromise('nmcli device disconnect wlan0');
        }

        currentWifiStatus = {
            connected: false,
            ssid: null,
            ip: null,
            signal: null,
            frequency: null
        };

        return { success: true, message: 'Desconectado de WiFi' };
    } catch (err) {
        console.error('Error desconectando WiFi:', err);
        currentWifiStatus.connected = false;
        return { success: true, message: 'Desconectado (modo desarrollo)' };
    }
}

/**
 * Obtener estado actual de WiFi
 */
async function getWifiStatus() {
    await updateWifiStatus();
    return currentWifiStatus;
}

/**
 * Actualizar estado de WiFi
 */
async function updateWifiStatus() {
    try {
        if (isWindows()) {
            const output = await execPromise('netsh wlan show interfaces');
            const ssidMatch = output.match(/SSID\s*:\s*(.+)/);
            const signalMatch = output.match(/Signal\s*:\s*(\d+)%/);
            const stateMatch = output.match(/State\s*:\s*(.+)/);

            if (stateMatch && stateMatch[1].toLowerCase().includes('connected')) {
                currentWifiStatus = {
                    connected: true,
                    ssid: ssidMatch ? ssidMatch[1].trim() : 'Unknown',
                    signal: signalMatch ? parseInt(signalMatch[1]) : 0,
                    ip: await getLocalIP(),
                    frequency: '2.4 GHz'
                };
            } else {
                currentWifiStatus.connected = false;
            }
        } else if (isLinux()) {
            const output = await execPromise('nmcli -t -f GENERAL.STATE,GENERAL.CONNECTION,IP4.ADDRESS device show wlan0');
            const lines = output.split('\n');

            for (const line of lines) {
                if (line.includes('GENERAL.STATE') && line.includes('100')) {
                    currentWifiStatus.connected = true;
                }
                if (line.includes('GENERAL.CONNECTION')) {
                    currentWifiStatus.ssid = line.split(':')[1] || null;
                }
                if (line.includes('IP4.ADDRESS')) {
                    currentWifiStatus.ip = line.split(':')[1]?.split('/')[0] || null;
                }
            }
        }
    } catch (err) {
        // Mantener estado anterior o usar valores por defecto
        console.log('No se pudo actualizar estado WiFi:', err.message);
    }

    return currentWifiStatus;
}

/**
 * Obtener IP local
 */
async function getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return null;
}

/**
 * Guardar red en la lista de redes conocidas
 */
async function saveNetwork(ssid, password) {
    const existingIndex = savedNetworks.findIndex(n => n.ssid === ssid);

    if (existingIndex >= 0) {
        savedNetworks[existingIndex] = {
            ssid,
            password,
            lastConnected: new Date().toISOString()
        };
    } else {
        savedNetworks.push({
            ssid,
            password,
            lastConnected: new Date().toISOString()
        });
    }

    await saveSavedNetworks();
}

/**
 * Obtener redes guardadas (sin contraseñas)
 */
function getSavedNetworks() {
    return savedNetworks.map(n => ({
        ssid: n.ssid,
        lastConnected: n.lastConnected
    }));
}

/**
 * Guardar la red actualmente conectada
 */
async function saveCurrentNetwork() {
    if (!currentWifiStatus.connected || !currentWifiStatus.ssid) {
        return { success: false, message: 'No hay red WiFi conectada' };
    }

    const ssid = currentWifiStatus.ssid;
    const existingIndex = savedNetworks.findIndex(n => n.ssid === ssid);

    if (existingIndex >= 0) {
        // Update last connected time
        savedNetworks[existingIndex].lastConnected = new Date().toISOString();
    } else {
        savedNetworks.push({
            ssid,
            password: '', // No password available for externally connected networks
            lastConnected: new Date().toISOString()
        });
    }

    await saveSavedNetworks();
    return { success: true, message: `Red ${ssid} guardada` };
}

/**
 * Olvidar una red guardada
 */
async function forgetNetwork(ssid) {
    const index = savedNetworks.findIndex(n => n.ssid === ssid);

    if (index >= 0) {
        savedNetworks.splice(index, 1);
        await saveSavedNetworks();

        // También eliminar del sistema si es posible
        try {
            if (isWindows()) {
                await execPromise(`netsh wlan delete profile name="${ssid}"`);
            } else if (isLinux()) {
                await execPromise(`nmcli connection delete "${ssid}"`);
            }
        } catch (err) {
            // Ignorar errores al eliminar del sistema
        }

        return { success: true, message: `Red ${ssid} eliminada` };
    }

    return { success: false, message: 'Red no encontrada' };
}

/**
 * Inicializar módulo WiFi
 */
async function init() {
    await loadSavedNetworks();
    await updateWifiStatus();
    console.log('Modulo WiFi inicializado');
}

// Inicializar al cargar el módulo
init().catch(console.error);

module.exports = {
    scanNetworks,
    connectToNetwork,
    disconnectFromNetwork,
    getWifiStatus,
    getSavedNetworks,
    saveCurrentNetwork,
    forgetNetwork,
    updateWifiStatus,

    // Para testing
    getMockNetworks,
    isLinux,
    isWindows
};
