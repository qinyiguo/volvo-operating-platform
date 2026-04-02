# 部署與本地開發

## 環境變數

```env
POSTGRES_CONNECTION_STRING=postgresql://user:password@host:5432/volvo_dms
PORT=8080
```

## Zeabur 部署流程

1. 推送到 GitHub `main` branch → Zeabur 自動觸發部署
2. 部署完成後，如有資料表結構異動，需重新上傳 Excel
3. 不需手動執行 SQL，`initDatabase()` 在每次啟動時自動處理建表與欄位補充

> 注意：資料表結構異動使用 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`，不會影響現有資料

## Dockerfile

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080
CMD ["node", "index.js"]
```

## 本地開發

### 需求

- Node.js 20+
- PostgreSQL 14+

### 啟動步驟

```bash
# 1. 安裝相依套件
npm install

# 2. 建立環境變數檔
cp .env.example .env
# 編輯 .env，填入資料庫連線字串

# 3. 啟動（會自動建表）
npm start
```
