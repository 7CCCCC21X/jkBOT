FROM node:20-slim

WORKDIR /app

# better-sqlite3 提供 glibc/x64 与 arm64 预编译二进制, slim 镜像直接下载, 无需 gcc
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY index.js ./

# 持久化数据目录 (SQLite 数据库文件 bot.db + WAL 日志)
ENV DATA_DIR=/data \
    SQLITE_PATH=/data/bot.db
VOLUME ["/data"]

CMD ["node", "index.js"]
