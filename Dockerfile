FROM node:20-slim

WORKDIR /app

# 安装系统依赖 + 正版 Google Chrome
# Google Chrome 自带所有需要的共享库，比手动安装 Chromium 依赖更可靠
# 正版 Chrome 不会被 Google 标记为"不安全浏览器"
RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    fonts-noto-cjk \
    && wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google-linux-signing-key.gpg \
    && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-linux-signing-key.gpg] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update \
    && apt-get install -y google-chrome-stable \
    && rm -rf /var/lib/apt/lists/*

# 复制依赖文件
COPY package.json package-lock.json ./

# 安装依赖（不再需要 playwright install，因为直接使用系统 Chrome）
RUN npm ci --omit=dev && \
    npm install typescript@5

# Playwright 需要知道 Chrome 的位置（环境变量回退方案）
ENV CHROME_PATH=/usr/bin/google-chrome-stable

# 复制源码和配置
COPY tsconfig.json ./
COPY src/ ./src/
COPY public/ ./public/
COPY scripts/ ./scripts/

# 构建
RUN npx tsc

# 创建数据目录
RUN mkdir -p /app/data

# 暴露端口
EXPOSE 3000

# 启动
CMD ["node", "dist/src/index.js"]
