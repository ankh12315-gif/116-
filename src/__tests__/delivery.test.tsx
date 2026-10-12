import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import fs from 'node:fs';
import path from 'node:path';
import { useFireStore, effectiveTime } from '../store/useFireStore';
import { clearDatasetCache, loadScenarioDataset, validateDatasetQuantization } from '../data/scenarioProvider';
import { describeQuantization, describeSliceSet, temperatureGradientCss } from '../utils/coords';
import type { ScenarioDataset, ScenarioSeries } from '../types/domain';
import StatusBar from '../ui/StatusBar';
import DisclaimerDrawer from '../ui/DisclaimerDrawer';
import { SimpleDeviceCard } from '../ui/SimpleControls';
import { createAlarmAudio } from '../audio/alarmAudio';

const root=path.join(process.cwd(),'public');
const read=(sid:string,file='manifest.json')=>JSON.parse(fs.readFileSync(path.join(root,'assets/results',sid,file),'utf-8'));
const initial=useFireStore.getState();
function renderMarkup(node:ReactNode) {
  const el=document.createElement('div');const root=createRoot(el);
  act(()=>root.render(node));const html=el.innerHTML;act(()=>root.unmount());return html;
}
beforeEach(()=>{vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);useFireStore.setState(initial,true);clearDatasetCache();});
afterEach(()=>vi.unstubAllGlobals());

describe('V1–V4 真实资产与UI回归',()=>{
  for (const sid of ['HV-01-40MW','HV-01-140MW']) {
    it(`${sid}的状态栏、说明公式、精度、帧数一致`,()=>{
      const manifest=read(sid) as ScenarioDataset;
      validateDatasetQuantization(manifest,sid);
      useFireStore.setState({slices:manifest.slices,series:read(sid,'series.json'),hrr:read(sid,'hrr.json')});
      const desc=describeQuantization(manifest.slices[0]);
      const bar=renderMarkup(<StatusBar/>);
      const drawer=renderMarkup(<DisclaimerDrawer open onClose={()=>{}}/>);
      expect(bar).toContain(desc.note);expect(bar).toContain(`${desc.frameCount} 帧最近邻`);
      expect(drawer).toContain(desc.formula);expect(drawer).toContain(`${desc.minC}–${desc.maxC}℃`);
      expect(drawer).toContain(describeSliceSet(manifest.slices)!.clipping);
      expect(desc.stepC).toBeCloseTo(sid.endsWith('140MW')?2000/255:780/255,8);
    });
  }
  it('顶层缺少scaleMode即失败，冗余切片声明不能替代',()=>{
    const m=read('HV-01-40MW');delete m.scaleMode;
    expect(()=>validateDatasetQuantization(m,'HV-01-40MW')).toThrow('manifest.scaleMode');
  });
  it('顶层和切片声明冲突必须失败',()=>{
    const m=read('HV-01-40MW');m.slices[0].quantization.scaleMode='PER_LSB';
    expect(()=>validateDatasetQuantization(m,'HV-01-40MW')).toThrow('不一致');
  });
  it('Provider缺少模式拒绝加载，store显示错误而非白屏或假温度',async()=>{
    const m=read('HV-01-40MW');delete m.scaleMode;
    vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>m})));
    await expect(loadScenarioDataset('HV-01-40MW')).rejects.toThrow('manifest.scaleMode');
    clearDatasetCache();
    useFireStore.setState({scenarios:[{id:'HV-01-40MW',availability:'READY'} as never]});
    await useFireStore.getState().activateScenario('HV-01-40MW');
    expect(useFireStore.getState().datasetStatus).toBe('CONVERSION_ERROR');
    expect(useFireStore.getState().datasetError).toContain('manifest.scaleMode');
    expect(useFireStore.getState().series).toBeNull();expect(useFireStore.getState().slices).toEqual([]);
  });
  it('2020℃图例把950℃定位在真实比例，超出固定色标为颜色平台',()=>{
    const css=temperatureGradientCss('to right','DEFAULT',20,2020);
    expect(css).toContain('rgb(45,21,67) 46.5%');expect(css).toContain('rgb(45,21,67) 100%');
  });
});

describe('16工况实际加载与异步切换',()=>{
  const ids=[...['HV-01','HV-02'].flatMap(c=>[40,70,100,140].map(mw=>`${c}-${mw}MW`)),...[1,2,3,4,5,6,7,8].map(n=>`LV-0${n}-FIRE`)];
  function assetFetch(url:string) {
    const p=path.join(root,url.replace(/^\.\//,''));
    if(!fs.existsSync(p))return Promise.resolve({ok:false,status:404});
    return Promise.resolve({ok:true,status:200,json:async()=>JSON.parse(fs.readFileSync(p,'utf-8')),arrayBuffer:async()=>new Uint8Array(fs.readFileSync(p)).buffer});
  }
  for(const sid of ids)it(`${sid}加载对应清单、标量和切片，不串工况`,async()=>{
    vi.stubGlobal('fetch',vi.fn(assetFetch));
    useFireStore.setState({scenarios:[{id:sid,availability:'READY'} as never]});
    await useFireStore.getState().activateScenario(sid);
    const s=useFireStore.getState();const manifest=read(sid);
    expect(s.datasetStatus).toBe('READY');expect(s.activeScenarioId).toBe(sid);expect(s.datasetError).toBeNull();
    expect(s.slices[0].asset).toBe(manifest.slices[0].asset);expect(s.series).toEqual(read(sid,'series.json'));
    expect(Object.keys(s.sliceData)).toHaveLength(manifest.slices.filter((sl: {plane:string})=>sl.plane==='PBZ').length);
    expect(s.hrr?.peakKW).toBe(manifest.hrr.peakKW);
  });
  it('较慢的旧工况请求不能覆盖新工况',async()=>{
    let release!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;});
    vi.stubGlobal('fetch',vi.fn(async(url:string)=>{if(url.includes('LV-01-FIRE/manifest.json'))await gate;return assetFetch(url);}));
    useFireStore.setState({scenarios:['LV-01-FIRE','LV-02-FIRE'].map(id=>({id,availability:'READY'} as never))});
    const first=useFireStore.getState().activateScenario('LV-01-FIRE');
    await useFireStore.getState().activateScenario('LV-02-FIRE');release();await first;
    const s=useFireStore.getState();expect(s.activeScenarioId).toBe('LV-02-FIRE');expect(s.series).toEqual(read('LV-02-FIRE','series.json'));expect(s.datasetError).toBeNull();
  });
  it('损坏的切片显式提示，不使用伪造温度',async()=>{
    vi.stubGlobal('fetch',vi.fn(async(url:string)=>url.endsWith('.bin')?{ok:false,status:404}:assetFetch(url)));
    useFireStore.setState({scenarios:[{id:'LV-01-FIRE',availability:'READY'} as never]});
    await useFireStore.getState().activateScenario('LV-01-FIRE');
    expect(useFireStore.getState().sliceData).toEqual({});expect(useFireStore.getState().datasetError).toContain('切片加载失败');
  });
});

describe('报警声音生命周期',()=>{
  it('手势解锁后播放；重复播放先停止旧节点；静音/销毁释放音频',async()=>{
    const oscs:Array<{start:ReturnType<typeof vi.fn>;stop:ReturnType<typeof vi.fn>;frequency:{value:number}}> = [];
    const ctx={state:'suspended',currentTime:0,destination:{},resume:vi.fn(async()=>{ctx.state='running';}),close:vi.fn(async()=>{}),
      createOscillator:()=>{const osc={start:vi.fn(),stop:vi.fn(),frequency:{value:0},connect:vi.fn(),disconnect:vi.fn(),type:'sine',onended:null};oscs.push(osc);return osc;},
      createGain:()=>({connect:vi.fn(),disconnect:vi.fn(),gain:{value:0,setValueAtTime:vi.fn(),linearRampToValueAtTime:vi.fn(),exponentialRampToValueAtTime:vi.fn(),cancelScheduledValues:vi.fn()}})};
    vi.stubGlobal('AudioContext',class {constructor(){return ctx;}});
    const audio=createAlarmAudio();expect(audio.play('FIRE_ALARM')).toBe(false);
    expect(await audio.unlock()).toBe(true);expect(audio.play('FIRE_ALARM')).toBe(true);expect(oscs).toHaveLength(3);
    const firstStops=oscs.map(o=>o.stop.mock.calls.length);audio.play('FIRE_ALARM');expect(oscs).toHaveLength(6);
    firstStops.forEach((n,i)=>expect(oscs[i].stop.mock.calls.length).toBeGreaterThan(n));
    audio.stop();expect(oscs[5].stop).toHaveBeenCalled();audio.dispose();expect(ctx.close).toHaveBeenCalled();expect(audio.play('FIRE_ALARM')).toBe(false);
  });
});

describe('时间、报警、简洁卡真实性',()=>{
  const cab=JSON.parse(fs.readFileSync(path.join(root,'assets/scenarios/cabinets.json'),'utf-8')).cabinets;
  const series:ScenarioSeries={...read('LV-01-FIRE','series.json'),timesS:[0,10,20],fireSourceMaxC:[20,200,200]};
  it('未来高温不触发当前报警，当前进入高温才报警',()=>{
    useFireStore.setState({cabinets:cab,selectedCabinetId:'LV-01',datasetStatus:'READY',series,currentTimeS:0});
    useFireStore.getState().setFutureOffset(10);
    expect(useFireStore.getState().alarmState).toBe('NORMAL');
    const card=renderMarkup(<SimpleDeviceCard/>);
    expect(card).toContain('未来');expect(card).toContain('200.0');expect(card).toContain('起火区域测点最高温');expect(card).toContain('其他柜体温度未接入');
    useFireStore.getState().setFutureOffset(null);useFireStore.getState().setTime(10);
    expect(useFireStore.getState().alarmState).toBe('FIRE_ALARM');
    expect(useFireStore.getState().alarmEvents).toHaveLength(1);
    useFireStore.getState().setTime(11);expect(useFireStore.getState().alarmEvents).toHaveLength(1);
    useFireStore.getState().setMuted(true);expect(useFireStore.getState().alarmState).toBe('FIRE_ALARM');
    useFireStore.getState().resetAlarm();expect(useFireStore.getState().alarmState).toBe('NORMAL');
    useFireStore.getState().setTime(12);expect(useFireStore.getState().alarmState).toBe('FIRE_ALARM');
  });
  it('时间上限、未来越界和非法输入拒绝',()=>{
    useFireStore.getState().setTime(1790);useFireStore.getState().setFutureOffset(10);
    expect(effectiveTime(useFireStore.getState())).toBe(1800);
    useFireStore.getState().setFutureOffset(30);expect(useFireStore.getState().futureOffsetS).toBeNull();
    useFireStore.getState().setTime(NaN);expect(useFireStore.getState().currentTimeS).toBe(1790);
    useFireStore.getState().setTime(-10);expect(useFireStore.getState().currentTimeS).toBe(0);
    useFireStore.getState().setPlaybackRate(4);useFireStore.getState().stepTime(1);expect(useFireStore.getState().currentTimeS).toBe(4);
  });
  it('切换柜体立即重置报警和未来状态，加载失败明确告知',async()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>({ok:false,status:404})));
    useFireStore.setState({cabinets:cab,scenarios:[{id:'LV-02-FIRE',cabinetId:'LV-02',zone:'LOW',availability:'READY'} as never],alarmState:'FIRE_ALARM',manualTriggered:true,futureOffsetS:30});
    await useFireStore.getState().selectCabinet('LV-02');
    expect(useFireStore.getState().alarmState).toBe('NORMAL');expect(useFireStore.getState().manualTriggered).toBe(false);expect(useFireStore.getState().futureOffsetS).toBeNull();
    expect(useFireStore.getState().datasetError).toContain('HTTP 404');
  });
});
