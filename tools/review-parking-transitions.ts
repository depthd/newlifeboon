import { дорогиПосёлка, построитьПосёлок } from '../src/city/plan.ts';
import { buildWorld } from '../src/world/world.ts';
import { buildNetwork, moveTraffic } from '../src/city/traffic.ts';
import { вывестиНаУлицу, жить, своиМеста } from '../src/city/жизнь.ts';
import { moveWalkers } from '../src/city/walkers.ts';
import { где, кто, расселить } from '../src/city/житель.ts';
const посёлок=построитьПосёлок(20260913,300,'город'),р=расселить(посёлок);
const все=Array.from({length:р.всего},(_,i)=>кто(р,i,0));
const чужоеМесто=false;
const say=(...x:unknown[])=>console.log(JSON.stringify(x));
{
  const world = buildWorld(дорогиПосёлка(посёлок), 'plain');
  const net = buildNetwork(world);
  const ОТ = 17.4, DT = 0.1, МИНУТ = 60;
  const с = вывестиНаУлицу(world, net, р, ОТ);
  const свои = своиМеста(world, net, р);
  const стоялиДома = new Set([...с.стоят].map((m) => m.хозяин));
  for (let к = 1; к * DT <= МИНУТ * 60; к++) {
    const время = к * DT, час = ОТ + время / 3600;
    moveWalkers(world, net, с.пешие, DT, время);
    const before = new Map(с.машины.map(m => [m, m.park?.bay]));
    const targetBefore = new Map(с.машины.map(m => { const own = свои.get(m.хозяин); return [m, own === undefined ? null : {own, taken:net.bays[own].taken, holders:[...с.машины,...с.стоят].filter(o=>o!==m&&o.park?.bay===own).map(o=>o.хозяин), bay:net.bays[own]}]; }));
    moveTraffic(world, net, с.машины, DT, время, {
      час, чужоеМесто,
      crossing: с.пешие.filter((w) => w.crossing > 0).map((w) => ({ shape: w.shape, s: w.s })),
    });
    for (const m of с.машины) {
      const info = targetBefore.get(m);
      if (info && m.park && m.park.bay !== info.own && before.get(m) !== m.park.bay && [5258,5262,5384,4172,192,1240,283,682].includes(m.хозяин)) console.log(JSON.stringify({event:'wrong-bay-selected',hour:час,owner:m.хозяин,dir:m.dir,shape:m.shape,s:m.s,selected:m.park.bay,selectedBay:net.bays[m.park.bay],before:info,ownTakenAfter:net.bays[info.own].taken}));
    }
    жить(world, net, р, с, час);
  }
  const час = ОТ + МИНУТ / 60;
  let вернулись = 0, наСвоё = 0, наЧужое = 0, своёЗанято = 0;
  for (const m of [...с.стоят, ...с.машины]) {
    if (m.park?.phase !== 'стоит' || стоялиДома.has(m.хозяин)) continue;
    const своё = свои.get(m.хозяин);
    const м = где(все[m.хозяин], час);
    if (своё === undefined || м.где !== 'дома') continue;
    вернулись++;
    if (m.park.bay === своё) { наСвоё++; continue; }
    наЧужое++;
    console.log(JSON.stringify({owner:m.хозяин,home:все[m.хозяин].дом,own:своё,bay:m.park.bay,parkingTarget:m.стоянка,target:m.маршрут?.цель,schedule:м,pending:с.ждут.filter(x=>x.номер===m.хозяин),ownOccupied:[...с.стоят,...с.машины].some(o=>o!==m&&o.park?.bay===своё)}));
    // своё занято другой машиной — тогда чужое место не ошибка, а жизнь
    if ([...с.стоят, ...с.машины].some((o) => o !== m && o.park?.bay === своё)) своёЗанято++;
  }
  say('вернувшийся домой встаёт на своё место', вернулись > 20 && наСвоё >= (вернулись - своёЗанято) * 0.95,
    `за час с ${ОТ} вернулись домой на машине ${вернулись}: на своё место ${наСвоё}, на другое ${наЧужое}`
    + ` (из них своё было занято ${своёЗанято}); своих мест в городе ${свои.size}`);
}
