import {it,expect} from 'vitest';
import fs from 'node:fs';
import {decodeRleFrame,nearestFieldFrame,type FieldManifest} from '../data/fieldsV7';
import {temperatureToColor,temperatureGradientCss} from '../utils/coords';
const fixtures=JSON.parse(fs.readFileSync('docs/v7/decoder-fixtures.json','utf8')) as {scenario:string;asset:string;frameIndex:number;sum:number;first:number[];last:number[]}[];
const ids=Array.from(new Set(fixtures.map(x=>x.scenario)));
for(const sid of ids)it(`${sid}真实烟气/HRRPUV清单、初帧及独立Python字节核对`,()=>{
 const base=`public/assets/fields-v7/${sid}/`,m=JSON.parse(fs.readFileSync(base+'manifest.json','utf8')) as FieldManifest;
 expect(m.scenarioId).toBe(sid);expect(m.slices.some(x=>x.plane==='PBX')).toBe(true);expect(m.slices.some(x=>x.plane==='PBY')).toBe(true);
 for(const v of m.volumes){expect(v.frames).toHaveLength(1001);expect(v.frames[0].timeS).toBe(0);expect(v.frames[1000].timeS).toBe(1800);expect(v.dxM).toBeGreaterThan(0);const binary=fs.readFileSync(base+v.asset);
 for(const f of fixtures.filter(x=>x.scenario===sid&&x.asset===v.asset)){const decoded=decodeRleFrame(binary,v.frames[f.frameIndex],v.ni*v.nj*v.nk);expect(decoded.reduce((a,b)=>a+b,0)).toBe(f.sum);expect(Array.from(decoded.slice(0,8))).toEqual(f.first);expect(Array.from(decoded.slice(-8))).toEqual(f.last);expect(nearestFieldFrame(v.frames,v.frames[f.frameIndex].timeS)).toBe(v.frames[f.frameIndex]);}}
});
it('三套固定℃色带不同且色标与取色共享锚点',()=>{expect(temperatureToColor(500,'RAINBOW_A')).not.toEqual(temperatureToColor(500,'RAINBOW_B'));expect(temperatureToColor(500,'SMOKEVIEW')).toEqual([255,45,0]);expect(temperatureGradientCss('to right','SMOKEVIEW',20,1200)).toContain('rgb(255,45,0)');});
