# 班务平台 class-feedback

大学班级的**匿名反馈 + 班务公开 + 决议投票**平台。

线上：[class.whitemoon319.xyz](https://class.whitemoon319.xyz) ｜ 仓库：[WhiteMoon319/class-feedback](https://github.com/WhiteMoon319/class-feedback)

Cloudflare Workers + D1 + R2，vanilla JS 无框架、无前端构建。15 个静态页面、43 个 API 端点、12 张数据表、116 项端到端断言。

---

## 功能

### 面向同学

| 功能 | 说明 |
|---|---|
| 匿名反馈 | 提交后自动跳转详情页，等待班委处理；班委回复与状态变更在详情页可见，可继续补充 |
| 双层假名 | 昵称（根假名）+ 每条反馈独立随机笔名，同人多条反馈无法被浏览者关联 |
| 反馈广场 | 浏览全班反馈、按状态筛选（待处理/处理中/已解决）、页码分页；**游客亦可读** |
| 我的反馈 | 按账号聚合的历史记录，含回复数；班委未回复时可**撤回** |
| 举报 | 详情页内举报违规反馈或回复 |
| 班务公开 | 公告 / 班费收支（凭证图片）/ 决议记录，独立详情页；班费 tab 显示收支结余汇总 |
| 投票 | 一人一票、截止前可改票、实时倒计时；发起方可选「截止前隐藏票数」 |
| 账号设置 | 登录状态改密（其他设备失效、当前设备保持登录）；忘记密码走恢复码重置 |
| 邀请链接 | `/register?code=…` 点开自动填码并预校验有效性，无需手抄邀请码 |
| 移动端 | 汉堡菜单（半透明模糊遮罩）、页码分页、卡片滚动渐入、深浅色跟随系统 |

### 面向班委 / 维护者

| 功能 | 权限 |
|---|---|
| 生成邀请码（学生码 / 班委码 / 维护者码） | 学生码班委可发；班委码与维护者码仅维护者 |
| 班务发布 / 编辑 / 传图 / 删图 / 删除 | 班委 |
| 投票发起 / 提前截止 / 删除 | 班委 |
| 举报处理（隐藏 / 驳回） | 班委 |
| 隐藏内容恢复 | 班委 |
| 成员列表、封禁 / 解封 | 仅维护者 |
| 审计日志查看 | 班委仅本人；全量仅维护者 |
| 审计哈希链校验 | 仅维护者 |

---

## 匿名与安全模型

平台可信不靠承诺，靠架构。

- **数据库不存在任何真实身份字段**（无学号/姓名/邮箱/手机号）
- **昵称（根假名）**：注册时自定义或随机生成，仅本人与封禁管理场景可见，任何对外页面不显示
- **笔名**：每条反馈独立随机，对外唯一可见的名字
- **邀请码与身份解耦**：预校验接口只回状态与类型，**绝不返回使用者**——否则邀请码会与注册者昵称关联
- **IP 不落盘**：仅以 `SHA-256(SESSION_SECRET + 日期 + IP)` 参与限流，原始 IP 不进日志不进库
- **审计日志**：只追加 + 哈希链（`hash(n) = SHA-256(hash(n-1) + payload)`），任何篡改或删除都会断链可查
- **会话**：HMAC 签名 token + HttpOnly + SameSite=Strict + Secure（生产 HTTPS）cookie；改密/重置后旧会话全体失效
- **限流**：登录/提交/注册/重置按 IP 与账号双维度（D1 原子 upsert）

### 权限矩阵

| 操作 | 学生 | 班委 | 维护者(owner) |
| --- | --- | --- | --- |
| 提交反馈 / 回复自己的反馈 / 撤回未回复的反馈 | ✓ | ✓ | ✓ |
| 举报 | ✓ | ✓ | ✓ |
| 学生码生成 | ✗ | ✓ | ✓ |
| 班委码 / 维护者码生成 | ✗ | ✗ | ✓ |
| 公告 / 班费 / 决议管理（编辑、传图、删附件） | ✗ | ✓ | ✓ |
| 举报处理（隐藏 / 驳回）、隐藏内容恢复 | ✗ | ✓ | ✓ |
| 投票管理（提前截止 / 删除） | ✗ | ✓ | ✓ |
| 封禁（含经举报处理） | ✗ | ✗ | ✓ |
| 成员列表与解封 | ✗ | ✗ | ✓ |
| 审计日志 | ✗ | 仅本人 | 全量 |
| 哈希链校验 | ✗ | ✗ | ✓ |

### 输入与请求侧防护

- 全部 SQL 走参数化绑定（无字符串拼接）
- 字段长度与格式校验集中在校验层（`src/lib/http.js`），越界即 400
- 图片上传：mime 白名单（jpeg/png/webp）+ 5MB 上限 + 内容哈希命名，读取经 Worker 代理，不用桶直链
- 写操作校验 `Origin` 同站，跨站请求直接 403（SameSite=Strict 之上再加一层）
- 恢复码一次性、会话可整体失效；口令用 PBKDF2-SHA512 十万次迭代

---

## 数据模型

12 张表（`db/migrations/`，编号迁移）：

| 表 | 作用 | 关键字段 |
|---|---|---|
| `members` | 账号 | `display_name`(根假名) / `password_hash` / `recovery_hash` / `role` / `duty` / `banned` / `session_version` |
| `invites` | 邀请码 | `code` / `type`(student\|committee\|owner) / `duty` / `used`(0 未用 / 1 已用 / -1 作废) |
| `feedbacks` | 反馈工单 | `member_id`(仅后端) / `alias`(对外笔名) / `status` / `hidden` |
| `replies` | 回复 | `feedback_id` / `is_committee` / `anonymous` / `display_name`(笔名或职务) |
| `reports` | 举报 | `target_type` / `target_id` / `handled` |
| `announcements` | 班务 | `category`(announcement\|finance\|minutes) / `amount` / `direction` / `pinned` / `created_duty` |
| `attachments` | 图片 | `announcement_id` / `r2_key` / `mime` / `size` |
| `polls` | 投票 | `options`(JSON) / `hide_results` / `expires_at` |
| `poll_votes` | 选票 | 主键 `(poll_id, member_id)` —— 一人一票，改票即覆盖 |
| `audit_logs` | 审计流水 | `actor_member_id` / `action` / `detail` / `prev_hash` / `hash`（只追加） |
| `audit_head` | 链头单例行 | 写入时 CAS 防并发分叉 |
| `rate_limits` | 限流计数 | `key`（哈希后）/ 窗口 / 计数 |

`feedbacks.member_id` 只在库内存在，任何 API 响应都不返回它——这是匿名模型的技术底座。

---

## API 概览

43 个端点，全部集中在 `src/router.js` 的表里。

| 分组 | 端点 |
|---|---|
| 基础 | `GET /api/health`、`GET /api/invites/:code`（邀请码预校验，游客可读） |
| 认证 | `POST /api/auth/{register,login,logout,reset,password}`、`GET /api/auth/me` |
| 反馈 | `GET /api/feedbacks`、`GET /api/feedbacks/:id`、`GET /api/my/feedbacks`、`POST /api/feedbacks`、`POST /api/feedbacks/:id/{replies,status,report,delete}` |
| 班务 | `GET /api/announcements`、`GET /api/announcements/:id`、`GET /api/finance/summary`、`POST /api/announcements`、`POST /api/announcements/:id/{update,delete,attachments}`、`POST /api/attachments/:id/delete`、`GET /api/attachments/:id` |
| 投票 | `GET /api/polls`、`GET /api/polls/:id`、`POST /api/polls`、`POST /api/polls/:id/{vote,close,delete}` |
| 管理 | `GET`/`POST /api/admin/invites`、`POST /api/admin/invites/:code/void`、`GET /api/admin/{reports,members,hidden,audit}`、`POST /api/admin/reports/:id/handle`、`POST /api/admin/members/:id/ban`、`POST /api/admin/feedbacks/:id/hide`、`POST /api/admin/replies/:id/hide`、`GET /api/admin/audit/verify` |

约定：响应统一为 `{ ok: true, ... }` 或 `{ ok: false, code, message }`；错误 `code` 稳定，可供前端分支判断（如 `has_reply`、`rate_limited`、`name_taken`）。

---

## 技术栈

| 层 | 选型 |
|---|---|
| 运行时 | Cloudflare Workers（静态资产 + fetch handler API + cron） |
| 数据库 | D1（SQLite），编号迁移 |
| 图片 | R2，Worker 代理输出 |
| 前端 | 静态 HTML + CSS + vanilla JS，设计令牌体系，无框架无构建 |
| 构建 | esbuild 打包 Worker 单入口；`scripts/cf-config.mjs` 用模板 + `.env` 生成 wrangler 配置 |
| 测试 | `node --test` 单元测试 + `scripts/smoke.mjs` 端到端冒烟 |
| 动效 | `--ease-out: cubic-bezier(0.23,1,0.32,1)`、卡片 stagger 渐入、骨架 shimmer、`prefers-reduced-motion` 降级 |

---

## 目录结构

```
src/index.js        Worker 入口（fetch + scheduled）
src/router.js       端点总表（单入口 path 分发）
src/api/            auth / invites / feedbacks / announcements / polls / admin
src/lib/            crypto / session / authz / ratelimit / audit / names / http
src/cron.js         每日维护：过期邀请码作废、限流计数清理（审计日志永不清理）
public/             静态前端（15 个页面 + css/tokens.css + css/base.css + js/app.js）
db/migrations/      D1 编号迁移（0001_init、0002_polls）
scripts/            cf-config（配置模板生成）、build-worker（esbuild 打包）、
                    dev-seed（随机种子码）、smoke（端到端冒烟）、bootstrap-owner（首个维护者）
tests/              单元测试（crypto / session / router / names）
TODO.md             后续计划（LLM 周报设想、暂不做的 P3 项）
```

---

## 本地开发

```bash
npm install
cp .env.example .env          # 填 CLASSFEEDBACK_D1_ID（本地可留占位符）
npm run cf:db:local           # 重置本地库 + 迁移 + 随机生成种子邀请码并打印
npm run cf:dev                # http://127.0.0.1:8787
npm test                      # 单元测试 23 项
node scripts/smoke.mjs        # 端到端冒烟 116 项（需先 cf:db:local 且 cf:dev 在跑）
```

- 种子邀请码每次运行随机生成、只写入本地库与 `.wrangler/dev-invites.json`；**仓库内不存任何固定邀请码**。owner 码注册后即为站点维护者。
- 本地密钥与放宽的限流阈值写在 `.dev.vars`（不入库）；生产阈值由代码默认值控制。

### 静态资源版本号约定

前端 CSS/JS 通过 `?v=YYYYMMDDx` 查询串破除浏览器缓存。**修改 `public/css/*` 或 `public/js/*` 后必须升版本号**，否则访问者看不到更新：

```bash
cd public && sed -i 's/v=20260908c/v=20260909/g' *.html
```

---

## 部署

```bash
npx wrangler login
npx wrangler d1 create class-feedback-db        # 记下 database_id 填入 .env
npx wrangler r2 bucket create class-feedback-media
cp .env.example .env                             # 填 CLASSFEEDBACK_D1_ID
npm run cf:deploy                                # 生成配置 + 构建 + wrangler deploy
npx wrangler d1 migrations apply class-feedback-db --remote
npx wrangler secret put SESSION_SECRET           # 会话签名密钥（随机 32+ 字节）
node scripts/bootstrap-owner.mjs                 # 生成首个 owner 邀请码（7 天有效）
```

自定义域在 `wrangler.jsonc.template` 的 `routes` 里声明（`custom_domain: true`），部署时自动绑定，无需面板操作。

**首次引导**：平台没有「注册入口之外」的账号——第一个维护者账号必须由 `bootstrap-owner.mjs` 生成的 owner 邀请码注册，之后班委码由维护者在管理端生成。

---

## 运维

### 数据备份

```bash
# D1 全库导出（结构化 SQL，可用于恢复）
npx wrangler d1 export class-feedback-db --remote --output=backup-$(date +%F).sql

# 审计日志快照（哈希链最新哈希，用于日后校验历史未被改写）
npx wrangler d1 execute class-feedback-db --remote \
  --command "SELECT id, hash, ts FROM audit_logs ORDER BY id DESC LIMIT 1"

# R2 图片：按 key 逐个下载（班级量小，或用 rclone 配置 R2 远端批量同步）
npx wrangler r2 object get class-feedback-media/announcements/<id>/<key>.png --file=backup.png
```

建议频率：每学期一次全量导出 + 重大班务变更后导出一次。备份文件含根假名与业务数据，**不要提交到仓库或公开分享**。

### 恢复

```bash
npx wrangler d1 execute class-feedback-db --remote --file=backup-YYYY-MM-DD.sql
```

### 密钥轮换

`SESSION_SECRET` 轮换会使所有会话立即失效（用户需重新登录），审计哈希链不受影响：

```bash
npx wrangler secret put SESSION_SECRET
```

### 限流阈值调整

阈值由代码默认值提供（登录 10 次/300s、提交 10 次/3600s、注册 8 次/3600s、登录名 5 次/900s）。如需生产调整，在 `wrangler.jsonc` 的 `vars` 中显式声明（注意会覆盖本地 `.dev.vars` 同名值）：

```jsonc
"vars": {
  "LOGIN_RATE_LIMIT_MAX": "20",
  "LOGIN_RATE_LIMIT_WINDOW": "300"
}
```

---

## 故障排查

| 现象 | 原因与处理 |
|---|---|
| `workers.dev` 域名访问超时 | 该域在部分网络不可达，改用自定义域 `class.whitemoon319.xyz` |
| `wrangler dev` 崩溃报 `SQLITE_BUSY` | 同时跑了多个 dev 实例抢同一个 `.wrangler/state`，确保只保留一个 |
| 改了 CSS/JS 但页面没变化 | 静态资源按 `?v=` 缓存，升版本号后强刷（见上文约定） |
| 冒烟测试邀请码报 `bad_invite` | 种子码一次性且每轮重置，先跑 `npm run cf:db:local` 再跑冒烟 |
| 本地库数据混乱想重来 | `npm run cf:db:local` 会重置本地库并重新播种 |
| `git push` 返回 502 | 本地代理临时故障，稍等重试即恢复，非仓库或凭据问题 |

---

## 测试覆盖

**单元测试（23 项）**：口令哈希往返与篡改拒绝、会话 token 验签与版本失效、路由匹配与 405 判定、假名生成与查重。

**端到端冒烟（116 项）**：匿名不变量（列表/详情无 member_id 与根假名）、双层笔名、权限矩阵（学生/班委/维护者）、封禁与举报处理、隐藏内容恢复、反馈撤回规则、单张附件删除、投票（一人一票/改票/隐藏票数/提前截止）、修改密码全流程、成员列表与搜索、班费汇总、邀请码预校验（含使用者信息不泄露）、审计哈希链完整性与可见性、恢复码重置、R2 图片白名单、限流、页码分页数据契约。

---

## 许可

AGPL-3.0-or-later
