const { Pool } = require('pg');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// Configuración del pool de conexiones
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'potentiostat_iot',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Evento de error del pool
pool.on('error', (err, client) => {
  console.error('Error inesperado en el cliente del pool', err);
  process.exit(-1);
});

// Función para verificar la conexión
async function testConnection() {
  try {
    const client = await pool.connect();
    console.log('Conexion a PostgreSQL establecida correctamente');
    client.release();
    return true;
  } catch (err) {
    console.error('Error al conectar con PostgreSQL:', err.message);
    return false;
  }
}

// ============================================
// FUNCIONES PARA USUARIOS
// ============================================

/**
 * Crear o actualizar un usuario (por alias)
 */
async function upsertUser(alias, name = null, email = null) {
  const query = `
    INSERT INTO users (alias, name, email)
    VALUES ($1, $2, $3)
    ON CONFLICT (alias) 
    DO UPDATE SET 
      name = COALESCE(EXCLUDED.name, users.name),
      email = COALESCE(EXCLUDED.email, users.email),
      updated_at = NOW()
    RETURNING *
  `;
  
  try {
    const result = await pool.query(query, [alias, name, email]);
    return result.rows[0];
  } catch (err) {
    console.error('Error al crear/actualizar usuario:', err);
    throw err;
  }
}

/**
 * Obtener usuario por alias
 */
async function getUserByAlias(alias) {
  const query = 'SELECT * FROM users WHERE alias = $1';
  
  try {
    const result = await pool.query(query, [alias]);
    return result.rows[0] || null;
  } catch (err) {
    console.error('Error al obtener usuario:', err);
    throw err;
  }
}

/**
 * Obtener todos los usuarios con estadísticas
 */
async function getAllUsers() {
  const query = `
    SELECT 
      u.*,
      COUNT(DISTINCT m.id) as total_measurements,
      MAX(m.created_at) as last_measurement_date
    FROM users u
    LEFT JOIN measurements m ON u.id = m.user_id
    GROUP BY u.id
    ORDER BY u.created_at DESC
  `;
  
  try {
    const result = await pool.query(query);
    return result.rows;
  } catch (err) {
    console.error('Error al obtener usuarios:', err);
    throw err;
  }
}

// ============================================
// FUNCIONES PARA MEDICIONES
// ============================================

/**
 * Crear una nueva medición con UUID
 */
async function createMeasurement(userAlias, deviceId, cvParams = {}) {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // Asegurar que el usuario existe
    const userResult = await client.query(
      'INSERT INTO users (alias) VALUES ($1) ON CONFLICT (alias) DO UPDATE SET updated_at = NOW() RETURNING id',
      [userAlias]
    );
    const userId = userResult.rows[0].id;
    
    // Crear la medición
    const measurementQuery = `
      INSERT INTO measurements (
        user_id, 
        device_id, 
        start_time, 
        status,
        cv_start_point,
        cv_first_vertex,
        cv_second_vertex,
        cv_zero_crosses,
        cv_scan_rate
      )
      VALUES ($1, $2, NOW(), 'active', $3, $4, $5, $6, $7)
      RETURNING *
    `;
    
    const result = await client.query(measurementQuery, [
      userId,
      deviceId,
      cvParams.startPoint || null,
      cvParams.firstVertex || null,
      cvParams.secondVertex || null,
      cvParams.zeroCrosses || null,
      cvParams.scanRate || null
    ]);
    
    await client.query('COMMIT');
    
    // Incluir el alias del usuario en el resultado
    const measurement = result.rows[0];
    measurement.user_alias = userAlias;
    
    return measurement;
    
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error al crear medición:', err);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Finalizar una medición
 */
async function finalizeMeasurement(measurementId) {
  const query = `
    UPDATE measurements
    SET end_time = NOW(), status = 'completed', updated_at = NOW()
    WHERE id = $1
    RETURNING *
  `;
  
  try {
    const result = await pool.query(query, [measurementId]);
    return result.rows[0];
  } catch (err) {
    console.error('Error al finalizar medición:', err);
    throw err;
  }
}

/**
 * Obtener mediciones por alias de usuario
 */
async function getMeasurementsByUserAlias(alias, limit = 50) {
  const query = `
    SELECT 
      m.*,
      u.alias as user_alias,
      u.name as user_name,
      COUNT(DISTINCT cv.id) as cv_data_points,
      COUNT(DISTINCT hr.id) as heartrate_points,
      COUNT(DISTINCT sp.id) as spo2_points,
      COUNT(DISTINCT st.id) as stress_points
    FROM measurements m
    INNER JOIN users u ON m.user_id = u.id
    LEFT JOIN cv_data cv ON m.id = cv.measurement_id
    LEFT JOIN heartrate_data hr ON m.id = hr.measurement_id
    LEFT JOIN spo2_data sp ON m.id = sp.measurement_id
    LEFT JOIN stress_data st ON m.id = st.measurement_id
    WHERE u.alias = $1
    GROUP BY m.id, u.id
    ORDER BY m.created_at DESC
    LIMIT $2
  `;
  
  try {
    const result = await pool.query(query, [alias, limit]);
    return result.rows;
  } catch (err) {
    console.error('Error al obtener mediciones por usuario:', err);
    throw err;
  }
}

/**
 * Obtener mediciones por dispositivo
 */
async function getMeasurementsByDevice(deviceId, limit = 50) {
  const query = `
    SELECT 
      m.*,
      u.alias as user_alias,
      u.name as user_name,
      COUNT(DISTINCT cv.id) as cv_data_points,
      COUNT(DISTINCT hr.id) as heartrate_points,
      COUNT(DISTINCT sp.id) as spo2_points,
      COUNT(DISTINCT st.id) as stress_points
    FROM measurements m
    INNER JOIN users u ON m.user_id = u.id
    LEFT JOIN cv_data cv ON m.id = cv.measurement_id
    LEFT JOIN heartrate_data hr ON m.id = hr.measurement_id
    LEFT JOIN spo2_data sp ON m.id = sp.measurement_id
    LEFT JOIN stress_data st ON m.id = st.measurement_id
    WHERE m.device_id = $1
    GROUP BY m.id, u.id
    ORDER BY m.created_at DESC
    LIMIT $2
  `;
  
  try {
    const result = await pool.query(query, [deviceId, limit]);
    return result.rows;
  } catch (err) {
    console.error('Error al obtener mediciones por dispositivo:', err);
    throw err;
  }
}

/**
 * Obtener una medición específica con todos sus datos
 */
async function getMeasurementById(measurementId) {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // Obtener info de la medición con usuario
    const measurementQuery = `
      SELECT m.*, u.alias as user_alias, u.name as user_name, u.email as user_email
      FROM measurements m
      INNER JOIN users u ON m.user_id = u.id
      WHERE m.id = $1
    `;
    const measurement = await client.query(measurementQuery, [measurementId]);
    
    if (measurement.rows.length === 0) {
      throw new Error('Medición no encontrada');
    }
    
    // Obtener datos CV
    const cvQuery = 'SELECT * FROM cv_data WHERE measurement_id = $1 ORDER BY timestamp';
    const cvData = await client.query(cvQuery, [measurementId]);
    
    // Obtener datos de ritmo cardíaco
    const hrQuery = 'SELECT * FROM heartrate_data WHERE measurement_id = $1 ORDER BY timestamp';
    const hrData = await client.query(hrQuery, [measurementId]);
    
    // Obtener datos de SpO2
    const spo2Query = 'SELECT * FROM spo2_data WHERE measurement_id = $1 ORDER BY timestamp';
    const spo2Data = await client.query(spo2Query, [measurementId]);
    
    // Obtener datos de estrés
    const stressQuery = 'SELECT * FROM stress_data WHERE measurement_id = $1 ORDER BY timestamp';
    const stressData = await client.query(stressQuery, [measurementId]);
    
    await client.query('COMMIT');
    
    return {
      measurement: measurement.rows[0],
      cvData: cvData.rows,
      heartrateData: hrData.rows,
      spo2Data: spo2Data.rows,
      stressData: stressData.rows
    };
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error al obtener medición completa:', err);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Obtener medición por UUID
 */
async function getMeasurementByUUID(uuid) {
  const query = `
    SELECT m.*, u.alias as user_alias, u.name as user_name
    FROM measurements m
    INNER JOIN users u ON m.user_id = u.id
    WHERE m.uuid = $1
  `;
  
  try {
    const result = await pool.query(query, [uuid]);
    if (result.rows.length === 0) {
      return null;
    }
    
    // Obtener la medición completa usando el ID
    return await getMeasurementById(result.rows[0].id);
  } catch (err) {
    console.error('Error al obtener medición por UUID:', err);
    throw err;
  }
}

// ============================================
// FUNCIONES PARA DATOS CV
// ============================================

/**
 * Insertar datos de voltametría cíclica
 */
async function insertCVData(measurementId, voltage, current, timestamp) {
  const query = `
    INSERT INTO cv_data (measurement_id, voltage, current, timestamp)
    VALUES ($1, $2, $3, $4)
    RETURNING *
  `;
  
  try {
    const result = await pool.query(query, [measurementId, voltage, current, timestamp]);
    return result.rows[0];
  } catch (err) {
    console.error('Error al insertar datos CV:', err);
    throw err;
  }
}

/**
 * Insertar múltiples datos CV en batch
 */
async function insertCVDataBatch(cvDataArray) {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const insertPromises = cvDataArray.map(data => 
      client.query(
        'INSERT INTO cv_data (measurement_id, voltage, current, timestamp) VALUES ($1, $2, $3, $4)',
        [data.measurement_id, data.voltage, data.current, data.timestamp]
      )
    );
    
    await Promise.all(insertPromises);
    await client.query('COMMIT');
    
    return { success: true, count: cvDataArray.length };
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error al insertar datos CV en batch:', err);
    throw err;
  } finally {
    client.release();
  }
}

// ============================================
// FUNCIONES PARA DATOS BIOSENSOR
// ============================================

/**
 * Insertar datos de ritmo cardíaco
 */
async function insertHeartRateData(measurementId, bpm, avgBpm, timestamp) {
  const query = `
    INSERT INTO heartrate_data (measurement_id, bpm, avg_bpm, timestamp)
    VALUES ($1, $2, $3, $4)
    RETURNING *
  `;
  
  try {
    const result = await pool.query(query, [measurementId, bpm, avgBpm, timestamp]);
    return result.rows[0];
  } catch (err) {
    console.error('Error al insertar datos de ritmo cardíaco:', err);
    throw err;
  }
}

/**
 * Insertar datos de SpO2
 */
async function insertSpO2Data(measurementId, spo2, avgSpo2, timestamp) {
  const query = `
    INSERT INTO spo2_data (measurement_id, spo2, avg_spo2, timestamp)
    VALUES ($1, $2, $3, $4)
    RETURNING *
  `;
  
  try {
    const result = await pool.query(query, [measurementId, spo2, avgSpo2, timestamp]);
    return result.rows[0];
  } catch (err) {
    console.error('Error al insertar datos de SpO2:', err);
    throw err;
  }
}

/**
 * Insertar datos de estrés
 */
async function insertStressData(measurementId, stressLevel, timestamp) {
  const query = `
    INSERT INTO stress_data (measurement_id, stress_level, timestamp)
    VALUES ($1, $2, $3)
    RETURNING *
  `;
  
  try {
    const result = await pool.query(query, [measurementId, stressLevel, timestamp]);
    return result.rows[0];
  } catch (err) {
    console.error('Error al insertar datos de estrés:', err);
    throw err;
  }
}

// ============================================
// FUNCIONES PARA DISPOSITIVOS
// ============================================

/**
 * Registrar o actualizar un dispositivo
 */
async function upsertDevice(deviceId, deviceName, ipAddress) {
  const query = `
    INSERT INTO devices (device_id, device_name, ip_address, last_seen)
    VALUES ($1, $2, $3, NOW())
    ON CONFLICT (device_id) 
    DO UPDATE SET 
      device_name = EXCLUDED.device_name,
      ip_address = EXCLUDED.ip_address,
      last_seen = NOW(),
      updated_at = NOW()
    RETURNING *
  `;
  
  try {
    const result = await pool.query(query, [deviceId, deviceName, ipAddress]);
    return result.rows[0];
  } catch (err) {
    console.error('Error al registrar/actualizar dispositivo:', err);
    throw err;
  }
}

/**
 * Obtener todos los dispositivos
 */
async function getAllDevices() {
  const query = `
    SELECT 
      d.*,
      COUNT(DISTINCT m.id) as total_measurements,
      MAX(m.created_at) as last_measurement
    FROM devices d
    LEFT JOIN measurements m ON d.device_id = m.device_id
    GROUP BY d.id
    ORDER BY d.last_seen DESC
  `;
  
  try {
    const result = await pool.query(query);
    return result.rows;
  } catch (err) {
    console.error('Error al obtener dispositivos:', err);
    throw err;
  }
}

// ============================================
// FUNCIONES DE ANÁLISIS Y ESTADÍSTICAS
// ============================================

/**
 * Obtener estadísticas de una medición
 */
async function getMeasurementStats(measurementId) {
  const query = `
    SELECT 
      COUNT(cv.id) as cv_points,
      AVG(cv.voltage) as avg_voltage,
      AVG(cv.current) as avg_current,
      MIN(cv.voltage) as min_voltage,
      MAX(cv.voltage) as max_voltage,
      AVG(hr.bpm) as avg_bpm,
      MIN(hr.bpm) as min_bpm,
      MAX(hr.bpm) as max_bpm,
      AVG(sp.spo2) as avg_spo2,
      MIN(sp.spo2) as min_spo2,
      MAX(sp.spo2) as max_spo2,
      AVG(st.stress_level) as avg_stress,
      MIN(st.stress_level) as min_stress,
      MAX(st.stress_level) as max_stress
    FROM measurements m
    LEFT JOIN cv_data cv ON m.id = cv.measurement_id
    LEFT JOIN heartrate_data hr ON m.id = hr.measurement_id
    LEFT JOIN spo2_data sp ON m.id = sp.measurement_id
    LEFT JOIN stress_data st ON m.id = st.measurement_id
    WHERE m.id = $1
    GROUP BY m.id
  `;
  
  try {
    const result = await pool.query(query, [measurementId]);
    return result.rows[0];
  } catch (err) {
    console.error('Error al obtener estadísticas:', err);
    throw err;
  }
}

/**
 * Eliminar mediciones antiguas (limpieza)
 */
async function deleteOldMeasurements(daysOld = 90) {
  const query = `
    DELETE FROM measurements
    WHERE created_at < NOW() - INTERVAL '${daysOld} days'
    RETURNING id
  `;
  
  try {
    const result = await pool.query(query);
    return { deleted: result.rowCount, ids: result.rows.map(r => r.id) };
  } catch (err) {
    console.error('Error al eliminar mediciones antiguas:', err);
    throw err;
  }
}

// ============================================
// EXPORTAR FUNCIONES Y POOL
// ============================================

module.exports = {
  pool,
  testConnection,
  
  // Usuarios
  upsertUser,
  getUserByAlias,
  getAllUsers,
  
  // Mediciones
  createMeasurement,
  finalizeMeasurement,
  getMeasurementsByUserAlias,
  getMeasurementsByDevice,
  getMeasurementById,
  getMeasurementByUUID,
  getMeasurementStats,
  deleteOldMeasurements,
  
  // Datos CV
  insertCVData,
  insertCVDataBatch,
  
  // Datos Biosensor
  insertHeartRateData,
  insertSpO2Data,
  insertStressData,
  
  // Dispositivos
  upsertDevice,
  getAllDevices
};