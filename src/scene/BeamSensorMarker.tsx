import {Html} from '@react-three/drei';
import {fdsToThree} from '../utils/coords';

/** Screen-sized label anchored to the configured FDS sampling point; no field edits. */
export default function BeamSensorMarker({point}:{point:[number,number,number]}){
 return <Html position={fdsToThree(...point)} zIndexRange={[26,0]}>
  <div className="beam-sensor-marker" role="img" aria-label="梁下模拟传感器位置" data-fds-position={point.join(',')} title={`MOCK梁下气相采样点：${point.join(', ')} m`}>
   <i aria-hidden="true"/><span>梁下传感器</span>
  </div>
 </Html>;
}
