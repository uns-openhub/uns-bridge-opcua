import { MessageSecurityMode, OPCUAClient, SecurityPolicy, type ClientSession, type OPCUAClientOptions } from 'node-opcua';
import { resolveRuntimeIdentity, redactRuntimeIdentityError } from "../runtime/local-secret-references.js";
import type { OpcuaConnectionConfig } from './opcuaClientWrapper.js';

const toSecurityMode = (value?: 'None' | 'Sign' | 'SignAndEncrypt'): MessageSecurityMode => {
  switch (value) {
    case 'Sign':
      return MessageSecurityMode.Sign;
    case 'SignAndEncrypt':
      return MessageSecurityMode.SignAndEncrypt;
    case 'None':
    default:
      return MessageSecurityMode.None;
  }
};

const toSecurityPolicy = (value?: string): SecurityPolicy => {
  if (!value || value === 'None') {
    return SecurityPolicy.None;
  }

  if (value in SecurityPolicy) {
    return SecurityPolicy[value as keyof typeof SecurityPolicy];
  }

  return SecurityPolicy.None;
};

function createClientOptions(connectionId: string, config: OpcuaConnectionConfig): OPCUAClientOptions {
  return {
    clientName: config.name ?? `uns-bridge-opcua-health-${connectionId}`,
    endpointMustExist: false,
    securityMode: toSecurityMode(config.securityMode),
    securityPolicy: toSecurityPolicy(config.securityPolicy),
    requestedSessionTimeout: config.requestedSessionTimeoutMs ?? 60_000,
    connectionStrategy: {
      initialDelay: 250,
      maxDelay: 1_000,
      maxRetry: 0,
    },
  };
}

export async function checkOpcuaSourceConnection(connectionId: string, config: OpcuaConnectionConfig): Promise<void> {
  const identity = resolveRuntimeIdentity(config.userIdentity);
  const client = OPCUAClient.create(createClientOptions(connectionId, config));
  let session: ClientSession | undefined;

  try {
    await client.connect(config.endpointUrl);
    session = await client.createSession(identity);
  } catch (error) {
    throw new Error(redactRuntimeIdentityError(error, config.userIdentity));
  } finally {
    if (session) {
      await session.close().catch(() => undefined);
      session.removeAllListeners();
    }
    await client.disconnect().catch(() => undefined);
    client.removeAllListeners();
  }
}
