const express = require('express');
const router = express.Router();
const db = require('./db');
const mqtt = require('./mqtt');
const wifi = require('./wifi');

// Intentar cargar xlsx (opcional)
let xlsx = null;
try {
  xlsx = require('xlsx');
} catch (e) {
  console.log('Modulo xlsx no instalado. Instale con: npm install xlsx');
}

// Estadísticas de transmisión
const transmissionStats = {
  messagesReceived: 0,
  messagesSent: 0,
  dataPointsSaved: 0,
  lastMessageTime: null,
  errors: 0,
  startTime: new Date().toISOString()
};

// ============================================
// USUARIOS
// ============================================

/**
 * GET /api/users
 * Obtener todos los usuarios con estadísticas
 */
router.get('/users', async (req, res) => {
  try {
    const users = await db.getAllUsers();
    res.json({
      success: true,
      count: users.length,
      data: users
    });
  } catch (err) {
    console.error('Error al obtener usuarios:', err);
    res.status(500).json({
      success: false,
      error: 'Error al obtener usuarios',
      message: err.message
    });
  }
});

/**
 * GET /api/users/:alias
 * Obtener un usuario específico por alias
 */
router.get('/users/:alias', async (req, res) => {
  try {
    const { alias } = req.params;
    const user = await db.getUserByAlias(alias);
    
    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'Usuario no encontrado'
      });
    }
    
    res.json({
      success: true,
      data: user
    });
  } catch (err) {
    console.error('Error al obtener usuario:', err);
    res.status(500).json({
      success: false,
      error: 'Error al obtener usuario',
      message: err.message
    });
  }
});

/**
 * POST /api/users
 * Crear o actualizar un usuario
 */
router.post('/users', async (req, res) => {
  try {
    const { alias, name, email } = req.body;
    
    if (!alias) {
      return res.status(400).json({
        success: false,
        error: 'El alias es requerido'
      });
    }
    
    const user = await db.upsertUser(alias, name, email);
    
    res.json({
      success: true,
      data: user,
      message: 'Usuario creado/actualizado correctamente'
    });
  } catch (err) {
    console.error('Error al crear/actualizar usuario:', err);
    res.status(500).json({
      success: false,
      error: 'Error al crear/actualizar usuario',
      message: err.message
    });
  }
});

/**
 * GET /api/users/:alias/measurements
 * Obtener todas las mediciones de un usuario
 */
router.get('/users/:alias/measurements', async (req, res) => {
  try {
    const { alias } = req.params;
    const limit = parseInt(req.query.limit) || 50;
    
    const measurements = await db.getMeasurementsByUserAlias(alias, limit);
    
    res.json({
      success: true,
      count: measurements.length,
      data: measurements
    });
  } catch (err) {
    console.error('Error al obtener mediciones del usuario:', err);
    res.status(500).json({
      success: false,
      error: 'Error al obtener mediciones del usuario',
      message: err.message
    });
  }
});

// ============================================
// MEDICIONES
// ============================================

/**
 * POST /api/measurements/start
 * Iniciar una nueva medición
 */
router.post('/measurements/start', async (req, res) => {
  try {
    const { userAlias, deviceId, cvParams } = req.body;
    
    if (!userAlias) {
      return res.status(400).json({
        success: false,
        error: 'El alias del usuario es requerido'
      });
    }
    
    const device = deviceId || mqtt.getCurrentDeviceId();
    
    // Crear medición en la base de datos
    const measurement = await db.createMeasurement(userAlias, device, cvParams);
    
    // Notificar al módulo MQTT
    mqtt.startMeasurement(measurement.id, userAlias);
    
    // Enviar comando START al dispositivo
    await mqtt.sendCommand('START');
    
    res.json({
      success: true,
      data: measurement,
      message: 'Medición iniciada correctamente'
    });
  } catch (err) {
    console.error('Error al iniciar medición:', err);
    res.status(500).json({
      success: false,
      error: 'Error al iniciar medición',
      message: err.message
    });
  }
});

/**
 * POST /api/measurements/:id/stop
 * Finalizar una medición
 */
router.post('/measurements/:id/stop', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Finalizar en la base de datos
    const measurement = await db.finalizeMeasurement(id);
    
    // Notificar al módulo MQTT
    mqtt.stopMeasurement();
    
    // Enviar comando STOP al dispositivo
    await mqtt.sendCommand('STOP');
    
    res.json({
      success: true,
      data: measurement,
      message: 'Medición finalizada correctamente'
    });
  } catch (err) {
    console.error('Error al finalizar medición:', err);
    res.status(500).json({
      success: false,
      error: 'Error al finalizar medición',
      message: err.message
    });
  }
});

/**
 * GET /api/measurements/:id
 * Obtener una medición completa con todos sus datos
 */
router.get('/measurements/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const measurementData = await db.getMeasurementById(id);
    
    res.json({
      success: true,
      data: measurementData
    });
  } catch (err) {
    console.error('Error al obtener medición:', err);
    res.status(500).json({
      success: false,
      error: 'Error al obtener medición',
      message: err.message
    });
  }
});

/**
 * GET /api/measurements/uuid/:uuid
 * Obtener una medición por UUID
 */
router.get('/measurements/uuid/:uuid', async (req, res) => {
  try {
    const { uuid } = req.params;
    const measurementData = await db.getMeasurementByUUID(uuid);
    
    if (!measurementData) {
      return res.status(404).json({
        success: false,
        error: 'Medición no encontrada'
      });
    }
    
    res.json({
      success: true,
      data: measurementData
    });
  } catch (err) {
    console.error('Error al obtener medición por UUID:', err);
    res.status(500).json({
      success: false,
      error: 'Error al obtener medición',
      message: err.message
    });
  }
});

/**
 * GET /api/measurements/:id/download
 * Descargar medición completa en formato JSON/TXT/CSV
 */
router.get('/measurements/:id/download', async (req, res) => {
  try {
    const { id } = req.params;
    const format = req.query.format || 'json'; // json, txt, csv
    
    const data = await db.getMeasurementById(id);
    
    if (!data.measurement) {
      return res.status(404).json({
        success: false,
        error: 'Medición no encontrada'
      });
    }
    
    const measurement = data.measurement;
    const filename = `measurement_${measurement.uuid}_${new Date().toISOString().slice(0, 10)}`;
    
    if (format === 'txt') {
      // Formato TXT
      let content = generateTXTContent(data);
      res.setHeader('Content-Type', 'text/plain');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}.txt"`);
      res.send(content);

    } else if (format === 'csv') {
      // Formato CSV
      let content = generateCSVContent(data);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
      res.send(content);

    } else if (format === 'xlsx') {
      // Formato XLSX (Excel)
      if (!xlsx) {
        return res.status(400).json({
          success: false,
          error: 'Módulo xlsx no disponible. Instale con: npm install xlsx'
        });
      }

      const buffer = generateXLSXContent(data);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}.xlsx"`);
      res.send(buffer);

    } else {
      // Formato JSON (default)
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}.json"`);
      res.json({
        success: true,
        data: data
      });
    }
    
  } catch (err) {
    console.error('Error al descargar medición:', err);
    res.status(500).json({
      success: false,
      error: 'Error al descargar medición',
      message: err.message
    });
  }
});

/**
 * GET /api/measurements/:id/stats
 * Obtener estadísticas de una medición
 */
router.get('/measurements/:id/stats', async (req, res) => {
  try {
    const { id } = req.params;
    const stats = await db.getMeasurementStats(id);
    
    res.json({
      success: true,
      data: stats
    });
  } catch (err) {
    console.error('Error al obtener estadísticas:', err);
    res.status(500).json({
      success: false,
      error: 'Error al obtener estadísticas',
      message: err.message
    });
  }
});

// ============================================
// DISPOSITIVOS
// ============================================

/**
 * GET /api/devices
 * Obtener todos los dispositivos
 */
router.get('/devices', async (req, res) => {
  try {
    const devices = await db.getAllDevices();
    res.json({
      success: true,
      count: devices.length,
      data: devices
    });
  } catch (err) {
    console.error('Error al obtener dispositivos:', err);
    res.status(500).json({
      success: false,
      error: 'Error al obtener dispositivos',
      message: err.message
    });
  }
});

/**
 * GET /api/devices/:deviceId/measurements
 * Obtener mediciones de un dispositivo específico
 */
router.get('/devices/:deviceId/measurements', async (req, res) => {
  try {
    const { deviceId } = req.params;
    const limit = parseInt(req.query.limit) || 50;
    
    const measurements = await db.getMeasurementsByDevice(deviceId, limit);
    
    res.json({
      success: true,
      count: measurements.length,
      data: measurements
    });
  } catch (err) {
    console.error('Error al obtener mediciones del dispositivo:', err);
    res.status(500).json({
      success: false,
      error: 'Error al obtener mediciones del dispositivo',
      message: err.message
    });
  }
});

// ============================================
// CONTROL MQTT
// ============================================

/**
 * POST /api/mqtt/command
 * Enviar comando al dispositivo (START, STOP, CLEAR)
 */
router.post('/mqtt/command', async (req, res) => {
  try {
    const { command } = req.body;
    
    if (!command) {
      return res.status(400).json({
        success: false,
        error: 'El comando es requerido'
      });
    }
    
    const result = await mqtt.sendCommand(command);
    
    res.json({
      success: result.success,
      message: result.success ? 'Comando enviado' : 'Error al enviar comando',
      data: result
    });
  } catch (err) {
    console.error('Error al enviar comando:', err);
    res.status(500).json({
      success: false,
      error: 'Error al enviar comando',
      message: err.message
    });
  }
});

/**
 * POST /api/mqtt/parameters
 * Enviar parámetros de CV al dispositivo
 */
router.post('/mqtt/parameters', async (req, res) => {
  try {
    const params = req.body;
    
    const result = await mqtt.sendParameters(params);
    
    res.json({
      success: result.success,
      message: result.success ? 'Parámetros enviados' : 'Error al enviar parámetros',
      data: result
    });
  } catch (err) {
    console.error('Error al enviar parámetros:', err);
    res.status(500).json({
      success: false,
      error: 'Error al enviar parámetros',
      message: err.message
    });
  }
});

/**
 * GET /api/mqtt/status
 * Obtener estado del sistema MQTT
 */
router.get('/mqtt/status', (req, res) => {
  const stats = mqtt.getStats();
  res.json({
    success: true,
    data: stats
  });
});

// ============================================
// HEALTH CHECK
// ============================================

/**
 * GET /api/health
 * Verificar estado del servidor
 */
router.get('/health', async (req, res) => {
  try {
    const dbStatus = await db.testConnection();
    const mqttStatus = mqtt.isConnected();
    
    res.json({
      success: true,
      status: 'healthy',
      services: {
        database: dbStatus ? 'connected' : 'disconnected',
        mqtt: mqttStatus ? 'connected' : 'disconnected'
      },
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      status: 'unhealthy',
      error: err.message
    });
  }
});

// ============================================
// FUNCIONES AUXILIARES
// ============================================

function generateTXTContent(data) {
  const m = data.measurement;
  let content = '';
  
  content += '='.repeat(60) + '\n';
  content += '  POTENTIOSTAT - MEASUREMENT REPORT\n';
  content += '='.repeat(60) + '\n\n';
  
  content += `Measurement UUID: ${m.uuid}\n`;
  content += `User: ${m.user_alias}${m.user_name ? ` (${m.user_name})` : ''}\n`;
  content += `Device: ${m.device_id || 'N/A'}\n`;
  content += `Start: ${new Date(m.start_time).toLocaleString()}\n`;
  if (m.end_time) {
    content += `End: ${new Date(m.end_time).toLocaleString()}\n`;
  }
  content += `Status: ${m.status}\n\n`;
  
  // Parámetros CV
  if (m.cv_start_point !== null) {
    content += '--- CYCLIC VOLTAMMETRY PARAMETERS ---\n';
    content += `Start Point: ${m.cv_start_point} V\n`;
    content += `First Vertex: ${m.cv_first_vertex} V\n`;
    content += `Second Vertex: ${m.cv_second_vertex} V\n`;
    content += `Zero Crosses: ${m.cv_zero_crosses}\n`;
    content += `Scan Rate: ${m.cv_scan_rate} V/s\n\n`;
  }
  
  // Datos CV
  if (data.cvData.length > 0) {
    content += '--- CYCLIC VOLTAMMETRY DATA ---\n';
    content += `Point\tVoltage(V)\tCurrent(uA)\tTimestamp\n`;
    data.cvData.forEach((point, idx) => {
      content += `${idx + 1}\t${point.voltage}\t${point.current}\t${new Date(point.timestamp).toLocaleTimeString()}\n`;
    });
    content += '\n';
  }
  
  // Datos HR
  if (data.heartrateData.length > 0) {
    content += '--- HEART RATE DATA ---\n';
    content += `Point\tBPM\tAvg BPM\tTimestamp\n`;
    data.heartrateData.forEach((point, idx) => {
      content += `${idx + 1}\t${point.bpm}\t${point.avg_bpm || 'N/A'}\t${new Date(point.timestamp).toLocaleTimeString()}\n`;
    });
    content += '\n';
  }
  
  // Datos SpO2
  if (data.spo2Data.length > 0) {
    content += '--- SPO2 DATA ---\n';
    content += `Point\tSpO2(%)\tAvg SpO2(%)\tTimestamp\n`;
    data.spo2Data.forEach((point, idx) => {
      content += `${idx + 1}\t${point.spo2}\t${point.avg_spo2 || 'N/A'}\t${new Date(point.timestamp).toLocaleTimeString()}\n`;
    });
    content += '\n';
  }
  
  // Datos Stress
  if (data.stressData.length > 0) {
    content += '--- STRESS DATA ---\n';
    content += `Point\tStress Level\tTimestamp\n`;
    data.stressData.forEach((point, idx) => {
      content += `${idx + 1}\t${point.stress_level}\t${new Date(point.timestamp).toLocaleTimeString()}\n`;
    });
    content += '\n';
  }
  
  content += '='.repeat(60) + '\n';
  content += 'Generated by Potentiostat IoT System\n';
  content += '='.repeat(60) + '\n';
  
  return content;
}

function generateCSVContent(data) {
  const m = data.measurement;
  let content = '';
  
  // Header con metadata
  content += `Measurement UUID,${m.uuid}\n`;
  content += `User,${m.user_alias}\n`;
  content += `Device,${m.device_id || 'N/A'}\n`;
  content += `Start Time,${m.start_time}\n`;
  content += `End Time,${m.end_time || 'N/A'}\n`;
  content += `Status,${m.status}\n\n`;
  
  // Parámetros CV
  if (m.cv_start_point !== null) {
    content += 'CV Parameters\n';
    content += `Start Point (V),${m.cv_start_point}\n`;
    content += `First Vertex (V),${m.cv_first_vertex}\n`;
    content += `Second Vertex (V),${m.cv_second_vertex}\n`;
    content += `Zero Crosses,${m.cv_zero_crosses}\n`;
    content += `Scan Rate (V/s),${m.cv_scan_rate}\n\n`;
  }
  
  // CV Data
  if (data.cvData.length > 0) {
    content += 'Cyclic Voltammetry Data\n';
    content += 'Point,Voltage (V),Current (uA),Timestamp\n';
    data.cvData.forEach((point, idx) => {
      content += `${idx + 1},${point.voltage},${point.current},${point.timestamp}\n`;
    });
    content += '\n';
  }
  
  // Heart Rate Data
  if (data.heartrateData.length > 0) {
    content += 'Heart Rate Data\n';
    content += 'Point,BPM,Avg BPM,Timestamp\n';
    data.heartrateData.forEach((point, idx) => {
      content += `${idx + 1},${point.bpm},${point.avg_bpm || 'N/A'},${point.timestamp}\n`;
    });
    content += '\n';
  }
  
  // SpO2 Data
  if (data.spo2Data.length > 0) {
    content += 'SpO2 Data\n';
    content += 'Point,SpO2 (%),Avg SpO2 (%),Timestamp\n';
    data.spo2Data.forEach((point, idx) => {
      content += `${idx + 1},${point.spo2},${point.avg_spo2 || 'N/A'},${point.timestamp}\n`;
    });
    content += '\n';
  }
  
  // Stress Data
  if (data.stressData.length > 0) {
    content += 'Stress Data\n';
    content += 'Point,Stress Level,Timestamp\n';
    data.stressData.forEach((point, idx) => {
      content += `${idx + 1},${point.stress_level},${point.timestamp}\n`;
    });
    content += '\n';
  }
  
  return content;
}

/**
 * Generar contenido XLSX (Excel)
 */
function generateXLSXContent(data) {
  const m = data.measurement;
  const workbook = xlsx.utils.book_new();

  // Hoja 1: Información de la medición
  const infoData = [
    ['POTENTIOSTAT - MEASUREMENT REPORT'],
    [''],
    ['Measurement UUID', m.uuid],
    ['User', m.user_alias + (m.user_name ? ` (${m.user_name})` : '')],
    ['Device', m.device_id || 'N/A'],
    ['Start Time', m.start_time],
    ['End Time', m.end_time || 'N/A'],
    ['Status', m.status],
    [''],
    ['CV PARAMETERS'],
    ['Start Point (V)', m.cv_start_point],
    ['First Vertex (V)', m.cv_first_vertex],
    ['Second Vertex (V)', m.cv_second_vertex],
    ['Zero Crosses', m.cv_zero_crosses],
    ['Scan Rate (V/s)', m.cv_scan_rate]
  ];
  const infoSheet = xlsx.utils.aoa_to_sheet(infoData);
  xlsx.utils.book_append_sheet(workbook, infoSheet, 'Info');

  // Hoja 2: Datos CV
  if (data.cvData.length > 0) {
    const cvHeaders = ['Point', 'Voltage (V)', 'Current (uA)', 'Timestamp'];
    const cvRows = data.cvData.map((point, idx) => [
      idx + 1,
      point.voltage,
      point.current,
      point.timestamp
    ]);
    const cvSheet = xlsx.utils.aoa_to_sheet([cvHeaders, ...cvRows]);
    xlsx.utils.book_append_sheet(workbook, cvSheet, 'CV Data');
  }

  // Hoja 3: Datos de ritmo cardíaco
  if (data.heartrateData.length > 0) {
    const hrHeaders = ['Point', 'BPM', 'Avg BPM', 'Timestamp'];
    const hrRows = data.heartrateData.map((point, idx) => [
      idx + 1,
      point.bpm,
      point.avg_bpm || 'N/A',
      point.timestamp
    ]);
    const hrSheet = xlsx.utils.aoa_to_sheet([hrHeaders, ...hrRows]);
    xlsx.utils.book_append_sheet(workbook, hrSheet, 'Heart Rate');
  }

  // Hoja 4: Datos SpO2
  if (data.spo2Data.length > 0) {
    const spo2Headers = ['Point', 'SpO2 (%)', 'Avg SpO2 (%)', 'Timestamp'];
    const spo2Rows = data.spo2Data.map((point, idx) => [
      idx + 1,
      point.spo2,
      point.avg_spo2 || 'N/A',
      point.timestamp
    ]);
    const spo2Sheet = xlsx.utils.aoa_to_sheet([spo2Headers, ...spo2Rows]);
    xlsx.utils.book_append_sheet(workbook, spo2Sheet, 'SpO2');
  }

  // Hoja 5: Datos de estrés
  if (data.stressData.length > 0) {
    const stressHeaders = ['Point', 'Stress Level', 'Timestamp'];
    const stressRows = data.stressData.map((point, idx) => [
      idx + 1,
      point.stress_level,
      point.timestamp
    ]);
    const stressSheet = xlsx.utils.aoa_to_sheet([stressHeaders, ...stressRows]);
    xlsx.utils.book_append_sheet(workbook, stressSheet, 'Stress');
  }

  // Generar buffer
  return xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

// ============================================
// WIFI MANAGEMENT
// ============================================

/**
 * GET /api/wifi/scan
 * Escanear redes WiFi disponibles
 */
router.get('/wifi/scan', async (req, res) => {
  try {
    const networks = await wifi.scanNetworks();
    res.json({
      success: true,
      count: networks.length,
      data: networks
    });
  } catch (err) {
    console.error('Error al escanear redes WiFi:', err);
    res.status(500).json({
      success: false,
      error: 'Error al escanear redes WiFi',
      message: err.message
    });
  }
});

/**
 * POST /api/wifi/connect
 * Conectar a una red WiFi
 */
router.post('/wifi/connect', async (req, res) => {
  try {
    const { ssid, password } = req.body;

    if (!ssid) {
      return res.status(400).json({
        success: false,
        error: 'SSID es requerido'
      });
    }

    const result = await wifi.connectToNetwork(ssid, password || '');
    res.json(result);
  } catch (err) {
    console.error('Error al conectar a WiFi:', err);
    res.status(500).json({
      success: false,
      error: 'Error al conectar a WiFi',
      message: err.message
    });
  }
});

/**
 * POST /api/wifi/disconnect
 * Desconectar de la red WiFi actual
 */
router.post('/wifi/disconnect', async (req, res) => {
  try {
    const result = await wifi.disconnectFromNetwork();
    res.json(result);
  } catch (err) {
    console.error('Error al desconectar WiFi:', err);
    res.status(500).json({
      success: false,
      error: 'Error al desconectar WiFi',
      message: err.message
    });
  }
});

/**
 * GET /api/wifi/status
 * Obtener estado actual de WiFi
 */
router.get('/wifi/status', async (req, res) => {
  try {
    const status = await wifi.getWifiStatus();
    res.json({
      success: true,
      data: status
    });
  } catch (err) {
    console.error('Error al obtener estado WiFi:', err);
    res.status(500).json({
      success: false,
      error: 'Error al obtener estado WiFi',
      message: err.message
    });
  }
});

/**
 * GET /api/wifi/saved
 * Obtener redes WiFi guardadas
 */
router.get('/wifi/saved', async (req, res) => {
  try {
    const networks = wifi.getSavedNetworks();
    res.json({
      success: true,
      count: networks.length,
      data: networks
    });
  } catch (err) {
    console.error('Error al obtener redes guardadas:', err);
    res.status(500).json({
      success: false,
      error: 'Error al obtener redes guardadas',
      message: err.message
    });
  }
});

/**
 * POST /api/wifi/save
 * Guardar la red WiFi actualmente conectada
 */
router.post('/wifi/save', async (req, res) => {
  try {
    const result = await wifi.saveCurrentNetwork();
    res.json(result);
  } catch (err) {
    console.error('Error al guardar red WiFi:', err);
    res.status(500).json({
      success: false,
      error: 'Error al guardar red WiFi',
      message: err.message
    });
  }
});

/**
 * POST /api/wifi/forget
 * Olvidar una red WiFi guardada
 */
router.post('/wifi/forget', async (req, res) => {
  try {
    const { ssid } = req.body;

    if (!ssid) {
      return res.status(400).json({
        success: false,
        error: 'SSID es requerido'
      });
    }

    const result = await wifi.forgetNetwork(ssid);
    res.json(result);
  } catch (err) {
    console.error('Error al olvidar red WiFi:', err);
    res.status(500).json({
      success: false,
      error: 'Error al olvidar red WiFi',
      message: err.message
    });
  }
});

// ============================================
// DATA TRANSMISSION STATUS
// ============================================

/**
 * GET /api/transmission/status
 * Obtener estado de transmisión de datos
 */
router.get('/transmission/status', (req, res) => {
  const mqttStats = mqtt.getStats();

  res.json({
    success: true,
    data: {
      mqtt: {
        connected: mqttStats.connected,
        broker: mqttStats.brokerUrl,
        currentMeasurement: mqttStats.currentMeasurementId
      },
      transmission: {
        ...transmissionStats,
        dataPointsSaved: mqttStats.messageStats.dataPointsSaved || 0,
        uptime: getUptime()
      },
      messageStats: mqttStats.messageStats
    }
  });
});

/**
 * GET /api/transmission/stats
 * Obtener estadísticas detalladas de transmisión
 */
router.get('/transmission/stats', (req, res) => {
  const mqttStats = mqtt.getStats();

  res.json({
    success: true,
    data: {
      mqtt: mqttStats,
      transmission: {
        ...transmissionStats,
        uptime: getUptime(),
        messagesPerMinute: calculateMessagesPerMinute()
      }
    }
  });
});

// ============================================
// DATABASE STATUS
// ============================================

/**
 * GET /api/database/status
 * Verificar conexión con la base de datos
 */
router.get('/database/status', async (req, res) => {
  try {
    const connected = await db.testConnection();

    res.json({
      success: true,
      data: {
        connected: connected,
        host: process.env.DB_HOST || 'localhost',
        port: process.env.DB_PORT || 5432,
        database: process.env.DB_NAME || 'potentiostat_iot',
        timestamp: new Date().toISOString()
      }
    });
  } catch (err) {
    res.json({
      success: false,
      data: {
        connected: false,
        error: err.message,
        timestamp: new Date().toISOString()
      }
    });
  }
});

/**
 * GET /api/database/stats
 * Obtener estadísticas de la base de datos
 */
router.get('/database/stats', async (req, res) => {
  try {
    // Obtener conteo de registros
    const usersResult = await db.pool.query('SELECT COUNT(*) FROM users');
    const measurementsResult = await db.pool.query('SELECT COUNT(*) FROM measurements');
    const cvDataResult = await db.pool.query('SELECT COUNT(*) FROM cv_data');
    const devicesResult = await db.pool.query('SELECT COUNT(*) FROM devices');

    res.json({
      success: true,
      data: {
        users: parseInt(usersResult.rows[0].count),
        measurements: parseInt(measurementsResult.rows[0].count),
        cvDataPoints: parseInt(cvDataResult.rows[0].count),
        devices: parseInt(devicesResult.rows[0].count),
        timestamp: new Date().toISOString()
      }
    });
  } catch (err) {
    console.error('Error al obtener estadísticas de DB:', err);
    res.status(500).json({
      success: false,
      error: 'Error al obtener estadísticas de base de datos',
      message: err.message
    });
  }
});

/**
 * GET /api/system/status
 * Obtener estado completo del sistema
 */
router.get('/system/status', async (req, res) => {
  try {
    const dbConnected = await db.testConnection();
    const mqttStats = mqtt.getStats();
    const wifiStatus = await wifi.getWifiStatus();

    res.json({
      success: true,
      data: {
        database: {
          connected: dbConnected,
          host: process.env.DB_HOST || 'localhost'
        },
        mqtt: {
          connected: mqttStats.connected,
          broker: mqttStats.brokerUrl,
          messagesReceived: mqttStats.messageStats.received,
          messagesProcessed: mqttStats.messageStats.processed
        },
        wifi: wifiStatus,
        uptime: getUptime(),
        timestamp: new Date().toISOString()
      }
    });
  } catch (err) {
    console.error('Error al obtener estado del sistema:', err);
    res.status(500).json({
      success: false,
      error: 'Error al obtener estado del sistema',
      message: err.message
    });
  }
});

// ============================================
// FUNCIONES AUXILIARES ADICIONALES
// ============================================

/**
 * Calcular tiempo de actividad
 */
function getUptime() {
  const startTime = new Date(transmissionStats.startTime);
  const now = new Date();
  const uptimeMs = now - startTime;

  const hours = Math.floor(uptimeMs / (1000 * 60 * 60));
  const minutes = Math.floor((uptimeMs % (1000 * 60 * 60)) / (1000 * 60));
  const seconds = Math.floor((uptimeMs % (1000 * 60)) / 1000);

  return {
    formatted: `${hours}h ${minutes}m ${seconds}s`,
    milliseconds: uptimeMs,
    hours,
    minutes,
    seconds
  };
}

/**
 * Calcular mensajes por minuto
 */
function calculateMessagesPerMinute() {
  const uptimeMs = new Date() - new Date(transmissionStats.startTime);
  const uptimeMinutes = uptimeMs / (1000 * 60);

  if (uptimeMinutes < 1) return 0;

  const mqttStats = mqtt.getStats();
  return Math.round(mqttStats.messageStats.received / uptimeMinutes * 100) / 100;
}

/**
 * Actualizar estadísticas de transmisión (llamar desde mqtt.js)
 */
function updateTransmissionStats(type) {
  transmissionStats.lastMessageTime = new Date().toISOString();

  switch (type) {
    case 'received':
      transmissionStats.messagesReceived++;
      break;
    case 'sent':
      transmissionStats.messagesSent++;
      break;
    case 'saved':
      transmissionStats.dataPointsSaved++;
      break;
    case 'error':
      transmissionStats.errors++;
      break;
  }
}

// Exportar función de actualización para uso externo
router.updateTransmissionStats = updateTransmissionStats;

module.exports = router;