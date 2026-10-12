from pathlib import Path
import shutil,re,json,hashlib,zipfile,time
root=Path(__file__).resolve().parents[1]
delivery=root/'delivery'
pkg=delivery/'116配电室免安装版'
runtime=pkg/'runtime';website=pkg/'website'
runtime.mkdir(parents=True,exist_ok=True);website.mkdir(exist_ok=True)
node=Path('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe')
shutil.copy2(node,runtime/'node.exe')
shutil.copytree(root/'public',website,dirs_exist_ok=True)
index=(root/'dist/index.html').read_text(encoding='utf-8')
(website/'index.html').write_text(index,encoding='utf-8')
for asset in re.findall(r'(?:src|href)="\./([^\"]+)"',index):
    target=website/asset;target.parent.mkdir(exist_ok=True,parents=True);shutil.copy2(root/'dist'/asset,target)
vbs='''Option Explicit
Dim fso, shell, base, node, script, command
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
base = fso.GetParentFolderName(WScript.ScriptFullName)
node = fso.BuildPath(base, "runtime\\node.exe")
script = fso.BuildPath(base, "runtime\\server.cjs")
If Not fso.FileExists(node) Then
  MsgBox "请先完整解压，再双击启动。不要在压缩包内直接运行。", 48, "116配电室"
  WScript.Quit 1
End If
command = Chr(34) & node & Chr(34) & " " & Chr(34) & script & Chr(34) & " --open"
shell.Run command, 0, False
'''
(pkg/'启动可视化.vbs').write_text(vbs,encoding='utf-16')
(pkg/'关闭可视化服务.vbs').write_text(vbs.replace(' --open',' --stop'),encoding='utf-16')
cmd='@echo off\r\ncd /d "%~dp0"\r\n"%~dp0runtime\\node.exe" "%~dp0runtime\\server.cjs" --open\r\nif errorlevel 1 pause\r\n'
(pkg/'备用启动.cmd').write_bytes(cmd.encode('ascii'))
readme='''116配电室可视化 Windows免安装版

使用步骤
1. 将整个压缩包解压到电脑任意本地文件夹。不要直接在压缩包内运行。
2. 双击“启动可视化.vbs”。默认浏览器会自动打开网站。
3. 页面自动监测、起火并以2倍速播放。可切换有窗/无窗、暂停、调整时间和倍速。
4. 不再使用时，双击“关闭可视化服务.vbs”。只关闭浏览器不会关闭本地服务。

无需安装Node.js、Python或任何编译工具。完整数据与运行程序已包含，可离线使用。
启动时无需管理员权限，不修改系统配置。只监听本机127.0.0.1，不开放局域网。
首次加载大量温度和烟气数据可能需要等待。优先从电脑本地硬盘运行。

运行条件
Windows 10/11 64位（x64），以及支持WebGL2的Edge或Chrome等现代浏览器。
建议8GB或以上内存、启用浏览器硬件加速、预留至少5GB磁盘空间。
macOS、32位Windows及ARM原生环境未验证，不能直接使用这个x64运行包。

如果无法启动
若系统禁用VBS，双击“备用启动.cmd”。运行时保留命令窗口；关闭它会停止服务。
程序优先使用5183端口，已被占用时自动改用空闲端口，并自动打开对应地址。
不需要手动输入以前的5182地址。再次双击会复用本文件夹已经运行的服务。
如浏览器提示WebGL不可用，检查硬件加速和显卡驱动。程序无法替代电脑显卡能力。
关闭后再次启动即可重新演示。运行日志放在用户LocalAppData中的116FireVisualization目录。

数据说明
温度、烟气与热释放来自原有独立FDS结果，传感器为MOCK模拟值。
点修正不改变空间FDS数据。测试异常匹配不代表真实火灾功率识别。
有窗/无窗名称沿用项目标签，物理边界与缺失工况的说明见附带网站说明书。
未运行新的FDS计算，未将缺少的无窗工况用有窗数据替代。

请完整保留website、runtime和启动文件，勿只复制启动图标。
第三方软件许可见runtime/NODE-LICENSE.txt及runtime/third-party-licenses。
'''
(pkg/'先读我.txt').write_text(readme,encoding='utf-8-sig')
manual=root/'docs/manual/116配电室火灾可视化网站说明书.docx'
if manual.exists():shutil.copy2(manual,pkg/manual.name)
licenses=runtime/'third-party-licenses'
for file in (root/'node_modules').rglob('*'):
    if file.is_file() and file.name.lower() in ['license','license.txt','license.md','licence','licence.txt','copying','notice']:
        dest=licenses/file.relative_to(root/'node_modules');dest.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(file,dest)
manifest={str(p.relative_to(pkg)).replace('\\','/'):{'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in pkg.rglob('*') if p.is_file()}
(pkg/'文件校验清单.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8')
print('Copied and hashed',len(manifest),'files',flush=True)
zip_path=delivery/'116配电室可视化_Windows免安装版.zip'
with zipfile.ZipFile(zip_path,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=3,allowZip64=True) as archive:
    for p in pkg.rglob('*'):
        if p.is_file():archive.write(p,str(p.relative_to(delivery)))
print('Archive',zip_path,'bytes',zip_path.stat().st_size,flush=True)
digest=hashlib.sha256(zip_path.read_bytes()).hexdigest()
(delivery/'116配电室可视化_Windows免安装版.zip.sha256.txt').write_text(digest+'  '+zip_path.name+'\n',encoding='utf-8')
print('SHA256',digest,flush=True)
