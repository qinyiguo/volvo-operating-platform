FROM node:20-alpine

# 安全：以非 root 使用者執行（node:20-alpine 內建 'node' 帳號 UID 1000）
WORKDIR /app
COPY --chown=node:node package*.json ./
# 用 npm ci 鎖定 lockfile 解析的版本，建構可重現
RUN npm ci --omit=dev && npm cache clean --force
COPY --chown=node:node . .

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

USER node
CMD ["node", "index.js"]
