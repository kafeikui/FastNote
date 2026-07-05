# FastNote 数据库 / 存储 Schema

> 本文档描述**当前实现**。客户端（Web 与 Electron）统一使用 IndexedDB，不使用 SQLite；服务端使用单个 JSON 文件持久化，不使用 SQLite。如果未来切换存储引擎，请同步更新本文档。

## 1. 客户端本地存储（IndexedDB，`packages/storage`，Web/Electron 共用同一实现）

数据库名由 `storageDbName(namespace)` 生成（`packages/api`），`namespace` 对应多保险库（vault registry）中的某一个库，因此**每个本地库是一个独立的 IndexedDB 数据库**。当前 `DB_VERSION = 4`。

所有加密字段均为 `{ ciphertext, nonce }` 拆开存成 `xxxEnc` + `xxxNonce` 两列（Base64 字符串），使用 AES-256-GCM。

### 1.1 `vault_meta`（key-value）

| key（示例） | value | 说明 |
|------|-------|------|
| `salt` | string | Argon2id salt |
| `password_verifier` | string | 密码校验值 |
| `wrapped_identity_key` / `wrapped_exchange_key` | string | 用 `wrap_key` 包装的 IM 密钥对 |
| `identity_pubkey` / `exchange_pubkey` | string | 明文公钥（用于聊天） |
| `search_index_snapshot` | string | 加密后的 MiniSearch 快照 |
| `chat_sessions` | string | 加密后的 IM 会话状态（`IMSessionState[]`，见下） |
| `chat_storage_migrated` / `bound_username` | string | 迁移标记 / 绑定账号 |

对应键名定义于 `packages/shared` 的 `META_KEYS`。

### 1.2 `notes_local`（keyPath: `id`）

笔记、文件夹、表格文档统一存于此表，用 `nodeType` 区分。

| 字段 | 类型 | 说明 |
|------|------|------|
| id | string | UUID，主键 |
| parentId | string \| null | 父节点，null=根 |
| nodeType | `'folder' \| 'note' \| 'table'` | 节点类型 |
| titleEnc / titleNonce | string | 加密标题 |
| contentEnc / contentNonce | string | 加密正文；`note`=Markdown 字符串，`table`=表格 JSON 序列化字符串，`folder`=空 |
| sortOrder | number | 同级排序 |
| version | number | 本地版本号，每次修改自增 |
| serverVersion | number | 最近一次同步成功时的服务端版本 |
| contentHash | string | 内容哈希，用于同步校验 |
| syncStatus | `'synced' \| 'pending' \| 'conflict'` | 同步状态（无独立 sync_queue 表，直接扫描该字段） |
| deleted | number (0/1) | 软删除 |
| updatedAt | string | ISO8601 |

### 1.3 `attachments_local`（keyPath: `id`，索引 `by_note` → `noteId`）

笔记/表格的附件，字段命名与 `notes_local` 同构：

| 字段 | 说明 |
|------|------|
| id / noteId | 附件 ID / 所属笔记 ID |
| metaEnc/metaNonce | 加密元数据（文件名、描述、MIME、体积） |
| dataEnc/dataNonce | 加密后的文件二进制（Base64） |
| version / serverVersion / syncStatus / deleted / updatedAt | 同步字段，语义同笔记 |

### 1.4 `chat_messages_local`（keyPath: `id`，索引 `by_peer` → `peerId`）

聊天消息（本地永久保存，与账号登录状态无关；登录云账号后会额外做一次简化版历史同步，见 §2.5）：

| 字段 | 说明 |
|------|------|
| id | 消息 ID |
| peerId | 对方 user_id |
| direction | `'in' \| 'out'` |
| payloadEnc/payloadNonce | 加密后的 `ChatStoredPayload`（`{ v, body, peerUsername?, attachments?, status? }`），密钥来自本地 `notes_key`（与传输层的 IM 会话密钥是两套不同的密钥） |
| sentAt | ISO8601 |
| synced | boolean（可选，旧数据视为 `false`）——是否已推送到服务端 `chat_blobs`；只用于「推一次」的去重，不代表本地是否已从服务端拉取过 |

### 1.5 `chat_attachments_local`（keyPath: `id`，索引 `by_message` → `messageId`）

| 字段 | 说明 |
|------|------|
| id / messageId / peerId | 附件 ID / 所属消息 / 对方 |
| metaEnc/metaNonce | 加密元数据 |
| dataEnc/dataNonce | 加密后的文件数据 |
| updatedAt | ISO8601 |

### 1.6 IM 会话状态（存于 `vault_meta.chat_sessions`，非独立表）

不是 Signal 风格的 Double Ratchet 状态机，而是一个轻量结构（`IMSessionState`，定义于 `packages/shared`）：

```ts
interface IMSessionState {
  peerId: string;
  peerUsername: string;
  peerExchangePubkey: string; // Base64
  sendCounter: number;
  recvCounter: number;
  rootKey: string; // Base64，X25519 ECDH + HKDF 派生，双方各自计算得到相同值
}
```

### 1.7 `localStorage`（不在 IndexedDB 内，未加密的本地配置/元数据）

| key | 说明 |
|-----|------|
| `fastnote_vault_registry` | 多保险库列表（每项含 namespace、label、创建时间等），支持同设备多个独立加密库 |
| `fastnote_locale` | 当前界面语言（`zh` \| `en`） |
| `fastnote_server_url` | 自托管服务器地址（同时驱动运行时 CSP 白名单） |
| `fastnote_ui_theme` | 界面主题 |
| `fastnote_note_width` | 笔记内容区宽度偏好 |
| `fastnote_chat_notify` | 消息提醒设置（气泡开关、音效、音量） |
| 会话 / 未读数 / 存储路径标签 等其它 key | 均为非敏感的本地 UI 状态，见 `packages/api/src/index.ts` |

这些内容本身不是密文数据，但也不包含任何笔记正文或密钥材料，仅为设备本地的偏好与索引信息。

---

## 2. 服务端存储（`server/`，JSON 文件，非 SQLite）

服务端使用自研的 `JsonRelayStore`（`server/src/store.ts`），所有状态保存在单个 `data/relay.json` 文件中（写入采用"写临时文件 + rename"防止半写损坏，变更后 200ms 防抖落盘）。**服务端任何情况下都不持有明文笔记内容、聊天正文或主密钥**，只持有密文、版本号和用于路由/鉴权的公钥、用户名等元数据。

```ts
interface RelayData {
  users: UserRecord[];
  note_blobs: Array<NoteBlobRecord & { user_id: string }>;
  attachment_blobs: Array<AttachmentBlobRecord & { user_id: string }>;
  message_queue: MessageQueueRecord[];
  chat_blobs: Array<ChatBlobRecord & { user_id: string }>;
}
```

### 2.1 `users`

| 字段 | 类型 | 说明 |
|------|------|------|
| id | string | UUID |
| username | string | 唯一 |
| password_verifier | string | 客户端派生的校验值（非明文密码） |
| identity_pubkey | string \| null | Base64 公钥（当前主要预留，聊天实际只用 exchange_pubkey） |
| exchange_pubkey | string \| null | Base64 X25519 公钥，用于聊天密钥交换 |
| vault_salt | string \| null | 用于云端保险库解锁的 salt（`GET/PUT /api/v1/vault-salt`） |
| created_at | string | ISO8601 |

### 2.2 `note_blobs`（含 `user_id`，逻辑主键 `(user_id, note_id)`）

| 字段 | 类型 | 说明 |
|------|------|------|
| note_id | string | 笔记/表格文档 ID（与本地 `notes_local.id` 一致） |
| ciphertext | string | Base64 密文（对应本地 title+content 打包后的密文，具体打包方式见 `packages/sync`） |
| version | number | 单调递增，冲突检测用 |
| content_hash | string \| null | 校验用 |
| deleted | 0/1 | 软删除 |
| updated_at | string | ISO8601 |

> 说明：**没有单独的 `manifests` 表**——目录树结构（父子关系、排序）随每个笔记节点一起加密同步在 `note_blobs` 里，服务端不单独维护目录树。

### 2.3 `attachment_blobs`（含 `user_id`，逻辑主键 `(user_id, attachment_id)`）

| 字段 | 类型 | 说明 |
|------|------|------|
| attachment_id | string | 附件 ID |
| note_id | string | 所属笔记/表格 |
| meta_ciphertext | string | 加密元数据 |
| data_ciphertext | string | 加密文件数据（Base64） |
| version | number | |
| deleted | 0/1 | |
| updated_at | string | |

### 2.4 `message_queue`（离线聊天消息暂存）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | string | 消息 ID |
| from_user / to_user | string | 收发双方 user_id |
| payload | string | JSON 字符串化的 IM 密文信封（`{ counter, nonce, ciphertext }`） |
| created_at | string | ISO8601 |

对方通过离线补拉（`GET /api/v1/messages/pending` 之后）ack 时会调用 `DELETE /api/v1/messages/:id` 从队列移除；对方**在线、走 WebSocket 实时收到**该消息时，也会在回发 `delivery_ack` 的同时由服务端顺带调用同一个 `deleteMessage` 清理队列（`server/src/index.ts` 的 `delivery_ack` 分支），避免实时送达成功的消息永远滞留在队列里被反复重试。这张表本身**没有 `delivered`/`read` 标记字段**——它只是一个"未确认收件箱"，送达/已读状态是通过 WebSocket 上单独的 `delivery_ack`/`read_ack` 控制帧尽力而为地实时转发给发送者、再由发送者客户端在自己本地的 `chat_messages_local` 里更新 `status` 字段完成的（见 §2.3 与 `docs/PROTOCOL.md` §4），并不经过这张表持久化。

### 2.5 `chat_blobs`（含 `user_id`，逻辑主键 `(user_id, message_id)`，聊天历史云同步）

| 字段 | 类型 | 说明 |
|------|------|------|
| message_id | string | 消息 ID，与本地 `chat_messages_local.id` 一致 |
| peer_id | string | 对方 user_id |
| direction | `'in' \| 'out'` | |
| ciphertext | string | 本地已加密的 `chat_messages_local.payloadEnc`+`payloadNonce` 直接打包成 wire 格式后原样上传（服务端不解密、不重新加密） |
| sent_at | string | ISO8601 |
| updated_at | string | ISO8601，服务端写入时间 |

与 `note_blobs`/`attachment_blobs` 不同，聊天消息视为不可变（没有版本号/冲突副本机制）：`PUT /api/v1/sync/chat/:messageId` 只在本地消息尚未标记 `synced` 时推送一次；`GET /api/v1/sync/chat` 拉取该账号下的全部消息，客户端对本地已存在的 `id` 直接跳过（不会用远端内容覆盖本地，因此本地对 `status` 字段的后续更新——送达/已读——不会被拉取覆盖，但也不会再被重新推送同步到其他设备）。这张表与 `message_queue`（§2.4）是两套完全独立的机制：`message_queue` 是離線期间的临时收件箱，送达后即删除；`chat_blobs` 是账号维度的永久历史副本，用于新设备登录云账号后补齐历史聊天记录。

> 说明：**没有 `prekeys` 表和 `devices` 表**——当前 IM 只用注册时/设置里上传的单一静态 `exchange_pubkey` 做 ECDH，没有 Signal 风格的一次性/签名预密钥体系，也不做多设备管理。

## 3. 加密字段与密钥对照

| 数据 | 密钥来源 | 算法 |
|------|------|------|
| 笔记/表格 title & content（本地 + 同步密文） | `notes_key = HKDF(MK, info="fastnote-notes-v1")` | AES-256-GCM |
| 笔记/聊天附件 meta & data | `notes_key` | AES-256-GCM |
| 搜索索引快照 | `index_key = HKDF(MK, info="fastnote-index-v1")` | AES-256-GCM |
| 保险库包装密钥（用于包装 identity/exchange 密钥对） | `wrap_key = HKDF(MK, info="fastnote-vault-v1")` | AES-256-GCM |
| 聊天消息传输密文 | 每条消息独立密钥 = `HKDF(root_key, info="fastnote-msg-{counter}")`；`root_key = HKDF(ECDH(my_exchange_priv, peer_exchange_pub), info="fastnote-im-v1")` | AES-256-GCM |
| 聊天消息本地存储 | `notes_key`（与传输密钥是两套独立密钥，本地落盘不复用传输密钥） | AES-256-GCM |

`MK`（主密钥）本身由用户密码通过 Argon2id 派生，只存在于解锁后的内存中，从不落盘、从不上传。
