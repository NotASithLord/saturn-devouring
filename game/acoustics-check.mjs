import assert from 'node:assert/strict';
import { roomTransmission } from './acoustics.js';
import { spatialMix, balanceRecording } from '../engine/spatial-audio.js';
import { PositionalSynth } from '../engine/audio.js';
const door = { type: 'hatch', open01: 1 };
const graph = { nodes: [{deck:1},{deck:1},{deck:1},{deck:2}], adj:{std:[[{to:1,link:door}],[{to:0,link:door},{to:2,link:door}],[{to:1,link:door}],[]]} };
const listener = {x:0,z:0,yaw:0,deck:1};
const mix = (to,d=8) => spatialMix(listener,{x:d,z:0,deck:graph.nodes[to].deck},1,roomTransmission(graph,0,to));
const same=mix(0), open=mix(1), two=mix(2), deck=mix(3);
assert.ok(same.gain>open.gain && open.gain>two.gain);
assert.ok(same.cutoff>open.cutoff && open.cutoff>two.cutoff);
door.open01=0;const closed=mix(1);
assert.ok(closed.gain<open.gain/4 && closed.cutoff<open.cutoff/4);
assert.ok(deck.gain<open.gain && deck.cutoff<closed.cutoff);
door.busted=true; assert.deepEqual(mix(1),open);
assert.ok(mix(0,24).gain<same.gain/4);
assert.equal(mix(0,72).gain,0);
assert.equal(spatialMix(listener,null,0.8).gain,0.8);
assert.equal(spatialMix(listener,{x:8,z:0,deck:1},1).pan, -spatialMix(listener,{x:-8,z:0,deck:1},1).pan);
const samples=Float32Array.of(-1,1,-0.5,0.5);
balanceRecording({numberOfChannels:1,getChannelData:()=>samples});
assert.ok(Math.max(...samples.map(Math.abs))<=0.85);
// Exercise the actual audio graph, not just the mix calculation.
const filters=[],gains=[];
const node=()=>({connect(){return this;},start(){},playbackRate:{value:1}});
const synth=new PositionalSynth();synth.listener=listener;synth.master=node();synth.buffers.shot={};
synth.transmission=()=>closed;
synth.ctx={state:'running',sampleRate:48000,createBufferSource:node,
 createGain:()=>{const n=node();n.gain={value:0};gains.push(n);return n;},
 createBiquadFilter:()=>{const n=node();n.frequency={value:0};n.Q={value:0};filters.push(n);return n;}};
synth.play('shot',{x:8,z:0,deck:1});
assert.equal(filters[0].frequency.value,closed.cutoff);
assert.ok(gains[0].gain.value<same.gain);
synth.playFar('shot',{x:8,z:0,deck:1},0);
assert.equal(gains[1].gain.value,gains[0].gain.value,'far path must not bypass attenuation');
console.log('audio: distance, open/closed/busted doors, multiple rooms, decks, panning, recording levels and filter graph ✓');
