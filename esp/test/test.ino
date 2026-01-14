// ESP32 + POTENTIOSTAT + MQTT - FIXED PROTOCOL
// Alineado 100% con Desktop App C# (Form1.cs)

#include <WiFi.h>
#include <ArduinoJson.h>
#include <Preferences.h>
#include "mqtt_client.h"
#include "esp_crt_bundle.h"

Preferences preferences;

// ============================================================================
//                        DEFAULT CONNECTION SETTINGS
// ============================================================================

#define DEFAULT_WIFI_SSID          "Nala3"
#define DEFAULT_WIFI_PASSWORD      "Nala2906"

#define DEFAULT_MQTT_BROKER        "57f57f62bdd7478ba34af49e9c090208.s1.eu.hivemq.cloud"
#define DEFAULT_MQTT_PORT          8883
#define DEFAULT_MQTT_USERNAME      "potentiostat"
#define DEFAULT_MQTT_PASSWORD      "POT123456s"
#define DEFAULT_MQTT_CLIENT_ID     "ESP32_Potentiostat_001"

// ============================================================================
//                      DYNAMIC CREDENTIALS
// ============================================================================

String wifi_ssid = DEFAULT_WIFI_SSID;
String wifi_password = DEFAULT_WIFI_PASSWORD;
String mqtt_broker = DEFAULT_MQTT_BROKER;
int mqtt_port = DEFAULT_MQTT_PORT;
String mqtt_username = DEFAULT_MQTT_USERNAME;
String mqtt_password_str = DEFAULT_MQTT_PASSWORD;
String mqtt_client_id = DEFAULT_MQTT_CLIENT_ID;
String mqtt_uri = "";

// ============================================================================
//                         HARDWARE CONFIGURATION
// ============================================================================

#define POTENTIOSTAT_RX 16
#define POTENTIOSTAT_TX 17
#define POTENTIOSTAT_BAUD 115200

HardwareSerial PotentiostatSerial(1);

// ============================================================================
//                         MQTT TOPICS
// ============================================================================
const char* topic_status = "device/esp32/status";
const char* topic_cv_data = "potentiostat/cv_data";
const char* topic_cv_status = "potentiostat/status";
const char* topic_cv_command = "potentiostat/command";
const char* topic_cv_params = "potentiostat/params";
const char* topic_credentials = "device/esp32/credentials";

// ============================================================================
//                    POTENTIOSTAT PROTOCOL (VERSION 1)
// ============================================================================

enum Commands {
    StartID = 0xA0,
    EndPKG = 0xAB,
    StartMeasurement = 0x01,
    StopMeasurement = 0x02,
    SetStartPoint = 0x03,
    SetZeroCross = 0x04,
    SetFirstVertex = 0x05,
    SetSecondVertex = 0x06,
    SetSpeed = 0x07,
    ACK = 0xB0,
    ENDRUN = 0xB1,
    SendAllCV = 0xC0
};

int version = 1;  // Desktop usa version 1
int data_rcv[4];
double dato1, dato2;
double resolution = 4096.0;

uint8_t buff[5];
bool scanInProgress = false;
unsigned long dataPointCount = 0;

// CV Parameters
struct CVParameters {
    float startPoint = 0.000;
    float firstVertex = 0.700;
    float secondVertex = -0.700;
    int zeroCrosses = 4;
    float scanRate = 0.100;
} cvParams;

// MQTT
esp_mqtt_client_handle_t mqtt_client = NULL;
bool mqttConnected = false;
unsigned long lastReconnectAttempt = 0;
const long reconnectInterval = 5000;
int reconnectAttempts = 0;
const int maxReconnectAttempts = 10;

unsigned long lastStatusPublish = 0;
const long statusInterval = 10000;

// Forward declarations
void publishPotentiostatStatus();
void publishCVData();
void handlePotentiostatCommand(String command);
void handlePotentiostatParams(String jsonParams);
void handleCredentials(String jsonCredentials);
void loadCredentials();
void saveCredentials();
void restartMQTT();

// ============================================================================
//            POTENTIOSTAT FUNCTIONS (EXACT DESKTOP PROTOCOL)
// ============================================================================

// Desktop: dato1 = (double)((dato1 - (resoulution / 2)) * (3.3 / resoulution));
void parseADCData() {
    // Reconstruir valores de 12-bit (EXACTAMENTE como Desktop línea 109-110)
    dato1 = ((data_rcv[0] << 6) & 0x0FC0) | data_rcv[1];
    dato2 = ((data_rcv[2] << 6) & 0x0FC0) | data_rcv[3];

    // Version 1 del potenciostato (EXACTAMENTE Desktop línea 116-118)
    dato1 = (double)((dato1 - (resolution / 2)) * (3.3 / resolution));
    dato2 = (double)((dato2 - (resolution / 2)) * (3.3 / resolution));

    // Invert current (EXACTAMENTE Desktop línea 131)
    dato2 = dato2 + 1.25;

    // Log cada 50 puntos
    if (dataPointCount % 50 == 0) {
        Serial.printf("Point %lu: V=%.4f V, I=%.4f V\n", dataPointCount, dato1, dato2);
    }
}

// Desktop: int dato = (int)(((double)numSP.Value + (3.3 / 2.0)) / 3.3 * resoulution) - 1;
int voltageToADC(float voltage) {
    return (int)(((voltage + (3.3 / 2.0)) / 3.3 * resolution) - 1);
}

// Desktop: buff[2] = (byte)(bytes[0] & 0x3F);
// Desktop: buff[3] = (byte)(((bytes[1] << 2) & 0xFC) | ((bytes[0] >> 6) & 0x03));
void sendParameterCommand(uint8_t command, int value) {
    buff[0] = (byte)StartID;
    buff[1] = command;
    
    // EXACTAMENTE como Desktop líneas 190-191, 206-207, etc.
    byte bytes[2];
    bytes[0] = value & 0xFF;
    bytes[1] = (value >> 8) & 0xFF;
    
    buff[2] = (byte)(bytes[0] & 0x3F);
    buff[3] = (byte)(((bytes[1] << 2) & 0xFC) | ((bytes[0] >> 6) & 0x03));
    buff[4] = (byte)EndPKG;
    
    PotentiostatSerial.write(buff, 5);
    PotentiostatSerial.flush();
    delay(50);
}

// Desktop: buff[2] = (byte)Commands.EndPKG;
void sendSimpleCommand(uint8_t command) {
    buff[0] = (byte)StartID;
    buff[1] = command;
    buff[2] = (byte)EndPKG;
    
    PotentiostatSerial.write(buff, 3);
    PotentiostatSerial.flush();
}

// Desktop: btnSendAll_Click - líneas 318-325
void sendAllCVParameters() {
    Serial.println("=== Sending All CV Parameters ===");
    Serial.printf("  SP=%.3fV, FV=%.3fV, SV=%.3fV, ZC=%d, SR=%.4fV/s\n",
                  cvParams.startPoint, cvParams.firstVertex,
                  cvParams.secondVertex, cvParams.zeroCrosses, cvParams.scanRate);

    // Desktop línea 321: buff[0] = (byte)0xC0;
    if (PotentiostatSerial) {
        buff[0] = (byte)0xC0;
        PotentiostatSerial.write(buff, 1);
        PotentiostatSerial.flush();
    }
    delay(50);

    // Desktop ejecuta cada btnSnd*_Click en secuencia
    int adcSP = voltageToADC(cvParams.startPoint);
    int adcFV = voltageToADC(cvParams.firstVertex);
    int adcSV = voltageToADC(cvParams.secondVertex);
    int speedVal = (int)round(cvParams.scanRate / 0.0008);

    Serial.printf("  ADC: SP=%d, FV=%d, SV=%d, Speed=%d\n", adcSP, adcFV, adcSV, speedVal);

    sendParameterCommand(SetStartPoint, adcSP);
    sendParameterCommand(SetFirstVertex, adcFV);
    sendParameterCommand(SetSecondVertex, adcSV);
    sendParameterCommand(SetZeroCross, cvParams.zeroCrosses);
    sendParameterCommand(SetSpeed, speedVal);

    Serial.println("=== Parameters Sent ===");
}

// Desktop: SerialPort1_DataReceived - líneas 70-154
void readPotentiostatData() {
    while (PotentiostatSerial.available() > 0) {
        byte c = (byte)PotentiostatSerial.read();
        
        switch ((Commands)c) {
            case StartID:  // 0xA0 - Datos
                // Desktop líneas 94-97: lee 4 bytes
                if (PotentiostatSerial.available() >= 4) {
                    data_rcv[0] = PotentiostatSerial.read();
                    data_rcv[1] = PotentiostatSerial.read();
                    data_rcv[2] = PotentiostatSerial.read();
                    data_rcv[3] = PotentiostatSerial.read();
                    
                    parseADCData();
                    publishCVData();
                    dataPointCount++;
                    
                    // Desktop línea 152: serialPort1.ReadExisting();
                    // (limpiar cualquier basura restante)
                    while (PotentiostatSerial.available() && 
                           PotentiostatSerial.peek() != StartID && 
                           PotentiostatSerial.peek() != ACK) {
                        PotentiostatSerial.read();
                    }
                }
                break;
                
            case ACK:  // 0xB0 - Acknowledgment
                // Desktop línea 155: byte msg = (byte)serialPort1.ReadByte();
                if (PotentiostatSerial.available() > 0) {
                    byte msg = (byte)PotentiostatSerial.read();
                    // Desktop línea 156: if (msg == (byte)Commands.ENDRUN)
                    if (msg == (byte)ENDRUN) {
                        if (scanInProgress) {
                            Serial.printf("\n>>> Scan finalizado (%lu puntos)\n", dataPointCount);
                            scanInProgress = false;
                            publishPotentiostatStatus();
                        }
                    }
                }
                break;
                
            default:
                // Ignorar bytes desconocidos
                break;
        }
    }
}

void publishCVData() {
    if (!mqttConnected || mqtt_client == NULL) return;

    StaticJsonDocument<300> doc;
    doc["voltage"] = round(dato1 * 1000.0) / 1000.0;  // 3 decimales
    doc["current"] = round(dato2 * 1000.0) / 1000.0;  // 3 decimales
    doc["voltage_unit"] = "V";
    doc["current_unit"] = "V";
    doc["timestamp"] = millis();
    doc["point"] = dataPointCount;
    doc["device_id"] = mqtt_client_id;

    char output[350];
    serializeJson(doc, output);

    esp_mqtt_client_publish(mqtt_client, topic_cv_data, output, 0, 0, 0);
}

void publishPotentiostatStatus() {
    if (!mqttConnected || mqtt_client == NULL) return;

    StaticJsonDocument<256> doc;
    doc["scan_active"] = scanInProgress;
    doc["data_points"] = dataPointCount;
    doc["params"]["sp"] = cvParams.startPoint;
    doc["params"]["fv"] = cvParams.firstVertex;
    doc["params"]["sv"] = cvParams.secondVertex;
    doc["params"]["zc"] = cvParams.zeroCrosses;
    doc["params"]["sr"] = cvParams.scanRate;

    char output[300];
    serializeJson(doc, output);
    esp_mqtt_client_publish(mqtt_client, topic_cv_status, output, 0, 1, 1);
}

// ============================================================================
//                         COMMAND HANDLERS
// ============================================================================

void handlePotentiostatCommand(String command) {
    command.trim();

    if (command == "START") {
        Serial.println("\n========== START COMMAND ==========");

        // Limpiar buffer UART
        while (PotentiostatSerial.available()) {
            PotentiostatSerial.read();
        }

        // Desktop: primero envía parámetros, luego espera, luego START
        sendAllCVParameters();
        
        Serial.println("Esperando 500ms...");
        delay(500);

        // Desktop línea 261: btnStart_Click
        Serial.println("Sending StartMeasurement...");
        sendSimpleCommand(StartMeasurement);

        scanInProgress = true;
        dataPointCount = 0;
        publishPotentiostatStatus();
        Serial.println("========== Scan Iniciado ==========\n");

    } else if (command == "STOP") {
        Serial.println("Deteniendo scan...");
        // Desktop línea 277: btnStop_Click
        sendSimpleCommand(StopMeasurement);
        scanInProgress = false;
        publishPotentiostatStatus();

    } else if (command == "SEND_ALL") {
        sendAllCVParameters();

    } else if (command == "CLEAR") {
        Serial.println("Clearing data...");
        dataPointCount = 0;
        publishPotentiostatStatus();
    }
}

void handlePotentiostatParams(String jsonParams) {
    StaticJsonDocument<256> doc;
    DeserializationError error = deserializeJson(doc, jsonParams);

    if (error) {
        Serial.print("JSON error: ");
        Serial.println(error.c_str());
        return;
    }

    // Claves cortas del frontend
    if (doc.containsKey("sp")) cvParams.startPoint = doc["sp"].as<float>();
    if (doc.containsKey("fv")) cvParams.firstVertex = doc["fv"].as<float>();
    if (doc.containsKey("sv")) cvParams.secondVertex = doc["sv"].as<float>();
    if (doc.containsKey("zc")) cvParams.zeroCrosses = doc["zc"].as<int>();
    if (doc.containsKey("sr")) cvParams.scanRate = doc["sr"].as<float>();

    // También claves largas
    if (doc.containsKey("startPoint")) cvParams.startPoint = doc["startPoint"].as<float>();
    if (doc.containsKey("firstVertex")) cvParams.firstVertex = doc["firstVertex"].as<float>();
    if (doc.containsKey("secondVertex")) cvParams.secondVertex = doc["secondVertex"].as<float>();
    if (doc.containsKey("zeroCrosses")) cvParams.zeroCrosses = doc["zeroCrosses"].as<int>();
    if (doc.containsKey("scanRate")) cvParams.scanRate = doc["scanRate"].as<float>();

    Serial.printf("Params: SP=%.3fV, FV=%.3fV, SV=%.3fV, ZC=%d, SR=%.4fV/s\n",
                  cvParams.startPoint, cvParams.firstVertex,
                  cvParams.secondVertex, cvParams.zeroCrosses, cvParams.scanRate);
}

// ============================================================================
//                    CREDENTIAL MANAGEMENT
// ============================================================================

void loadCredentials() {
    preferences.begin("credentials", true);

    wifi_ssid = preferences.getString("wifi_ssid", DEFAULT_WIFI_SSID);
    wifi_password = preferences.getString("wifi_pass", DEFAULT_WIFI_PASSWORD);
    mqtt_broker = preferences.getString("mqtt_broker", DEFAULT_MQTT_BROKER);
    mqtt_port = preferences.getInt("mqtt_port", DEFAULT_MQTT_PORT);
    mqtt_username = preferences.getString("mqtt_user", DEFAULT_MQTT_USERNAME);
    mqtt_password_str = preferences.getString("mqtt_pass", DEFAULT_MQTT_PASSWORD);
    mqtt_client_id = preferences.getString("mqtt_client", DEFAULT_MQTT_CLIENT_ID);

    preferences.end();

    mqtt_uri = "mqtts://" + mqtt_broker + ":" + String(mqtt_port);

    Serial.println("Credentials loaded:");
    Serial.printf("  WiFi: %s\n", wifi_ssid.c_str());
    Serial.printf("  MQTT: %s:%d\n", mqtt_broker.c_str(), mqtt_port);
}

void saveCredentials() {
    preferences.begin("credentials", false);

    preferences.putString("wifi_ssid", wifi_ssid);
    preferences.putString("wifi_pass", wifi_password);
    preferences.putString("mqtt_broker", mqtt_broker);
    preferences.putInt("mqtt_port", mqtt_port);
    preferences.putString("mqtt_user", mqtt_username);
    preferences.putString("mqtt_pass", mqtt_password_str);
    preferences.putString("mqtt_client", mqtt_client_id);

    preferences.end();
    Serial.println("Credentials saved");
}

void handleCredentials(String jsonCredentials) {
    StaticJsonDocument<512> doc;
    DeserializationError error = deserializeJson(doc, jsonCredentials);

    if (error) return;

    bool changed = false;

    if (doc.containsKey("wifi_ssid") && doc["wifi_ssid"].as<String>() != wifi_ssid) {
        wifi_ssid = doc["wifi_ssid"].as<String>();
        changed = true;
    }

    if (doc.containsKey("wifi_password")) {
        wifi_password = doc["wifi_password"].as<String>();
        changed = true;
    }

    if (doc.containsKey("mqtt_broker") && doc["mqtt_broker"].as<String>() != mqtt_broker) {
        mqtt_broker = doc["mqtt_broker"].as<String>();
        changed = true;
    }

    if (doc.containsKey("mqtt_port") && doc["mqtt_port"].as<int>() != mqtt_port) {
        mqtt_port = doc["mqtt_port"].as<int>();
        changed = true;
    }

    if (changed) {
        saveCredentials();
        mqtt_uri = "mqtts://" + mqtt_broker + ":" + String(mqtt_port);

        if (doc.containsKey("apply_now") && doc["apply_now"].as<bool>()) {
            ESP.restart();
        }
    }
}

void restartMQTT() {
    if (mqtt_client != NULL) {
        esp_mqtt_client_stop(mqtt_client);
        esp_mqtt_client_destroy(mqtt_client);
        mqtt_client = NULL;
    }
    mqttConnected = false;
    delay(500);
}

// ============================================================================
//                         WIFI SETUP
// ============================================================================

void setup_wifi() {
    Serial.print("Conectando a WiFi: ");
    Serial.println(wifi_ssid);

    WiFi.mode(WIFI_STA);
    WiFi.begin(wifi_ssid.c_str(), wifi_password.c_str());

    int attempts = 0;
    while (WiFi.status() != WL_CONNECTED && attempts < 30) {
        delay(500);
        Serial.print(".");
        attempts++;
    }

    Serial.println();

    if (WiFi.status() == WL_CONNECTED) {
        Serial.print("✓ WiFi conectado: ");
        Serial.println(WiFi.localIP());
    } else {
        Serial.println("✗ WiFi falló");
    }
}

// ============================================================================
//                         MQTT EVENT HANDLER
// ============================================================================

static void mqtt_event_handler(void *handler_args, esp_event_base_t base, int32_t event_id, void *event_data) {
    esp_mqtt_event_handle_t event = (esp_mqtt_event_handle_t)event_data;

    switch ((esp_mqtt_event_id_t)event_id) {
        case MQTT_EVENT_CONNECTED:
            Serial.println("✓ MQTT conectado");
            mqttConnected = true;
            reconnectAttempts = 0;

            esp_mqtt_client_subscribe(mqtt_client, topic_cv_command, 1);
            esp_mqtt_client_subscribe(mqtt_client, topic_cv_params, 1);
            esp_mqtt_client_subscribe(mqtt_client, topic_credentials, 1);

            {
                StaticJsonDocument<128> doc;
                doc["device"] = mqtt_client_id;
                doc["status"] = "online";
                char msg[150];
                serializeJson(doc, msg);
                esp_mqtt_client_publish(mqtt_client, topic_status, msg, 0, 1, 1);
            }

            publishPotentiostatStatus();
            break;

        case MQTT_EVENT_DISCONNECTED:
            Serial.println("✗ MQTT desconectado");
            mqttConnected = false;
            break;

        case MQTT_EVENT_DATA:
            {
                String topic = String(event->topic).substring(0, event->topic_len);
                String payload = String((char*)event->data).substring(0, event->data_len);

                Serial.print("MQTT [");
                Serial.print(topic);
                Serial.print("]: ");
                Serial.println(payload);

                if (topic == topic_cv_command) {
                    handlePotentiostatCommand(payload);
                } else if (topic == topic_cv_params) {
                    handlePotentiostatParams(payload);
                } else if (topic == topic_credentials) {
                    handleCredentials(payload);
                }
            }
            break;

        default:
            break;
    }
}

void initMQTT() {
    Serial.println("Inicializando MQTT TLS...");

    // Fix: Forzar puerto 8883
    if (mqtt_port == 8884) {
        mqtt_port = 8883;
        saveCredentials();
    }

    mqtt_uri = "mqtts://" + mqtt_broker + ":" + String(mqtt_port);

    esp_mqtt_client_config_t mqtt_cfg = {};
    mqtt_cfg.broker.address.uri = mqtt_uri.c_str();
    mqtt_cfg.credentials.username = mqtt_username.c_str();
    mqtt_cfg.credentials.authentication.password = mqtt_password_str.c_str();
    mqtt_cfg.credentials.client_id = mqtt_client_id.c_str();
    mqtt_cfg.session.keepalive = 60;
    mqtt_cfg.network.disable_auto_reconnect = false;
    mqtt_cfg.buffer.size = 2048;
    mqtt_cfg.broker.verification.crt_bundle_attach = esp_crt_bundle_attach;

    mqtt_client = esp_mqtt_client_init(&mqtt_cfg);
    esp_mqtt_client_register_event(mqtt_client, MQTT_EVENT_ANY, mqtt_event_handler, NULL);
}

void startMQTT() {
    if (mqtt_client == NULL) initMQTT();
    if (WiFi.status() == WL_CONNECTED && mqtt_client != NULL) {
        esp_mqtt_client_start(mqtt_client);
    }
}

void reconnect() {
    unsigned long now = millis();
    if (now - lastReconnectAttempt < reconnectInterval) return;

    lastReconnectAttempt = now;

    if (WiFi.status() != WL_CONNECTED) return;

    if (!mqttConnected) {
        reconnectAttempts++;
        if (reconnectAttempts >= maxReconnectAttempts) {
            restartMQTT();
            startMQTT();
            reconnectAttempts = 0;
        } else {
            esp_mqtt_client_reconnect(mqtt_client);
        }
    }
}

// ============================================================================
//                         SETUP & LOOP
// ============================================================================

void setup() {
    Serial.begin(115200);
    delay(1000);

    Serial.println("\n========================================");
    Serial.println("ESP32 Potentiostat - Desktop Protocol");
    Serial.println("Version 1.0 Compatible");
    Serial.println("========================================");

    loadCredentials();

    PotentiostatSerial.begin(POTENTIOSTAT_BAUD, SERIAL_8N1, POTENTIOSTAT_RX, POTENTIOSTAT_TX);
    Serial.println("✓ UART inicializado (115200 baud)");

    setup_wifi();

    if (WiFi.status() == WL_CONNECTED) {
        initMQTT();
        startMQTT();
    }

    Serial.println("========================================");
    Serial.println("✓ Sistema listo - esperando comandos");
    Serial.println("========================================");
}

void loop() {
    // WiFi reconnection
    if (WiFi.status() != WL_CONNECTED) {
        mqttConnected = false;
        setup_wifi();
        if (WiFi.status() == WL_CONNECTED) {
            startMQTT();
        }
    }

    // MQTT reconnection
    if (!mqttConnected && WiFi.status() == WL_CONNECTED) {
        reconnect();
    }

    // Leer datos del potenciostato (MÁXIMA PRIORIDAD)
    readPotentiostatData();

    // Publicar status periódicamente
    unsigned long now = millis();
    if (now - lastStatusPublish > statusInterval) {
        lastStatusPublish = now;
        if (mqttConnected) {
            publishPotentiostatStatus();
        }
    }

    delay(5);  // Yield mínimo
}