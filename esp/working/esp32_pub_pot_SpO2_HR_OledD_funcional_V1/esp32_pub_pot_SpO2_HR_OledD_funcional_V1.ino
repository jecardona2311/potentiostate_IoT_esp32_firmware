// ESP32 + MAX30102 + POTENTIOSTAT + MQTT + OLED
// Control IoT con SpO2, HR y Voltametria Ciclica

#include <WiFi.h>
#include <PubSubClient.h>

#include <Wire.h>
#include <ArduinoJson.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include "MAX30105.h"
#include "spo2_algorithm.h"
#include <WiFiClientSecure.h>

// I2C Configuration
#define I2C_SDA 21
#define I2C_SCL 22

// OLED Configuration
#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
#define OLED_RESET -1
Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET);

// UART for Potentiostat
#define POTENTIOSTAT_RX 16
#define POTENTIOSTAT_TX 17
#define POTENTIOSTAT_BAUD 115200

HardwareSerial PotentiostatSerial(1);

// Potentiostat Protocol
enum PotentiostatCommands {
    StartID = 0xA0,
    EndPKG = 0xAB,
    StartMeasurement = 0x01,
    StopMeasurement = 0x02,
    SetStartPoint = 0x03,
    SetZeroCross = 0x04,
    SetFirstVertex = 0x05,
    SetSecondVertex = 0x06,
    SetSpeed = 0x07,
    SetTimeHold = 0x11,
    SetFinalValue = 0x12,
    ACK = 0xB0,
    ENDRUN = 0xB1,
    SendAllCV = 0xC0,
    SendAllASV = 0xC1,
    SendAllSWASV = 0xC2
};

uint8_t buff[5];
int data_rcv[4];
double voltage = 0.0;
double current = 0.0;
const double resolution = 4096.0;
bool scanInProgress = false;

enum ParserState {
    WAITING_START,
    READING_DATA
};
ParserState parserState = WAITING_START;
int dataIndex = 0;

// MAX30102 Sensor
MAX30105 particleSensor;

#define BUFFER_LENGTH 100
uint32_t irBuffer[BUFFER_LENGTH];
uint32_t redBuffer[BUFFER_LENGTH];

int32_t spo2 = 0;
int8_t validSPO2 = 0;
int32_t heartRate = 0;
int8_t validHeartRate = 0;
int32_t bufferLength = BUFFER_LENGTH;

bool sensorReady = false;
unsigned long lastSensorUpdate = 0;
const long sensorUpdateInterval = 1000;

float displayHeartRate = 0;
float displaySpO2 = 0;

// WiFi Configuration
const char* ssid = "esp32";
const char* password = "123456789";

// MQTT Configuration
const char* mqtt_server = "57f57f62bdd7478ba34af49e9c090208.s1.eu.hivemq.cloud";
const int mqtt_port = 8883;
const char* mqtt_user = "potentiostat";
const char* mqtt_password = "POT123456s";
const char* mqtt_client_id = "ESP32_BioSensor_001";

// ---------- Certificado CA (ISRG Root X1) ----------
static const char ca_cert[] PROGMEM = R"EOF(
-----BEGIN CERTIFICATE-----
MIIFazCCA1OgAwIBAgIRAIIQz7DSQONZRGPgu2OCiwAwDQYJKoZIhvcNAQELBQAw
TzELMAkGA1UEBhMCVVMxKTAnBgNVBAoTIEludGVybmV0IFNlY3VyaXR5IFJlc2Vh
cmNoIEdyb3VwMRUwEwYDVQQDEwxJU1JHIFJvb3QgWDEwHhcNMTUwNjA0MTEwNDM4
WhcNMzUwNjA0MTEwNDM4WjBPMQswCQYDVQQGEwJVUzEpMCcGA1UEChMgSW50ZXJu
ZXQgU2VjdXJpdHkgUmVzZWFyY2ggR3JvdXAxFTATBgNVBAMTDElTUkcgUm9vdCBY
MTCCAiIwDQYJKoZIhvcNAQEBBQADggIPADCCAgoCggIBAK3oJHP0FDfzm54rVygc
h77ct984kIxuPOZXoHj3dcKi/vVqbvYATyjb3miGbESTtrFj/RQSa78f0uoxmyF+
0TM8ukj13Xnfs7j/EvEhmkvBioZxaUpmZmyPfjxwv60pIgbz5MDmgK7iS4+3mX6U
A5/TR5d8mUgjU+g4rk8Kb4Mu0UlXjIB0ttov0DiNewNwIRt18jA8+o+u3dpjq+sW
T8KOEUt+zwvo/7V3LvSye0rgTBIlDHCNAymg4VMk7BPZ7hm/ELNKjD+Jo2FR3qyH
B5T0Y3HsLuJvW5iB4YlcNHlsdu87kGJ55tukmi8mxdAQ4Q7e2RCOFvu396j3x+UC
B5iPNgiV5+I3lg02dZ77DnKxHZu8A/lJBdiB3QW0KtZB6awBdpUKD9jf1b0SHzUv
KBds0pjBqAlkd25HN7rOrFleaJ1/ctaJxQZBKT5ZPt0m9STJEadao0xAH0ahmbWn
OlFuhjuefXKnEgV4We0+UXgVCwOPjdAvBbI+e0ocS3MFEvzG6uBQE3xDk3SzynTn
jh8BCNAw1FtxNrQHusEwMFxIt4I7mKZ9YIqioymCzLq9gwQbooMDQaHWBfEbwrbw
qHyGO0aoSCqI3Haadr8faqU9GY/rOPNk3sgrDQoo//fb4hVC1CLQJ13hef4Y53CI
rU7m2Ys6xt0nUW7/vGT1M0NPAgMBAAGjQjBAMA4GA1UdDwEB/wQEAwIBBjAPBgNV
HRMBAf8EBTADAQH/MB0GA1UdDgQWBBR5tFnme7bl5AFzgAiIyBpY9umbbjANBgkq
hkiG9w0BAQsFAAOCAgEAVR9YqbyyqFDQDLHYGmkgJykIrGF1XIpu+ILlaS/V9lZL
ubhzEFnTIZd+50xx+7LSYK05qAvqFyFWhfFQDlnrzuBZ6brJFe+GnY+EgPbk6ZGQ
3BebYhtF8GaV0nxvwuo77x/Py9auJ/GpsMiu/X1+mvoiBOv/2X/qkSsisRcOj/KK
NFtY2PwByVS5uCbMiogziUwthDyC3+6WVwW6LLv3xLfHTjuCvjHIInNzktHCgKQ5
ORAzI4JMPJ+GslWYHb4phowim57iaztXOoJwTdwJx4nLCgdNbOhdjsnvzqvHu7Ur
TkXWStAmzOVyyghqpZXjFaH3pO3JLF+l+/+sKAIuvtd7u+Nxe5AW0wdeRlN8NwdC
jNPElpzVmbUq4JUagEiuTDkHzsxHpFKVK7q4+63SM1N95R1NbdWhscdCb+ZAJzVc
oyi3B43njTOQ5yOf+1CceWxG1bQVs5ZufpsMljq4Ui0/1lvh+wjChP4kqKOJ2qxq
4RgqsahDYVvTH9w7jXbyLeiNdd8XM2w9U/t7y0Ff/9yi0GE44Za4rF2LN9d11TPA
mRGunUHBcnWEvgJBQl9nJEiU0Zsnvgc/ubhPgXRR4Xq37Z0j4r7g1SgEEzwxA57d
emyPxgcYxn/eR44/KJ4EBs+lVDR3veyJm+kXQ99b21/+jh5Xos1AnX5iItreGCc=
-----END CERTIFICATE-----
)EOF";

// MQTT Topics
const char* topic_heartrate = "sensor/heartrate";
const char* topic_spo2 = "sensor/spo2";
const char* topic_stress = "sensor/stress_laccase";
const char* topic_status = "device/esp32/status";
const char* topic_cv_data = "potentiostat/cv_data";
const char* topic_cv_raw = "potentiostat/raw_data";
const char* topic_cv_status = "potentiostat/status";
const char* topic_cv_command = "potentiostat/command";
const char* topic_cv_params = "potentiostat/params";
const char* topic_config = "device/esp32/config";

WiFiClientSecure espClient;
PubSubClient client(espClient);

unsigned long lastReconnectAttempt = 0;
const long reconnectInterval = 5000;
int reconnectAttempts = 0;
const int maxReconnectAttempts = 10;

unsigned long lastMsg = 0;
unsigned long lastDisplayUpdate = 0;
const long interval = 5000;
const long displayInterval = 500;
int msgCount = 0;
unsigned long dataPointCount = 0;

unsigned long wifiReconnects = 0;
unsigned long mqttReconnects = 0;
bool wasConnected = false;

// CV Parameters
struct CVParameters {
    float startPoint = 0.000;
    float firstVertex = 0.700;
    float secondVertex = -0.700;
    int zeroCrosses = 4;
    float scanRate = 0.050;
} cvParams;

// Display Functions
void initDisplay() {
    if(!display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) {
        Serial.println("SSD1306 not found");
        return;
    }
    
    display.clearDisplay();
    display.setTextColor(WHITE);
    display.setTextSize(2);
    display.setCursor(10, 10);
    display.println(F("BioSensor"));
    display.setTextSize(1);
    display.setCursor(15, 35);
    display.println(F("IoT v2.1"));
    display.display();
    delay(2000);
    
    Serial.println("Display initialized");
}

void updateDisplay() {
    display.clearDisplay();
    display.setTextSize(1);
    display.setCursor(0, 0);
    
    if (WiFi.status() == WL_CONNECTED) {
        display.print(F("WiFi:"));
        display.print(WiFi.RSSI());
    } else {
        display.print(F("WiFi:OFF"));
    }
    
    display.setCursor(85, 0);
    if (client.connected()) {
        display.print(F("MQTT:OK"));
    } else {
        display.print(F("MQTT:--"));
    }
    
    display.drawLine(0, 10, 128, 10, WHITE);
    
    display.setCursor(0, 13);
    display.print(F("CV: "));
    display.print(scanInProgress ? F("RUN") : F("IDLE"));
    
    display.setCursor(65, 13);
    display.print(F("Pts:"));
    display.print(dataPointCount);
    
    display.drawLine(0, 33, 128, 33, WHITE);
    
    display.setCursor(0, 36);
    display.print(F("HR:"));
    
    if (validHeartRate && heartRate > 30 && heartRate < 200) {
        display.setTextSize(2);
        display.setCursor(25, 35);
        display.print((int)displayHeartRate);
        display.setTextSize(1);
        display.setCursor(60, 42);
        display.print(F("BPM"));
    } else {
        display.setCursor(25, 38);
        display.print(F("-- BPM"));
    }
    
    display.drawLine(0, 50, 128, 50, WHITE);
    
    display.setTextSize(1);
    display.setCursor(0, 53);
    display.print(F("SpO2:"));
    
    if (validSPO2 && spo2 > 70 && spo2 <= 100) {
        display.setTextSize(2);
        display.setCursor(40, 51);
        display.print((int)displaySpO2);
        display.setTextSize(1);
        display.setCursor(70, 58);
        display.print(F("%"));
    } else {
        display.setCursor(40, 55);
        display.print(F("-- %"));
    }
    
    display.display();
}

void displayMessage(const char* title, const char* message, uint16_t duration = 2000) {
    display.clearDisplay();
    display.setTextSize(1);
    display.setCursor(10, 20);
    display.print(title);
    display.setCursor(10, 35);
    display.print(message);
    display.display();
    delay(duration);
}

// MAX30102 Functions
void initMAX30102() {
    Serial.println("Initializing MAX30102...");
    
    if (!particleSensor.begin(Wire, I2C_SPEED_FAST)) {
        Serial.println("MAX30102 not found");
        return;
    }
    
    Serial.println("MAX30102 detected");
    
    byte ledBrightness = 100;
    byte sampleAverage = 4;
    byte ledMode = 2;
    byte sampleRate = 100;
    int pulseWidth = 411;
    int adcRange = 4096;
    
    particleSensor.setup(ledBrightness, sampleAverage, ledMode, sampleRate, pulseWidth, adcRange);
    
    Serial.println("Filling initial buffer...");
    
    for (byte i = 0; i < bufferLength; i++) {
        while (particleSensor.available() == false) {
            particleSensor.check();
        }
        
        redBuffer[i] = particleSensor.getRed();
        irBuffer[i] = particleSensor.getIR();
        particleSensor.nextSample();
    }
    
    maxim_heart_rate_and_oxygen_saturation(irBuffer, bufferLength, redBuffer, &spo2, &validSPO2, &heartRate, &validHeartRate);
    
    sensorReady = true;
    displaySpO2 = spo2;
    displayHeartRate = heartRate;
    
    Serial.println("MAX30102 ready");
}

void updateMAX30102() {
    if (!sensorReady) return;
    
    for (byte i = 25; i < 100; i++) {
        redBuffer[i - 25] = redBuffer[i];
        irBuffer[i - 25] = irBuffer[i];
    }
    
    for (byte i = 75; i < 100; i++) {
        while (particleSensor.available() == false) {
            particleSensor.check();
        }
        
        redBuffer[i] = particleSensor.getRed();
        irBuffer[i] = particleSensor.getIR();
        particleSensor.nextSample();
    }
    
    maxim_heart_rate_and_oxygen_saturation(irBuffer, bufferLength, redBuffer, &spo2, &validSPO2, &heartRate, &validHeartRate);
    
    if (validHeartRate && heartRate > 30 && heartRate < 200) {
        displayHeartRate = displayHeartRate * 0.7 + heartRate * 0.3;
    }
    
    if (validSPO2 && spo2 > 70 && spo2 <= 100) {
        displaySpO2 = displaySpO2 * 0.7 + spo2 * 0.3;
    }
}

// Potentiostat Functions
int voltageToADC(float voltage) {
    return (int)(((voltage + (3.3 / 2.0)) / 3.3 * resolution) - 1);
}

void parseADCData() {
    int dato1 = ((data_rcv[0] << 6) & 0x0FC0) | data_rcv[1];
    int dato2 = ((data_rcv[2] << 6) & 0x0FC0) | data_rcv[3];
    
    if (dato1 > 2048)
        dato1 = (dato1 | 0xF000);
    voltage = -((int16_t)dato1 * 0.001);
    
    if (dato2 > 2048)
        dato2 = (dato2 | 0xF000);
    current = -((int16_t)dato2 * 0.001);
    
    current = current + 1.25;
}

void sendParameterCommand(uint8_t command, int value) {
    byte bytes[2];
    bytes[0] = value & 0xFF;
    bytes[1] = (value >> 8) & 0xFF;
    
    buff[0] = StartID;
    buff[1] = command;
    buff[2] = bytes[0] & 0x3F;
    buff[3] = ((bytes[1] << 2) & 0xFC) | ((bytes[0] >> 6) & 0x03);
    buff[4] = EndPKG;
    
    PotentiostatSerial.write(buff, 5);
    delay(10);
}

void sendSimpleCommand(uint8_t command) {
    buff[0] = StartID;
    buff[1] = command;
    buff[2] = EndPKG;
    
    PotentiostatSerial.write(buff, 3);
}

void sendAllCVParameters() {
    Serial.println("Sending CV parameters...");
    
    PotentiostatSerial.write(SendAllCV);
    delay(20);
    
    sendParameterCommand(SetStartPoint, voltageToADC(cvParams.startPoint));
    sendParameterCommand(SetFirstVertex, voltageToADC(cvParams.firstVertex));
    sendParameterCommand(SetSecondVertex, voltageToADC(cvParams.secondVertex));
    sendParameterCommand(SetZeroCross, cvParams.zeroCrosses);
    sendParameterCommand(SetSpeed, (int)round(cvParams.scanRate / 0.0008));
    
    Serial.println("Parameters sent");
    publishPotentiostatStatus();
}

void readPotentiostatData() {
    while (PotentiostatSerial.available()) {
        uint8_t c = PotentiostatSerial.read();
        
        switch (parserState) {
            case WAITING_START:
                if (c == StartID) {
                    parserState = READING_DATA;
                    dataIndex = 0;
                } else if (c == ACK) {
                    if (PotentiostatSerial.available()) {
                        uint8_t next = PotentiostatSerial.read();
                        if (next == ENDRUN) {
                            Serial.println("Scan completed");
                            scanInProgress = false;
                            publishPotentiostatStatus();
                        }
                    }
                }
                break;
                
            case READING_DATA:
                data_rcv[dataIndex++] = c;
                if (dataIndex >= 4) {
                    parseADCData();
                    publishCVData();
                    parserState = WAITING_START;
                    dataIndex = 0;
                    dataPointCount++;
                }
                break;
        }
    }
}

void publishCVData() {
    if (!client.connected()) return;
    
    StaticJsonDocument<300> doc;
    doc["voltage"] = round(voltage * 1000.0) / 1000.0;
    doc["current"] = current;
    doc["timestamp"] = millis();
    doc["point"] = dataPointCount;
    doc["device_id"] = mqtt_client_id;
    
    char output[350];
    serializeJson(doc, output);
    
    client.publish(topic_cv_data, output, false);
    client.publish(topic_cv_raw, output, false);
}

void publishPotentiostatStatus() {
    if (!client.connected()) return;
    
    StaticJsonDocument<300> doc;
    doc["scan_active"] = scanInProgress;
    doc["data_points"] = dataPointCount;
    doc["params"]["sp"] = cvParams.startPoint;
    doc["params"]["fv"] = cvParams.firstVertex;
    doc["params"]["sv"] = cvParams.secondVertex;
    doc["params"]["zc"] = cvParams.zeroCrosses;
    doc["params"]["sr"] = cvParams.scanRate;
    
    char output[350];
    serializeJson(doc, output);
    client.publish(topic_cv_status, output, true);
}

// MQTT Callback
void callback(char* topic, byte* payload, unsigned int length) {
    String message = "";
    for (unsigned int i = 0; i < length; i++) {
        message += (char)payload[i];
    }
    
    Serial.print("MQTT [");
    Serial.print(topic);
    Serial.print("]: ");
    Serial.println(message);

    if (String(topic) == topic_cv_command) {
        handlePotentiostatCommand(message);
    }
    
    if (String(topic) == topic_cv_params) {
        handlePotentiostatParams(message);
    }

    if (String(topic) == topic_config) {
        handleDeviceConfig(message);
    }
}

void handlePotentiostatCommand(String command) {
    command.trim();
    
    if (command == "START") {
        Serial.println("Starting scan...");
        sendSimpleCommand(StartMeasurement);
        scanInProgress = true;
        dataPointCount = 0;
        publishPotentiostatStatus();
        
    } else if (command == "STOP") {
        Serial.println("Stopping scan...");
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
    StaticJsonDocument<300> doc;
    DeserializationError error = deserializeJson(doc, jsonParams);
    
    if (error) {
        Serial.print("JSON error: ");
        Serial.println(error.c_str());
        return;
    }
    
    if (doc.containsKey("startPoint")) cvParams.startPoint = doc["startPoint"];
    if (doc.containsKey("firstVertex")) cvParams.firstVertex = doc["firstVertex"];
    if (doc.containsKey("secondVertex")) cvParams.secondVertex = doc["secondVertex"];
    if (doc.containsKey("zeroCrosses")) cvParams.zeroCrosses = doc["zeroCrosses"];
    if (doc.containsKey("scanRate")) cvParams.scanRate = doc["scanRate"];
    
    Serial.println("Parameters updated");
    sendAllCVParameters();
}

void handleDeviceConfig(String jsonConfig) {
    StaticJsonDocument<300> doc;
    DeserializationError error = deserializeJson(doc, jsonConfig);
    
    if (error) {
        Serial.print("JSON config error: ");
        Serial.println(error.c_str());
        return;
    }
    
    Serial.println("Remote config received");
    
    StaticJsonDocument<128> ackDoc;
    ackDoc["status"] = "config_received";
    ackDoc["device_id"] = mqtt_client_id;
    
    char ackMsg[150];
    serializeJson(ackDoc, ackMsg);
    client.publish(topic_status, ackMsg);
}

// WiFi and MQTT
void setup_wifi() {
    Serial.println("Connecting to WiFi...");
    Serial.print("SSID: ");
    Serial.println(ssid);
    
    WiFi.mode(WIFI_STA);
    WiFi.begin(ssid, password);
    
    int attempts = 0;
    while (WiFi.status() != WL_CONNECTED && attempts < 30) {
        delay(500);
        Serial.print(".");
        attempts++;
    }
    
    Serial.println();
    
    if (WiFi.status() == WL_CONNECTED) {
        Serial.println("WiFi connected");
        Serial.print("IP: ");
        Serial.println(WiFi.localIP());
        Serial.print("RSSI: ");
        Serial.print(WiFi.RSSI());
        Serial.println(" dBm");
        wifiReconnects++;
    } else {
        Serial.println("WiFi failed - Check credentials");
        Serial.println("Continuing without WiFi...");
        Serial.print("Expected SSID: ");
        Serial.println(ssid);
    }
}

void reconnect() {
    unsigned long now = millis();
    
    if (now - lastReconnectAttempt < reconnectInterval) {
        return;
    }
    lastReconnectAttempt = now;
    
    if (reconnectAttempts >= maxReconnectAttempts) {
        Serial.println("Too many failed attempts, restarting WiFi...");
        WiFi.disconnect();
        delay(1000);
        setup_wifi();
        reconnectAttempts = 0;
        return;
    }
    
    if (!client.connected()) {
        Serial.println("\n=== MQTT Connection Attempt ===");
        Serial.print("Broker: ");
        Serial.println(mqtt_server);
        Serial.print("Port: ");
        Serial.println(mqtt_port);
        Serial.print("User: ");
        Serial.println(mqtt_user);
        Serial.print("WiFi Status: ");
        Serial.println(WiFi.status());
        Serial.print("WiFi RSSI: ");
        Serial.println(WiFi.RSSI());
        Serial.print("Free Heap: ");
        Serial.println(ESP.getFreeHeap());
        
        // Test DNS resolution
        Serial.print("Resolving DNS... ");
        IPAddress serverIP;
        if (WiFi.hostByName(mqtt_server, serverIP)) {
            Serial.print("OK - IP: ");
            Serial.println(serverIP);
        } else {
            Serial.println("FAILED!");
            reconnectAttempts++;
            return;
        }
        
        // Test TCP connection
        Serial.print("Testing TCP connection... ");
        WiFiClient testClient;
        if (testClient.connect(mqtt_server, mqtt_port)) {
            Serial.println("OK");
            testClient.stop();
        } else {
            Serial.println("FAILED!");
            reconnectAttempts++;
            return;
        }
        
        String clientId = String(mqtt_client_id) + "-" + String(random(0xffff), HEX);
        Serial.print("Client ID: ");
        Serial.println(clientId);
        
        Serial.println("Attempting MQTT connect...");
        
        if (client.connect(clientId.c_str(), mqtt_user, mqtt_password)) {
            Serial.println("✓ MQTT CONNECTED!");
            
            reconnectAttempts = 0;
            mqttReconnects++;
            wasConnected = true;
            
            StaticJsonDocument<256> statusDoc;
            statusDoc["device"] = mqtt_client_id;
            statusDoc["ip"] = WiFi.localIP().toString();
            statusDoc["status"] = "online";
            statusDoc["uptime"] = millis() / 1000;
            
            char statusMsg[256];
            serializeJson(statusDoc, statusMsg);
            client.publish(topic_status, statusMsg, true);
            
            client.subscribe(topic_cv_command);
            client.subscribe(topic_cv_params);
            client.subscribe(topic_config);
            
            Serial.println("Subscribed to topics");
            publishPotentiostatStatus();
            
        } else {
            reconnectAttempts++;
            Serial.print("✗ MQTT FAILED, rc=");
            Serial.print(client.state());
            
            switch(client.state()) {
                case -4: Serial.println(" - Connection timeout"); break;
                case -3: Serial.println(" - Connection lost"); break;
                case -2: Serial.println(" - Connect failed"); break;
                case -1: Serial.println(" - Disconnected"); break;
                case  1: Serial.println(" - Bad protocol"); break;
                case  2: Serial.println(" - Bad client ID"); break;
                case  3: Serial.println(" - Unavailable"); break;
                case  4: Serial.println(" - Bad credentials"); break;
                case  5: Serial.println(" - Unauthorized"); break;
                default: Serial.println(" - Unknown error"); break;
            }
        }
        Serial.println("===============================\n");
    }
}

void publishSensorData() {
    if (!client.connected()) return;
    
    StaticJsonDocument<256> hrDoc;
    hrDoc["bpm"] = (int)displayHeartRate;
    hrDoc["avg_bpm"] = (int)displayHeartRate;
    hrDoc["valid"] = validHeartRate;
    hrDoc["timestamp"] = millis();
    hrDoc["device_id"] = mqtt_client_id;
    
    char hrMsg[256];
    serializeJson(hrDoc, hrMsg);
    client.publish(topic_heartrate, hrMsg, false);
    
    StaticJsonDocument<256> spo2Doc;
    spo2Doc["spo2"] = (int)displaySpO2;
    spo2Doc["avg_spo2"] = (int)displaySpO2;
    spo2Doc["valid"] = validSPO2;
    spo2Doc["timestamp"] = millis();
    spo2Doc["device_id"] = mqtt_client_id;
    
    char spo2Msg[256];
    serializeJson(spo2Doc, spo2Msg);
    client.publish(topic_spo2, spo2Msg, false);
    
    float stressValue = 0.0;
    if (validHeartRate && validSPO2) {
        stressValue = ((displayHeartRate - 60) / 40.0) * 0.5;
        stressValue += ((100 - displaySpO2) / 10.0) * 0.5;
        stressValue = constrain(stressValue, 0.0, 1.0);
    }
    
    StaticJsonDocument<150> stressDoc;
    stressDoc["stress_laccase"] = stressValue;
    stressDoc["timestamp"] = millis();
    stressDoc["device_id"] = mqtt_client_id;
    
    char stressMsg[150];
    serializeJson(stressDoc, stressMsg);
    client.publish(topic_stress, stressMsg, false);
    
    msgCount++;
}

void publishDeviceStatus() {
    if (!client.connected()) return;
    
    StaticJsonDocument<512> doc;
    doc["device_id"] = mqtt_client_id;
    doc["ip_address"] = WiFi.localIP().toString();
    doc["wifi_rssi"] = WiFi.RSSI();
    doc["uptime_seconds"] = millis() / 1000;
    doc["free_heap"] = ESP.getFreeHeap();
    doc["mqtt_connected"] = client.connected();
    
    JsonObject cv = doc.createNestedObject("potentiostat");
    cv["scan_active"] = scanInProgress;
    cv["data_points"] = dataPointCount;
    cv["voltage"] = voltage;
    cv["current"] = current;
    
    JsonObject bio = doc.createNestedObject("biosensors");
    bio["heart_rate"] = (int)displayHeartRate;
    bio["hr_valid"] = validHeartRate;
    bio["spo2"] = (int)displaySpO2;
    bio["spo2_valid"] = validSPO2;
    
    char output[512];
    serializeJson(doc, output);
    client.publish(topic_status, output, true);
}

// Setup
void setup() {
    Serial.begin(115200);
    delay(1000);
    
    Serial.println("\nESP32 BioSensor + Potentiostat IoT v2.1");
    
    Wire.begin(I2C_SDA, I2C_SCL);
    
    initDisplay();
    
    PotentiostatSerial.begin(POTENTIOSTAT_BAUD, SERIAL_8N1, POTENTIOSTAT_RX, POTENTIOSTAT_TX);
    Serial.println("UART initialized");
    
    setup_wifi();
    
    client.setServer(mqtt_server, mqtt_port);
    client.setCallback(callback);
    client.setBufferSize(2048);
    client.setKeepAlive(60);
    client.setSocketTimeout(30);
    
    Serial.println("Attempting initial MQTT connection...");
    String clientId = String(mqtt_client_id) + "-" + String(random(0xffff), HEX);
    if (client.connect(clientId.c_str(), mqtt_user, mqtt_password)) {
        Serial.println("MQTT connected in setup");
        client.subscribe(topic_cv_command);
        client.subscribe(topic_cv_params);
        client.subscribe(topic_config);
    } else {
        Serial.println("MQTT not connected, will retry in loop");
    }
    
    initMAX30102();
    
    Serial.println("System ready");
}

// Main Loop
void loop() {
    if (WiFi.status() != WL_CONNECTED) {
        Serial.println("WiFi disconnected, reconnecting...");
        setup_wifi();
    }
    
    if (!client.connected()) {
        reconnect();
    } else {
        client.loop();
        
        if (wasConnected && reconnectAttempts > 0) {
            reconnectAttempts = 0;
        }
    }
    
    unsigned long now = millis();
    
    updateMAX30102();
    
    if (now - lastMsg > interval) {
        lastMsg = now;
        publishSensorData();
        
        if (msgCount % 10 == 0) {
            publishDeviceStatus();
        }
    }
    
    if (now - lastDisplayUpdate > displayInterval) {
        lastDisplayUpdate = now;
        updateDisplay();
    }
    
    readPotentiostatData();
    
    delay(10);
}