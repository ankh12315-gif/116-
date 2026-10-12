# 交接包构建验证

- FDS 输入：16份，文件名唯一，源文件保存在 `source_fds/`。
- 起火工况目录：16条（8低压 + 8高压），其中 `HV-01-140MW` **源输入有误并已禁用**。
- 起火设备锚点：10个、彼此不同，均从 `VENT SURF_ID='burner'` 的 `XB` 计算中心。
- 源文件已计算 SHA256（位于 `data/fds_audit_full.json`）。
- `MESH/OBST/HOLE/VENT/DEVC/SLCF` 均按源文件审计输出。
- 原 FDS 数据属于模拟输入，交接包不包含经验证的模拟温度输出。
- 完整交互前端尚待 WorkBuddy 实现；交接包是工程输入，不是宣称已经完成的软件。

## 验证命令

```bash
python tools/audit_fds.py
python tools/test_handoff.py
```

当前验证：**7 个检查全部通过**。要交付最终 Web 前端，WorkBuddy 仍需完成 `docs/06_验收测试清单.md` 的工程运行/渲染验证。
