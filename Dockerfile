FROM node:20-slim

WORKDIR /app

# 安装 Playwright 系统依赖
RUN apt-get update && apt-get install -y \
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libpango-1.0-0 \
    libcairo2 \
    libasound2 \
    libatspi2.0-0 \
    libwayland-client0 \
    fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*

# 复制依赖文件
COPY package.json package-lock.json ./

# 安装依赖
RUN npm ci --omit=dev && \
    npm install typescript@5

# 安装 Playwright Chromium 浏览器
RUN npx playwright install chromium

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
