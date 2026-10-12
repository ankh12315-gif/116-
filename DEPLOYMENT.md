# 公网发布

本工程是 Vite + React + TypeScript 前端，配套常驻 Node.js 传感器服务。
必须部署 Web Service；只发布 dist 的静态网站无法使用自动监测和温度调控。

## Render 免费部署

1. 仓库：https://github.com/ankh12315-gif/116-
2. 在 Render 创建 Web Service，选择 Public Git Repository 并连接该仓库的 main 分支。
3. 选择 Free（$0/月）和新加坡区域；不要添加付费磁盘、数据库或支付方式。
4. 构建：`npm ci --include=dev && npm run build`。
5. 启动：`npm start`；前端产物为 `dist`。
6. 健康检查：`/api/setup`。
7. 公网地址由 Render 创建服务时生成，部署成功后以面板显示的 HTTPS 地址为准。

也可手动创建 Web Service，使用上述构建、启动命令，设置 HOST=0.0.0.0、NODE_VERSION=22.16.0，计算规格必须选择 Free。

## 再次发布

在工程目录修改代码并执行 `npm run build` 和相关测试，通过后：

```powershell
git add src server public package.json package-lock.json vite.config.ts render.yaml
git commit -m "Update visualization"
git push origin main
```

本次使用公开仓库地址连接，推送后在 Render 服务面板选择 Manual Deploy → Deploy latest commit。通过 Git Provider 或 Blueprint 配置的自动部署属于另一个选项，本次无需启用。

## 保留现有行为的部署配置

- Node 默认仍监听本机 127.0.0.1:5184；云端通过 HOST 和 PORT 覆盖。
- HTTP 和 HTTPS 同主机 Origin 均允许；其他主机仍拒绝。
- public 中的原始运行资产完整保留；安装、构建不会运行 FDS 资产生成脚本。
- .gitattributes 将温度和烟气二进制资产标记为 binary，防止 Git 换行转换。
- node_modules、dist、原始输入备份、本地免安装包和运行日志不上传。

免费服务闲置15分钟后会休眠，首次访问需要等待唤醒。重启会清空内存会话和运行时日志，刷新网页即可重新开始；FDS资产来自仓库，不会因此改变。资产体积约2.1GB，首次推送、云端构建和部分场数据下载会较慢。免费带宽和构建额度以 Render 账户面板为准。
