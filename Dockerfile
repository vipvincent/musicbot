# 使用官方 Node.js LTS Alpine 版本
FROM node:lts-alpine

# 設定工作目錄
WORKDIR /app

# 複製 package 檔案
COPY package*.json ./

# 安裝正式環境所需的套件
# 使用 --omit=dev 可以確保不下載開發用的測試工具
RUN npm install --omit=dev

# 複製其餘程式碼
COPY . .

# 啟動應用程式
CMD ["node", "index.js"]