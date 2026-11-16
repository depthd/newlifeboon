/**
 * Один клавиатурный манёвр в настоящем приложении при 30/60/144 Гц.
 * Управляем часами RAF; физику, ввод, контакты и камеру считает приложение.
 * Без --visual рендер выключен: это проверка частоты, не визуальная приёмка.
 * --visual сохраняет движение, салон и 16 кадров кувырка с телеметрией.
 * CHROMIUM_PATH=/usr/bin/chromium node tools/car-frames.mjs [--visual]
 * Отдельно от ride: поездка с трафиком использует реальные часы браузера.
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import {writeFileSync,mkdirSync} from 'node:fs';
const out = process.env.CAR_CHECK_OUTPUT ?? 'work/car-physics';
mkdirSync(out, { recursive: true });
const server=await createServer({server:{port:5231,strictPort:true,hmr:false},logLevel:'error'}); await server.listen();
const browser=await chromium.launch({executablePath: process.env.CHROMIUM_PATH});
const errors=[]; const results=[];
async function open(){
 const page=await browser.newPage({viewport:{width:1200,height:800}});
 page.on('pageerror',e=>errors.push(String(e)));
 await page.route('**://fonts.googleapis.com/**',r=>r.abort());
 await page.addInitScript(()=>{
  let next=1,time=0;const pending=new Map();
  window.requestAnimationFrame=fn=>{const n=next++;pending.set(n,fn);return n;};
  window.cancelAnimationFrame=n=>pending.delete(n);
  window.advance=(ms)=>{time+=ms;const batch=[...pending.values()];pending.clear();for(const fn of batch)fn(time);};
 });
 await page.goto('http://localhost:5231/?scene='+encodeURIComponent('крест')+'&terrain=plain&view=close&трава=нет&кадр=нет&машина=viper');
 for(let i=0;i<120;i++){await page.evaluate(()=>window.advance(1000/60));if(await page.evaluate(()=>window.__ready===true))break;}
 await page.evaluate(()=>document.querySelector('button[data-drive="seat"]').click());
 return page;
}
try{
 for(const fps of [30,60,144]){
  const page=await open();
  for(let second=0;second<6;second++){
   await page.evaluate(s=>{
    const event=(type,code)=>dispatchEvent(new KeyboardEvent(type,{code}));
    if(s===0)event('keydown','KeyW');
    if(s===2)event('keydown','KeyD');
    if(s===3){event('keyup','KeyD');event('keydown','KeyA');}
    if(s===4){event('keyup','KeyA');event('keyup','KeyW');event('keydown','Space');}
   },second);
   await page.evaluate(({fps})=>{for(let i=0;i<fps;i++)window.advance(1000/fps);},{fps});
  }
  results.push({fps,...await page.evaluate(()=>window.__car())});
  await page.close();
 }
 writeFileSync(out+'/fps.json',JSON.stringify({results,errors},null,2));
 console.log('FPS',results.map(r=>({fps:r.fps,x:r.x,z:r.z,speed:r.speed,sim:r.sim})));
 const max=Math.max(...results.map(r=>Math.hypot(r.x-results[0].x,r.z-results[0].z)));
 if(!results.every(r => [r.x, r.z, r.speed, r.sim, r.yaw].every(Number.isFinite))) throw Error('Non-finite car state');
 if(max>0.05)throw Error('FPS mismatch '+max);
 if(results.some(r => Math.abs(r.sim-results[0].sim)>1e-9 || Math.abs(r.speed-results[0].speed)>0.02)) throw Error('Simulation time/speed mismatch');
 if (process.argv.includes('--visual')) {
 const page=await open();
 await page.addStyleTag({content: '.layer { visibility: hidden !important; }'});
 await page.evaluate(()=>{window.__кадр(true);window.advance(1000/60);});
 await page.screenshot({path:out+'/chase-rest.png'});
 await page.evaluate(()=>{dispatchEvent(new KeyboardEvent('keydown',{code:'Enter'}));window.advance(1000/60);});
 await page.screenshot({path:out+'/diagnostic-rest.png'});
 await page.evaluate(()=>{dispatchEvent(new KeyboardEvent('keydown',{code:'Enter'}));window.advance(1000/60);});
 await page.evaluate(()=>dispatchEvent(new KeyboardEvent('keydown',{code:'KeyW'})));
 for(let i=0;i<60;i++)await page.evaluate(()=>window.advance(1000/60));
 await page.screenshot({path:out+'/chase-moving.png'});
 await page.evaluate(()=>{dispatchEvent(new KeyboardEvent('keyup',{code:'KeyW'}));dispatchEvent(new KeyboardEvent('keydown',{code:'KeyC'}));window.advance(1000/60);});
 await page.screenshot({path:out+'/cockpit-moving.png'});
 await page.evaluate(()=>{dispatchEvent(new KeyboardEvent('keydown',{code:'KeyC'}));window.__подбросить(7,2.4,1.7);});
 const frames=[];
 for(let i=0;i<16;i++){
  for(let k=0;k<15;k++)await page.evaluate(()=>window.advance(1000/60));
  frames.push(await page.evaluate(()=>window.__car()));
  await page.screenshot({path:out+`/toss-${String(i).padStart(2,'0')}.png`});
 }
 writeFileSync(out+'/toss.json',JSON.stringify({frames,errors},null,2));
 console.log('TOSS',frames.map(r=>({t:r.sim,y:r.y,roll:r.roll})),errors);
 await page.close();
 }
 if (errors.length) throw Error(errors.join("\n"));
}finally{await browser.close();await server.close();}
