import {дорогиПосёлка,построитьПосёлок} from '../src/city/plan.ts';
import {buildWorld} from '../src/world/world.ts';
import {buildNetwork,moveTraffic} from '../src/city/traffic.ts';
import {расселить,кто} from '../src/city/житель.ts';
import {вывестиНаУлицу,жить} from '../src/city/жизнь.ts';
const p=построитьПосёлок(20260913,300,'город'),r=расселить(p),w=buildWorld(дорогиПосёлка(p),'plain'),n=buildNetwork(w),s=вывестиНаУлицу(w,n,r,7.8),id=3561;
const held=s.машины.find(m=>m.хозяин===id);
if(!held) throw new Error('selected car not active');
const route=held.маршрут, deadline=held.доЧаса;
s.машины.splice(0,s.машины.length,held);
s.стоят.splice(0); s.пешие.splice(0);
s.выходы.splice(0,s.выходы.length,...s.выходы.filter(x=>x.номер===id));s.следующий=0;
while(s.следующий<s.выходы.length&&s.выходы[s.следующий].час<=7.8)s.следующий++;
for(let minute=469;minute<=1038;minute++)жить(w,n,r,s,minute/60);
const retained=s.машины.includes(held)&&held.маршрут===route&&held.доЧаса===deadline;
const pending=s.ждут.map(x=>({...x}));
let arrived:number|null=null,resumed:number|null=null,replacedEarly=false;
for(let k=1;k<=18000;k++){
 const elapsed=k*.1,hour=17.3+elapsed/3600;
 moveTraffic(w,n,s.машины,.1,elapsed,{час:hour});
 const goal=route!.цель;
 const atGoal=held.park?.phase==='стоит'||held.park===null&&held.shape===goal.shape&&(deadline===null?Math.abs(held.s-goal.s)<15:(held.s-goal.s)*held.dir>40);
 if(atGoal&&arrived===null)arrived=elapsed;
 жить(w,n,r,s,hour);
 if(held.маршрут!==route&&arrived===null)replacedEarly=true;
 const newTrip=s.машины.find(m=>m.хозяин===id&&(m!==held||m.маршрут!==route));
 if(newTrip){resumed=elapsed;break;}
}
console.log(JSON.stringify({experiment:'single selected car on production network; other actors removed; real moveTraffic after hold',id,retained,pending,arrived,resumed,replacedEarly,active:s.машины.map(m=>({owner:m.хозяин,s:m.s,shape:m.shape,park:m.park?.phase})),day:кто(r,id,0).день},null,2));
process.exit(retained&&arrived!==null&&resumed!==null&&resumed>=arrived&&!replacedEarly?0:1);
