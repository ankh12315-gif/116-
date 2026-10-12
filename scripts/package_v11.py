"""Separate V11 portable artifact. Existing release and FDS files remain intact."""
from pathlib import Path
import json,hashlib,re,shutil,zipfile
ROOT=Path(__file__).resolve().parents[1];delivery=ROOT/'delivery';old=delivery/'116配电室免安装版'
pkg=delivery/'116配电室_V11免安装版';runtime=pkg/'runtime';website=pkg/'website';runtime.mkdir(parents=True,exist_ok=True);website.mkdir(exist_ok=True)
for name in ['node.exe','NODE-LICENSE.txt']:shutil.copy2(old/'runtime'/name,runtime/name)
shutil.copytree(old/'runtime/third-party-licenses',runtime/'third-party-licenses',dirs_exist_ok=True)
shutil.copytree(ROOT/'public',website,dirs_exist_ok=True)
index=(ROOT/'dist/index.html').read_text(encoding='utf8');(website/'index.html').write_text(index,encoding='utf8')
for asset in re.findall(r'(?:src|href)="\./([^\"]+)"',index):
 dest=website/asset;dest.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(ROOT/'dist'/asset,dest)
for name in ['启动可视化.vbs','关闭可视化服务.vbs','备用启动.cmd']:shutil.copy2(old/name,pkg/name)
shutil.copytree(ROOT/'server',runtime/'server',dirs_exist_ok=True)
server=(old/'runtime/server.cjs').read_text(encoding='utf8')
server=server.replace("const server=http.createServer((req,res)=>{","const api=require('./server/api.cjs').createApi(root,path.join(state,'events'));\n const server=http.createServer(async(req,res)=>{\n  if(await api(req,res))return;")
(runtime/'server.cjs').write_text(server,encoding='utf8')
shutil.copy2(ROOT/'docs/v11/116配电室网站说明书_V11.docx',pkg/'116配电室网站说明书_V11.docx')
shutil.copy2(ROOT/'docs/v11/VALIDATION.md',pkg/'开发与验收说明.md')
(pkg/'先读我.txt').write_text('''116配电室 V11 有窗版本 Windows免安装版

1 将整个压缩包完整解压到本地文件夹。
2 双击“启动可视化.vbs”，等待浏览器自动打开。
3 自动起火后，默认2倍速播放真实三维温度。温度与烟气可以独立开关。
4 点击“模拟温度异常”测试同工况后续阶段匹配；升温幅度由真实曲线选择。
5 右上角“传感器温度”中可打开“查看全部传感器与接口”。
6 不再使用时双击“关闭可视化服务.vbs”。系统禁用VBS时用“备用启动.cmd”。

无需安装Node.js、Python或编译工具，数据与本机传感器服务已包含，可离线使用。
仅支持已验证的Windows 10/11 x64环境与支持WebGL2的现代浏览器。
建议8GB以上内存，启用硬件加速；请勿在压缩包内直接运行。
默认5183端口，占用时自动改用空闲端口并打开正确网址。
服务只监听本机127.0.0.1；其他电脑需分别解压启动，不是公网网站。

配置在runtime/server/fire-config.json，修改后先关闭服务，再重新启动。
可修改演示起火柜体、已有高压功率、触发时刻、模拟温度与演示报警门槛。
传感器为MOCK，不代表已有真实设备。10个柜体通道保留来源标识；LV-07在部分
工况缺少可信近点，显示MOCK初始值。柜附近点不冒称柜内传感器。
实际起火后时间和匹配FDS时间分别记录；阶段匹配不是重新计算火灾。
异常按钮每会话注入一次，无可信后续升温候选时明确说明；刷新可以重新测试。
真实设备协议、持续采集、时钟同步和远程部署尚需配合硬件完成。

完整说明书和验收说明已附带。请保留website、runtime和全部启动文件。
''',encoding='utf-8-sig')
manifest={str(p.relative_to(pkg)).replace('\\','/'):{'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in pkg.rglob('*') if p.is_file() and p.name!='文件校验清单.json'}
(pkg/'文件校验清单.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf8');print('Hashed',len(manifest),'files',flush=True)
archive=delivery/'116配电室_V11免安装版.zip'
with zipfile.ZipFile(archive,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=3,allowZip64=True) as z:
 for file in pkg.rglob('*'):
  if file.is_file():z.write(file,str(file.relative_to(delivery)))
digest=hashlib.sha256(archive.read_bytes()).hexdigest();archive.with_suffix('.zip.sha256.txt').write_text(digest+'  '+archive.name,encoding='utf8')
print(archive,archive.stat().st_size,digest,flush=True)
