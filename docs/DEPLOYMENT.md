# 自托管中继部署（HTTPS + nginx 共存 + certbot 自动续期）

> 目标场景：一台已经跑着其它应用、nginx 里已有若干 `server {}` 配置的主机，现在要**追加** FastNote 的中继服务，并且不能影响已有站点。
>
> 本文档只覆盖**中继服务器**（`server/`）。如果你想把 **Web 前端**（`apps/web`）托管到 Vercel 而不是自己搭静态服务器，见 [`docs/VERCEL.md`](VERCEL.md)——两者是完全独立的两个部署单元，Web 前端连哪个中继服务器由用户在设置里自己填，跟前端部署在哪里无关。

## 架构

```
Internet ──443/80──▶ nginx（已有，负责所有站点的 TLS 终止）
                        │
                        ├─ 其它 server_name → 其它应用（不动）
                        │
                        └─ fastnote.example.com → 127.0.0.1:8787 ─▶ Docker 容器 (relay)
```

- nginx 是唯一对公网暴露 80/443 的组件；FastNote 的 Fastify 服务只绑定 `127.0.0.1:8787`（见 `server/docker-compose.yml`），即使容器被攻破也不会绕过 nginx 直接被外部访问。
- 新增的 nginx 配置是**独立文件**，用 `server_name` 区分，不修改任何已有的 `server {}` 块。

## 0. 前提

- 域名已经解析到这台服务器（例如 `fastnote.example.com`）
- nginx、certbot 已安装（`apt install certbot python3-certbot-nginx` 或你发行版对应的包；这里我们**不用** certbot 的 nginx 插件自动改配置，避免它扫描/修改你其它站点，改用 webroot 方式手动申请）
- Docker + Docker Compose 已安装

## 1. 启动 FastNote 中继容器（先只监听本机）

```bash
cd server
cp .env.example .env
# 编辑 .env，填入 JWT_SECRET（生成一个：openssl rand -hex 32）
docker compose up -d
curl http://127.0.0.1:8787/health   # 应返回 {"status":"ok"}
```

`docker-compose.yml` 已经把端口绑定改成了 `127.0.0.1:8787:8787`，不会占用/暴露到公网网卡。

## 2. 准备 ACME 共享目录（供 certbot 走 webroot 验证）

如果你之前给别的应用申请证书时已经有一个共享 webroot 目录，直接复用即可；否则新建一个：

```bash
sudo mkdir -p /var/www/certbot
```

## 3. 添加 FastNote 的 nginx 站点配置（新文件，不改已有配置）

把仓库里的 `server/deploy/nginx/fastnote.conf` 拷贝到 nginx 配置目录，替换域名和 webroot 路径为你的实际值：

```bash
sudo cp server/deploy/nginx/fastnote.conf /etc/nginx/sites-available/fastnote.conf
sudo sed -i 's/fastnote.example.com/你的真实域名/g' /etc/nginx/sites-available/fastnote.conf
# 如果你的共享 webroot 不是 /var/www/certbot，也一并替换
sudo ln -s /etc/nginx/sites-available/fastnote.conf /etc/nginx/sites-enabled/fastnote.conf
sudo nginx -t   # 先只检查语法；443 server block 此时因为证书还不存在会报错，属预期
```

> 如果 `nginx -t` 在这一步因为找不到证书文件报错，属正常现象——先临时注释掉文件里 `listen 443` 那个 server block，只留 80 端口的 ACME 校验块，跑通 `nginx -t` 并 `reload` 后再申请证书，申请成功后再取消注释、`reload` 一次即可。两种做法都可以，前者（先申请再放开 443）更省事：

```bash
# 只启用 80 端口块（临时把 443 的 server {} 整段注释掉），然后：
sudo nginx -t && sudo systemctl reload nginx
```

## 4. 用 certbot（webroot 模式）申请证书

webroot 模式**不会触碰任何已有的 nginx server 配置**，只是往 `/var/www/certbot/.well-known/acme-challenge/` 写校验文件：

```bash
sudo certbot certonly --webroot -w /var/www/certbot -d 你的真实域名
```

成功后证书在 `/etc/letsencrypt/live/你的真实域名/{fullchain,privkey}.pem`（配置文件里已经指向这个路径）。

## 5. 打开 443 配置并 reload

把之前注释掉的 443 `server {}` 块取消注释（如果第 3 步用了这种方式），然后：

```bash
sudo nginx -t && sudo systemctl reload nginx
curl -I https://你的真实域名/health
```

## 6. 自动续期

大多数发行版安装 certbot 后会自带一个定时任务（systemd timer 或 cron），每天检查两次、到期前自动续期，**通常不需要额外配置**。可以确认一下：

```bash
systemctl list-timers | grep certbot     # 或者：cat /etc/cron.d/certbot
```

证书续期后 nginx 需要重新加载才能读到新证书。加一个全局的 **deploy-hook**（对这台机器上所有 certbot 证书都生效，包括你已有的其它应用，幂等、可重复添加）：

```bash
sudo tee /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh <<'EOF'
#!/bin/sh
nginx -t && systemctl reload nginx
EOF
sudo chmod +x /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
```

验证续期流程本身没问题（不会真的申请，只是模拟一次）：

```bash
sudo certbot renew --dry-run
```

## 7. 收尾检查清单

- [ ] `curl http://127.0.0.1:8787/health`（本机直连，确认容器正常）
- [ ] `curl https://你的真实域名/health`（走 nginx + TLS，确认反代正常）
- [ ] 客户端（Web/桌面版）设置 → 服务器地址填 `https://你的真实域名`
- [ ] 防火墙只放行 80/443（以及你已有应用需要的端口），**不要**额外放行 8787
- [ ] `server/.env` 里的 `JWT_SECRET` 已经是随机值，不是默认占位符（`docker-compose.yml` 已经加了强制校验，缺失时 `docker compose up` 会直接报错拒绝启动）
- [ ] `sudo certbot renew --dry-run` 通过

## 与其它应用共存的注意点

- 每个域名/子域名对应一个独立的 nginx `server {}` 文件，用 `server_name` 区分，互不干扰；FastNote 用自己的文件（`fastnote.conf`），不去改任何已有的 `.conf`。
- certbot 的续期 deploy-hook 是全局的（对所有域名的证书都生效），加一次即可，不会重复触发多份。
- FastNote 的 Fastify 服务只监听 `127.0.0.1:8787`，与其它应用监听的其它本地端口不会冲突；如果 `8787` 恰好被占用，改 `server/.env` 的 `PORT` 和 `docker-compose.yml`/nginx 配置里对应的端口号即可。
