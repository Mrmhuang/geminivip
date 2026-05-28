# HTTPS 部署记录

> 完成时间：2025-05-28  
> 服务器 IP：`43.162.118.171`  
> 域名：`venor.top`  
> 服务器地域：腾讯云轻量应用服务器 - 硅谷（na-siliconvalley）  
> 实例 ID：`lhins-52y95owj`  
> 操作系统：OpenCloudOS 9.2

---

## 一、DNS 解析配置

在域名 DNS 管理面板中添加以下 A 记录：

| 主机记录 | 记录类型 | 记录值 | TTL |
|---------|---------|-------|-----|
| `@` | A | `43.162.118.171` | 600 |
| `www` | A | `43.162.118.171` | 600 |

✅ DNS 解析验证通过，`venor.top` 和 `www.venor.top` 均解析到 `43.162.118.171`。

---

## 二、服务器环境检查

- **Nginx**：v1.26.3，已安装且运行中
- **Certbot**：未安装（需安装）
- **firewalld**：运行中，80/tcp 和 3001/tcp 已开放
- **腾讯云控制台防火墙**：80 和 443 端口已放行

---

## 三、安装 Certbot

```bash
yum install -y certbot python3-certbot-nginx
```

OpenCloudOS 9.2 自带 EPOL 仓库，直接安装即可，无需额外配置 epel-release。

---

## 四、修改 Nginx 配置

将 `server_name` 从 IP 地址改为域名：

```bash
sed -i 's/server_name 43.162.118.171;/server_name venor.top www.venor.top;/' /etc/nginx/conf.d/quan.conf
nginx -t && systemctl reload nginx
```

---

## 五、申请 SSL 证书

```bash
certbot --nginx -d venor.top -d www.venor.top \
  --non-interactive --agree-tos --email admin@venor.top --redirect
```

**结果：**
- ✅ 证书保存在 `/etc/letsencrypt/live/venor.top/`
- ✅ 证书到期时间：2026-08-26
- ✅ 自动配置了 HTTP → HTTPS 重定向

---

## 六、解决外网无法访问 443 端口问题

**问题**：从外网访问 `https://venor.top` 报 `ERR_SSL_PROTOCOL_ERROR`。

**原因**：服务器内部 `firewalld` 防火墙只开放了 80/tcp 和 3001/tcp，未开放 443/tcp。虽然腾讯云控制台安全组已放行，但系统级防火墙拦截了连接。

**修复：**

```bash
firewall-cmd --permanent --add-port=443/tcp
firewall-cmd --reload
```

---

## 七、配置自动续期

添加 crontab 定时任务，每天凌晨 2:30 自动检查并续期证书：

```bash
(crontab -l 2>/dev/null | grep -v certbot; echo '30 2 * * * /usr/bin/certbot renew --quiet --deploy-hook "systemctl reload nginx"') | crontab -
```

---

## 八、保留 IP 直连访问（兼容存量用户）

**需求**：存量用户通过 `http://43.162.118.171` 访问不受影响，域名访问走 HTTPS。

在 Nginx 中新增 server 块，让通过 IP 地址访问 80 端口的请求直接代理到后端服务，不做 HTTPS 重定向。

---

## 九、配置 `/gemini` 路径代理

**需求**：通过 `https://venor.top/gemini` 访问原来 `http://43.162.118.171:3000` 的 Gemini Pro 项目，不暴露端口号。

服务器上有两个服务：
- **3000 端口**：Gemini Pro 认证项目（Docker 运行）
- **3001 端口**：「加点糖」项目（Node 运行）

---

## 十、最终 Nginx 配置

文件路径：`/etc/nginx/conf.d/quan.conf`

```nginx
# HTTPS server for domain
server {
    server_name venor.top www.venor.top;

    # 根路径 -> 3001 端口（加点糖）
    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_cache_bypass $http_upgrade;
    }

    # /gemini 路径 -> 3000 端口（Gemini Pro）
    location /gemini/ {
        proxy_pass http://127.0.0.1:3000/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_cache_bypass $http_upgrade;
    }
    location = /gemini { return 301 /gemini/; }

    listen 443 ssl;
    ssl_certificate /etc/letsencrypt/live/venor.top/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/venor.top/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;
}

# 域名 HTTP -> HTTPS 重定向
server {
    listen 80;
    server_name venor.top www.venor.top;
    return 301 https://$host$request_uri;
}

# IP 直连访问保持 80 端口（兼容存量用户）
server {
    listen 80;
    server_name 43.162.118.171;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_cache_bypass $http_upgrade;
    }

    location /gemini/ {
        proxy_pass http://127.0.0.1:3000/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_cache_bypass $http_upgrade;
    }
    location = /gemini { return 301 /gemini/; }
}
```

---

## 最终访问方式汇总

| 访问地址 | 效果 |
|---------|------|
| `https://venor.top/gemini` | ✅ Gemini Pro 项目（HTTPS，推荐） |
| `http://43.162.118.171/gemini` | ✅ Gemini Pro 项目（IP + 80 端口） |
| `http://43.162.118.171:3000` | ✅ 原始方式，存量用户继续可用 |
| `https://venor.top` | ✅ 「加点糖」项目（HTTPS） |
| `http://43.162.118.171` | ✅ 「加点糖」项目（IP 直连） |
| `http://venor.top` | 🔄 自动 301 跳转到 `https://venor.top` |

---

## 证书信息

| 项目 | 值 |
|-----|---|
| 证书路径 | `/etc/letsencrypt/live/venor.top/fullchain.pem` |
| 私钥路径 | `/etc/letsencrypt/live/venor.top/privkey.pem` |
| 到期时间 | 2026-08-26 |
| 自动续期 | crontab 每天 02:30 执行 |
| 续期配置 | `/etc/letsencrypt/renewal/venor.top.conf` |

---

## 注意事项

1. **证书续期**：Let's Encrypt 证书有效期 90 天，已配置自动续期，无需手动操作
2. **防火墙**：如果重装系统或重置防火墙，记得开放 443/tcp 端口（`firewall-cmd --permanent --add-port=443/tcp && firewall-cmd --reload`）
3. **Nginx 配置备份**：修改前建议备份 `cp /etc/nginx/conf.d/quan.conf /etc/nginx/conf.d/quan.conf.bak`
4. **新增子域名**：如需为新子域名配置 HTTPS，运行 `certbot --nginx -d 新域名`
