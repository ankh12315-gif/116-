import {useFireStore} from '../store/useFireStore';
import {sceneModes,type SceneMode} from '../config/sceneModes';
export default function SceneSwitcher(){const s=useFireStore();return <div className="scene-switcher" role="group" aria-label="场景模式">{(['windowed','windowless'] as SceneMode[]).map(mode=><button key={mode} aria-pressed={s.sceneMode===mode} title={sceneModes[mode].sourceNote} onClick={()=>void s.switchSceneMode(mode)}>{sceneModes[mode].label}</button>)}</div>;}
