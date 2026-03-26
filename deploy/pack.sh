#!/bin/bash
# ============================================
# OvO System 打包脚本
# 在 Mac 上运行，生成可部署到 Windows 的压缩包
# ============================================

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PACK_NAME="OvO-System-v1.0"
OUTPUT_DIR="$PROJECT_DIR/dist"
PACK_DIR="$OUTPUT_DIR/$PACK_NAME"

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║    OvO System 部署包打包工具                ║"
echo "╚══════════════════════════════════════════════╝"
echo ""

# 清理旧的打包
rm -rf "$PACK_DIR"
mkdir -p "$PACK_DIR"

echo "[1/4] 复制项目文件..."

# 复制核心文件（排除不需要的）
rsync -a --exclude='node_modules' \
         --exclude='.git' \
         --exclude='dist' \
         --exclude='data/*.db' \
         --exclude='data/*.db-*' \
         --exclude='backups' \
         --exclude='.claude' \
         --exclude='.env' \
         --exclude='*.log' \
         --exclude='.DS_Store' \
         "$PROJECT_DIR/" "$PACK_DIR/"

echo "[√] 文件复制完成"

echo ""
echo "[2/4] 创建生产 .env 模板..."
cat > "$PACK_DIR/.env.example" << 'EOF'
# OvO System 配置文件
# 首次部署请将此文件复制为 .env

# 服务端口（默认 3000）
PORT=3000

# Session 密钥（请修改为随机字符串）
SESSION_SECRET=请修改为一个随机字符串-越长越好

# 运行环境
NODE_ENV=production
EOF
echo "[√] .env 模板已创建"

echo ""
echo "[3/4] 创建空 data 目录..."
mkdir -p "$PACK_DIR/data"
touch "$PACK_DIR/data/.gitkeep"
echo "[√] data 目录已创建"

echo ""
echo "[4/4] 打包为 ZIP..."
cd "$OUTPUT_DIR"
zip -r "$PACK_NAME.zip" "$PACK_NAME" -x "*.DS_Store"
echo "[√] 打包完成"

# 显示结果
echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║  打包完成！                                  ║"
echo "╠══════════════════════════════════════════════╣"
echo "║                                              ║"
echo "  输出文件: $OUTPUT_DIR/$PACK_NAME.zip"
FILESIZE=$(du -sh "$OUTPUT_DIR/$PACK_NAME.zip" | cut -f1)
echo "  文件大小: $FILESIZE"
echo "║                                              ║"
echo "║  部署步骤:                                   ║"
echo "║  1. 复制 ZIP 到目标 Windows 电脑             ║"
echo "║  2. 解压到任意目录（如 C:\OvO System）      ║"
echo "║  3. 安装 Node.js (nodejs.org)                ║"
echo "║  4. 右键管理员运行 deploy\install.bat        ║"
echo "║                                              ║"
echo "╚══════════════════════════════════════════════╝"
echo ""

# 清理临时目录
rm -rf "$PACK_DIR"
