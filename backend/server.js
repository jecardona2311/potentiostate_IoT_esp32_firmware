const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const db = require('./db');
const mqtt = require('./mqtt');
const routes = require('./routes');

// Crear aplicación Express
const app = express();
const PORT = process.env.PORT || 3000;

// ============================================
// MIDDLEWARES
// ============================================

// Seguridad - configurar helmet para permitir scripts inline
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));

// CORS
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Body parsers
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Logging
if (process.env.NODE_ENV === 'development') {
  app.use(morgan('dev'));
} else {
  app.use(morgan('combined'));
}

// Servir archivos estaticos del frontend
const frontendPath = path.join(__dirname, '..', 'frontend');
app.use(express.static(frontendPath));

// ============================================
// RUTAS
// ============================================

// API Routes
app.use('/api', routes);

// Ruta para documentación simple
app.get('/api/docs', (req, res) => {
  res.json({
    title: 'Potentiostat IoT API Documentation',
    version: '1.0.0',
    baseURL: `http://localhost:${PORT}/api`,
    endpoints: {
      users: {
        'GET /users': 'Obtener todos los usuarios',
        'GET /users/:alias': 'Obtener usuario por alias',
        'POST /users': 'Crear/actualizar usuario',
        'GET /users/:alias/measurements': 'Obtener mediciones de un usuario'
      },
      measurements: {
        'POST /measurements/start': 'Iniciar nueva medición',
        'POST /measurements/:id/stop': 'Finalizar medición',
        'GET /measurements/:id': 'Obtener medición completa',
        'GET /measurements/uuid/:uuid': 'Obtener medición por UUID',
        'GET /measurements/:id/download': 'Descargar medición (query: format=json|txt|csv)',
        'GET /measurements/:id/stats': 'Obtener estadísticas de medición'
      },
      devices: {
        'GET /devices': 'Obtener todos los dispositivos',
        'GET /devices/:deviceId/measurements': 'Obtener mediciones de un dispositivo'
      },
      mqtt: {
        'POST /mqtt/command': 'Enviar comando (START|STOP|CLEAR)',
        'POST /mqtt/parameters': 'Enviar parámetros de CV',
        'GET /mqtt/status': 'Obtener estado del sistema MQTT'
      },
      system: {
        'GET /health': 'Estado del sistema'
      }
    }
  });
});

// Manejo de rutas no encontradas para API
app.use('/api/*', (req, res) => {
  res.status(404).json({
    success: false,
    error: 'Ruta API no encontrada',
    path: req.path
  });
});

// Fallback: servir index.html para cualquier otra ruta (SPA)
app.get('*', (req, res) => {
  res.sendFile(path.join(frontendPath, 'index.html'));
});

// Manejo de errores global
app.use((err, req, res, next) => {
  console.error('Error no manejado:', err);
  
  res.status(err.status || 500).json({
    success: false,
    error: err.message || 'Error interno del servidor',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
});

// ============================================
// INICIALIZACIÓN
// ============================================

async function initializeServer() {
  try {
    console.log('Iniciando servidor Potentiostat IoT...\n');

    // 1. Probar conexión a PostgreSQL
    console.log('Conectando a PostgreSQL...');
    const dbConnected = await db.testConnection();
    if (!dbConnected) {
      throw new Error('No se pudo conectar a PostgreSQL');
    }
    
    // 2. Inicializar MQTT
    console.log('\nConectando a HiveMQ Cloud...');
    mqtt.initMQTT();
    
    // Esperar un momento para que MQTT se conecte
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    if (!mqtt.isConnected()) {
      console.warn('MQTT no conectado, pero el servidor continuara');
    }
    
    // 3. Iniciar servidor HTTP
    console.log('\nIniciando servidor HTTP...');
    app.listen(PORT, () => {
      console.log('\n' + '='.repeat(60));
      console.log('Servidor Potentiostat IoT iniciado correctamente');
      console.log('='.repeat(60));
      console.log(`Frontend: http://localhost:${PORT}`);
      console.log(`API: http://localhost:${PORT}/api`);
      console.log(`Documentacion: http://localhost:${PORT}/api/docs`);
      console.log(`Health Check: http://localhost:${PORT}/api/health`);
      console.log(`PostgreSQL: ${dbConnected ? 'Conectado' : 'Desconectado'}`);
      console.log(`MQTT: ${mqtt.isConnected() ? 'Conectado a HiveMQ Cloud' : 'Desconectado'}`);
      console.log('='.repeat(60));
      console.log('\nPresiona Ctrl+C para detener el servidor\n');
    });
    
  } catch (err) {
    console.error('\nError al inicializar el servidor:', err.message);
    console.error(err);
    process.exit(1);
  }
}

// ============================================
// MANEJO DE SEÑALES DE CIERRE
// ============================================

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

async function gracefulShutdown() {
  console.log('\n\nSenal de cierre recibida. Cerrando servidor...');

  try {
    // Cerrar MQTT
    if (mqtt.isConnected()) {
      console.log('Cerrando conexion MQTT...');
      mqtt.disconnect();
    }

    // Cerrar pool de PostgreSQL
    console.log('Cerrando conexiones de base de datos...');
    await db.pool.end();

    console.log('Servidor cerrado correctamente');
    process.exit(0);
  } catch (err) {
    console.error('Error durante el cierre:', err);
    process.exit(1);
  }
}

// Manejo de errores no capturados
process.on('uncaughtException', (err) => {
  console.error('Excepcion no capturada:', err);
  gracefulShutdown();
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Promesa rechazada no manejada:', reason);
  gracefulShutdown();
});

// ============================================
// INICIAR SERVIDOR
// ============================================

initializeServer();