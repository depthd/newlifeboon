const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(__dirname + '/upstream-worklet.js', 'utf8');
const opts = {cylinders:4,intakeWaveguideLength:100,exhaustWaveguideLength:100,extractorWaveguideLength:100,intakeOpenReflectionFactor:0.01,intakeClosedReflectionFactor:0.95,exhaustOpenReflectionFactor:0.01,exhaustClosedReflectionFactor:0.95,ignitionTime:0.016,straightPipeWaveguideLength:128,straightPipeReflectionFactor:0.01,mufflerElementsLength:[10,15,20,25],action:0.1,outletWaveguideLength:5,outletReflectionFactor:0.01};
function create(rate=48000, randomMode='seeded') {
 let seed=123456789, Processor;
 const math=Object.create(Math);
 math.random=()=>randomMode==='constant' ? .5 : ((seed=(Math.imul(1664525,seed)+1013904223)>>>0)/4294967296);
 const ctx=vm.createContext({sampleRate:rate,Math:math,Float32Array,AudioWorkletProcessor:class {constructor(){this.port={};}},registerProcessor:(name,p)=>Processor=p});
 vm.runInContext(source,ctx);
 return new Processor({processorOptions:opts});
}
function render(p,rpm,throttle,n,block=128){
 const result=Array.from({length:3},()=>new Float32Array(n));
 for(let off=0;off<n;off+=block){
  let count=Math.min(block,n-off), out=Array.from({length:3},()=>[new Float32Array(count)]);
  p.process([],out,{rpm:new Float32Array([rpm]),throttle:new Float32Array([throttle])});
  for(let c=0;c<3;c++) result[c].set(out[c][0],off);
 }
 return result;
}
function metrics(arr,offset=0){return arr.map(x=>{
 let max=0,sum=0,sq=0,nonfinite=0;for(let i=offset;i<x.length;i++){let v=x[i];if(!Number.isFinite(v)){nonfinite++;continue;}max=Math.max(max,Math.abs(v));sum+=v;sq+=v*v;}
 let n=x.length-offset,mean=sum/n;return {peak:max,mean,rms:Math.sqrt(sq/n),acRms:Math.sqrt(Math.max(0,sq/n-mean*mean)),nonfinite};
});}
function diff(a,b){return a.map((x,c)=>{let m=0;for(let i=0;i<x.length;i++)m=Math.max(m,Math.abs(x[i]-b[c][i]));return m;});}
let report={upstreamCommit:'c76c5adb9e63f5a54fb0def3b97e8e0ac1a7dea1',environment:{node:process.version,kind:'Node VM DSP harness, NOT browser or listening test'},params:opts,tests:[]};
for(const rate of [44100,48000]){
 let p0=create(rate),p1=create(rate);
 const a=render(p0,3000,0,rate),b=render(p1,3000,1,rate);
 report.tests.push({name:'throttle comparison',rate,maxAbsDifference:diff(a,b),metrics:metrics(a,Math.floor(rate/2))});
 const zero=render(create(rate),0,0,rate*2);
 report.tests.push({name:'cold zero RPM after 1s settling',rate,metrics:metrics(zero,rate)});
 const p=create(rate);render(p,3000,1,rate);const stopped=render(p,0,0,rate*2);
 report.tests.push({name:'3000 to zero RPM after 1s settling',rate,metrics:metrics(stopped,rate),phase:p.currentRevolution});
 const a64=render(create(rate),3000,.5,rate,64),a256=render(create(rate),3000,.5,rate,256);
 report.tests.push({name:'block size invariance 64 versus 256',rate,maxAbsDifference:diff(a64,a256)});
}
const p=create();render(p,2000,1,48000);
let partial;
try{p.port.onmessage({data:{rpm:3000}});partial='no throw';}catch(e){partial=e.toString();}
report.tests.push({name:'partial telemetry posted to upstream port',result:partial});
const q=create(48000,'constant');render(q,3000,1,48000);
report.tests.push({name:'steady cylinder phases constant random 0.5',crankshaftNoise:q.crankshaftLowPassFilter.lastValue,phaseOffsets:q.cylinders.map((c,i)=>(i*(q.cylindersCountInverse+q.crankshaftLowPassFilter.lastValue))%1)});
fs.writeFileSync(__dirname+'/results.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
