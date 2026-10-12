import {it,expect} from 'vitest';
import fs from 'node:fs';
import {THERMAL_STOPS,temperatureToColor,temperatureGradientCss} from '../utils/coords';
import {THERMAL_MIN_C,THERMAL_MAX_C} from '../data/palettes/thermal';
import {visualization} from '../config/visualization';

it('thermal keeps the official lower 80%, has a continuous red cap and fixed Celsius range',()=>{
 const rows=fs.readFileSync('src/data/palettes/thermal-rgb.txt','utf8').trim().split(/\r?\n/).map(l=>l.trim().split(/\s+/).map(Number));
 expect(rows).toHaveLength(256);expect(THERMAL_STOPS).toHaveLength(256);
 for(let i=0;i<=204;i++){
  const t=THERMAL_MIN_C+i*(THERMAL_MAX_C-THERMAL_MIN_C)/255;
  expect(temperatureToColor(t,'THERMAL')).toEqual(rows[i].map(v=>Math.round(v*255)));
 }
 expect(THERMAL_STOPS[255][1]).toEqual([235,24,20]);
 for(let i=205;i<256;i++)expect(THERMAL_STOPS[i][1][1]).toBeLessThanOrEqual(THERMAL_STOPS[i-1][1][1]);
 expect(temperatureToColor(-50,'THERMAL')).toEqual(THERMAL_STOPS[0][1]);
 expect(temperatureToColor(2000,'THERMAL')).toEqual(THERMAL_STOPS[255][1]);
 expect(visualization.palette).toBe('THERMAL');expect(visualization.earlyPlaybackRate).toBe(.5);
});
it('volume texture and legend share endpoint mapping and centered texel interpolation',()=>{
 const shader=fs.readFileSync('src/scene/TemperatureField.tsx','utf8');
 expect(shader).toContain('THERMAL_STOPS.flatMap');expect(shader).toContain('(f*255.0+.5)/256.0');
 expect(shader).toContain('THERMAL_MIN_C,THERMAL_MAX_C');
 const gradient=temperatureGradientCss('to right','THERMAL',THERMAL_MIN_C,THERMAL_MAX_C);
 expect(gradient).toContain(`rgb(${THERMAL_STOPS[0][1].join(',')}) 0%`);
 expect(gradient).toContain(`rgb(${THERMAL_STOPS[255][1].join(',')}) 100%`);
});
