import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpcuaClientWrapper } from './opcuaClientWrapper.js';
import { OPCUAClient } from 'node-opcua';
import type { OpcuaValueEvent } from './subscriptionManager.js';
test('last data observations survive state changes and retain the last good receipt',async()=>{
 const wrapper=new OpcuaClientWrapper('plc',{endpointUrl:'opc.tcp://localhost:4840'},{minDelayMs:100,maxDelayMs:200,maxAttempts:1});
 let onValue!: (event:OpcuaValueEvent)=>Promise<void>;
 Object.assign(wrapper,{subscriptions:{addMapping:async(_id:unknown,_config:unknown,callback:typeof onValue)=>{onValue=callback;}}});
 assert.equal((await wrapper.getStatus()).details?.['lastValueReceivedAt'],undefined);
 await wrapper.addMapping({id:'mapping',config:{nodeId:'ns=2;s=T',topic:'site/',asset:'a',objectType:'equipment',objectId:'main',attribute:'temperature'}},async()=>{});
 await onValue({value:20,timestamp:'2020-01-01T00:00:00Z',quality:'Good',connectionId:'plc',nodeId:'ns=2;s=T'});
 const good=(await wrapper.getStatus()).details!;
 assert.equal(good['lastValueReceivedAt'],good['lastGoodValueReceivedAt']);assert.notEqual(good['lastValueReceivedAt'],'2020-01-01T00:00:00Z');
 await new Promise(r=>setTimeout(r,5));await onValue({value:null,timestamp:'2020-01-01T00:00:00Z',quality:'BadNodeIdUnknown',connectionId:'plc',nodeId:'ns=2;s=T'});
 const bad=(await wrapper.getStatus()).details!;assert.equal(bad['lastGoodValueReceivedAt'],good['lastGoodValueReceivedAt']);assert.equal(bad['lastValueQuality'],'BadNodeIdUnknown');assert.notEqual(bad['lastValueReceivedAt'],bad['lastGoodValueReceivedAt']);
});

test('session failure is redacted before propagating to the lifecycle engine', async (t) => {
 t.mock.method(OPCUAClient, 'create', () => ({on(){}, connect:async()=>{throw new Error('local-user:local-password denied');}}));
 const wrapper=new OpcuaClientWrapper('plc',{endpointUrl:'opc.tcp://plc.example:4840',userIdentity:{type:'username',userName:'local-user',password:'local-password'}},{minDelayMs:100,maxDelayMs:200,maxAttempts:1});
 await assert.rejects(wrapper.start(), error => error instanceof Error && !error.message.includes('local-user') && !error.message.includes('local-password') && error.message.includes('[redacted]'));
 assert.equal((await wrapper.getStatus()).message?.includes('local-password'),false);
});
