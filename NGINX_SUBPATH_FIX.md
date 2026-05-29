# Nginx 子路径部署修复记录

## 问题现象

将 GeminiVip 部署到 `/gemini/` 子路径时，页面样式丢失，资源加载异常。

**具体表现：**
- 浏览器访问 `http://43.162.118.171/gemini/` 时，HTML 文档能正常返回
- 但 `style.css`、`antd.min.js` 等资源 404 或返回错误内容
- 网络面板显示 `/style.css` 请求返回的是 HTML（加点糖站点的兜底页面），而不是 CSS
- 页面失去样式，布局错乱

## 根因分析

### 问题链路

1. **HTML 中的绝对路径引用**
   ```html
   <link rel="stylesheet" href="/style.css">
   <script src="/antd.min.js"></script>
   ```
   这些路径以 `/` 开头，是**绝对路径**，浏览器会直接请求 `http://host/style.css`（根路径），而不是 `http://host/gemini/style.css`

2. **Nginx 配置问题**
   - `/gemini/` 路径的请求被正确反代到 Node.js (3000)
   - 但 HTML 里引用的资源路径是 `/style.css`（根路径），不是 `/gemini/style.css`
   - 根路径 `/style.css` 被 Nginx 的 `location /` 捕获，转发到了"加点糖"站点 (3001)
   - "加点糖"站点没有 `/style.css` 这个资源，返回了 HTML 兜底页面
   - 浏览器拿到 HTML 当成 CSS 解析，样式失效

### 为什么 `<base>` 标签不生效

**尝试方案：** 在 Nginx 反代时注入 `<base href="/gemini/">` 标签

```nginx
sub_filter '</head>' '<base href="/gemini/"></head>';
sub_filter_once on;
```

**失败原因：** HTML 规范规定，`<base>` 标签**只对相对路径生效**，对以 `/` 开头的绝对路径无效。

| 路径类型 | 示例 | `<base href="/gemini/">` 是否生效 |
|---------|------|----------------------------------|
| 相对路径 | `style.css` | ✅ 解析为 `/gemini/style.css` |
| 绝对路径 | `/style.css` | ❌ 解析为 `/style.css`（忽略 base） |
| 完整 URL | `http://host/style.css` | ❌ 完全忽略 base |

由于 HTML 中的所有资源引用都是绝对路径（`/style.css`、`/antd.min.js` 等），`<base>` 标签完全无效。

## 最终解决方案

### 核心思路

在 Nginx 的 `location /`（加点糖站点）里，通过判断 **`Referer` 请求头**，把来自 `/gemini/` 页面的资源请求"劫持"回 Node.js (3000)，而不是转发到加点糖 (3001)。

**原理：**
- 浏览器在 `/gemini/` 页面上发起的任何资源请求，都会带上 `Referer: http://host/gemini/`
- 浏览器在加点糖页面 (`/`) 上发起的请求，`Referer` 是 `http://host/` 或为空
- 通过判断 `Referer` 是否包含 `/gemini/`，可以区分请求来源

### Nginx 配置

在 `/etc/nginx/conf.d/quan.conf` 的两个 `server` 块中，修改 `location /` 块：

```nginx
location / {
    # === GeminiVip: 来自 /gemini/ 页面的资源/接口请求(带绝对路径 /xxx)，回拨给 3000 ===
    set $gemini_proxy 0;
    if ($http_referer ~* "^https?://[^/]+/gemini/") { set $gemini_proxy 1; }
    if ($request_uri ~* "^/(gemini|favicon\.ico)") { set $gemini_proxy 0; }
    if ($gemini_proxy = 1) {
        proxy_pass http://127.0.0.1:3000;
    }

    # 原有加点糖配置（只有非 gemini 来源的请求的才会走到这里）
    root /var/www/jdt/dist;
    index index.html index.htm;
    try_files $uri $uri/ /index.html;
    # ... 其他原有配置
}
```

**逻辑说明：**
1. 默认 `$gemini_proxy = 0`，请求走原有加点糖逻辑
2. 如果 `Referer` 包含 `/gemini/`，设置 `$gemini_proxy = 1`
3. 但如果请求 URI 已经是 `/gemini/...` 或 `/favicon.ico`，强制设置 `$gemini_proxy = 0`（避免循环代理）
4. 当 `$gemini_proxy = 1` 时，请求转发到 Node.js (3000)

### 配置生效步骤

```bash
# 1. 测试配置
nginx -t

# 2. 重新加载
nginx -s reload
```

## 验证方法

### 1. 验证来自 `/gemini/` 的请求被正确转发

```bash
# 模拟浏览器从 /gemini/ 页面请求 /style.css
curl -H "Referer: http://43.162.118.171/gemini/" \
     -H "Host: 43.162.118.171" \
     http://127.0.0.1/style.css -o /tmp/test.css

# 检查内容是否是 CSS（而不是 HTML）
head -c 100 /tmp/test.css
# 期望输出: :root { 或类似 CSS 内容
```

### 2. 验证加点糖站点不受影响

```bash
# 无 Referer 请求 /style.css，应该返回加点糖的兜底页面
curl -H "Host: 43.162.118.171" \
     http://127.0.0.1/style.css -o /tmp/test2.html

# 检查内容是否是 HTML（加点糖的兜底页面）
head -c 100 /tmp/test2.html
# 期望输出: <!DOCTYPE html> 或类似 HTML 内容
```

### 3. 浏览器验证

1. 完全关闭浏览器（不是关标签页）
2. 重新打开浏览器，访问 `http://43.162.118.171/gemini/`
3. 打开 DevTools → 网络面板
4. 刷新页面，检查：
   - `style.css` 的 `Type` 应该是 `stylesheet`
   - 状态码应该是 `200`
   - 页面样式正常显示

## 备份与回滚

### 备份文件

修改前已自动备份：
```
/etc/nginx/conf.d/quan.conf.bak.20260530-003452
```

### 回滚步骤

```bash
# 1. 恢复备份
cp -a /etc/nginx/conf.d/quan.conf.bak.20260530-003452 \
      /etc/nginx/conf.d/quan.conf

# 2. 测试配置
nginx -t

# 3. 重新加载
nginx -s reload
```

## 其他尝试过的方案（均已放弃）

### 方案 A：修改 HTML 中的资源路径

**思路：** 把所有绝对路径改成相对路径

```html
<!-- 修改前 -->
<link rel="stylesheet" href="/style.css">
<script src="/antd.min.js"></script>

<!-- 修改后 -->
<link rel="stylesheet" href="style.css">
<script src="antd.min.js"></script>
```

**放弃原因：** 需要修改所有 HTML 文件，且如果有 JS 动态创建的资源请求（如 `fetch('/api/...')`），仍然会有同样问题。

### 方案 B：Nginx rewrite 重定向

**思路：** 在 Nginx 配置里加 rewrite 规则，把 `/style.css` 重定向到 `/gemini/style.css`

```nginx
location = /style.css {
    return 301 /gemini/style.css;
}
```

**放弃原因：**
1. 需要为每一个可能的资源路径写 rewrite 规则，维护成本高
2. `fetch('/api/...')` 的 POST 请求会被 301 降级为 GET，导致接口调用失败
3. 加点糖站点的同名资源会被错误重定向

### 方案 C：`<base>` 标签注入

**思路：** 在 Nginx 反代时注入 `<base href="/gemini/">`

**放弃原因：** `<base>` 只对相对路径生效，对绝对路径无效（详见上面的根因分析）

## 总结

| 方案 | 优点 | 缺点 | 结果 |
|------|------|------|------|
| 修改 HTML 资源路径 | 一劳永逸 | 工作量大，JS 动态请求仍会出问题 | ❌ 放弃 |
| Nginx rewrite | 实现简单 | POST 请求会被降级，加点糖资源会受影响 | ❌ 放弃 |
| `<base>` 标签注入 | 无需修改代码 | 对绝对路径无效 | ❌ 放弃 |
| **Referer 判断转发** | **零代码修改，加点糖完全不受影响** | **需要 Nginx 支持** | ✅ **采用** |

## 适用场景

本方案适用于以下场景：
- 同一个域名下部署多个应用
- 其中一个应用需要部署在子路径下（如 `/gemini/`）
- 应用的 HTML 中使用绝对路径引用资源
- 不希望修改应用代码

## 注意事项

1. **Referer 可能被修改或删除**
   - 某些隐私浏览器或插件可能会删除 `Referer` 头
   - 如果发生这种情况，请求会错误地走到加点糖站点
   - 解决方案：在 HTML 中添加 `<meta name="referrer" content="origin-when-cross-origin">` 强制发送 Referer

2. **Nginx `if` 指令的陷阱**
   - Nginx 的 `if` 指令有些诡异行为（详见 [If Is Evil](https://www.nginx.com/resources/wiki/start/topics/depth/ifisevil/)）
   - 本方案使用了多个 `if` 指令，但在 `location` 块中使用是安全的
   - 避免在其他地方使用类似的 `if` 逻辑

3. **性能影响**
   - 每个请求都会执行 2-3 次 `if` 判断，性能影响可忽略不计
   - 如果担心性能，可以用 `map` 指令预计算 `$gemini_proxy` 变量

## 参考资料

- [Nginx `if` Is Evil](https://www.nginx.com/resources/wiki/start/topics/depth/ifisevil/)
- [HTML `<base>` 标签规范](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/base)
- [HTTP `Referer` 头](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Referer)
