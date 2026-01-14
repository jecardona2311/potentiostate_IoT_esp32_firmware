# Imagen base oficial de Node.js
FROM node:18-alpine

# Crear directorio de la app
WORKDIR /app

# Copiar únicamente los archivos de dependencias
COPY package*.json ./

# Instalar dependencias
RUN npm install --production

# Copiar el resto del código
COPY . .

# Exponer el puerto de la API
EXPOSE 3000

# Comando por defecto
CMD ["npm", "start"]
