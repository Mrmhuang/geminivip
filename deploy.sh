#!/bin/bash
# GeminiVip 一键部署脚本
# 用法: ./deploy.sh

set -e

# ========== 配置 ==========
SERVER_IP="43.162.118.171"
SERVER_USER="root"
PROJECT_NAME="geminiVip"
CONTAINER_NAME="gemini-vip"
REMOTE_DIR="/root/${PROJECT_NAME}"
LOCAL_DIR="$(cd "$(dirname "$0")" && pwd)"
PORT=3000

# 颜色输出
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

info() { echo -e "${GREEN}[INFO]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# ========== 步骤 1: 上传项目文件 ==========
info "正在上传项目文件到服务器..."

# 使用 rsync 同步文件（排除不需要的目录和服务器环境变量文件）
rsync -avz --delete \
  --exclude 'node_modules' \
  --exclude 'dist' \
  --exclude 'data' \
  --exclude '.env' \
  --exclude '.env.production' \
  --exclude '.git' \
  --exclude '.codebuddy' \
  "${LOCAL_DIR}/" "${SERVER_USER}@${SERVER_IP}:${REMOTE_DIR}/"

info "文件上传完成！"

# ========== 步骤 2: 远程构建并部署 ==========
info "正在服务器上构建 Docker 镜像并重启容器..."

ssh "${SERVER_USER}@${SERVER_IP}" bash -s <<'REMOTE_SCRIPT'
set -e

PROJECT_DIR="/root/geminiVip"
CONTAINER_NAME="gemini-vip"
IMAGE_NAME="gemini-vip"
DATA_DIR="/root/geminiVip_data"

echo "[1/4] 进入项目目录..."
cd "$PROJECT_DIR"

echo "[2/4] 构建 Docker 镜像..."
docker build -t "$IMAGE_NAME" .

echo "[3/4] 停止并移除旧容器..."
docker stop "$CONTAINER_NAME" 2>/dev/null || true
docker rm "$CONTAINER_NAME" 2>/dev/null || true

echo "[4/4] 启动新容器..."
docker run -d \
  --name "$CONTAINER_NAME" \
  --restart unless-stopped \
  --shm-size=1g \
  -p 3000:3000 \
  -v "$DATA_DIR":/app/data \
  --env-file "$PROJECT_DIR/.env.production" \
  "$IMAGE_NAME"

echo ""
echo "=== 容器状态 ==="
docker ps --filter "name=$CONTAINER_NAME" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
echo ""
echo "=== 最近日志 ==="
sleep 2
docker logs "$CONTAINER_NAME" --tail 5
REMOTE_SCRIPT

# ========== 步骤 3: 验证 ==========
info "正在验证服务..."
sleep 3

HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' "http://${SERVER_IP}:${PORT}" 2>/dev/null || echo "000")

if [ "$HTTP_CODE" = "200" ]; then
  info "✅ 部署成功！服务已正常运行"
  echo ""
  echo "  🌐 访问地址: http://${SERVER_IP}:${PORT}"
  echo "  🔧 管理后台: http://${SERVER_IP}:${PORT}/admin"
  echo ""
else
  warn "服务返回 HTTP ${HTTP_CODE}，请检查日志: ssh ${SERVER_USER}@${SERVER_IP} 'docker logs ${CONTAINER_NAME}'"
fi
