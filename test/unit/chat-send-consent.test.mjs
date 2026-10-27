import test from 'node:test';
import assert from 'node:assert/strict';
import {runChat} from '../../bin/commands/chat.mjs';

test('live chat without second consent refuses before browser or runtime effects', async()=>{
 let calls=0;
 const ctx={args:['chatgpt'],flags:{execute:true,prompt:'A harmless test prompt'},out:{emit(){calls++;}}};
 await assert.rejects(()=>runChat(ctx,{factory:async()=>{calls++;throw Error('runtime opened');}}),/--execute --accept-sends/);
 assert.equal(calls,0);
});
test('offline chat preview does not require live-send consent',async()=>{
 const values=[];
 await runChat({args:['chatgpt'],flags:{prompt:'A harmless test prompt'},out:{emit(v){values.push(v);}}});
 assert.equal(values.length,1);
 assert.equal(values[0].browserAction,false);
});
