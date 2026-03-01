FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY config ./config

RUN mkdir -p /app/data

ENV CONFIG_PATH=/app/config/config.json

CMD ["npm", "start"]
