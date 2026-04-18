FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY index.js ./

# 持久化数据目录 (tokens.json + history.json)
ENV DATA_DIR=/data
VOLUME ["/data"]

CMD ["node", "index.js"]
