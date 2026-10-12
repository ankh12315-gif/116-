import {it,expect} from 'vitest';
import fs from 'node:fs';import path from 'node:path';
import {decodeRleFrame,nearestFieldFrame} from '../data/fieldsV7';
import {temperatureToColor,BLUE_RED_STOPS} from '../utils/coords';
const root='public/assets/temperature-v11';
for(const id of fs.readdirSync(root))it(`${id}整室多网格温度源、独立量化、时间帧与掩码`,()=>{
 const base=path.join(root,id),m=JSON.parse(fs.readFileSync(path.join(base,'manifest.json'),'utf8'));
 expect(m.scenarioId).toBe(id);expect(m.sceneMode).toBe('windowed');expect(m.volumes.length).toBeGreaterThanOrEqual(4);
 for(const v of m.volumes){
  expect(v.quantity).toBe('TEMPERATURE');expect(v.baseC).toBe(20);expect(v.perLsbC).toBeCloseTo(1980/254,8);
  expect(v.sourceSha256).toMatch(/^[a-f0-9]{64}$/);expect(v.frames.length).toBe(1001);
  const b=new Uint8Array(fs.readFileSync(path.join(base,v.asset))),mask=new Uint8Array(fs.readFileSync(path.join(base,v.maskAsset))),n=v.ni*v.nj*v.nk;
  expect(mask.length).toBe(n);expect(Array.from(mask).every(x=>x===0||x===1)).toBe(true);expect(Array.from(mask).filter(x=>x===0).length).toBe(v.maskedNodes);
  for(const f of [v.frames[0],v.frames[Math.floor(v.frames.length/2)],v.frames[v.frames.length-1]]){const decoded=decodeRleFrame(b,f,n);expect(decoded.length).toBe(n);expect(Math.max(...decoded)).toBe(f.maxByte);expect(nearestFieldFrame(v.frames,f.timeS)?.timeS).toBe(f.timeS);}
 }
});
it('60℃以下恒蓝，无黄色；各模式相同绝对温标，温度越高越红',()=>{
 const blue=temperatureToColor(20,'BLUE_RED');for(const t of [-10,20,40,59.9,60])expect(temperatureToColor(t,'BLUE_RED')).toEqual(blue);
 let last=-1;for(let t=60;t<=1200;t+=10){const [r,g,b]=temperatureToColor(t,'BLUE_RED');expect(r).toBeGreaterThanOrEqual(last);expect(g).toBeLessThan(60);expect(g).toBeLessThan(Math.max(r,b));last=r;}
 expect(BLUE_RED_STOPS.length).toBe(6);expect(temperatureToColor(NaN,'BLUE_RED')).not.toEqual(blue);
});
it('柜体曲线缺失保持缺失标识，不用其他测点冒充；源曲线无+10',()=>{
 const curves=JSON.parse(fs.readFileSync('public/assets/sensors-v11/cabinet-curves.json','utf8'));
 expect(Object.keys(curves)).toHaveLength(16);expect(curves['HV-01-70MW']['LV-07']).toBeUndefined();
 expect(curves['LV-07-FIRE']['LV-07'].locationKind).toBe('CABINET_NEAR_AIR_NOT_VERIFIED_INTERIOR');
 for(const library of Object.values(curves) as Record<string,{temperatureC:number[];timesS:number[]}>[])for(const c of Object.values(library)){expect(c.temperatureC[0]).toBeCloseTo(20);expect(c.temperatureC.length).toBe(c.timesS.length);}
});
