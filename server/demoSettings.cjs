const POWERS=[40,70,100,140];
function defaultSettings(cabinets){return {temperaturesC:Object.fromEntries(cabinets.map(c=>[c.id,20])),powerMWByCabinet:{'HV-01':70,'HV-02':70}};}
function validateSettings(input,cabinets,thresholdC,beam){
 if(!input||typeof input!=='object'||Array.isArray(input))throw Error('设置格式无效');
 const ids=cabinets.map(c=>c.id),temperaturesC={},powerMWByCabinet={};
 if(!input.temperaturesC||Object.keys(input.temperaturesC).length!==ids.length||Object.keys(input.temperaturesC).some(id=>!ids.includes(id)))throw Error('请设置全部10个柜体的温度');
 for(const id of ids){const value=input.temperaturesC[id];if(typeof value!=='number'||!Number.isFinite(value)||value< -50||value>2000)throw Error(`${id}温度须在−50～2000℃之间`);temperaturesC[id]=value;}
 for(const id of ['HV-01','HV-02']){const power=input.powerMWByCabinet?.[id];if(!POWERS.includes(power)||!beam[`${id}-${power}MW`])throw Error(`${id}请选择可用的火源功率`);powerMWByCabinet[id]=power;}
 const hot=ids.filter(id=>temperaturesC[id]>=thresholdC);
 if(hot.length>1)throw Error(`本次仅支持一个起火柜体，请调整：${hot.join('、')}`);
 return {temperaturesC,powerMWByCabinet};
}
module.exports={POWERS,defaultSettings,validateSettings};
