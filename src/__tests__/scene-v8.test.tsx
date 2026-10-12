import {beforeEach,afterEach,it,expect,vi} from 'vitest';

import fs from 'node:fs';import path from 'node:path';
import {decodeRleFrame,type FieldManifest} from '../data/fieldsV7';
import {controlledGeometry} from '../data/sceneRegistry';
import {assertSceneId,fieldBase,resultsBase,scenarioInScene} from '../config/sceneModes';
import {useFireStore} from '../store/useFireStore';import {clearDatasetCache} from '../data/scenarioProvider';

import {scoreCandidates,advanceMatcher,createMatcherState,matchingConfig} from '../simulation/scenarioMatcher';
import type {PointCurve} from '../simulation/monitorCorrection';
const read=(p:string)=>JSON.parse(fs.readFileSync(p,'utf8'));
const base='public/assets/scenes/windowless/';
const fixtures=read('docs/v8/decoder-fixtures.json') as {scenario:string;asset:string;frameIndex:number;sum:number;first:number[];last:number[]}[];
for(const sid of new Set(fixtures.map(f=>f.scenario)))it(`${sid}独立源文件RLE核对、温度完整帧、HRR与真实控制几何`,()=>{
 const m=read(`${base}fields/${sid}/manifest.json`) as FieldManifest;
 expect(m.scenarioId).toBe(sid);expect(m.volumes.some(v=>v.quantity==='SOOT DENSITY')).toBe(true);
 for(const v of m.volumes){const b=fs.readFileSync(`${base}fields/${sid}/${v.asset}`);expect(v.frames).toHaveLength(1001);
  for(const f of fixtures.filter(f=>f.scenario===sid&&f.asset===v.asset)){const a=decodeRleFrame(b,v.frames[f.frameIndex],v.ni*v.nj*v.nk);expect(a.reduce((x,y)=>x+y,0)).toBe(f.sum);expect([...a.slice(0,8)]).toEqual(f.first);expect([...a.slice(-8)]).toEqual(f.last);}}
 const thermal=read(`${base}thermal/${sid}/manifest.json`);expect(thermal.sceneMode).toBe('windowless');expect(thermal.slices.length).toBeGreaterThan(0);expect(thermal.slices.every((s:{frameCount:number;planeCoordM:number})=>s.frameCount===1001&&s.planeCoordM===3)).toBe(true);
 const geom=read(`${base}geometries/${sid}.json`),before=controlledGeometry(geom,0),after=controlledGeometry(geom,1800);
 expect(before.solids.length+before.surfaces.length-after.solids.length-after.surfaces.length).toBe(6);
 expect(geom.holes.length).toBe(sid.includes('HV')?12:24);
 expect(read(`${base}results/${sid}/hrr.json`).timesS).toHaveLength(1001);
});
it('无窗缺失柜体/功率与跨场景路径拒绝，不回退既有结果',()=>{
 expect(()=>scenarioInScene('windowless','HV-01',70)).toThrow('缺少');expect(()=>scenarioInScene('windowless','HV-02',40)).toThrow('缺少');
 expect(scenarioInScene('windowless','LV-01',40)).toBe('WL-LV-01-FIRE-B0');
 expect(()=>assertSceneId('windowless','HV-01-40MW')).toThrow('禁止');expect(()=>resultsBase('windowed','WL-HV-01-40MW-B0')).toThrow();expect(()=>fieldBase('windowless','HV-01-40MW','fields')).toThrow();
});
it('构件移除按精确HIDE_OBST时刻，不使用四舍五入的DEVICE_ACT或文件名0s',()=>{
 const geom=read(base+'geometries/WL-HV-01-40MW-B0.json');const original=geom.solids.length+geom.surfaces.length;
 const count=(t:number)=>{const g=controlledGeometry(geom,t);return g.solids.length+g.surfaces.length;};
 expect(count(0)).toBe(original);expect(count(.06)).toBe(original);expect(count(.125251)).toBe(original);expect(count(.125252)).toBe(original-6);
});
it('相似曲线只搜索当前场景；同温度但不同开口时刻或柜体不可自动替换',()=>{
 const curves=read(base+'beam-curves.json') as Record<string,PointCurve>;curves['HV-01-40MW']={...curves['WL-HV-01-40MW-B0'],sceneMode:'windowed'};
 const current='WL-HV-01-40MW-B0',cfg={...matchingConfig,sceneMode:'windowless' as const};
 const scores=scoreCandidates([{absoluteS:30,valueC:90,monitorId:'beam',source:'MOCK',sceneMode:'windowless'}],curves,0,current,cfg);
 expect(scores).toHaveLength(17);expect(scores.filter(x=>x.allowed).map(x=>x.id)).toEqual([current]);
 const result=advanceMatcher(createMatcherState(),{absoluteS:30,valueC:90,monitorId:'beam',source:'MOCK',sceneMode:'windowed'},30,0,current,curves,cfg);
 expect(result.decision.reason).toContain('其他场景');expect(result.state.history).toHaveLength(0);
});
const initial=useFireStore.getState();let callbacks=new Map<number,FrameRequestCallback>(),seq=0;
beforeEach(()=>{useFireStore.setState(initial,true);clearDatasetCache();callbacks=new Map();seq=0;
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);vi.stubGlobal('requestAnimationFrame',(fn:FrameRequestCallback)=>{callbacks.set(++seq,fn);return seq;});vi.stubGlobal('cancelAnimationFrame',(i:number)=>callbacks.delete(i));
 vi.stubGlobal('fetch',vi.fn(async(url:string)=>{const p=path.join(process.cwd(),'public',url);if(!fs.existsSync(p))return {ok:false,status:404};const b=fs.readFileSync(p);return {ok:true,json:async()=>JSON.parse(new TextDecoder().decode(b)),arrayBuffer:async()=>b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength)};}));
});
afterEach(()=>vi.unstubAllGlobals());
it('快速有窗→无窗→有窗→无窗，只提交最终资产，无旧工况时间残留',async()=>{
 await useFireStore.getState().init();const revision=useFireStore.getState().sceneRevision;
 const p1=useFireStore.getState().switchSceneMode('windowless'),p2=useFireStore.getState().switchSceneMode('windowed'),p3=useFireStore.getState().switchSceneMode('windowless');await Promise.all([p1,p2,p3]);
 const s=useFireStore.getState();expect(s.sceneMode).toBe('windowless');expect(s.sceneRevision).toBe(revision+3);expect(s.sceneSwitching).toBe(false);expect(s.scene?.sceneMode).toBe('windowless');expect(s.scenarios).toHaveLength(17);expect(s.activeScenarioId).toBe(null);expect(s.hrr).toBe(null);expect(s.currentTimeS).toBe(0);
});
it('无窗索引延迟返回时切回有窗，旧响应不能覆盖最后一次选择',async()=>{
 await useFireStore.getState().init();const realFetch=fetch;let release!:()=>void;
 const blocked=new Promise<void>(r=>{release=r;});vi.stubGlobal('fetch',vi.fn(async(url:string)=>{if(url.includes('scenes/windowless/scenarios.json'))await blocked;return realFetch(url);}));
 const old=useFireStore.getState().switchSceneMode('windowless');await useFireStore.getState().switchSceneMode('windowed');release();await old;
 const s=useFireStore.getState();expect(s.sceneMode).toBe('windowed');expect(s.scene?.sceneMode).toBe('windowed');expect(s.scenarios).toHaveLength(16);expect(s.loadError).toBe(null);expect(s.sceneSwitching).toBe(false);
});
