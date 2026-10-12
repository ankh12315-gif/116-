import {it,expect,afterEach} from 'vitest';
import fs from 'node:fs';import path from 'node:path';
import {setMockTemperature,monitorSnapshot,useAutomaticFire} from '../simulation/AutomaticFire';
import {useFireStore} from '../store/useFireStore';
import {heatExtent,visibleHeatAlpha,warmContours} from '../utils/heatPresentation';
import type {SliceMeta} from '../types/domain';
afterEach(()=>setMockTemperature(null));
it('手动MOCK90℃独立修正FDS80℃，不改变原曲线',()=>{
 const curve={timesS:[0,2],temperatureC:[80,80],sampledFdsM:[11.5,-12,4.5],source:'test',sourceSha256:'test',quantity:'GAS'};
 useAutomaticFire.setState({curves:{'HV-01-70MW':curve},fireOriginAbsoluteS:100});useFireStore.setState({activeScenarioId:'HV-01-70MW',currentTimeS:1});
 expect(setMockTemperature(90)).toBe(true);expect(monitorSnapshot(1)).toMatchObject({rawFdsC:80,sensorC:90,correctedC:90,errorBeforeC:10,errorAfterC:0});expect(curve.temperatureC).toEqual([80,80]);
});
it('拒绝无效手动温度且保留上一读数',()=>{setMockTemperature(90);for(const v of [NaN,Infinity,-51,2001])expect(setMockTemperature(v)).toBe(false);expect(useAutomaticFire.getState().manualMockC).toBe(90);});
it('蓝色低温区域轻量可见，热区更醒目，数值不变',()=>{expect(visibleHeatAlpha(20)).toBe(.1);expect(visibleHeatAlpha(60)).toBe(.1);expect(visibleHeatAlpha(955)).toBeLessThanOrEqual(.9);});
it('原PBX回退切片热点仍使用真实FDS坐标和平面水平距离',()=>{
 const sl={asset:'test',plane:'PBX',planeCoordM:11,uRangeM:[-12,-11],vRangeM:[3,4],ni:2,nj:2,frameCount:1,frameTimesS:[0],quantization:{baseC:20,scaleC:780,bits:8,scaleMode:'SPAN'}} as SliceMeta;
 expect(heatExtent([sl],{test:new Float32Array([80,20,20,20])},0,[10,-12,0])).toMatchObject({point:[11,-12,3],maxDistanceM:1});
});
for(const sid of ['HV-01','HV-02'].flatMap(id=>[40,70,100,140].map(mw=>`${id}-${mw}MW`)).concat(Array.from({length:8},(_,i)=>`LV-0${i+1}-FIRE`)))it(`${sid}完整帧Float32清单及长度/时刻有效`,()=>{
 const base=path.join(process.cwd(),'public/assets/thermal-view-v4',sid),m=JSON.parse(fs.readFileSync(path.join(base,'manifest.json'),'utf8'));
 expect(m.storageEncoding).toBe('FLOAT32_LE');for(const sl of m.slices){const b=new Uint8Array(fs.readFileSync(path.join(base,sl.asset)));expect(b.byteLength).toBe(sl.ni*sl.nj*sl.frameCount*4);expect(sl.frameCount).toBe(1001);expect(sl.frameTimesS[0]).toBe(0);expect(sl.frameTimesS[1000]).toBe(1800);}
});
it('955℃峰值来自Float32，SPAN元数据不会把新层截成800；最近帧与轮廓随时间改变',()=>{
 const sl={asset:'test',plane:'PBZ',planeCoordM:3,uRangeM:[0,1],vRangeM:[0,1],ni:2,nj:2,frameCount:2,frameTimesS:[0,1.8],quantization:{baseC:20,scaleC:780,bits:8,scaleMode:'SPAN'}} as SliceMeta;
 const data={test:new Float32Array([20,20,20,20,955,60,20,20])};expect(heatExtent([sl],data,0,[0,0,1]).warmCount).toBe(0);expect(heatExtent([sl],data,1.8,[0,0,1])).toMatchObject({maxC:955,warmCount:2,frameTimeS:1.8});expect(warmContours([sl],data,0).length).toBe(0);expect(warmContours([sl],data,1.8).length).toBeGreaterThan(0);
});
