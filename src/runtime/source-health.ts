import { redactRuntimeIdentityError } from "./local-secret-references.js";
import type { BridgeConnectionStatus } from '@uns-kit/bridge-core';
import type { RuntimeConfigSnapshot } from '../config/runtime-config.js';
export const SOURCE_HEALTH_INTERVAL_MS = 5_000;
export const SOURCE_HEALTH_STALE_MS = 20_000;
export type SourceDependencyHealth = { id: string; label: string; state: 'healthy' | 'degraded' | 'unknown'; healthy: boolean | null; checkedAt: string; message: string; action?: string };
export async function within<T>(work: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer=setTimeout(()=>reject(new Error('Runtime observation timed out')),milliseconds); })]); }
  finally { if(timer) clearTimeout(timer); }
}
/** Observe the real sessions. Never open a second connection to test an active source. */
export async function observeSourceHealth(snapshot: RuntimeConfigSnapshot, getStatus: (id: string) => Promise<BridgeConnectionStatus>, now = new Date()): Promise<SourceDependencyHealth[]> {
  const active = snapshot.connections.filter(connection=>connection.start===true);
  const checkedAt=now.toISOString();
  if(!active.length) return [{id:'opcua-source',label:'OPC UA source server',state:'unknown',healthy:null,checkedAt,message:'No started OPC UA source connections are configured.'}];
  const results=await Promise.all(active.map(async connection=>{
    try {
      const status=await within(getStatus(connection.id),1_000);
      const ok=status.connected===true && status.state==='running';
      // Protocol errors can contain endpoint/identity details. Keep shared diagnostics concise.
      let message=status.message || status.state;
      message=redactRuntimeIdentityError(message,connection.config.userIdentity).slice(0,200);
      return {id:connection.id,ok,message};
    } catch {return {id:connection.id,ok:false,message:'Runtime source status is unavailable.'};}
  }));
  const failed=results.filter(result=>!result.ok);
  return [{id:'opcua-source',label:'OPC UA source server',state:failed.length?'degraded':'healthy',healthy:!failed.length,checkedAt,
    message:failed.length?`${failed.length}/${active.length} started OPC UA sources unavailable: ${failed.slice(0,5).map(result=>`${result.id}: ${result.message}`).join('; ')}${failed.length>5?'; more sources unavailable':''}`:`${active.length} started OPC UA source${active.length===1?'':'s'} connected.`,
    ...(failed.length?{action:'Check the source server, network and connection settings. The bridge reconnects automatically.'}:{})}];
}
export function createSourceHealthRefresh(read:()=>RuntimeConfigSnapshot,getStatus:(id:string)=>Promise<BridgeConnectionStatus>,publish:(dependencies:SourceDependencyHealth[])=>Promise<void>,onError:()=>void) {
  let inFlight:Promise<void>|undefined;
  return ():Promise<void>=>{
    if(inFlight) return inFlight;
    inFlight=(async()=>{try {const dependencies=await observeSourceHealth(read(),getStatus);await within(publish(dependencies),2_000);}catch{onError();}})().finally(()=>{inFlight=undefined;});
    return inFlight;
  };
}
