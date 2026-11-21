import { дорогиПосёлка, построитьПосёлок } from '../src/city/plan.ts';
import { buildWorld } from '../src/world/world.ts';
import { buildNetwork,moveTraffic } from '../src/city/traffic.ts';
import { расселить,кто,где } from '../src/city/житель.ts';
import { вывестиНаУлицу,жить,своиМеста } from '../src/city/жизнь.ts';
import { moveWalkers } from '../src/city/walkers.ts';
const p=построитьПосёлок(20260913,300,'город'),r=расселить(p),w=buildWorld(дорогиПосёлка(p),'plain'),n=buildNetwork(w);
const start=17.4,s=вывестиНаУлицу(w,n,r,start),own=своиМеста(w,n,r),initial=new Set(s.стоят.map(m=>m.хозяин));
const targets=new Set([5258,5262,5384,4172,192,1240,283,682]); const assigned=new Map<number,number>();
for(let step=1;step<=36000;step++) {const time=step*.1,hour=start+time/3600;moveWalkers(w,n,s.пешие,.1,time);moveTraffic(w,n,s.машины,.1,time,{час:hour,crossing:s.пешие.filter(w=>w.crossing>0).map(w=>({shape:w.shape,s:w.s}))});жить(w,n,r,s,hour); for(const m of [...s.машины,...s.стоят]) { if(!targets.has(m.хозяин)||m.park===null||assigned.get(m.хозяин)===m.park.bay)continue; assigned.set(m.хозяин,m.park.bay); const ownBay=own.get(m.хозяин); if(m.park.bay!==ownBay) console.log(JSON.stringify({event:'assigned-other-bay',hour,owner:m.хозяин,bay:m.park.bay,own:ownBay,phase:m.park.phase,ownTaken:n.bays[ownBay!].taken,otherCars:[...s.машины,...s.стоят].filter(o=>o!==m&&o.park?.bay===ownBay).map(o=>({owner:o.хозяин,phase:o.park!.phase}))})); }}
let returned=0,atOwn=0,atOther=0,occupied=0;
for(const m of [...s.стоят,...s.машины]) {if(m.park?.phase!=='стоит'||initial.has(m.хозяин))continue;const home=own.get(m.хозяин),resident=кто(r,m.хозяин,0),place=где(resident,start+1);if(home===undefined||place.где!=='дома')continue;returned++;if(m.park.bay===home){atOwn++;continue;}atOther++;const busy=[...s.стоят,...s.машины].some(o=>o!==m&&o.park?.bay===home);if(busy)occupied++;
console.log(JSON.stringify({owner:m.хозяин,occupied:busy,preferred:m.стоянка,park:m.park,own:home,actualGoal:m.маршрут?.цель,schedule:resident.день,pending:s.ждут.filter(e=>e.номер===m.хозяин),position:{shape:m.shape,s:m.s},bay:n.bays[home]}));}
console.log(JSON.stringify({returned,atOwn,atOther,occupied}));
