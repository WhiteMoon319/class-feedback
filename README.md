# 班务平台 class-feedback

大学班级匿名反馈 + 班务公开平台。Cloudflare Workers + D1 + R2，无框架、无前端构建。

## 匿名模型

- **根假名**：注册时随机分配（如「沉默的橘子」），固定不变，仅本人与后端可见，是封禁依据
- **笔名**：每条反馈提交时独立随机生成，是对外唯一可见的名字；同一人的多条反馈无法被浏览者关联
- **职务署名**：班委回复默认署职务（班长/生活委员），可按条自选匿名（显示「班委」）
- 数据库不存在任何真实身份字段；IP 只以 SHA-256(IP + 当日盐) 参与限流，原始 IP 不落盘

## 审计日志

只追加、带哈希链（`hash(n) = SHA-256(hash(n-1) + payload(n))`）。记录「哪个根假名做了什么」，
不含真实身份与原始 IP。班委仅可查本人操作记录，全量与链校验仅维护者可查。

## 部署

```bash
npm install
cp .env.example .env          # 填 CLASSFEEDBACK_D1_ID
npx wrangler d1 create class-feedback-db
npx wrangler r2 bucket create class-feedback-media
npm run cf:config
npm run cf:deploy
npx wrangler d1 migrations apply class-feedback-db --remote
npx wrangler secret put SESSION_SECRET
```

## 本地开发

```bash
npm run cf:db:local           # 重置 + 迁移 + 随机生成种子邀请码（打印到控制台）
npm run cf:dev                # http://localhost:8787
npm test
node scripts/smoke.mjs        # 端到端冒烟（需先 cf:db:local 且 cf:dev 在跑）
```

种子邀请码每次运行随机生成、只写入本地库（写入 .wrangler/dev-invites.json 供冒烟读取），
**仓库内不存任何固定邀请码**。其中 owner 码注册后即为站点维护者。

## 目录

```
src/index.js        Worker 入口（fetch + scheduled）
src/router.js       端点总表
src/api/            auth / feedbacks / announcements / admin
src/lib/            crypto / session / authz / ratelimit / audit / names / http
src/cron.js         每日维护：过期邀请码作废、限流计数清理
public/             静态前端（HTML + CSS + vanilla JS）
db/migrations/      D1 编号迁移
scripts/            配置模板生成、esbuild 打包
```

## 许可

AGPL-3.0-or-later
