/**
 * Cliente MQTT para el frontend
 * Maneja la conexión WebSocket con el broker MQTT
 */

const MQTTClient = {
    // =========================================================================
    //                     CONNECTION SETTINGS
    // =========================================================================
    // Modify these values to connect to your MQTT broker
    // =========================================================================

    // Default MQTT Configuration (HiveMQ Cloud with TLS WebSocket)
    broker: '57f57f62bdd7478ba34af49e9c090208.s1.eu.hivemq.cloud',
    port: 8884,                    // TLS WebSocket port for HiveMQ Cloud
    username: 'potentiostat',      // MQTT username
    password: 'POT123456s',        // MQTT password
    useSSL: true,                  // Use secure WebSocket (wss://)

    // =========================================================================
    //                   END OF CONNECTION SETTINGS
    // =========================================================================

    // Internal state
    client: null,
    connected: false,

    // Callbacks personalizables
    onConnect: null,
    onDisconnect: null,
    onMessage: null,
    onError: null,

    /**
     * Conectar al broker MQTT
     * @returns {Promise} Promesa que resuelve cuando se conecta
     */
    connect() {
        return new Promise((resolve, reject) => {
            try {
                // Generar ID único de cliente
                const clientId = 'web_' + Math.random().toString(16).substr(2, 8);
                
                console.log(`🔄 Connecting to MQTT: ${this.broker}:${this.port}`);

                // Crear cliente Paho MQTT
                this.client = new Paho.MQTT.Client(
                    this.broker,
                    this.port,
                    clientId
                );

                // Configurar callback de pérdida de conexión
                this.client.onConnectionLost = (response) => {
                    this.connected = false;
                    console.log('⚠️ MQTT Connection lost:', response.errorMessage);
                    this.updateStatusUI(false);
                    
                    if (this.onDisconnect) {
                        this.onDisconnect(response);
                    }
                };

                // Configurar callback de mensaje recibido
                this.client.onMessageArrived = (message) => {
                    this.handleMessage(message);
                };

                // Opciones de conexión
                const connectOptions = {
                    onSuccess: () => {
                        this.connected = true;
                        console.log('✅ MQTT Connected successfully');
                        this.updateStatusUI(true);
                        this.subscribeToTopics();

                        if (this.onConnect) {
                            this.onConnect();
                        }

                        resolve();
                    },
                    onFailure: (error) => {
                        console.error('❌ MQTT Connection failed:', error);
                        this.updateStatusUI(false);

                        if (this.onError) {
                            this.onError(error);
                        }

                        reject(error);
                    },
                    keepAliveInterval: 60,
                    timeout: 30,
                    cleanSession: true,
                    useSSL: this.useSSL  // Enable TLS/SSL for secure connection
                };

                // Agregar credenciales si están configuradas
                if (this.username) {
                    connectOptions.userName = this.username;
                }
                if (this.password) {
                    connectOptions.password = this.password;
                }

                // Intentar conexión
                this.client.connect(connectOptions);

            } catch (error) {
                console.error('❌ MQTT Error:', error);
                reject(error);
            }
        });
    },

    /**
     * Suscribirse a los topics relevantes
     */
    subscribeToTopics() {
        const topics = [
            'potentiostat/cv_data',
            'potentiostat/status',
            'potentiostat/raw_data',
            'sensor/heartrate',
            'sensor/spo2',
            'sensor/stress_laccase',
            'device/esp32/status'
        ];

        topics.forEach(topic => {
            this.client.subscribe(topic, {
                qos: 0,
                onSuccess: () => {
                    console.log(`📡 Subscribed to ${topic}`);
                },
                onFailure: (err) => {
                    console.error(`❌ Failed to subscribe to ${topic}:`, err);
                }
            });
        });
    },

    /**
     * Manejar mensajes MQTT recibidos
     * @param {Object} message - Mensaje Paho MQTT
     */
    handleMessage(message) {
        const topic = message.destinationName;
        const payload = message.payloadString;

        try {
            // Intentar parsear como JSON
            const data = JSON.parse(payload);
            
            // Llamar callback personalizado si existe
            if (this.onMessage) {
                this.onMessage(topic, data);
            }

        } catch (e) {
            // No es JSON, tratar como texto
            console.log(`📩 ${topic}: ${payload}`);
            
            if (this.onMessage) {
                this.onMessage(topic, payload);
            }
        }
    },

    /**
     * Publicar un mensaje MQTT
     * @param {String} topic - Topic MQTT
     * @param {Object|String} message - Mensaje a enviar
     * @param {Object} options - Opciones (qos, retained)
     * @returns {Boolean} true si se publicó exitosamente
     */
    publish(topic, message, options = {}) {
        if (!this.connected) {
            console.error('❌ MQTT not connected, cannot publish');
            return false;
        }

        try {
            // Convertir mensaje a string si es necesario
            const payload = typeof message === 'string' ? 
                message : JSON.stringify(message);

            // Crear mensaje Paho
            const mqttMessage = new Paho.MQTT.Message(payload);
            mqttMessage.destinationName = topic;
            mqttMessage.qos = options.qos || 0;
            mqttMessage.retained = options.retained || false;

            // Enviar mensaje
            this.client.send(mqttMessage);
            console.log(`📤 Published to ${topic}:`, payload.substring(0, 100));
            
            return true;

        } catch (error) {
            console.error('❌ Error publishing:', error);
            return false;
        }
    },

    /**
     * Actualizar indicador de estado en la UI
     * @param {Boolean} connected - Estado de conexión
     */
    updateStatusUI(connected) {
        const statusDot = document.querySelector('#mqttStatus .status-dot');
        const statusText = document.getElementById('mqttText');

        if (statusDot && statusText) {
            if (connected) {
                statusDot.classList.add('connected');
                statusText.textContent = 'Connected';
            } else {
                statusDot.classList.remove('connected');
                statusText.textContent = 'Disconnected';
            }
        }
    },

    /**
     * Desconectar del broker
     */
    disconnect() {
        if (this.client && this.connected) {
            this.client.disconnect();
            this.connected = false;
            this.updateStatusUI(false);
            console.log('🔌 MQTT Disconnected');
        }
    },

    /**
     * Verificar si está conectado
     * @returns {Boolean} Estado de conexión
     */
    isConnected() {
        return this.connected && this.client && this.client.isConnected();
    },

    /**
     * Reconectar al broker
     * @returns {Promise} Promesa de reconexión
     */
    async reconnect() {
        console.log('🔄 Attempting to reconnect...');
        this.disconnect();
        await new Promise(resolve => setTimeout(resolve, 1000));
        return this.connect();
    },

    /**
     * Configurar credenciales MQTT
     * @param {String} broker - URL del broker
     * @param {Number} port - Puerto WebSocket
     * @param {String} username - Usuario (opcional)
     * @param {String} password - Contraseña (opcional)
     * @param {Boolean} useSSL - Usar conexión segura (opcional)
     */
    configure(broker, port, username = '', password = '', useSSL = true) {
        this.broker = broker;
        this.port = port;
        this.username = username;
        this.password = password;
        this.useSSL = useSSL;

        const protocol = useSSL ? 'wss' : 'ws';
        console.log(`⚙️ MQTT configured: ${protocol}://${broker}:${port}`);
    },

    /**
     * Cargar configuración desde localStorage
     */
    loadSavedConfig() {
        const saved = localStorage.getItem('mqttConfig');
        if (saved) {
            try {
                const config = JSON.parse(saved);
                this.broker = config.broker || this.broker;
                this.port = config.port || this.port;
                this.username = config.username || this.username;
                this.password = config.password || this.password;
                this.useSSL = config.useSSL !== undefined ? config.useSSL : this.useSSL;
                console.log('📂 Loaded saved MQTT configuration');
                return true;
            } catch (e) {
                console.warn('⚠️ Could not load saved config:', e);
            }
        }
        return false;
    },

    /**
     * Guardar configuración en localStorage
     */
    saveConfig() {
        const config = {
            broker: this.broker,
            port: this.port,
            username: this.username,
            password: this.password,
            useSSL: this.useSSL
        };
        localStorage.setItem('mqttConfig', JSON.stringify(config));
        console.log('💾 MQTT configuration saved');
    },

    /**
     * Obtener información de conexión
     * @returns {Object} Info de conexión
     */
    getConnectionInfo() {
        return {
            broker: this.broker,
            port: this.port,
            connected: this.connected,
            clientId: this.client ? this.client.clientId : null
        };
    }
};