from pathlib import Path
import json,sys
import numpy as np
from PIL import Image,ImageDraw,ImageFont
from convert_s3d import decompress
ROOT=Path(__file__).resolve().parents[1];folder=ROOT/'public/assets/temperature-v11/HV-01-70MW';source=ROOT.parent/'116-gaoya-window/116-gaoya-1-70mw'
m=json.loads((folder/'manifest.json').read_text(encoding='utf8'))
rgb=np.round(np.loadtxt(ROOT/'src/data/palettes/thermal-rgb.txt')*255)
for i in range(205,256):
 b=(i/255-.8)/.2;rgb[i]=np.round(rgb[i]*(1-b)+np.array([235,24,20])*b)
rgb=rgb.astype(np.uint8);image=Image.new('RGB',(1800,1050),'#f7f5f0');d=ImageDraw.Draw(image)
def text(x,y,t,size=23,color='#303b32'):d.text((x,y),t,font=ImageFont.truetype('C:/Windows/Fonts/msyh.ttc',size),fill=color)
text(48,25,'高压1 · 70MW｜原始FDS温度体数据｜起火后3.606秒',36)
text(48,85,'最高温节点：X=11.9，Y=−12.1，Z=2.1 m；量化解码值 1025.6℃',27,'#b84d32')
vol=[]
for v in m['volumes']:
 f=min(v['frames'],key=lambda f:abs(f['timeS']-3.605975866317749));raw=(source/v['asset']).read_bytes();q=np.frombuffer(bytes(decompress(raw[f['offset']:f['offset']+f['length']],v['ni']*v['nj']*v['nk'])),dtype=np.uint8).reshape(v['nk'],v['nj'],v['ni']);t=20+q*float(1980/254);mask=np.frombuffer((folder/v['maskAsset']).read_bytes(),dtype=np.uint8).reshape(q.shape);xb=v['meshXb'];coords=[np.linspace(xb[2*a],xb[2*a+1],[v['ni'],v['nj'],v['nk']][a]) for a in range(3)];vol.append((v,t,mask,coords))
panels=[(2,2.1,'水平截面 Z≈2.1 m',(115,200),(450,585),(-1,14,-17.5,2),(11.9,-12.1),('X / m','Y / m')),(0,11.9,'纵向截面 X≈11.9 m',(905,240),(585,195),(-17.5,2,0,6.5),(-12.1,2.1),('Y / m','Z / m')),(1,-12.1,'横向截面 Y≈−12.1 m',(905,590),(450,195),(-1,14,0,6.5),(11.9,2.1),('X / m','Z / m'))]
for axis,pos,title,(ox,oy),(w,h),(umin,umax,vmin,vmax),(pu,pv),(xlabel,ylabel) in panels:
 text(ox,oy-53,title,27);su=np.linspace(umin,umax,w);sv=np.linspace(vmax,vmin,h);pixels=np.full((h,w,3),[255,252,247],dtype=np.uint8)
 for meta,t,mask,coords in vol:
  xb=meta['meshXb']
  if not xb[2*axis]<=pos<=xb[2*axis+1]:continue
  idx=np.abs(coords[axis]-pos).argmin()
  if axis==2:plane=t[idx,:,:];valid=mask[idx,:,:];u,v=coords[0],coords[1]
  elif axis==0:plane=t[:,:,idx];valid=mask[:,:,idx];u,v=coords[1],coords[2]
  else:plane=t[:,idx,:];valid=mask[:,idx,:];u,v=coords[0],coords[2]
  cols=np.where((su>=u[0])&(su<=u[-1]))[0];rows=np.where((sv>=v[0])&(sv<=v[-1]))[0];ui=np.abs(su[cols,None]-u[None,:]).argmin(axis=1);vi=np.abs(sv[rows,None]-v[None,:]).argmin(axis=1);values=plane[np.ix_(vi,ui)];air=valid[np.ix_(vi,ui)];colors=rgb[np.rint(np.clip((values-20)/1180,0,1)*255).astype(int)];colors[air==0]=[222,219,212];pixels[np.ix_(rows,cols)]=colors
 image.paste(Image.fromarray(pixels),(ox,oy));d.rectangle((ox,oy,ox+w,oy+h),outline='#888888',width=2)
 for val in np.linspace(umin,umax,4):
  px=ox+(val-umin)/(umax-umin)*w;d.line((px,oy+h,px,oy+h+7),fill='#777777',width=2);text(px-22,oy+h+10,f'{val:g}',19)
 for val in np.linspace(vmin,vmax,4):
  py=oy+h-(val-vmin)/(vmax-vmin)*h;text(ox-82,py-12,f'{val:g}',19)
 text(ox+w+15,oy+h+12,xlabel,20);text(ox-80,oy-38,ylabel,20)
 px=ox+(pu-umin)/(umax-umin)*w;py=oy+h-(pv-vmin)/(vmax-vmin)*h;d.ellipse((px-9,py-9,px+9,py+9),outline='white',width=3);lx=ox+w+24 if axis==2 else min(px+24,ox+w-180);ly=py-38;d.line((px,py,lx,ly+18),fill='#b84d32',width=2);d.rounded_rectangle((lx-8,ly-6,lx+178,ly+40),radius=8,fill='#fffcf7',outline='#b84d32');text(lx,ly,'1025.6℃',24,'#b84d32')
image.paste(Image.fromarray(np.repeat(rgb[None,:,:],24,axis=0)).resize((1100,28)),(350,865))
for t in [20,200,400,600,800,1000,1200]:text(350+(t-20)/1180*1100-23,905,str(t),20)
text(48,945,'固定量程20～1200℃；灰色为实体掩码。粗网格取最近层，未做空间插值。',22)
text(48,985,'来源：116-gaoya-1-70mw_*_3.s3d；无烟气叠加、无透明颜色混合；量化步长约7.80℃。',22)
out=ROOT/'docs/v11/hv01-70mw-3p606-temperature.png';image.save(out);print(out)
