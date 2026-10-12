import {it,expect,vi,afterEach} from 'vitest';
import {act} from 'react';
import {createRoot} from 'react-dom/client';
import BeamSensorMarker from '../scene/BeamSensorMarker';
import PredictionNotice from '../ui/PredictionNotice';
import {injectMockAnomaly,useAutomaticFire} from '../simulation/AutomaticFire';
vi.mock('@react-three/drei',()=>({Html:({position,children}:{position:number[];children:React.ReactNode})=><div data-world={position.join(',')}>{children}</div>}));
afterEach(()=>vi.unstubAllGlobals());
it('pending notice shows the deviation plus matching line; success replaces both',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);const host=document.createElement('div'),root=createRoot(host);
 await act(async()=>root.render(<PredictionNotice text="梁下传感器温度与预测值偏差 +31.0℃" matching/>));
 expect(host.textContent).toBe('梁下传感器温度与预测值偏差 +31.0℃正在匹配');expect(host.querySelector('.matching-dots')).not.toBeNull();
 await act(async()=>root.render(<PredictionNotice text="后续预测已更新"/>));
 expect(host.textContent).toBe('后续预测已更新');expect(host.querySelector('.matching-line')).toBeNull();await act(async()=>root.unmount());
});
it('successful injection immediately updates the notice and marker state without waiting for polling',async()=>{
 const old=useAutomaticFire.getState();useAutomaticFire.setState({sessionId:'beam-test'});
 const snapshot={mockInjected:true,anomalyAvailable:false,beam:{position:[11.5,-12,4.5]},deltaC:31.8,notice:'梁下传感器温度与预测值偏差 +31.8℃'};
 vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>snapshot})));
 expect(await injectMockAnomaly()).toEqual({deltaC:31.8});
 expect(useAutomaticFire.getState().snapshot?.mockInjected).toBe(true);expect(useAutomaticFire.getState().predictionNotice).toBe(snapshot.notice);
 useAutomaticFire.setState(old,true);
});
it('beam label is anchored to the actual FDS point with the existing axis conversion',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);const host=document.createElement('div'),root=createRoot(host);
 await act(async()=>root.render(<BeamSensorMarker point={[11.5,-12,4.5]}/>));
 expect(host.querySelector('[data-world]')?.getAttribute('data-world')).toBe('11.5,4.5,12');
 expect(host.querySelector('[role="img"]')?.getAttribute('data-fds-position')).toBe('11.5,-12,4.5');expect(host.textContent).toBe('梁下传感器');
 await act(async()=>root.unmount());
});
