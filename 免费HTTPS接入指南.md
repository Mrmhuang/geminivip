# 免费 HTTPS 接入指南（Let's Encrypt + Nginx + CentOS）

> 基于 Let's Encrypt 免费证书 + Certbot + Nginx，适用于已备案域名的项目。

---

## 前置条件

- [x] 域名已完成备案
- [x] 服务器已安装 Nginx
- [x] 服务器有公网 IP
- [x] 域名 DNS 管理权限

---

## 一、DNS 解析配置

在域名 DNS 管理面板中添加以下 A 记录，将域名指向你的服务器公网 IP：

| 主机记录 | 记录类型 | 线路类型 | 记录值 | TTL |
|---------|---------|---------|-------|-----|
| `@` | A | 默认 | `你的服务器公网IP` | 600 |
| `www` | A | 默认 | `你的服务器公网IP` | 600 |

> 如果有其他子域名（如 `api`、`admin`），也一并添加 A 记录。

### 验证 DNS 生效

```bash
dig your-domain.com A
dig www.your-domain.com A
```

确认返回的 IP 是你的服务器 IP 即可（一般几分钟内生效）。

---

## 二、安装 Certbot

### CentOS 7/8

```bash
sudo yum install -y epel-release
sudo yum install -y certbot python3-certbot-nginx
```

### Ubuntu/Debian

```bash
sudo apt update
sudo apt install -y certbot python3-certbot-nginx
```

### 验证安装

```bash
certbot --version
```

---

## 三、确保 Nginx 配置正确

在申请证书前，确保 Nginx 中已有你域名的 server 块配置。

示例 `/etc/nginx/conf.d/your-project.conf`：

```nginx
server {
    listen 80;
    server_name your-domain.com www.your-domain.com;

    # 你的项目配置（静态文件、反向代理等）
    location / {
        root /var/www/your-project;
        index index.html;
        try_files $uri $uri/ /index.html;
    }
}
```

配置完成后测试并重载：

```bash
sudo nginx -t
sudo systemctl reload nginx
```

---

## 四、申请并安装证书

```bash
sudo certbot --nginx -d your-domain.com -d www.your-domain.com
```

### 执行过程中的选项

1. **如果提示输入邮箱** —— 输入你的邮箱（用于接收到期提醒）
2. **如果提示同意条款** —— 输入 `Y`
3. **如果问是否分享邮箱给 EFF** —— 输入 `N`（可选）
4. **如果已有证书，问重装还是更新** —— 选 `1`（Reinstall）
5. **如果问 HTTP 重定向** —— 选 `2`（Redirect，自动将 HTTP 跳转到 HTTPS）

### 成功标志

看到以下输出说明成功：

```
Congratulations! You have successfully enabled https://your-domain.com and
https://www.your-domain.com
```

---

## 五、验证 HTTPS

```bash
# 测试 HTTPS 是否正常
curl -I https://your-domain.com

# 查看证书详情
echo | openssl s_client -connect your-domain.com:443 2>/dev/null | openssl x509 -noout -dates

# 查看 certbot 管理的证书
sudo certbot certificates
```

---

## 六、配置自动续期

### 6.1 确认续期配置使用 HTTP-01 验证

查看续期配置文件：

```bash
cat /etc/letsencrypt/renewal/your-domain.com.conf
```

确保 `[renewalparams]` 段内容如下：

```ini
[renewalparams]
authenticator = nginx
installer = nginx
account = xxxxxx（保持原值）
pref_challs = http-01,
server = https://acme-v02.api.letsencrypt.org/directory
```

> ⚠️ 如果你看到 `authenticator = manual` 或 `pref_challs = dns-01`，需要改成上面的配置，否则自动续期会失败。

### 6.2 测试自动续期

```bash
sudo certbot renew --dry-run
```

成功标志：

```
Congratulations, all simulated renewals succeeded
```

### 6.3 添加定时任务

```bash
sudo crontab -e
```

添加以下行（每天凌晨 2:30 自动检查续期）：

```
30 2 * * * /usr/bin/certbot renew --quiet --deploy-hook "systemctl reload nginx"
```

> - `--quiet`：静默模式，只在出错时输出日志
> - `--deploy-hook`：仅在证书实际更新后才执行重载 Nginx
> - Let's Encrypt 证书有效期 90 天，certbot 会在到期前 30 天开始尝试续期

### 验证 cron 已添加

```bash
sudo crontab -l
```

---

## 七、完整流程清单

```
□ 1. DNS 面板添加 @ 和 www 的 A 记录指向服务器 IP
□ 2. 等待 DNS 生效（dig 验证）
□ 3. 服务器安装 certbot + nginx 插件
□ 4. 配置好 Nginx server 块（监听 80 端口）
□ 5. 执行 certbot --nginx 申请并安装证书
□ 6. 验证 HTTPS 正常访问
□ 7. 确认续期配置为 nginx + http-01
□ 8. certbot renew --dry-run 测试通过
□ 9. 添加 crontab 定时任务
□ 10. 完成 ✅
```

---

## 常见问题

### Q: `certbot renew --dry-run` 报错 manual plugin 不工作？

**原因**：证书最初是用 DNS-01 手动验证申请的，续期配置还在用 manual 方式。

**解决**：编辑 `/etc/letsencrypt/renewal/your-domain.com.conf`，将：
```ini
authenticator = manual
pref_challs = dns-01,
manual_public_ip_logging_ok = None
```
改为：
```ini
authenticator = nginx
installer = nginx
pref_challs = http-01,
```
删除 `manual_public_ip_logging_ok` 行。

### Q: 之前用 DNS 验证时添加的 `_acme-challenge` TXT 记录还需要保留吗？

**不需要**。切换到 HTTP-01 验证后，DNS 中的 `_acme-challenge` TXT 记录已无用，可以安全删除。

### Q: 需要通配符证书（`*.your-domain.com`）怎么办？

通配符证书**必须**使用 DNS-01 验证，需要配合 DNS 服务商的 API 插件实现自动续期：
- 腾讯云 DNSPod：`certbot-dns-tencentcloud`
- 阿里云：`certbot-dns-aliyun`
- Cloudflare：`certbot-dns-cloudflare`

### Q: 80 端口被占用或无法访问怎么办？

HTTP-01 验证需要从外网访问服务器的 80 端口。确保：
1. 防火墙/安全组已开放 80 和 443 端口
2. Nginx 正在监听 80 端口
3. 没有其他程序占用 80 端口

```bash
# 检查端口占用
sudo ss -tlnp | grep -E ':80|:443'

# 腾讯云安全组需要在控制台开放 80/443 端口
```

---

## 参考

- Let's Encrypt 官网：https://letsencrypt.org/
- Certbot 文档：https://certbot.eff.org/
- 证书有效期：90 天（建议到期前 30 天自动续期）
