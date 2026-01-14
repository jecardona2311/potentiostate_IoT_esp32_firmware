const mqtt = require('mqtt');
const db = require('./db');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// Configuración MQTT - HiveMQ Cloud con WebSocket seguro
const MQTT_BROKER = process.env.MQTT_BROKER || 'wss://broker.hivemq.cloud:8884/mqtt';
const MQTT_USERNAME = process.env.MQTT_USERNAME || '';
const MQTT_PASSWORD = process.env.MQTT_PASSWORD || '';

// Topics
const TOPICS = {
  CV_DATA: 'potentiostat/cv_data',
  RAW_DATA: 'potentiostat/raw_data',
  STATUS: 'potentiostat/status',
  HEARTRATE: 'sensor/heartrate',
  SPO2: 'sensor/spo2',
  STRESS: 'sensor/stress_laccase',
  ESP32_STATUS: 'device/esp32/status',
  ESP32_CONFIG: 'device/esp32/config',
  PARAMS: 'potentiostat/params',
  COMMAND: 'potentiostat/command'
};

// Variables globales
let mqttClient = null;
let currentMeasurementId = null;
let currentDeviceId = 'ESP32_001'; // ID por defecto del dispositivo
let currentUserAlias = null;
let isConnected = false;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;

// Estadísticas de mensajes
const messageStats = {
  received: 0,
  processed: 0,
  errors: 0,
  dataPointsSaved: 0,
  byTopic: {}
};

/**
 * Validar y convertir timestamp a formato ISO
 * Maneja: ISO strings, Excel serial dates, Unix timestamps, o usa fecha actual
 */
function parseTimestamp(timestamp) {
  if (!timestamp) {
    return new Date().toISOString();
  }

  // Si ya es un string ISO válido
  if (typeof timestamp === 'string' && timestamp.includes('T')) {
    const date = new Date(timestamp);
    if (!isNaN(date.getTime())) {
      return timestamp;
    }
  }

  // Si es un número
  const numValue = Number(timestamp);
  if (!isNaN(numValue)) {
    // Excel serial date (típicamente entre 1 y 100000)
    if (numValue > 0 && numValue < 100000) {
      // Convertir Excel serial date a JavaScript Date
      // Excel usa 1/1/1900 como día 1 (con bug del año bisiesto 1900)
      const excelEpoch = new Date(1899, 11, 30); // 30 Dec 1899
      const date = new Date(excelEpoch.getTime() + numValue * 86400000);
      return date.toISOString();
    }
    // Unix timestamp en segundos (típicamente > 1000000000)
    if (numValue > 1000000000 && numValue < 10000000000) {
      return new Date(numValue * 1000).toISOString();
    }
    // Unix timestamp en milisegundos
    if (numValue > 10000000000) {
      return new Date(numValue).toISOString();
    }
  }

  // Fallback: usar fecha actual
  return new Date().toISOString();
}

/**
 * Inicializar conexión MQTT con HiveMQ Cloud
 */
function initMQTT() {
  console.log(`Conectando a HiveMQ Cloud: ${MQTT_BROKER}`);

  const options = {
    clientId: `potentiostat_backend_${Math.random().toString(16).substr(2, 8)}`,
    clean: true,
    reconnectPeriod: 5000,
    connectTimeout: 30000,
    keepalive: 60,
    protocol: 'wss',
    protocolVersion: 4,
  };

  // Agregar credenciales (requeridas para HiveMQ Cloud)
  if (MQTT_USERNAME && MQTT_PASSWORD) {
    options.username = MQTT_USERNAME;
    options.password = MQTT_PASSWORD;
    console.log(`Usando credenciales: ${MQTT_USERNAME}`);
  } else {
    console.warn('No se encontraron credenciales MQTT. Configure MQTT_USERNAME y MQTT_PASSWORD en .env');
  }
  
  // Validar certificado SSL (HiveMQ Cloud usa certificados válidos)
  options.rejectUnauthorized = true;
  
  mqttClient = mqtt.connect(MQTT_BROKER, options);
  
  // Eventos del cliente MQTT
  mqttClient.on('connect', onConnect);
  mqttClient.on('message', onMessage);
  mqttClient.on('error', onError);
  mqttClient.on('offline', onOffline);
  mqttClient.on('reconnect', onReconnect);
  mqttClient.on('close', onClose);
  
  return mqttClient;
}

/**
 * Evento: Conexión establecida
 */
function onConnect() {
  console.log('Conectado a HiveMQ Cloud');
  isConnected = true;
  reconnectAttempts = 0;

  // Suscribirse a todos los topics
  const topicsToSubscribe = Object.values(TOPICS);

  mqttClient.subscribe(topicsToSubscribe, { qos: 1 }, (err) => {
    if (err) {
      console.error('Error al suscribirse a topics:', err);
    } else {
      console.log('Suscrito a topics:');
      topicsToSubscribe.forEach(topic => {
        console.log(`   - ${topic}`);
        // Inicializar contadores
        if (!messageStats.byTopic[topic]) {
          messageStats.byTopic[topic] = 0;
        }
      });
    }
  });
  
  // Publicar estado del backend
  const statusPayload = {
    backend: 'online',
    timestamp: new Date().toISOString(),
    version: '1.0.0'
  };
  publish('backend/status', statusPayload);
}

/**
 * Evento: Mensaje recibido
 */
async function onMessage(topic, message) {
  messageStats.received++;
  messageStats.byTopic[topic] = (messageStats.byTopic[topic] || 0) + 1;
  
  try {
    const payload = message.toString();
    const preview = payload.length > 100 ? `${payload.substring(0, 100)}...` : payload;
    console.log(`[${topic}] ${preview}`);
    
    // Procesar según el topic
    switch (topic) {
      case TOPICS.CV_DATA:
        await handleCVData(payload);
        break;
        
      case TOPICS.HEARTRATE:
        await handleHeartRateData(payload);
        break;
        
      case TOPICS.SPO2:
        await handleSpO2Data(payload);
        break;
        
      case TOPICS.STRESS:
        await handleStressData(payload);
        break;
        
      case TOPICS.ESP32_STATUS:
        await handleESP32Status(payload);
        break;
        
      case TOPICS.STATUS:
        await handlePotentiostatStatus(payload);
        break;
        
      case TOPICS.RAW_DATA:
        // Raw data - solo logging
        console.log('Raw data recibida');
        break;

      default:
        console.log(`Topic no manejado: ${topic}`);
    }
    
    messageStats.processed++;
    
  } catch (err) {
    console.error('Error procesando mensaje:', err);
    messageStats.errors++;
  }
}

/**
 * Manejar datos de voltametría cíclica
 */
async function handleCVData(payload) {
  try {
    const data = JSON.parse(payload);
    
    // Validar datos
    if (data.voltage === undefined || data.current === undefined) {
      throw new Error('Datos CV incompletos');
    }
    
    // Crear medicion si no existe
    if (!currentMeasurementId) {
      console.log('No hay medicion activa. Los datos CV no se guardaran.');
      console.log('Use el endpoint POST /api/measurements/start para iniciar una medicion');
      return;
    }
    
    // Insertar datos en la base de datos
    await db.insertCVData(
      currentMeasurementId,
      data.voltage,
      data.current,
      parseTimestamp(data.timestamp)
    );

    // Incrementar contador de puntos guardados
    messageStats.dataPointsSaved++;

    const unit = data.current_unit || 'A';
    console.log(`Datos CV guardados [Med: ${currentMeasurementId}]: V=${data.voltage}V, I=${data.current}${unit}`);
    
  } catch (err) {
    console.error('Error al procesar datos CV:', err.message);
  }
}

/**
 * Manejar datos de ritmo cardíaco
 */
async function handleHeartRateData(payload) {
  try {
    const data = JSON.parse(payload);
    
    if (!currentMeasurementId) {
      console.log('No hay medicion activa para datos de ritmo cardiaco');
      return;
    }

    await db.insertHeartRateData(
      currentMeasurementId,
      data.bpm,
      data.avg_bpm || null,
      parseTimestamp(data.timestamp)
    );

    console.log(`Datos de ritmo cardiaco guardados [Med: ${currentMeasurementId}]: ${data.bpm} BPM`);
    
  } catch (err) {
    console.error('Error al procesar datos de ritmo cardíaco:', err.message);
  }
}

/**
 * Manejar datos de SpO2
 */
async function handleSpO2Data(payload) {
  try {
    const data = JSON.parse(payload);
    
    if (!currentMeasurementId) {
      console.log('No hay medicion activa para datos de SpO2');
      return;
    }

    await db.insertSpO2Data(
      currentMeasurementId,
      data.spo2,
      data.avg_spo2 || null,
      parseTimestamp(data.timestamp)
    );

    console.log(`Datos de SpO2 guardados [Med: ${currentMeasurementId}]: ${data.spo2}%`);
    
  } catch (err) {
    console.error('Error al procesar datos de SpO2:', err.message);
  }
}

/**
 * Manejar datos de estrés
 */
async function handleStressData(payload) {
  try {
    const data = JSON.parse(payload);
    
    if (!currentMeasurementId) {
      console.log('No hay medicion activa para datos de estres');
      return;
    }

    await db.insertStressData(
      currentMeasurementId,
      data.stress_laccase,
      parseTimestamp(data.timestamp)
    );

    console.log(`Datos de estres guardados [Med: ${currentMeasurementId}]: ${data.stress_laccase}`);
    
  } catch (err) {
    console.error('Error al procesar datos de estrés:', err.message);
  }
}

/**
 * Manejar estado del ESP32
 */
async function handleESP32Status(payload) {
  try {
    const data = JSON.parse(payload);
    
    // Actualizar dispositivo en la base de datos
    if (data.device_id) {
      currentDeviceId = data.device_id;
      await db.upsertDevice(
        data.device_id,
        data.device_name || 'ESP32',
        data.ip_address || 'unknown'
      );
      console.log(`Estado ESP32 actualizado: ${data.device_id}`);
    }
    
  } catch (err) {
    console.error('Error al procesar estado ESP32:', err.message);
  }
}

/**
 * Manejar estado del potenciostato
 */
async function handlePotentiostatStatus(payload) {
  try {
    const data = typeof payload === 'string' ? JSON.parse(payload) : payload;
    const status = data.status || payload.toString();

    console.log(`Estado del potenciostato: ${status}`);
    
    // No crear/finalizar mediciones automáticamente
    // Esto ahora se maneja desde el API REST
    
  } catch (err) {
    console.error('Error al procesar estado del potenciostato:', err.message);
  }
}

/**
 * Evento: Error de conexión
 */
function onError(err) {
  console.error('Error MQTT:', err.message);
  isConnected = false;
}

/**
 * Evento: Cliente offline
 */
function onOffline() {
  console.log('Cliente MQTT offline');
  isConnected = false;
}

/**
 * Evento: Intentando reconectar
 */
function onReconnect() {
  reconnectAttempts++;
  console.log(`Intentando reconectar a HiveMQ... (Intento ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);

  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.error('Maximo de intentos de reconexion alcanzado');
    mqttClient.end();
  }
}

/**
 * Evento: Conexión cerrada
 */
function onClose() {
  console.log('Conexion MQTT cerrada');
  isConnected = false;
}

/**
 * Publicar mensaje en un topic
 */
function publish(topic, message, options = { qos: 1, retain: false }) {
  return new Promise((resolve, reject) => {
    if (!mqttClient) {
      reject(new Error('Cliente MQTT no inicializado'));
      return;
    }
    
    if (!isConnected) {
      reject(new Error('Cliente MQTT no conectado'));
      return;
    }
    
    const payload = typeof message === 'object' ? JSON.stringify(message) : message.toString();
    
    mqttClient.publish(topic, payload, options, (err) => {
      if (err) {
        console.error(`Error al publicar en ${topic}:`, err);
        reject(err);
      } else {
        const preview = payload.length > 50 ? `${payload.substring(0, 50)}...` : payload;
        console.log(`Publicado en ${topic}: ${preview}`);
        resolve();
      }
    });
  });
}

/**
 * Enviar comando al potenciostato
 */
async function sendCommand(command) {
  try {
    await publish(TOPICS.COMMAND, command.toUpperCase());
    return { success: true, command };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Enviar parámetros al potenciostato
 */
async function sendParameters(params) {
  try {
    await publish(TOPICS.PARAMS, params);
    return { success: true, params };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Iniciar una nueva medición (llamado desde API)
 */
function startMeasurement(measurementId, userAlias) {
  currentMeasurementId = measurementId;
  currentUserAlias = userAlias;
  console.log(`Medicion iniciada: ID=${measurementId}, Usuario=${userAlias}`);
}

/**
 * Finalizar medición actual (llamado desde API)
 */
function stopMeasurement() {
  if (currentMeasurementId) {
    console.log(`Medicion finalizada: ID=${currentMeasurementId}`);
    currentMeasurementId = null;
    currentUserAlias = null;
  }
}

/**
 * Obtener estadísticas del sistema MQTT
 */
function getStats() {
  return {
    connected: isConnected,
    reconnectAttempts,
    currentMeasurementId,
    currentUserAlias,
    currentDeviceId,
    brokerUrl: MQTT_BROKER,
    messageStats: { ...messageStats }
  };
}

/**
 * Cerrar conexión MQTT
 */
function disconnect() {
  if (mqttClient) {
    console.log('Cerrando conexion MQTT...');
    mqttClient.end(true);
    isConnected = false;
  }
}

// ============================================
// EXPORTAR FUNCIONES
// ============================================

module.exports = {
  initMQTT,
  publish,
  sendCommand,
  sendParameters,
  startMeasurement,
  stopMeasurement,
  getStats,
  disconnect,
  TOPICS,
  
  // Getters
  isConnected: () => isConnected,
  getCurrentMeasurementId: () => currentMeasurementId,
  getCurrentDeviceId: () => currentDeviceId,
  getCurrentUserAlias: () => currentUserAlias,
  
  // Setters
  setCurrentDeviceId: (deviceId) => { currentDeviceId = deviceId; },
  setCurrentUserAlias: (alias) => { currentUserAlias = alias; }
};