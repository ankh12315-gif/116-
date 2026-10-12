import {it,expect,vi} from 'vitest';
import {act} from 'react';import {createRoot} from 'react-dom/client';
import SimulationSetup from '../ui/SimulationSetup';
import {settingsError,type SetupOptions} from '../config/demoSettings';
const ids=['HV-01','HV-02',...Array.from({length:8},(_,i)=>`LV-0${i+1}`)];
const options:SetupOptions={cabinetIds:ids,powers:[40,70,100,140],triggerAtS:10,thresholdC:120,holdS:1,settings:{temperaturesC:Object.fromEntries(ids.map(id=>[id,20])),powerMWByCabinet:{'HV-01':70,'HV-02':70}}};
it('settings allow neutral monitoring, identify multiple hot cabinets and validate each high-power selection',()=>{
 expect(settingsError(options.settings,options)).toBeNull();
 const draft=structuredClone(options.settings);draft.temperaturesC['HV-01']=130;expect(settingsError(draft,options)).toBeNull();draft.temperaturesC['LV-03']=130;expect(settingsError(draft,options)).toContain('一个起火柜体');
 draft.temperaturesC['LV-03']=NaN;expect(settingsError(draft,options)).toContain('LV-03');draft.temperaturesC['LV-03']=20;draft.powerMWByCabinet['HV-01']=75;expect(settingsError(draft,options)).toContain('功率');
});
it('all ten sensor inputs and both power groups submit selected settings without mutating the initial draft',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);const host=document.createElement('div'),root=createRoot(host),start=vi.fn();
 const draft=structuredClone(options.settings);draft.temperaturesC['HV-02']=130;
 await act(async()=>root.render(<SimulationSetup options={options} initial={draft} onStart={start}/>));
 expect(host.querySelectorAll('input[type="number"]')).toHaveLength(10);expect(host.querySelectorAll('.setting-power')).toHaveLength(2);
 await act(async()=>(host.querySelector('[aria-label="HV-02 100MW"]') as HTMLButtonElement).click());
 await act(async()=>host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
 expect(start.mock.calls[0][0].powerMWByCabinet['HV-02']).toBe(100);expect(start.mock.calls[0][0].temperaturesC['HV-02']).toBe(130);expect(draft.powerMWByCabinet['HV-02']).toBe(70);
 await act(async()=>root.unmount());vi.unstubAllGlobals();
});
it('multiple hot cabinets visibly block start; returning setup preserves the edited temperatures',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);const host=document.createElement('div'),root=createRoot(host),start=vi.fn(),draft=structuredClone(options.settings);draft.temperaturesC['HV-01']=130;draft.temperaturesC['LV-01']=130;
 await act(async()=>root.render(<SimulationSetup options={options} initial={draft} onStart={start}/>));
 expect(host.querySelector('[role="alert"]')?.textContent).toContain('HV-01、LV-01');expect((host.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(true);
 expect((host.querySelector('[aria-label="HV-01第10秒温度"]') as HTMLInputElement).value).toBe('130');
 await act(async()=>root.unmount());vi.unstubAllGlobals();
});
