Como construir el contendor de docker

# 1. Desde la raíz del proyecto
cd potentiostat-iot

# 2. Configurar .env con tus credenciales de HiveMQ Cloud
cp .env.example .env
nano .env

# 3. Construir las imágenes
docker-compose build

# 4. Iniciar los servicios
docker-compose up -d

# 5. Ver logs en tiempo real
make logs

# 6. Verificar que todo funciona
make health

# 7. Ejecutar tests automatizados
chmod +x test-system.sh
./test-system.sh