# 公网发布

网址：https://fire-116-visualization.vercel.app
仓库：https://github.com/ankh12315-gif/116-

## 当前部署

- 平台：Vercel，cdt 团队，Hobby 免费套餐。
- 框架：Vite + React + TypeScript；根目录 ./。
- 安装：npm ci --include=dev；构建：npm run build；前端输出：dist。
- 接口：api/index.js → server/vercelHandler.cjs，复用原 server/api.cjs 和 Simulation。
- 会话：Upstash Redis fire-116-sessions，Free 套餐（500,000 命令/月）。环境变量由 Vercel 集成注入，不放进代码或仓库。
- FDS 运行资产完整来自 public；原始几何、温度、烟气及算法未改动，构建不运行资产生成脚本。

Render 免费入口要求绑卡，因此未创建 Render 服务，未填写银行卡或付款。
Vercel 和 Redis 均有免费额度限制，不能视为无限用量；不选择 Pro、Pay As You Go 或其他付费套餐。达到免费上限时可能暂停或拒绝请求，应在平台面板查看用量。

## 再次发布

修改后运行 npm run build、npm test 和 npm run test:server，通过后 git add、git commit、git push origin main。
Vercel 自动构建发布；在项目 Deployments 确认 Production 状态 Ready。若只改变环境变量，使用现有生产部署的 Redeploy，应用最新设置。

## 本地与云端会话

npm start 仍使用常驻 Node 监听 127.0.0.1:5184，本地 Map 会话行为不变。云端适配只保存 Simulation 可变状态，不复制或修改 FDS 曲线，并在每次请求恢复原有类方法；跨实例请求通过有期限的锁串行处理。生产与预览会话分开，空闲一小时过期。

健康检查 /api/setup 不依赖 Redis。若设置页能打开但确认后出现“会话服务暂不可用”，检查免费 Redis 是否 Available、是否连接本项目 Production、环境变量是否注入，随后 Redeploy。无需公开或在聊天中粘贴数据库 Token。

FDS 资产约 2.1GB，首次部署及温度场下载需要时间。中国大陆不同网络对 vercel.app 的访问情况可能不同，应以目标电脑实际打开结果为准。