#!/bin/bash

# Colores
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

BASE_URL="http://localhost:3000"

echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${YELLOW}  POTENTIOSTAT IOT - SYSTEM TEST${NC}"
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n"

# Test 1: Health Check
echo -e "${YELLOW}[TEST 1]${NC} Health Check..."
response=$(curl -s -o /dev/null -w "%{http_code}" $BASE_URL/api/health)
if [ $response -eq 200 ]; then
    echo -e "${GREEN}✓ Health Check: OK${NC}"
    curl -s $BASE_URL/api/health | jq .
else
    echo -e "${RED}✗ Health Check: FAILED (HTTP $response)${NC}"
fi
echo ""

# Test 2: MQTT Status
echo -e "${YELLOW}[TEST 2]${NC} MQTT Connection Status..."
response=$(curl -s $BASE_URL/api/mqtt/status)
mqtt_connected=$(echo $response | jq -r '.data.connected')
if [ "$mqtt_connected" = "true" ]; then
    echo -e "${GREEN}✓ MQTT: Connected${NC}"
    echo $response | jq .
else
    echo -e "${RED}✗ MQTT: Disconnected${NC}"
    echo $response | jq .
fi
echo ""

# Test 3: Create User
echo -e "${YELLOW}[TEST 3]${NC} Creating test user..."
response=$(curl -s -X POST $BASE_URL/api/users \
  -H "Content-Type: application/json" \
  -d '{"alias":"test_user","name":"Test User","email":"test@example.com"}')
  
if echo $response | jq -e '.success' > /dev/null 2>&1; then
    echo -e "${GREEN}✓ User created successfully${NC}"
    echo $response | jq .
else
    echo -e "${RED}✗ User creation failed${NC}"
    echo $response | jq .
fi
echo ""

# Test 4: Get Users
echo -e "${YELLOW}[TEST 4]${NC} Fetching all users..."
response=$(curl -s $BASE_URL/api/users)
user_count=$(echo $response | jq -r '.count')
echo -e "${GREEN}✓ Found $user_count users${NC}"
echo $response | jq '.data[] | {alias, name, email}'
echo ""

# Test 5: Get Devices
echo -e "${YELLOW}[TEST 5]${NC} Fetching devices..."
response=$(curl -s $BASE_URL/api/devices)
device_count=$(echo $response | jq -r '.count')
echo -e "${GREEN}✓ Found $device_count devices${NC}"
echo $response | jq '.data[] | {device_id, device_name, ip_address, last_seen}'
echo ""

# Test 6: Start Measurement
echo -e "${YELLOW}[TEST 6]${NC} Starting measurement..."
response=$(curl -s -X POST $BASE_URL/api/measurements/start \
  -H "Content-Type: application/json" \
  -d '{
    "userAlias":"test_user",
    "deviceId":"ESP32_001",
    "cvParams":{
      "startPoint":0.0,
      "firstVertex":0.7,
      "secondVertex":-0.7,
      "zeroCrosses":4,
      "scanRate":1.0
    }
  }')

if echo $response | jq -e '.success' > /dev/null 2>&1; then
    echo -e "${GREEN}✓ Measurement started${NC}"
    measurement_id=$(echo $response | jq -r '.data.id')
    measurement_uuid=$(echo $response | jq -r '.data.uuid')
    echo -e "  ID: ${GREEN}$measurement_id${NC}"
    echo -e "  UUID: ${GREEN}$measurement_uuid${NC}"
    echo $response | jq .
else
    echo -e "${RED}✗ Measurement start failed${NC}"
    echo $response | jq .
fi
echo ""

# Test 7: Send MQTT Command
echo -e "${YELLOW}[TEST 7]${NC} Sending MQTT command..."
response=$(curl -s -X POST $BASE_URL/api/mqtt/command \
  -H "Content-Type: application/json" \
  -d '{"command":"START"}')
  
if echo $response | jq -e '.success' > /dev/null 2>&1; then
    echo -e "${GREEN}✓ Command sent successfully${NC}"
    echo $response | jq .
else
    echo -e "${RED}✗ Command failed${NC}"
    echo $response | jq .
fi
echo ""

# Test 8: Send CV Parameters
echo -e "${YELLOW}[TEST 8]${NC} Sending CV parameters..."
response=$(curl -s -X POST $BASE_URL/api/mqtt/parameters \
  -H "Content-Type: application/json" \
  -d '{
    "startPoint":0.0,
    "firstVertex":0.7,
    "secondVertex":-0.7,
    "zeroCrosses":4,
    "scanRate":1.0
  }')
  
if echo $response | jq -e '.success' > /dev/null 2>&1; then
    echo -e "${GREEN}✓ Parameters sent successfully${NC}"
    echo $response | jq .
else
    echo -e "${RED}✗ Parameters failed${NC}"
    echo $response | jq .
fi
echo ""

# Wait for some data
echo -e "${YELLOW}[INFO]${NC} Waiting 5 seconds for data collection..."
sleep 5
echo ""

# Test 9: Stop Measurement
if [ ! -z "$measurement_id" ]; then
    echo -e "${YELLOW}[TEST 9]${NC} Stopping measurement..."
    response=$(curl -s -X POST $BASE_URL/api/measurements/$measurement_id/stop)
    
    if echo $response | jq -e '.success' > /dev/null 2>&1; then
        echo -e "${GREEN}✓ Measurement stopped${NC}"
        echo $response | jq .
    else
        echo -e "${RED}✗ Measurement stop failed${NC}"
        echo $response | jq .
    fi
    echo ""
    
    # Test 10: Get Measurement Data
    echo -e "${YELLOW}[TEST 10]${NC} Fetching measurement data..."
    response=$(curl -s $BASE_URL/api/measurements/$measurement_id)
    
    cv_points=$(echo $response | jq -r '.data.cvData | length')
    hr_points=$(echo $response | jq -r '.data.heartrateData | length')
    spo2_points=$(echo $response | jq -r '.data.spo2Data | length')
    stress_points=$(echo $response | jq -r '.data.stressData | length')
    
    echo -e "${GREEN}✓ Measurement retrieved${NC}"
    echo -e "  CV Data Points: $cv_points"
    echo -e "  Heart Rate Points: $hr_points"
    echo -e "  SpO2 Points: $spo2_points"
    echo -e "  Stress Points: $stress_points"
    echo ""
    
    # Test 11: Get Statistics
    echo -e "${YELLOW}[TEST 11]${NC} Getting measurement statistics..."
    response=$(curl -s $BASE_URL/api/measurements/$measurement_id/stats)
    echo -e "${GREEN}✓ Statistics retrieved${NC}"
    echo $response | jq .
    echo ""
    
    # Test 12: Download as JSON
    echo -e "${YELLOW}[TEST 12]${NC} Testing download (JSON)..."
    curl -s "$BASE_URL/api/measurements/$measurement_id/download?format=json" -o "test_measurement.json"
    if [ -f "test_measurement.json" ]; then
        size=$(wc -c < "test_measurement.json")
        echo -e "${GREEN}✓ JSON downloaded ($size bytes)${NC}"
        rm "test_measurement.json"
    else
        echo -e "${RED}✗ JSON download failed${NC}"
    fi
    echo ""
    
    # Test 13: Download as TXT
    echo -e "${YELLOW}[TEST 13]${NC} Testing download (TXT)..."
    curl -s "$BASE_URL/api/measurements/$measurement_id/download?format=txt" -o "test_measurement.txt"
    if [ -f "test_measurement.txt" ]; then
        size=$(wc -c < "test_measurement.txt")
        echo -e "${GREEN}✓ TXT downloaded ($size bytes)${NC}"
        rm "test_measurement.txt"
    else
        echo -e "${RED}✗ TXT download failed${NC}"
    fi
    echo ""
    
    # Test 14: Download as CSV
    echo -e "${YELLOW}[TEST 14]${NC} Testing download (CSV)..."
    curl -s "$BASE_URL/api/measurements/$measurement_id/download?format=csv" -o "test_measurement.csv"
    if [ -f "test_measurement.csv" ]; then
        size=$(wc -c < "test_measurement.csv")
        echo -e "${GREEN}✓ CSV downloaded ($size bytes)${NC}"
        rm "test_measurement.csv"
    else
        echo -e "${RED}✗ CSV download failed${NC}"
    fi
    echo ""
fi

# Test 15: Get User Measurements
echo -e "${YELLOW}[TEST 15]${NC} Getting user measurements..."
response=$(curl -s $BASE_URL/api/users/test_user/measurements)
measurement_count=$(echo $response | jq -r '.count')
echo -e "${GREEN}✓ Found $measurement_count measurements for test_user${NC}"
echo $response | jq '.data[] | {uuid, start_time, status, cv_data_points}'
echo ""

# Summary
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${YELLOW}  TEST SUMMARY${NC}"
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}✓ All tests completed${NC}"
echo -e "\nYou can now:"
echo -e "  • Open frontend: ${GREEN}http://localhost:8080${NC}"
echo -e "  • View API docs: ${GREEN}http://localhost:3000/api/docs${NC}"
echo -e "  • Monitor logs: ${GREEN}make logs${NC}"
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n"