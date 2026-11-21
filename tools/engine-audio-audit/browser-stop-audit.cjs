const { chromium } = require('playwright');
const http = require('node:http');
const fs = require('node:fs');
const source = fs.readFileSync(__dirname+'/upstream-exact.js');
const saved = JSON.parse(fs.readFileSync(__dirname+'/results.json'));
(async()=>{
 const server=http.createServer((req,res)=>{if(req.url==='/worklet.js'){res.setHeader('Content-Type','text/javascript');res.end(source);}else{res.setHeader('Content-Type','text/html');res.end('<!DOCTYPE html><title>Independent engine DSP audit</title>');}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({headless:true,executablePath:'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage']});
 try {
  const page=await browser.newPage();await page.goto('http://127.0.0.1:'+server.address().port);
  const tests=[];
  for(const rate of [44100,48000])for(const rpm of [0,3000]){
   const result=await page.evaluate(async({rate,rpm,options})=>{
    const ctx=new OfflineAudioContext(3,rate*3,rate);
    await ctx.audioWorklet.addModule('/worklet.js');
    const node=new AudioWorkletNode(ctx,'engine-sound-processor',{numberOfInputs:0,numberOfOutputs:3,outputChannelCount:[1,1,1],processorOptions:options,parameterData:{rpm,throttle:0.5}});
    node.parameters.get('rpm').setValueAtTime(0, 0.137);
    let errors=[];node.onprocessorerror=()=>errors.push('processorerror');
    const merger=ctx.createChannelMerger(3);for(let c=0;c<3;c++)node.connect(merger,c,c);merger.connect(ctx.destination);
    const audio=await ctx.startRendering();
    const metrics=[];for(let c=0;c<3;c++){const a=audio.getChannelData(c);let peak=0,sum=0,sq=0,nonfinite=0;for(let i=rate;i<a.length;i++){const v=a[i];if(!Number.isFinite(v)){nonfinite++;continue;}peak=Math.max(peak,Math.abs(v));sum+=v;sq+=v*v;}const n=a.length-rate,mean=sum/n;metrics.push({peak,mean,rms:Math.sqrt(sq/n),acRms:Math.sqrt(Math.max(0,sq/n-mean*mean)),nonfinite});}
    return {sampleRate:ctx.sampleRate,initialRpm:rpm,stopAtS:0.137,seconds:3,measurementWindow:'seconds 1 to 3',metrics,errors};
   },{rate,rpm,options:saved.params});
   tests.push(result);
  }
  const report={environment:{browser:await browser.version(),mode:'headless Chromium OfflineAudioContext; no realtime CPU/glitch or listening claims'},upstreamCommit:saved.upstreamCommit,params:saved.params,tests};
  fs.writeFileSync(__dirname+'/browser-stop-results.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
 } finally {await browser.close();server.close();}
})().catch(e=>{console.error(e);process.exit(1)});
