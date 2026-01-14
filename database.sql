-- Crear base de datos
CREATE DATABASE potentiostat_iot;

-- Conectar a la base de datos
\c potentiostat_iot;

-- Habilitar extensión para UUID
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================
-- TABLA DE USUARIOS
-- ============================================
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    alias VARCHAR(100) UNIQUE NOT NULL,
    name VARCHAR(200),
    email VARCHAR(200),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- TABLA DE DISPOSITIVOS
-- ============================================
CREATE TABLE devices (
    id SERIAL PRIMARY KEY,
    device_id VARCHAR(100) UNIQUE NOT NULL,
    device_name VARCHAR(200),
    ip_address VARCHAR(50),
    last_seen TIMESTAMP DEFAULT NOW(),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- TABLA DE MEDICIONES
-- ============================================
CREATE TABLE measurements (
    id SERIAL PRIMARY KEY,
    uuid UUID DEFAULT uuid_generate_v4() UNIQUE NOT NULL,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    device_id VARCHAR(100) REFERENCES devices(device_id) ON DELETE SET NULL,
    start_time TIMESTAMP NOT NULL,
    end_time TIMESTAMP,
    status VARCHAR(20) DEFAULT 'active', -- active, completed, error
    
    -- Parámetros de voltametría cíclica (para trazabilidad)
    cv_start_point NUMERIC(10, 6),
    cv_first_vertex NUMERIC(10, 6),
    cv_second_vertex NUMERIC(10, 6),
    cv_zero_crosses INTEGER,
    cv_scan_rate NUMERIC(10, 6),
    
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- TABLA DE DATOS DE VOLTAMETRÍA CÍCLICA
-- ============================================
CREATE TABLE cv_data (
    id SERIAL PRIMARY KEY,
    measurement_id INTEGER REFERENCES measurements(id) ON DELETE CASCADE,
    voltage NUMERIC(10, 6) NOT NULL,
    current NUMERIC(15, 10) NOT NULL,
    timestamp TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- TABLA DE DATOS DE RITMO CARDÍACO
-- ============================================
CREATE TABLE heartrate_data (
    id SERIAL PRIMARY KEY,
    measurement_id INTEGER REFERENCES measurements(id) ON DELETE CASCADE,
    bpm NUMERIC(6, 2) NOT NULL,
    avg_bpm NUMERIC(6, 2),
    timestamp TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- TABLA DE DATOS DE SPO2 (OXÍGENO)
-- ============================================
CREATE TABLE spo2_data (
    id SERIAL PRIMARY KEY,
    measurement_id INTEGER REFERENCES measurements(id) ON DELETE CASCADE,
    spo2 NUMERIC(5, 2) NOT NULL,
    avg_spo2 NUMERIC(5, 2),
    timestamp TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- TABLA DE DATOS DE ESTRÉS
-- ============================================
CREATE TABLE stress_data (
    id SERIAL PRIMARY KEY,
    measurement_id INTEGER REFERENCES measurements(id) ON DELETE CASCADE,
    stress_level NUMERIC(10, 4) NOT NULL,
    timestamp TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- ÍNDICES PARA MEJORAR EL RENDIMIENTO
-- ============================================

-- Índices de usuarios
CREATE INDEX idx_users_alias ON users(alias);

-- Índices de mediciones
CREATE INDEX idx_measurements_uuid ON measurements(uuid);
CREATE INDEX idx_measurements_user ON measurements(user_id);
CREATE INDEX idx_measurements_device ON measurements(device_id);
CREATE INDEX idx_measurements_status ON measurements(status);
CREATE INDEX idx_measurements_start_time ON measurements(start_time DESC);

-- Índices de datos CV
CREATE INDEX idx_cv_data_measurement ON cv_data(measurement_id);
CREATE INDEX idx_cv_data_timestamp ON cv_data(timestamp);

-- Índices de datos de biosensores
CREATE INDEX idx_heartrate_measurement ON heartrate_data(measurement_id);
CREATE INDEX idx_heartrate_timestamp ON heartrate_data(timestamp);
CREATE INDEX idx_spo2_measurement ON spo2_data(measurement_id);
CREATE INDEX idx_spo2_timestamp ON spo2_data(timestamp);
CREATE INDEX idx_stress_measurement ON stress_data(measurement_id);
CREATE INDEX idx_stress_timestamp ON stress_data(timestamp);

-- ============================================
-- VISTAS ÚTILES
-- ============================================

-- Vista de resumen de mediciones
CREATE VIEW measurement_summary AS
SELECT 
    m.id,
    m.uuid,
    m.user_id,
    u.alias as user_alias,
    u.name as user_name,
    m.device_id,
    m.start_time,
    m.end_time,
    m.status,
    m.cv_start_point,
    m.cv_first_vertex,
    m.cv_second_vertex,
    m.cv_zero_crosses,
    m.cv_scan_rate,
    COUNT(DISTINCT cv.id) as cv_points,
    COUNT(DISTINCT hr.id) as hr_points,
    COUNT(DISTINCT sp.id) as spo2_points,
    COUNT(DISTINCT st.id) as stress_points,
    m.created_at
FROM measurements m
INNER JOIN users u ON m.user_id = u.id
LEFT JOIN cv_data cv ON m.id = cv.measurement_id
LEFT JOIN heartrate_data hr ON m.id = hr.measurement_id
LEFT JOIN spo2_data sp ON m.id = sp.measurement_id
LEFT JOIN stress_data st ON m.id = st.measurement_id
GROUP BY m.id, u.id;

-- Vista de estadísticas por usuario
CREATE VIEW user_statistics AS
SELECT 
    u.id,
    u.alias,
    u.name,
    COUNT(DISTINCT m.id) as total_measurements,
    COUNT(DISTINCT cv.id) as total_cv_points,
    COUNT(DISTINCT hr.id) as total_hr_points,
    COUNT(DISTINCT sp.id) as total_spo2_points,
    COUNT(DISTINCT st.id) as total_stress_points,
    MIN(m.start_time) as first_measurement,
    MAX(m.start_time) as last_measurement
FROM users u
LEFT JOIN measurements m ON u.id = m.user_id
LEFT JOIN cv_data cv ON m.id = cv.measurement_id
LEFT JOIN heartrate_data hr ON m.id = hr.measurement_id
LEFT JOIN spo2_data sp ON m.id = sp.measurement_id
LEFT JOIN stress_data st ON m.id = st.measurement_id
GROUP BY u.id;

-- ============================================
-- FUNCIONES ÚTILES
-- ============================================

-- Función para limpiar mediciones antiguas
CREATE OR REPLACE FUNCTION cleanup_old_measurements(days_old INTEGER DEFAULT 90)
RETURNS TABLE(deleted_count INTEGER) AS $$
BEGIN
    DELETE FROM measurements
    WHERE created_at < NOW() - (days_old || ' days')::INTERVAL;
    
    RETURN QUERY SELECT COUNT(*)::INTEGER FROM measurements WHERE FALSE;
END;
$$ LANGUAGE plpgsql;

-- Función para obtener duración de una medición
CREATE OR REPLACE FUNCTION get_measurement_duration(measurement_uuid UUID)
RETURNS INTERVAL AS $$
DECLARE
    duration INTERVAL;
BEGIN
    SELECT end_time - start_time INTO duration
    FROM measurements
    WHERE uuid = measurement_uuid;
    
    RETURN duration;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- DATOS DE EJEMPLO (OPCIONAL)
-- ============================================

-- Insertar un usuario de ejemplo
INSERT INTO users (alias, name, email) 
VALUES ('john_doe', 'John Doe', 'john@example.com');

-- Insertar un dispositivo de ejemplo
INSERT INTO devices (device_id, device_name, ip_address) 
VALUES ('ESP32_001', 'Potentiostato Principal', '192.168.1.100');

-- ============================================
-- TRIGGERS
-- ============================================

-- Trigger para actualizar updated_at automáticamente
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_users_updated_at 
BEFORE UPDATE ON users
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_devices_updated_at 
BEFORE UPDATE ON devices
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_measurements_updated_at 
BEFORE UPDATE ON measurements
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

-- ============================================
-- COMENTARIOS EN LAS TABLAS
-- ============================================

COMMENT ON TABLE users IS 'Usuarios identificados por alias único';
COMMENT ON TABLE devices IS 'Dispositivos ESP32 registrados en el sistema';
COMMENT ON TABLE measurements IS 'Mediciones con UUID único para identificación y trazabilidad';
COMMENT ON TABLE cv_data IS 'Datos de voltametría cíclica';
COMMENT ON TABLE heartrate_data IS 'Datos de ritmo cardíaco (BPM)';
COMMENT ON TABLE spo2_data IS 'Datos de nivel de oxígeno en sangre';
COMMENT ON TABLE stress_data IS 'Datos de nivel de estrés (laccase)';

COMMENT ON COLUMN measurements.uuid IS 'UUID único para cada medición, usado en descargas';
COMMENT ON COLUMN measurements.cv_start_point IS 'Punto de inicio de voltametría (V)';
COMMENT ON COLUMN measurements.cv_first_vertex IS 'Primer vértice de voltametría (V)';
COMMENT ON COLUMN measurements.cv_second_vertex IS 'Segundo vértice de voltametría (V)';
COMMENT ON COLUMN measurements.cv_zero_crosses IS 'Número de cruces por cero';
COMMENT ON COLUMN measurements.cv_scan_rate IS 'Velocidad de escaneo (V/s)';

-- ============================================
-- PERMISOS (OPCIONAL)
-- ============================================

-- Crear rol para la aplicación
-- CREATE ROLE potentiostat_app WITH LOGIN PASSWORD 'secure_password';
-- GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO potentiostat_app;
-- GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO potentiostat_app;