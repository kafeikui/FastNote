# FastNote 协议规范

> 本文档描述服务端 `server/src/index.ts` 当前实际暴露的接口。与实现不一致时以源码为准。所有请求/响应 body 均为 JSON；除注册/登录外均需 `Authorization: Bearer <jwt>`。

## 1. 通用约定

- 传输：生产环境要求 HTTPS + WSS（见 `docs/DEPLOYMENT.md`），开发环境可用 HTTP/WS
- 编码：JSON 信封 + Base64 密文字符串（不是二进制帧）
- 认证：`Authorization: Bearer <jwt>`，JWT payload 仅含 `{ sub: user_id, username }`，7 天过期；WebSocket 通过 query 参数 `?token=<jwt>` 或同样的 Header 鉴权
- 时间：ISO 8601 字符串（`new Date().toISOString()`）
- 版本冲突：所有需要 `version` 的写接口，若请求 version 落后于服务端当前 version，返回 `409` + `{ error: 'version_conflict', server_version }`
- **没有** 请求限流 / 429、没有分页游标（`next_cursor` 恒为 `null`）、没有 prekey/X3DH 相关接口——这些均为早期设计草案中的内容，当前实现中不存在

## 2. 注册 / 登录 / 密钥

### POST `/api/v1/register`

```json
{
  "username": "alice",
  "password_proof": "<string>",
  "identity_pubkey": "<base64, 可选>",
  "exchange_pubkey": "<base64, 可选>",
  "vault_salt": "<string, 可选>"
}
```

- `username` / `password_proof` 必填，否则 `400`
- 用户名已存在 → `409 { error: 'username taken' }`

响应：

```json
{ "user_id": "uuid", "device_id": "uuid", "token": "<jwt>" }
```

> `device_id` 为每次注册随机生成，服务端**不持久化设备记录**（无 `devices` 表），仅在响应中返回。

### POST `/api/v1/login`

```json
{ "username": "alice", "password_proof": "<string>" }
```

校验失败（用户不存在或 proof 不匹配）→ `401 { error: 'invalid credentials' }`。成功响应同注册。

### GET `/api/v1/vault-salt?username=<username>`

用于云端保险库解锁时获取该账号绑定的 salt。无需鉴权头，但需精确用户名。

- 用户不存在 → `404 { error: 'user_not_found' }`
- 未设置过 salt → `404 { error: 'vault_salt_missing' }`
- 成功 → `{ "vault_salt": "<string>" }`

### PUT `/api/v1/vault-salt`（需鉴权）

```json
{ "vault_salt": "<string>" }
```

写入/更新当前账号的 vault salt，成功返回 `{ "ok": true }`。

### PUT `/api/v1/keys`（需鉴权）

```json
{ "identity_pubkey": "<base64>", "exchange_pubkey": "<base64>" }
```

用于注册后单独上传/轮换公钥（例如切换设备后重新生成密钥对）。返回 `{ "ok": true }`。

### GET `/api/v1/users/lookup?username=<username>`（需鉴权）

按用户名查找聊天对象的公钥。仅当对方已上传过 `exchange_pubkey` 才能查到，否则 `404`。

```json
{ "user_id": "uuid", "username": "bob", "exchange_pubkey": "<base64>" }
```

### GET `/api/v1/users/:id`（需鉴权）

同上，按 `user_id` 查找。

## 3. 笔记 / 表格 / 附件同步

同步粒度是**单个文档**（`note` / `table` 两种节点类型统一走同一套接口，用密文内部区分），**没有独立的 manifest/目录树接口**——每个节点自身的父子关系、排序都打包进该节点的密文里，一起同步。

### PUT `/api/v1/sync/notes/:noteId`（需鉴权）

```json
{
  "ciphertext": "<base64>",
  "version": 3,
  "content_hash": "<hex>"
}
```

- 若服务端已有更高 `version` → `409 { error: 'version_conflict', server_version }`；客户端策略：保留本地为"冲突副本"（新建节点），不覆盖
- 成功 → `{ "ok": true }`；`updated_at` 由服务端写入当前时间

### GET `/api/v1/sync/notes`（需鉴权）

一次性返回该账号名下**全部**笔记/表格密文条目（当前无分页/增量游标，`next_cursor` 恒为 `null`）：

```json
{
  "items": [
    {
      "note_id": "uuid",
      "ciphertext": "<base64>",
      "version": 3,
      "content_hash": "...",
      "deleted": false,
      "updated_at": "..."
    }
  ],
  "next_cursor": null
}
```

### PUT `/api/v1/sync/attachments/:attachmentId`（需鉴权）

```json
{
  "note_id": "uuid",
  "meta_ciphertext": "<base64>",
  "data_ciphertext": "<base64>",
  "version": 1,
  "deleted": false
}
```

冲突处理同笔记接口（比较 `version`）。

### GET `/api/v1/sync/attachments`（需鉴权）

返回该账号下全部附件密文条目（同样无分页）：

```json
{
  "items": [
    {
      "attachment_id": "uuid",
      "note_id": "uuid",
      "meta_ciphertext": "<base64>",
      "data_ciphertext": "<base64>",
      "version": 1,
      "deleted": false,
      "updated_at": "..."
    }
  ]
}
```

### 笔记明文结构（加密前，由客户端自行约定，服务端不感知）

```json
{
  "title": "需求文档",
  "content": "# 标题\n\n正文...",
  "nodeType": "note",
  "parentId": "folder-uuid",
  "sortOrder": 100
}
```

## 4. 即时通讯（1:1）

### WebSocket

`wss://host/ws/v1?token=<jwt>`（或走 `Authorization` header 鉴权）。连接成功后客户端应立即发送一次 `ping`。服务端每个 `user_id` 只保留**最新一个**连接（新连接会替换旧连接在内存 Map 中的记录，不支持多设备同时在线接收推送）。

### 消息信封（客户端 → 服务端 → 对方，经 WebSocket）

```json
{
  "type": "message",
  "id": "msg-uuid",
  "to": "user-uuid",
  "sent_at": "2026-07-04T10:00:00Z",
  "payload": {
    "counter": 12,
    "nonce": "<base64>",
    "ciphertext": "<base64>"
  }
}
```

服务端收到后：写入 `message_queue`（供离线补拉）+ 若对方在线，追加 `from` / `from_username` 字段后原样转发：

```json
{
  "type": "message",
  "id": "msg-uuid",
  "from": "user-uuid",
  "from_username": "alice",
  "to": "user-uuid",
  "sent_at": "...",
  "payload": { "counter": 12, "nonce": "<base64>", "ciphertext": "<base64>" }
}
```

`payload` 用会话根密钥按 `counter` 派生的一次性 AES-GCM 密钥解密后，明文是 `ChatWirePayload`：

```json
{
  "v": 1,
  "body": "你好",
  "peerUsername": "bob",
  "attachments": [
    { "id": "att-uuid", "fileName": "photo.png", "description": "", "mimeType": "image/png", "size": 12345, "dataB64": "<base64>" }
  ],
  "status": "sent"
}
```

> 附件是**内嵌在聊天消息明文里**一起加密传输的（`dataB64` 直接放进 `attachments[]`），**不是**单独的附件同步接口——这与"笔记/表格附件走 `/api/v1/sync/attachments`"是两条完全独立的路径。

客户端收到并成功解密后，通过 WebSocket 回发 `delivery_ack`（服务端当前**不处理**该消息类型，仅作为客户端侧的记录钩子，不影响 `message_queue`）：

```json
{ "type": "delivery_ack", "id": "msg-uuid", "to": "peer-uuid" }
```

### 已实现的 `type` 取值

| type | 方向 | 说明 |
|------|------|------|
| `ping` / `pong` | 客户端→服务端 / 服务端→客户端 | 心跳，服务端收到 `ping` 立即回 `pong` |
| `message` | 双向 | 聊天消息信封 |
| `delivery_ack` | 客户端→服务端 | 送达确认（服务端当前忽略此类型） |

> 早期草案中的 `read_ack`、`prekey_bundle_request`/`prekey_bundle_response` **未实现**，服务端也没有对应的 `/api/v1/keys/bundle/:userId` 接口。

## 5. 离线消息补拉

### GET `/api/v1/messages/pending`（需鉴权）

返回当前账号收件箱中尚未 ack 的全部消息（按 `created_at` 升序，默认最多 100 条）：

```json
{
  "items": [
    {
      "id": "msg-uuid",
      "from_user": "user-uuid",
      "from_username": "alice",
      "payload": { "counter": 12, "nonce": "<base64>", "ciphertext": "<base64>" },
      "created_at": "..."
    }
  ]
}
```

### DELETE `/api/v1/messages/:id`（需鉴权）

客户端解密处理成功后调用，将该消息从 `message_queue` 中移除。返回 `{ "ok": true }`。若解密失败，客户端当前策略是**丢弃**（不重试、不删除），避免无限重试导致的死循环。

WebSocket 连接建立/`onopen` 时，以及此后每 15 秒，客户端会主动轮询一次 `/api/v1/messages/pending` 作为对推送丢失的兜底。

## 6. 健康检查

### GET `/health`

```json
{ "status": "ok" }
```

无需鉴权，用于容器编排/反向代理健康探测。

## 7. 错误响应约定

服务端所有错误响应均为 `{ "error": "<string>" }`，**没有**统一的机器可读 `code` 字段（早期草案中的 `UNAUTHORIZED`/`VERSION_CONFLICT`/`NOT_FOUND`/`RATE_LIMITED` 枚举未实现），客户端按 HTTP 状态码 + `error` 文本做展示映射（并经 `packages/i18n` 翻译为用户可读提示）。

| HTTP | 场景 |
|------|------|
| 400 | 缺少必填字段 |
| 401 | 未携带/无效 token，或用户名密码不匹配 |
| 404 | 用户/资源不存在，或对方尚未上传聊天公钥 |
| 409 | 用户名已被占用（注册），或笔记/附件版本冲突（同步） |
