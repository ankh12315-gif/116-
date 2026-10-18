# 公网发布

生产网址：http://62.234.143.200
仓库：https://github.com/ankh12315-gif/116-

> HTTP 明文访问，无域名、无证书、无备案。浏览器提示"不安全"是正常现象，不是故障。

## 当前部署（腾讯云 Lighthouse，生产）

| 项 | 值 |
|---|---|
| 实例 | `Ubuntu-166Q` / `lhins-0l46q3ai`，`ap-beijing` |
| 规格 | 2C / 2G / 50G SSD，**出带宽 4 Mbps** |
| 系统 | Ubuntu 22.04.5 LTS，内核 5.15 |
| 代码 | `/opt/fire-116`（Git 仓库，分支 `main`） |
| Node | v22.11.0，npm 10.9.0，装在 `/usr/local/bin` |
| 应用 | systemd `fire116`，`HOST=127.0.0.1 PORT=5184`，`Restart=always` |
| 反代 | Nginx 1.18.0 监听 `0.0.0.0:80` → `127.0.0.1:5184`，`proxy_buffering off` |
| Swap | 4GB `/swapfile`，已入 `/etc/fstab` |
| FDS 资产 | `public/assets` **1802 个文件 / 2003.8 MB**，已被 Git 跟踪 |

`5184` 只绑本机、不放行；对外只有 80。构建需 `NODE_OPTIONS=--max-old-space-size=1536`。

## 一键增量更新

```bash
sudo /tmp/deploy-update.sh --dry-run   # 演练，只预览不改动
sudo /tmp/deploy-update.sh             # 正式更新
```

七阶段：前置检查 → 拉取远端 → 安全闸 → 备份 → 同步源码 → 暂存目录构建 + 原子换名 → 重启与健康检查。

已实测跑通一次真实更新（`3488b96 → ae87d2b`，5 个文件 +61/−18），更新后内网与公网均 HTTP 200、FDS 1802 个文件指纹逐位未变。

### 五条红线（不可放宽）

1. 绝不触碰 `public/assets`——2GB FDS 数据在里面。
2. 绝不执行 `git reset --hard` / `git clean -fd`。
3. 更新前必备份，失败可回滚。
4. 保留 `*.log`、`.env` 与本地配置。
5. 暂存目录构建后原子换名，线上 `dist` 永不是半成品。

### 资产指纹校验

更新前 / 同步后 / 上线后**三次比对**：

```bash
find public/assets -type f -printf '%s %p\n' | LC_ALL=C sort | md5sum
```

当前指纹 `2873eb5fdedbff90b0f6397eb633f4c4`。不一致立即回滚——这是红线 1 的硬证据。

### 回滚触发点

`npm ci` 失败 / `tsc` 或 `vite` 构建失败 / 服务重启失败 / 健康检查非 200 / **FDS 指纹变化**。任一触发即自动回滚：还原 `dist`、还原源码、`git update-ref` 退回分支指针（**不用 `reset`**，属红线）、重启并复检。

> 回滚会同时退分支指针，否则 HEAD 停在新提交而文件是旧的，下次运行会误判"已是最新"，故障被永久掩盖。

## 4 Mbps 带宽下的前端加载（必读，别改回去）

单工况首屏资产约 **69MB**（`fields-v7` 56MB + `thermal-view-v4` 6.9MB + `temperature-v11` 3.1MB + `results` 2.5MB），按 0.5 MB/s 理论需 **≥138s**。这与前端超时是**结构性矛盾**，已在 `ae87d2b` 修复，两道门都要放宽：

1. **两阶段加载**：`src/data/fieldsV7.ts` 阶段 A 只拉小体积 HRRPUV 卷即放行 FIRE，阶段 B 后台拉 SOOT 与 slices。
2. **超时 45s → 180s**：`src/data/presentationReady.ts`，可用 `VITE_PRESENTATION_TIMEOUT_MS` 覆盖。
3. **重试 + 串行**：公网 TCP 层会中断大文件传输（`ERR_CONTENT_LENGTH_MISMATCH`）。**有限重试（3次，退避 500/1500/3000ms，仅网络层错误）与并发改串行必须同时做**——实测只加重试仍会换一个文件继续失败。

实测 FIRE 阶段 55–56s 就绪，真实浏览器验收 **27/27 PASS**，四类 FDS 数据零缺失（`thermal-view-v4` 6 / `fields-v7` 18 / `temperature-v11` 11 / `results` 30）。

## 再次发布

改代码后 `npm run build`、`npm test`、`npm run test:server`，通过后提交推送；服务器侧跑 `sudo /tmp/deploy-update.sh`。

**GitHub 加速**：服务器直连 `github.com` 超时。仓库 ~972MB，只有 `ghfast.top` 可用（实测 5 MB/s），`ghproxy.net` 约 20 KB/s 且 HTTP/2 断流。remote 形如 `https://ghfast.top/https://github.com/ankh12315-gif/116-.git`。

⚠️ **增量更新绝不能 `git pull` / `git checkout -- .`**——`public/assets` 被 Git 跟踪，那样会把 2GB 资产重新落盘。只对白名单源码路径操作。

## 历史部署：Vercel（保留，未触碰）

网址：https://fire-116-visualization.vercel.app

Vercel Hobby 免费套餐 + Upstash Redis `fire-116-sessions`（Free，500,000 命令/月）。接口 `api/index.js` → `server/vercelHandler.cjs`，复用 `server/api.cjs` 与 `Simulation`。会话空闲一小时过期，生产与预览分开。健康检查 `/api/setup` 不依赖 Redis。

Vercel 与 Redis 均有免费额度上限，达到后可能暂停或拒绝请求，不选任何付费套餐。FDS 资产约 2.1GB，首次部署与温度场下载需要时间；大陆网络对 `vercel.app` 的访问情况可能不同，以目标电脑实际打开结果为准。

## 遗留

- **SSH 22 仍对 `0.0.0.0/0` 全开放**（用户已选"暂不调整"，建议后续收紧白名单）。
- 未配 HTTPS：无域名、无备案，符合当前预期。
- `SceneSwitcher`（有窗/无窗按钮）是 dead component——已定义但无任何渲染入口。这是代码现状，不是部署缺陷。
- `docs/v7|v8/*.json` 测试夹具缺失导致 2 个单测失败，非功能回归。
- `/opt/fire-116` 已恢复完整 Git 历史（原为 shallow clone，`git fetch --unshallow origin main`）。远端只有 `main` 一个分支，`master` 不存在。
- 仓库无 `docs/` 目录，`start.cjs` 里 `../docs/v11/runtime-events` 不存在，但代码按需 mkdir，不影响运行。