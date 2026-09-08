# 班务平台 class-feedback

大学班级匿名反馈 + 班务公开 + 决议投票平台。Cloudflare Workers + D1 + R2，vanilla JS 无框架、无前端构建。

部署目标：`class.whitemoon319.xyz`（域名解析到 Worker 自定义域）。

## 功能

- **匿名反馈**：同学以随机笔名向班委提交反馈，班委以职务身份回复并流转状态（待处理/处理中/已解决）
- **双层假名**：注册获得昵称（根假名，可自定义或随机），每条反馈独立随机生成对外笔名——同一人多条反馈无法被浏览者关联
- **班务公开**：公告 / 班费收支（凭证图片存 R2，支持多图上传）/ 决议记录，游客只读，独立详情页；班费 tab 显示收支结余汇总
- **决议投票**：班委发起（2-10 选项、截止时间、可选隐藏票数），一人一票、截止前可改票，实时倒计时与票数进度条
- **账号设置**：登录状态下修改密码（其他设备自动失效，当前设备保持登录）；忘记密码走恢复码重置
- **管理端**：邀请码管理、公告发布/编辑/传图/删除、举报处理、隐藏内容恢复、成员管理与封禁/解封（仅维护者）、审计日志查看与哈希链校验
- **邀请链接**：生成的邀请码附带可直接点开的注册链接（`/register?code=…`），同学点开自动填码；填码前预校验该码是否有效/已用（校验接口不返回使用者，不破坏匿名）
- **移动端**：汉堡菜单（半透明高斯模糊遮罩）、页码分页、卡片滚动渐入

## 匿名与安全模型

平台可信不靠承诺，靠架构：

- **数据库不存在任何真实身份字段**（无学号/姓名/邮箱/手机号）
- **昵称（根假名）**：注册时自定义或随机生成，仅本人与封禁管理场景可见，任何对外页面不显示
- **笔名**：每条反馈独立随机，对外唯一可见的名字
- **IP 不落盘**：仅以 `SHA-256(SESSION_SECRET + 日期 + IP)` 参与限流，原始 IP 不进日志不进库
- **审计日志**：只追加 + 哈希链（`hash(n) = SHA-256(hash(n-1) + payload)`），任何篡改/删除都会断链可查；班委仅可查本人操作，全量仅站点维护者
- **权限矩阵**：

| 操作 | 班委 | 维护者(owner) |
| --- | --- | --- |
| 学生码生成 | ✓ | ✓ |
| 班委码/维护者码生成 | ✗ | ✓ |
| 公告/班费/决议管理（含编辑、传图、删附件） | ✓ | ✓ |
| 举报处理（隐藏/驳回） | ✓ | ✓ |
| 隐藏内容恢复 | ✓ | ✓ |
| 封禁（含经举报处理） | ✗ | ✓ |
| 成员列表与解封 | ✗ | ✓ |
| 投票管理（提前截止/删除） | ✓ | ✓ |
| 审计日志 | 仅本人 | 全量 |
| 哈希链校验 | ✗ | ✓ |

- 会话：HMAC 签名 token + HttpOnly + SameSite=Strict + Secure（生产 HTTPS）cookie；改密/重置后旧会话全体失效
- 限流：登录/提交/注册/重置按 IP 与账号双维度（D1 原子 upsert），阈值生产默认、本地经 `.dev.vars` 放宽

## 技术栈

| 层 | 选型 |
|---|---|
| 运行时 | Cloudflare Workers（静态资产 + fetch handler API + cron） |
| 数据库 | D1，编号迁移（`db/migrations/`） |
| 图片 | R2（班务凭证，mime 白名单 jpeg/png/webp + 5MB 上限，Worker 代理输出） |
| 前端 | 静态 HTML + CSS + vanilla JS，设计令牌体系，深浅色，无框架无构建 |
| 动效 | `--ease-out: cubic-bezier(0.23,1,0.32,1)`、卡片 stagger 渐入、骨架 shimmer、`prefers-reduced-motion` 降级 |

## 目录结构

```
src/index.js        Worker 入口（fetch + scheduled）
src/router.js       端点总表（单入口 path 分发）
src/api/            auth / feedbacks / announcements / admin / polls
src/lib/            crypto / session / authz / ratelimit / audit / names / http
src/cron.js         每日维护：过期邀请码作废、限流计数清理（审计日志永不清理）
public/             静态前端（15 个页面 + css/ + js/）
db/migrations/      D1 编号迁移
scripts/            cf-config（模板生成）、build-worker（esbuild）、
                    dev-seed（随机种子码）、smoke（端到端冒烟）、bootstrap-owner
```

## 本地开发

```bash
npm install
cp .env.example .env          # 填 CLASSFEEDBACK_D1_ID（本地可留占位符）
npm run cf:db:local           # 重置本地库 + 迁移 + 随机生成种子邀请码并打印
npm run cf:dev                # http://127.0.0.1:8787
npm test                      # 单元测试（crypto/session/router/names）
node scripts/smoke.mjs        # 端到端冒烟 90 项（需先 cf:db:local 且 dev 在跑）
```

种子邀请码每次运行随机生成、只写入本地库与 `.wrangler/dev-invites.json`（仓库内不存任何固定邀请码）。其中 owner 码注册后即为站点维护者。

本地放宽限流/密钥写在 `.dev.vars`（不入库）；生产阈值由代码默认值控制。

## 部署

```bash
npx wrangler login
npx wrangler d1 create class-feedback-db        # 记下 database_id 填入 .env
npx wrangler r2 bucket create class-feedback-media
cp .env.example .env                             # 填 CLASSFEEDBACK_D1_ID
npm run cf:deploy                                # 构建 + wrangler deploy
npx wrangler d1 migrations apply class-feedback-db --remote
npx wrangler secret put SESSION_SECRET           # 会话签名密钥（随机 32+ 字节）
node scripts/bootstrap-owner.mjs                 # 生成首个 owner 邀请码（7 天有效）
```

之后在 Cloudflare 面板把 `class.whitemoon319.xyz` 绑定到该 Worker（自定义域）。

**首次引导**：平台没有「注册入口之外」的账号——第一个维护者账号必须由 `bootstrap-owner.mjs` 创建的 owner 邀请码注册，之后班委码由维护者在管理端生成。

## 运维

### 数据备份

```bash
# D1 全库导出（结构化 SQL，可用于恢复）
npx wrangler d1 export class-feedback-db --remote --output=backup-$(date +%F).sql

# 审计日志快照（哈希链最新哈希，用于日后校验历史未被改写）
npx wrangler d1 execute class-feedback-db --remote \
  --command "SELECT id, hash, ts FROM audit_logs ORDER BY id DESC LIMIT 1"

# R2 图片：按 key 逐个下载（班级量小，或使用 rclone 配置 R2 远端批量同步）
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
npx wrangler secret put SESSION_SECRET    # 输入新的随机 32+ 字节
```

### 限流阈值调整

阈值由代码默认值提供（登录 10 次/300s、提交 10 次/3600s、注册 8 次/3600s）。
如需生产调整，在 `wrangler.jsonc` 的 `vars` 中显式声明（注意：会覆盖本地 `.dev.vars` 的同名值）：

```jsonc
"vars": {
  "LOGIN_RATE_LIMIT_MAX": "20",
  "LOGIN_RATE_LIMIT_WINDOW": "300"
}
```

## 冒烟测试覆盖

匿名不变量（列表/详情无 member_id、无根假名）、双层笔名、权限矩阵（学生/班委/维护者）、封禁与举报处理、隐藏内容恢复、反馈撤回（作者权限与「有班委回复不可撤回」规则）、单张附件删除、投票（一人一票/改票/隐藏票数/提前截止）、修改密码全流程、成员列表与搜索、班费汇总、审计哈希链完整性与可见性、恢复码重置、R2 图片白名单、限流、页码分页数据契约。

## 许可

AGPL-3.0-or-later
