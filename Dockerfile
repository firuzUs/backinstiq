FROM node:20-slim

RUN apt-get update && apt-get install -y \
    ffmpeg \
    fonts-dejavu-core \
    fonts-dejavu-extra \
    fontconfig \
    && fc-cache -fv \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 3000
CMD ["node", "index.js"]
