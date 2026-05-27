# GeminiVip 项目架构文档

## 概述

自动化 Google AI Pro 一年会员认证 + 绑卡服务。用户在网页填写 Google 账号信息和卡密，后端通过 Telegram Bot 自动完成 Pixel 设备认证流程，认证成功后自动使用 Playwright 浏览器完成 Google One AI Premium 绑卡激活。

## 技术栈

- **后端**: Express + TypeScript
- **数据库**: SQLite (better-sqlite3)
- **Telegram 自动化**: Telegram MTProto (gramjs)
- **浏览器自动化**: Playwright (Chromium)
- **前端**: 静态 HTML + CSS + React/Ant Design (CDN)
- **运行**: tsx (开发) / tsc + node (生产)

## 目录结构

```
geminiVip/
├── public/                  # 静态前端文件
│   ├── index.html           # 认证提交页（React + Ant Design 表单）
│   ├── guide.html           # 准备工作教程页（含 TOC 目录）
│   ├── admin.html           # 管理后台页（工具 + 用户数据表）
│   ├── style.css            # 全局样式
│   └── *.png                # 教程截图
├── src/                     # 后端源码
│   ├── index.ts             # 入口：Express 启动 + Telegram/Browser 初始化
│   ├── config.ts            # 环境变量读取与校验
│   ├── routes.ts            # API 路由定义（含 Admin 接口）
│   ├── taskQueue.ts         # 内存任务队列（FIFO + 防重复提交）
│   ├── database.ts          # SQLite 数据层（卡密、日志、状态更新）
│   ├── cardKey.ts           # 卡密生成（generateKey）与 HMAC 验签（validateKey）
│   ├── telegramWorker.ts    # Telegram 自动化交互逻辑
│   ├── browserWorker.ts     # Playwright 浏览器自动绑卡逻辑
│   └── types.d.ts           # 类型定义
├── scripts/                 # 运维脚本
│   ├── generateKeys.ts      # 批量生成卡密（命令行）
│   └── setupSession.ts      # 初始化 Telegram session（交互式登录）
├── data/                    # 运行时数据（gitignore）
│   └── keys.db              # SQLite 数据库
├── .env                     # 环境变量（不入库）
├── Dockerfile               # Docker 部署
├── deploy.sh                # 部署脚本
├── package.json
└── tsconfig.json
```

## 环境变量 (.env)

| 变量 | 必填 | 说明 |
|------|------|------|
| `CARD_SECRET` | 是 | 卡密 HMAC 签名密钥，自定义长字符串 |
| `ADMIN_PASSWORD` | 否 | 管理后台密码，默认 `admin` |
| `TELEGRAM_API_ID` | 是 | Telegram API ID (my.telegram.org) |
| `TELEGRAM_API_HASH` | 是 | Telegram API Hash |
| `TELEGRAM_SESSION` | 是 | Telegram StringSession（运行 setup-session 或管理后台热更新） |
| `PORT` | 否 | 服务端口，默认 `3000` |
| `BROWSER_HEADLESS` | 否 | 浏览器是否无头，默认 `true`，设为 `false` 可调试 |
| `GOOGLE_OFFER_URL` | 否 | Google One Offer 链接（Telegram 返回后会覆盖） |
| `CARD_NUMBER` | 是 | 绑卡信用卡号 |
| `CARD_EXPIRY` | 是 | 信用卡有效期（MM/YY 格式） |
| `CARD_CVV` | 是 | 信用卡 CVV |
| `CARD_NAME` | 是 | 信用卡持卡人姓名 |
| `CARD_ZIP` | 否 | 账单邮编 |

## 脚本命令

| 命令 | 说明 |
|------|------|
| `npm run dev` | 开发模式启动（tsx 热重载） |
| `npm run dev:local` | 开发模式 + 浏览器可视化（BROWSER_HEADLESS=false） |
| `npm run build` | TypeScript 编译到 dist/ |
| `npm run start` | 生产模式启动（node dist/） |
| `npm run generate-keys` | 生成 5 个卡密（默认） |
| `npm run generate-keys 20` | 生成 20 个卡密 |
| `npm run setup-session` | 交互式登录 Telegram 生成 session 字符串 |

---

## 核心流程

### 完整用户流程

```
┌─────────────────────────────────────────────────────────────────┐
│ 用户打开 index.html                                              │
│     ↓                                                           │
│ 填写表单（邮箱、密码、TOTP Key、卡密）                               │
│     ↓ 前端即时校验（Ant Design Form）                              │
│ POST /api/submit                                                │
│     ↓ 后端校验（格式 + HMAC验签 + 卡密未用 + 邮箱无活跃任务）          │
│     ↓ logSubmit() 记录提交日志                                    │
│     ↓ createTask() 加入内存队列                                   │
│ 返回 taskId                                                      │
│     ↓                                                           │
│ 前端展示 "进度查询链接"（/?taskId=xxx），提示无需等待                   │
│     ↓                                                           │
│ ┌─── 阶段一：Telegram 认证 ───┐                                  │
│ │ 队列处理器从队列取出任务        │                                  │
│ │ 通过 Telegram 发送 /pixel 指令 │                                  │
│ │ 依次发送：邮箱 → 密码 → TOTP   │                                  │
│ │ Bot 返回 Job ID 后释放队列      │                                  │
│ │ 异步等待 Bot 回复认证结果       │                                  │
│ └────────────────────────────┘                                   │
│     ↓ 认证成功，获取 offerLink                                    │
│ ┌─── 阶段二：自动绑卡 ─────────┐                                  │
│ │ Playwright 启动浏览器           │                                  │
│ │ 登录 Google 账号              │                                  │
│ │ 打开 Offer 链接               │                                  │
│ │ 填写信用卡信息                 │                                  │
│ │ 确认订阅                      │                                  │
│ └────────────────────────────┘                                   │
│     ↓                                                           │
│ 绑卡成功 → task.status = 'success'                                │
│ 前端轮询到结果 → 展示"全部完成"                                      │
└─────────────────────────────────────────────────────────────────┘
```

### 任务状态流转

```
queued             → 排队等待处理
running            → 正在与 Telegram Bot 交互（发送指令中）
processing         → 指令已发送，等待 Bot 异步返回认证结果（约5-15分钟）
telegram_success   → Telegram 认证成功，准备绑卡
bindcard_running   → 浏览器自动绑卡执行中
success            → 认证 + 绑卡全部成功 ✅
failed             → 任意步骤失败 ❌
```

### 成功判定逻辑

**Telegram 认证成功 + 绑卡成功 = 彻底成功。** 具体判断：
- Telegram 认证：Bot 回复中包含 offer 链接
- 绑卡成功：Playwright 在确认页面检测到"成功"文字

---

## 防重复提交机制

当用户提交认证时，系统检查该邮箱是否已有活跃任务（状态非 `success`/`failed`）：
- 有活跃任务 → 拒绝提交，返回"该邮箱已有任务正在执行中"
- 无活跃任务 → 正常创建新任务

```typescript
// taskQueue.ts
export function isEmailActive(email: string): boolean {
  for (const task of tasks.values()) {
    if (task.email === email && !['success', 'failed'].includes(task.status)) {
      return true;
    }
  }
  return false;
}
```

---

## 进度查询链接

提交成功后，前端生成一个可复制的链接：`{域名}/?taskId=xxx`

- 用户可以关闭页面，稍后通过该链接回来查看进度
- 前端通过 URL 参数 `taskId` 自动恢复轮询
- 提示信息："整个流程约需 10~20 分钟，您无需在此等待"

---

## 卡密机制

### 格式
```
A3KX9MPQ-f7c2b1d8
├── 前8位：随机 payload（大写字母+数字）
└── 后8位：HMAC-SHA256 签名（十六进制小写）
```

### 生成方式

**方式一：命令行生成**
```bash
npm run generate-keys       # 默认生成 5 个
npm run generate-keys 20    # 指定数量
```

**方式二：Admin 后台在线生成**
- 在 `/admin` 页面的"工具区"输入数量
- 点击"生成卡密"按钮
- 弹窗一次性展示所有生成的卡密，支持一键复制

**方式三：API 调用**
```bash
curl -X POST http://your-server:3000/api/admin/generate-keys \
  -H "Content-Type: application/json" \
  -H "X-Admin-Password: your_password" \
  -d '{"count": 10}'
```

### 安全特性
- 使用 `CARD_SECRET` 作为 HMAC 签名密钥
- 验证时使用 `crypto.timingSafeEqual` 防止时序攻击
- 每个卡密只能使用一次，消耗后存入 SQLite `used_keys` 表
- 认证失败时自动恢复卡密（可再次使用）

---

## Telegram Session 管理

### 首次生成
```bash
npm run setup-session
# 交互式登录，输入手机号 → 验证码 → 2FA密码
# 生成的 session 字符串需填入 .env 的 TELEGRAM_SESSION
```

### 热更新（不需要重启服务）

**方式一：Admin 后台更新**
- 在 `/admin` 页面的"工具区"输入新的 session 字符串
- 点击"更新 Session"按钮
- 系统自动断开旧连接、用新 session 重连

**方式二：API 调用**
```bash
curl -X POST http://your-server:3000/api/admin/update-session \
  -H "Content-Type: application/json" \
  -H "X-Admin-Password: your_password" \
  -d '{"session": "新的session字符串"}'
```

### Session 失效场景
- Telegram 帐号在其他设备登出所有会话
- 长时间未使用（通常几周~几月）
- Telegram 封号

---

## 管理后台 (/admin)

### 功能概览

| 区域 | 功能 |
|------|------|
| 工具区 | 更新 Telegram Session / 生成卡密 |
| 用户数据表 | 明文展示所有提交记录（邮箱、密码、TOTP、卡密、状态等） |
| 操作列 | 手动触发绑卡按钮（条件显示） |

### 数据表字段

| 列 | 说明 |
|----|------|
| ID | 记录 ID |
| 邮箱 | 用户 Gmail |
| 密码 | 明文密码 |
| TOTP Key | TOTP 密钥 |
| 卡密 | 使用的卡密 |
| Offer 链接 | Telegram 认证返回的链接 |
| 认证状态 | telegram_status（pending/success/failed） |
| 绑卡状态 | bindcard_status（pending/running/success/failed） |
| 消息 | 实时错误/成功信息 |
| 提交时间 | 用户提交时间 |
| 操作 | 手动绑卡按钮（条件：认证成功 + 绑卡未成功） |

### 手动绑卡

当 `telegram_status = success` 且 `bindcard_status ≠ success` 时，管理员可以：
1. 点击该行的"手动绑卡"按钮
2. 系统使用该行的用户信息（邮箱、密码、TOTP、offer 链接）重新触发绑卡
3. 绑卡结果会更新到数据库

适用场景：
- 绑卡超时
- 网络问题导致绑卡中断
- 浏览器异常

---

## API 接口

### 用户接口

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/submit` | 提交认证请求（含防重复提交） |
| GET | `/api/status/:taskId` | 查询任务状态 |
| GET | `/api/queue` | 获取当前排队数 |
| GET | `/api/health` | 健康检查（Telegram/Browser 状态） |

### 管理接口（均需 `X-Admin-Password` 头或 `?pwd=` 参数）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/admin` | 管理后台页面 |
| GET | `/api/admin/logs` | 获取所有提交记录（明文） |
| GET | `/api/admin/telegram-status` | 查看 Telegram 连接状态 |
| POST | `/api/admin/update-session` | 热更新 Telegram Session |
| POST | `/api/admin/reconnect` | 重新连接 Telegram（不换 session） |
| POST | `/api/admin/generate-keys` | 在线生成卡密 |
| POST | `/api/admin/trigger-bindcard` | 手动触发绑卡 |
| POST | `/api/admin/revoke-key` | 作废卡密（退货用） |
| POST | `/api/admin/restore-key` | 恢复卡密（误消耗时用） |

curl -X POST http://43.162.118.171:3000/api/admin/revoke-key \
  -H "Content-Type: application/json" \
  -H "X-Admin-Password: admin123" \
  -d '{"cardKey": "1CZDK6EW-c0cbbba9"}'

---

## 数据库表

### used_keys — 已使用的卡密

| 字段 | 类型 | 说明 |
|------|------|------|
| key | TEXT PK | 卡密 |
| used_at | TEXT | 使用时间 |

### submit_logs — 提交日志（明文，管理/排查用）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER PK | 自增ID |
| email | TEXT | 邮箱 |
| password | TEXT | 密码（明文） |
| totp_key | TEXT | TOTP 密钥（明文） |
| card_key | TEXT | 使用的卡密 |
| offer_link | TEXT | 认证成功后的 offer 链接 |
| telegram_status | TEXT | Telegram 认证状态 |
| bindcard_status | TEXT | 绑卡状态 |
| status | TEXT | 总体状态 |
| message | TEXT | 结果信息 |
| created_at | TEXT | 提交时间 |

### success_logs — 成功认证记录

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER PK | 自增ID |
| email | TEXT | 邮箱 |
| link | TEXT | 激活链接 |
| created_at | TEXT | 时间 |

---

## 安全设计

### 敏感信息处理
- 用户密码和 TOTP Key 存储在内存任务对象中，仅在处理期间保留
- 任务完成（成功/失败）后，`browserWorker.ts` 的 `finally` 块中清除 `password` 和 `totpKey`
- 过期任务（1小时）定期从内存中移除
- `/api/status/:taskId` 接口仅返回 `status`、`message`、`position`，不暴露任何敏感字段

### 卡密保护
- HMAC 签名 + `timingSafeEqual` 防伪造和时序攻击
- 卡密在认证成功后才标记为已使用（失败则恢复）
- 更换 `CARD_SECRET` 后所有已生成未使用的卡密自动失效

### Admin 认证
- 所有管理接口需要 `X-Admin-Password` 头或 `?pwd=` 查询参数
- 前端登录后密码仅存在 `sessionStorage`，关闭浏览器即失效

---

## 部署

### Docker 部署

```bash
docker build -t gemini-vip .
docker run -d --name gemini-vip \
  --env-file .env \
  -p 3000:3000 \
  -v $(pwd)/data:/app/data \
  gemini-vip
```

### 手动部署

```bash
# 1. 安装依赖
npm install

# 2. 配置环境变量
cp .env.example .env
# 编辑 .env 填入所有必填项

# 3. 初始化 Telegram session（首次）
npm run setup-session

# 4. 生成卡密
npm run generate-keys 50

# 5. 启动服务
npm run dev              # 开发
npm run build && npm start  # 生产
```

---

## 前端依赖（CDN）

| 库 | 用途 |
|----|------|
| React 18 | 表单组件渲染 |
| Ant Design 5 | 表单 UI + 即时校验 |
| Babel standalone | JSX 编译 |
| Material Symbols | 图标 |
| medium-zoom | 教程页图片预览 |

---

## 注意事项

1. **数据安全**: `data/keys.db` 包含用户敏感信息（密码、TOTP），务必保护好服务器访问权限
2. **卡密密钥**: `CARD_SECRET` 更换后所有已生成未使用的卡密失效
3. **内存队列**: 任务存储在内存中，服务重启后进行中的任务会丢失（数据库记录不丢）
4. **Session 维护**: Telegram session 失效需要重新运行 `setup-session` 或通过 Admin 后台热更新
5. **并发处理**: 任务队列为串行 FIFO，同一时间仅处理一个 Telegram 交互任务
6. **绑卡信用卡**: 信用卡信息配置在 `.env` 中，所有用户共享同一张卡绑定
7. **防重复**: 同一邮箱有任务执行中时不允许重复提交，避免浪费卡密
