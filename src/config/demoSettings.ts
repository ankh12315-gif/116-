export interface DemoSettings {temperaturesC:Record<string,number>;powerMWByCabinet:Record<string,number>;}
export interface SetupOptions {settings:DemoSettings;cabinetIds:string[];powers:number[];triggerAtS:number;thresholdC:number;holdS:number;}
export function settingsError(settings:DemoSettings,options:SetupOptions):string|null{
 const invalid=options.cabinetIds.find(id=>!Number.isFinite(settings.temperaturesC[id])||settings.temperaturesC[id]<-50||settings.temperaturesC[id]>2000);
 if(invalid)return `${invalid}：请输入−50～2000℃之间的温度`;
 const hot=options.cabinetIds.filter(id=>settings.temperaturesC[id]>=options.thresholdC);
 if(hot.length>1)return `本次仅支持一个起火柜体，请调整：${hot.join('、')}`;
 if(['HV-01','HV-02'].some(id=>!options.powers.includes(settings.powerMWByCabinet[id])))return '请选择高压柜火源功率';
 return null;
}
