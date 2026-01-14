/**
 * API Client para el frontend
 * Maneja todas las comunicaciones con el backend
 */

const API = {
    // Usar ruta relativa para que funcione desde el mismo servidor
    baseURL: '/api',

    // ============================================
    // MÉTODOS AUXILIARES
    // ============================================

    /**
     * Realizar petición HTTP
     */
    async request(endpoint, options = {}) {
        const url = `${this.baseURL}${endpoint}`;

        const defaultOptions = {
            headers: {
                'Content-Type': 'application/json'
            }
        };

        const config = {
            ...defaultOptions,
            ...options,
            headers: {
                ...defaultOptions.headers,
                ...options.headers
            }
        };

        try {
            const response = await fetch(url, config);

            // Si es descarga de archivo
            if (options.blob) {
                if (!response.ok) {
                    throw new Error(`HTTP error! status: ${response.status}`);
                }
                return response.blob();
            }

            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.error || data.message || `HTTP error! status: ${response.status}`);
            }

            return data;
        } catch (error) {
            console.error(`API Error [${endpoint}]:`, error);
            throw error;
        }
    },

    /**
     * GET request
     */
    async get(endpoint) {
        return this.request(endpoint, { method: 'GET' });
    },

    /**
     * POST request
     */
    async post(endpoint, body) {
        return this.request(endpoint, {
            method: 'POST',
            body: JSON.stringify(body)
        });
    },

    // ============================================
    // HEALTH & STATUS
    // ============================================

    /**
     * Verificar estado del backend
     */
    async health() {
        return this.get('/health');
    },

    /**
     * Obtener estado del sistema
     */
    async getSystemStatus() {
        return this.get('/system/status');
    },

    // ============================================
    // SESIONES / MEDICIONES
    // ============================================

    /**
     * Iniciar nueva sesión de medición
     */
    async startSession(params) {
        const response = await this.post('/measurements/start', {
            userAlias: params.userAlias || 'default_user',
            deviceId: params.deviceId || null,
            cvParams: {
                startPoint: params.startPoint,
                firstVertex: params.firstVertex,
                secondVertex: params.secondVertex,
                zeroCrosses: params.zeroCrosses,
                scanRate: params.scanRate
            }
        });

        return {
            sessionId: response.data.id,
            uuid: response.data.uuid,
            ...response.data
        };
    },

    /**
     * Detener sesión activa
     */
    async stopSession(sessionId) {
        return this.post(`/measurements/${sessionId}/stop`, {});
    },

    /**
     * Obtener datos de una sesión
     */
    async getSessionData(sessionId) {
        return this.get(`/measurements/${sessionId}`);
    },

    /**
     * Obtener estadísticas de una sesión
     */
    async getSessionStats(sessionId) {
        return this.get(`/measurements/${sessionId}/stats`);
    },

    // ============================================
    // EXPORTACIÓN DE DATOS
    // ============================================

    /**
     * Exportar sesión en formato CSV
     */
    async exportSessionCSV(sessionId) {
        const response = await fetch(`${this.baseURL}/measurements/${sessionId}/download?format=csv`);
        if (!response.ok) {
            throw new Error('Error downloading CSV');
        }

        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `measurement_${sessionId}.csv`;
        a.click();
        URL.revokeObjectURL(url);
    },

    /**
     * Exportar sesión en formato TXT
     */
    async exportSessionTXT(sessionId) {
        const response = await fetch(`${this.baseURL}/measurements/${sessionId}/download?format=txt`);
        if (!response.ok) {
            throw new Error('Error downloading TXT');
        }

        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `measurement_${sessionId}.txt`;
        a.click();
        URL.revokeObjectURL(url);
    },

    /**
     * Exportar sesión en formato XLSX
     */
    async exportSessionXLSX(sessionId) {
        const response = await fetch(`${this.baseURL}/measurements/${sessionId}/download?format=xlsx`);
        if (!response.ok) {
            throw new Error('Error downloading XLSX');
        }

        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `measurement_${sessionId}.xlsx`;
        a.click();
        URL.revokeObjectURL(url);
    },

    /**
     * Exportar sesión en formato JSON
     */
    async exportSessionJSON(sessionId) {
        const response = await fetch(`${this.baseURL}/measurements/${sessionId}/download?format=json`);
        if (!response.ok) {
            throw new Error('Error downloading JSON');
        }

        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `measurement_${sessionId}.json`;
        a.click();
        URL.revokeObjectURL(url);
    },

    // ============================================
    // WIFI MANAGEMENT
    // ============================================

    /**
     * Escanear redes WiFi disponibles
     */
    async scanWifiNetworks() {
        return this.get('/wifi/scan');
    },

    /**
     * Conectar a una red WiFi
     */
    async connectWifi(ssid, password) {
        return this.post('/wifi/connect', { ssid, password });
    },

    /**
     * Desconectar de la red WiFi actual
     */
    async disconnectWifi() {
        return this.post('/wifi/disconnect', {});
    },

    /**
     * Obtener estado actual de la conexión WiFi
     */
    async getWifiStatus() {
        return this.get('/wifi/status');
    },

    /**
     * Obtener redes WiFi guardadas
     */
    async getSavedWifiNetworks() {
        return this.get('/wifi/saved');
    },

    /**
     * Guardar la red WiFi actualmente conectada
     */
    async saveCurrentWifiNetwork() {
        return this.post('/wifi/save', {});
    },

    /**
     * Eliminar una red WiFi guardada
     */
    async forgetWifiNetwork(ssid) {
        return this.post('/wifi/forget', { ssid });
    },

    // ============================================
    // DATA TRANSMISSION STATUS
    // ============================================

    /**
     * Obtener estado de transmisión de datos
     */
    async getTransmissionStatus() {
        return this.get('/transmission/status');
    },

    /**
     * Obtener estadísticas de transmisión
     */
    async getTransmissionStats() {
        return this.get('/transmission/stats');
    },

    /**
     * Verificar conexión con la base de datos
     */
    async checkDatabaseConnection() {
        return this.get('/database/status');
    },

    /**
     * Obtener estadísticas de la base de datos
     */
    async getDatabaseStats() {
        return this.get('/database/stats');
    },

    // ============================================
    // MQTT STATUS
    // ============================================

    /**
     * Obtener estado MQTT
     */
    async getMqttStatus() {
        return this.get('/mqtt/status');
    },

    /**
     * Enviar comando MQTT
     */
    async sendMqttCommand(command) {
        return this.post('/mqtt/command', { command });
    },

    /**
     * Enviar parámetros via MQTT
     */
    async sendMqttParameters(params) {
        return this.post('/mqtt/parameters', params);
    },

    // ============================================
    // USUARIOS
    // ============================================

    /**
     * Obtener todos los usuarios
     */
    async getUsers() {
        return this.get('/users');
    },

    /**
     * Obtener usuario por alias
     */
    async getUser(alias) {
        return this.get(`/users/${alias}`);
    },

    /**
     * Crear/actualizar usuario
     */
    async saveUser(alias, name, email) {
        return this.post('/users', { alias, name, email });
    },

    /**
     * Obtener mediciones de un usuario
     */
    async getUserMeasurements(alias, limit = 50) {
        return this.get(`/users/${alias}/measurements?limit=${limit}`);
    },

    // ============================================
    // DISPOSITIVOS
    // ============================================

    /**
     * Obtener todos los dispositivos
     */
    async getDevices() {
        return this.get('/devices');
    },

    /**
     * Obtener mediciones de un dispositivo
     */
    async getDeviceMeasurements(deviceId, limit = 50) {
        return this.get(`/devices/${deviceId}/measurements?limit=${limit}`);
    }
};

// Hacer disponible globalmente
window.API = API;
