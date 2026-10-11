// SPDX-License-Identifier: GPL-3.0-or-later
// Operator/Sky rendezvous. This test never substitutes Unicode injection for IME.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Key } from 'webdriverio';
import { saveNativeScreenshot } from '../../support/native-window.mjs';
const output = resolve('work/ui-evaluation/native/ime');
mkdirSync(output,{recursive:true});
const invoke = (command,args={}) => browser.execute((name,value)=>window.__TAURI_INTERNALS__.invoke(name,value),command,args);

describe('actual Japanese IME in native candidate dialogs', () => {
  it('records trusted OS composition, candidate cancellation and commit per primitive', async function () {
    this.timeout(15 * 60 * 1000);
    const results=[];
    await $('.eval-play').waitForEnabled();
    await invoke('player_control',{request:{action:'volume',value:0}});
    const candidates=(process.env.SURTITLE_UI_NATIVE_IME_CANDIDATES ?? 'current,base,aria,radix').split(',');
    assert(candidates.every(candidate=>['current','base','aria','radix'].includes(candidate)));
    for (const candidate of candidates) {
      await $(`[data-candidate="${candidate}"]`).click();
      await $('.native-candidate-trigger').click();
      await $('.modal').waitForDisplayed();
      await browser.waitUntil(()=>browser.execute(()=>!document.querySelector('[data-native-occlusion="pending"]')));
      const input=await $('input[aria-label="Meaning"]');
      await input.click(); await browser.keys([Key.Ctrl,'a']); await browser.keys(Key.Backspace);
      await browser.execute(()=>{
        window.__nativeImeCleanup?.();
        window.__nativeImeEvents=[];
        const input=document.querySelector('input[aria-label="Meaning"]');
        const types=['compositionstart','compositionupdate','compositionend','keydown','input'];
        const observe=event=>{if(event.target===input)window.__nativeImeEvents.push({type:event.type, phase:'window-capture', isTrusted:event.isTrusted, key:event.key, code:event.code, isComposing:event.isComposing, data:event.data, value:input.value, dialogPresent:!!document.querySelector('.modal')});};
        for(const type of types)window.addEventListener(type,observe,true);
        window.__nativeImeCleanup=()=>{for(const type of types)window.removeEventListener(type,observe,true);};
      });
      const token=randomUUID();
      writeFileSync(resolve(output,'request.json'),JSON.stringify({candidate,token,phase:'ready',windowTitle:'Surtitle UI Native Evaluation',instruction:'Use physical Japanese IME keys in the already focused Meaning input; observe popup, cancel composition once with Escape, commit 日本 with Return, restore previous IME mode, then write matching token to response.json.'},null,2));
      await browser.waitUntil(()=>{
        if(!existsSync(resolve(output,'response.json')))return false;
        try{return JSON.parse(readFileSync(resolve(output,'response.json'),'utf8')).token===token;}catch{return false;}
      },{timeout:180000,interval:500,timeoutMsg:`Waiting for actual OS IME operation: ${candidate}`});
      const receipt=JSON.parse(readFileSync(resolve(output,'response.json'),'utf8'));
      const observation=await browser.execute(()=>({events:window.__nativeImeEvents,value:document.querySelector('input[aria-label="Meaning"]')?.value,dialogPresent:!!document.querySelector('.modal'),focus:document.activeElement?.getAttribute('aria-label'),devicePixelRatio}));
      const player=await invoke('get_player_state');
      const trustedCompositionEnd=observation.events.some(event=>event.type==='compositionend'&&event.isTrusted);
      const result={candidate,receipt,observation,trustedCompositionEnd,surfaceVisible:player.surfaceVisible,paused:player.paused,positionMs:player.positionMs};
      results.push(result);
      writeFileSync(resolve(output,'results.json'),JSON.stringify({results,limits:['Actual physical-key composition in this evaluation frontend; not a complete production migration.','compositionend trust is reported independently: trusted start/update, native candidate popup, committed value and subsequent non-composing keys establish the observed operation; an untrusted end event does not establish a native end event.']},null,2));
      assert(observation.events.some(event=>event.type==='compositionstart'&&event.isTrusted),'No trusted OS compositionstart');
      assert(observation.events.some(event=>event.type==='compositionupdate'&&event.isTrusted),'No trusted OS compositionupdate');
      assert(observation.events.some(event=>event.type==='compositionend'),'No observed compositionend');
      const endIndex=observation.events.findLastIndex(event=>event.type==='compositionend');
      assert(observation.events.slice(endIndex+1).some(event=>event.type==='keydown'&&event.isTrusted&&event.isComposing===false),'No subsequent non-composing key evidence');
      assert(observation.value.includes('日本'),'Expected committed Japanese conversion');
      assert(observation.dialogPresent,'IME cancellation closed the modal');
      assert.equal(player.surfaceVisible,true);
      assert.equal(player.paused,true,'IME Space escaped into the playback shortcut');
      await saveNativeScreenshot(resolve(`test-results/native/ui-candidate-${candidate}-ime.png`));
      await $('.eval-resume').click(); await $('.modal').waitForExist({reverse:true});
      await invoke('player_control',{request:{action:'pause'}});
    }
    writeFileSync(resolve(output,'request.json'),JSON.stringify({phase:'complete'},null,2));
  });
});
