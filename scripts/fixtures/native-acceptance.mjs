// SPDX-License-Identifier: GPL-3.0-or-later
// Synthetic validator inputs only. Nothing here is an actual native observation.
export function syntheticMeasurements(required, binary) {
  const bounds=(scale=1,x=0)=>({x,y:0,width:640*scale,height:360*scale});
  if (required.id==='dpi-monitor-transitions') return {
    dpiSamples:required.requiredDpiPercentages.map(scalePercent=>({scalePercent,windowDpi:96*scalePercent/100,monitor:'Synthetic A',viewportBounds:bounds(scalePercent/100),nativeVideoBounds:bounds(scalePercent/100),workArea:{x:0,y:0,width:3840,height:2160}})),
    monitorMoves:[{fromMonitor:'Synthetic A',toMonitor:'Synthetic B',fromDpi:96,toDpi:144,beforeViewportBounds:bounds(),afterViewportBounds:bounds(1.5,2000),beforeNativeVideoBounds:bounds(),afterNativeVideoBounds:bounds(1.5,2000)}],
  };
  if (required.id==='keyboard-clipboard-accessibility') return {
    keyboardInputMethod:'windows-sendinput', // Synthetic description only; never invoked.
    keyboardOperations:required.requiredKeyboardOperations.map(operation=>({operation,keys:'Synthetic fixture, not typed',observedResult:'Synthetic fixture, not observed'})),
    clipboard:{format:'CF_UNICODETEXT',copiedText:'Synthetic 日本語 😀 &',pastedText:'Synthetic 日本語 😀 &'},
    screenReader:{product:'Synthetic fixture, not a running screen reader',version:'test-fixture',outputCaptureMethod:'Synthetic log only, never spoken or listened',operations:required.requiredScreenReaderOperations.map(operation=>({operation,controlRole:'button',controlName:'Synthetic control',spokenText:'Synthetic text, never spoken',observedResult:'Synthetic fixture only'}))},
  };
  if (required.id==='gpu-performance') return {
    hardware:'Synthetic test hardware, never measured',measurementMethod:'Synthetic fixture only',criteria:'Synthetic fixture only',
    workloads:required.requiredWorkloads.map((workload,index)=>{
      const common={assetSha256:String(index+1).repeat(64),displaySize:{width:1600,height:900},cpuPercent:10,gpuPercent:20,droppedFrames:0,avSyncOffsetMs:1,sampleWindowMs:10000};
      return {...workload,current:{...common,executableSha256:binary}};
    }),
  };
  if (required.id==='audio-output') return {directListeningPerformed:false,outputDevice:'Synthetic fixture only',captureMethod:'Synthetic fixture only',signalRmsDbfs:-20,measuredDurationMs:1000,stopExpectedMs:1000,stopObservedMs:1000,stopToleranceMs:10};
  if (required.id==='rendered-composition') return {captureMethod:'Synthetic fixture only, no pixels captured',layouts:required.requiredLayouts.map((id,index)=>({id,clientLogicalSize:{width:1280+index*320,height:900},frameCount:10,videoVisibleFrames:10,dialogVisibleFrames:5,transitionFrames:2,observedResult:'Synthetic fixture only'}))};
  if (required.id==='real-japanese-ime') return {languageTag:'ja-JP',imeEngine:'Synthetic fixture only',imeVersion:'test-fixture',preeditText:'にほんご',candidateText:'日本語',committedText:'日本語',restoredText:'日本語',candidateBounds:bounds(),workArea:{x:0,y:0,width:3840,height:2160},windowDpi:96,observedResult:'Synthetic fixture only; no IME executed'};
  if (required.id==='interval-auto-stop') return {stops:required.requiredStopKinds.map(kind=>({kind,requestedStartMs:0,expectedStopMs:1000,observedStopMs:1000,toleranceMs:50,clockSource:'Synthetic fixture only',observedResult:'Synthetic fixture only; no player executed'}))};
  if (required.id==='long-media') return {sourceSha256:'1'.repeat(64),sourceDurationMs:7200000,criteria:'Synthetic fixture duration, no policy threshold is implied',seeks:[{targetMs:1000,observedMs:1000,latencyMs:1},{targetMs:7100000,observedMs:7100000,latencyMs:1}],restart:{beforePid:100,afterPid:101,observedPositionMs:7100000,observedResult:'Synthetic fixture only; no process executed'},transcriptScroll:{totalCueCount:20000,firstCueId:'synthetic-1',lastCueId:'synthetic-20000',maxLatencyMs:1}};
  return {syntheticSample:42,description:'Synthetic test fixture, not a desktop measurement'};
}
