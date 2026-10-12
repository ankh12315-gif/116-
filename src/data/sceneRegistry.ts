import type {SceneMaster} from '../types/domain';
import {assertSceneId,type SceneMode} from '../config/sceneModes';
export async function loadSceneGeometry(mode:SceneMode,id:string,signal?:AbortSignal):Promise<SceneMaster>{
 assertSceneId(mode,id);const r=await fetch(`/assets/scenes/${mode}/geometries/${id}.json`,{signal});if(!r.ok)throw new Error(`当前场景真实几何未接入 (HTTP ${r.status})`);const scene=await r.json();if(scene.sceneMode!==mode||scene.scenarioId!==id)throw new Error('几何场景来源不一致');return scene;
}
export function controlledGeometry(scene:SceneMaster,t:number):SceneMaster{
 const active=(s:{disappearAtS?:number|null})=>s.disappearAtS==null||t<s.disappearAtS;
 return {...scene,solids:scene.solids.filter(active),surfaces:scene.surfaces.filter(active)};
}
export function geometryStateKey(scene:SceneMaster,t:number){return [...scene.solids,...scene.surfaces].filter(s=>s.disappearAtS!=null).map(s=>t<s.disappearAtS!?'1':'0').join('');}
