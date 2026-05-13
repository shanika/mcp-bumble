FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY dist/ ./dist/

ENV DB_PATH=/data/bumble.db

ENTRYPOINT ["node", "dist/index.js"]
