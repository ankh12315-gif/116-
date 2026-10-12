// V11 replaces client timers with a backend. Prior fixtures archived in docs/v11.
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {act} from 'react';import {createRoot} from 'react-dom/client';
import fs from 'node:fs';import path from 'node:path';
import {useFireStore} from '../store/useFireStore';
import {clearDatasetCache} from '../data/scenarioProvider';
import AutomaticFire,{useAutomaticFire,monitorSnapshot} from '../simulation/AutomaticFire';
import {ThermalViewLoader} from '../data/thermalView';
import {FieldsV7Loader,useFieldsV7} from '../data/fieldsV7';
const initial=useFireStore.getState();let replies=0;
vi.mock('../scene/TemperatureField',()=>({waitForTemperature:async()=>{}}));
beforeEach(()=>{
 useFireStore.setState(initial,true);clearDatasetCache();replies=0;vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
 vi.stubGlobal('fetch',vi.fn(async(url:string)=>{
  if(url.startsWith('/api/')){replies++;return {ok:true,json:async()=>({id:'test',phase:'FIRE',absoluteS:6,origin:6,actualS:0,displayFdsS:0,offsetS:0,scenarioId:'HV-01-70MW',cabinetId:'HV-01',cabinetSensors:[{id:'HV-01',valueC:130}],beam:{valueC:20,rawFdsC:20,source:'MOCK'},notice:'',pending:null,events:[]})};}
  const p=path.join(process.cwd(),'public',url);if(!fs.existsSync(p))return {ok:false,status:404};const b=fs.readFileSync(p);
  return {ok:true,json:async()=>JSON.parse(new TextDecoder().decode(b)),arrayBuffer:async()=>b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength)};
 }));
});
afterEach(()=>vi.unstubAllGlobals());
it('服务端起火后真实工况温度烟气同源、初始0.5倍速、无10℃偏差',async()=>{
 await useFireStore.getState().init();const root=createRoot(document.createElement('div'));
 await act(async()=>{root.render(<><AutomaticFire/><ThermalViewLoader/><FieldsV7Loader/></>);await new Promise(r=>setTimeout(r,300));});
 expect(replies).toBeGreaterThan(1);expect(useAutomaticFire.getState().phase).toBe('FIRE');
 const s=useFireStore.getState();expect(s.activeScenarioId).toBe('HV-01-70MW');expect(s.playbackRate).toBe(.5);expect(s.playback).toBe('PLAYING');
 expect(useFieldsV7.getState().manifest?.scenarioId).toBe('HV-01-70MW');expect(monitorSnapshot(0).deltaT).toBe(0);await act(async()=>root.unmount());
});
it('没有传感器服务时显式报错暂停，不伪造起火',async()=>{
 await useFireStore.getState().init();vi.stubGlobal('fetch',vi.fn(async()=>({ok:false,json:async()=>({error:'offline'})})));
 const root=createRoot(document.createElement('div'));await act(async()=>{root.render(<AutomaticFire/>);});
 expect(useAutomaticFire.getState().phase).toBe('ERROR');expect(useFireStore.getState().playback).toBe('PAUSED');await act(async()=>root.unmount());
});
