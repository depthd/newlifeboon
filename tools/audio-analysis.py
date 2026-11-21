"""Analyze browser-produced PCM; true peak is an 8x FIR estimate, not certification."""
import json, pathlib, sys
import numpy as np
from scipy.io import wavfile
from scipy.signal import resample_poly, welch

root = pathlib.Path(sys.argv[1] if len(sys.argv)>1 else '../engine-audio-results')
(root/'matched').mkdir(exist_ok=True)
def read(path):
    rate, raw = wavfile.read(path)
    return rate, raw.astype(np.float64)/2147483648 if raw.dtype == np.int32 else raw.astype(np.float64)
def rms(x): return float(np.sqrt(np.mean(x*x)))
def db(x): return float(20*np.log10(max(float(x),1e-15)))
def peak(x, factor=8): return float(np.max(np.abs(resample_poly(x,factor,1,window=('kaiser',12.0)))))
def bands(x,rate):
    f,p=welch(x,rate,nperseg=8192)
    edges=[40,150,400,800,1600,3200,6400]
    powers=np.array([np.sum(p[(f>=a)&(f<b)]) for a,b in zip(edges,edges[1:])])
    return 10*np.log10(np.maximum(powers/powers.sum(),1e-15))
report={'method':{'truePeak':'8x scipy.signal.resample_poly, Kaiser beta=12; largest file crosschecked at16x. Estimate, not certified BS.1770 meter',
  'loudnessMatch':'RMS match to quietest of three steady clips at each RPM; not LUFS/perceptual equal-loudness',
  'listening':'NOT PERFORMED','physicalAudioOutput':'NOT VERIFIED'},'files':[],'firingRates':[],'loads':[],'live':[],'sampleRateComparison':[], 'failures':[]}
largest=(0,None)
for path in sorted((root/'wav').glob('*.wav')):
    rate,x=read(path); valid=bool(np.all(np.isfinite(x)))
    tp=peak(x) if valid else float('inf')
    item={'file':path.name,'sampleRate':rate,'seconds':len(x)/rate,'finite':valid,'samplePeakDbFS':db(np.max(np.abs(x))),
      'estimatedTruePeakDbTP':db(tp),'rmsDbFS':db(rms(x)),'maxAdjacentDifference':float(np.max(np.abs(np.diff(x))))}
    report['files'].append(item)
    if tp>largest[0]: largest=(tp,path)
    if not valid or db(tp)>-1: report['failures'].append(path.name+': finite/truepeak')
    journal=json.loads((root/'journals'/(path.stem+'.json')).read_text())
    if journal.get('quantumGaps',0): report['failures'].append(path.name+': quantum timeline gap')
    if path.name.startswith('idle-'):
        events=np.array(journal['firingSampleIndices'])/rate
        actual=float(np.sum((events>=2)&(events<29))/27)
        report['firingRates'].append({'file':path.name,'expectedHz':25,'measuredHz':actual,'countToleranceHz':1/27})
        if abs(actual-25)>1/27+1e-8: report['failures'].append(path.name+': firing frequency')
    if path.name.startswith('live-'):
        rows=np.array(journal['rows']); fields=journal['traceFields']; get=lambda key: rows[:,fields.index(key)]
        t=get('audioTimeS')-journal['epoch']; after=np.where((t>=2)&(get('smoothedRpm')>=2750))[0]
        stale=get('dataAgeS'); freshness=get('freshnessGain')
        report['live'].append({'file':path.name,'hz':journal['hz'],'stallMs':journal['block']['requestedMs'],
          'midpointReactionDelayMs':float((t[after[0]]-2)*1000) if len(after) else None,
          'minimumFreshness':float(freshness.min()),'maxDataAgeMs':float(stale.max()*1000),
          'quantumGaps':journal['quantumGaps'], 'rejectedMessages':journal['rejectedMessages'],
          'firstFadeAgeMs':float(stale[np.where(freshness<0.999)[0][0]]*1000) if np.any(freshness<0.999) else None})

spectra={}
for rate in [44100,48000]:
    _,x=read(root/'wav'/f'loads-{rate}.wav')
    for rpm,offset in [(2000,0),(3500,3)]:
        clips=[x[int(((offset+i)*3+0.75)*rate):int(((offset+i)*3+2.75)*rate)] for i in range(3)]
        target=min(map(rms,clips)); specs=[]
        for i,(load,clip) in enumerate(zip([0.1,0.5,1],clips)):
            factor=target/rms(clip); matched=clip*factor
            name=f'matched-{rpm}-load{load}-{rate}'
            wavfile.write(root/'matched'/(name+'.wav'),rate,matched.astype(np.float32))
            spec=bands(matched,rate); specs.append(spec); spectra[(rate,rpm,load)]=spec
            (root/'matched'/(name+'.json')).write_text(json.dumps({'sourceWav':f'../wav/loads-{rate}.wav',
              'sourceJournal':f'../journals/loads-{rate}.json','sourceStartSample':int(((offset+i)*3+0.75)*rate),
              'frames':len(clip),'gain':factor,'rpm':rpm,'load01':load,'rmsDbFS':db(rms(matched)),
              'estimatedTruePeakDbTP':db(peak(matched))}))
        difference=float(np.max(np.abs(specs[2]-specs[0])))
        report['loads'].append({'sampleRate':rate,'rpm':rpm,'matchedRmsDbFS':db(target),
          'maxNormalizedBandDifferenceDb_load01_vs10':difference,'bandEdgesHz':[40,150,400,800,1600,3200,6400]})
        if difference<1: report['failures'].append(f'{rate} {rpm}: insufficient measured spectral load difference')
for rpm in [2000,3500]:
    for load in [0.1,0.5,1]:
        a=spectra[(44100,rpm,load)];b=spectra[(48000,rpm,load)]
        report['sampleRateComparison'].append({'rpm':rpm,'load01':load,'maxNormalizedBandDifferenceDb':float(np.max(np.abs(a-b)))})
if largest[1]:
    rate,x=read(largest[1]); report['peakCrosscheck']={'file':largest[1].name,'eightTimesDbTP':db(largest[0]),'sixteenTimesDbTP':db(peak(x,16))}
report['negativeControls']={'nanDetected':not bool(np.all(np.isfinite([0,float('nan')]))),
 'overCeilingDetected':db(peak(np.ones(1024)*1.1))>-1,
 'identicalNormalizedSpectraRejected':float(np.max(np.abs(spectra[(48000,2000,0.1)]-spectra[(48000,2000,0.1)])))<1}
(root/'analysis.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
print(json.dumps({'files':len(report['files']),'highestTruePeakDbTP':db(largest[0]),'loads':report['loads'],'live':report['live'],'failures':report['failures']},ensure_ascii=False,indent=2))
sys.exit(bool(report['failures']))
