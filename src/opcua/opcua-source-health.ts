import { MessageSecurityMode, OPCUAClient, SecurityPolicy, type ClientSession, type OPCUAClientOptions } from 'node-opcua';
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

function resolveUserIdentity(
  connectionId: string,
  config: OpcuaConnectionConfig,
):
  | undefined
  | {
      type: 1;
      userName: string;
      password: string;
    } {
  if (!config.userIdentity || config.userIdentity.type === 'anonymous') {
    return undefined;
  }

  if (!config.userIdentity.userName || !config.userIdentity.password) {
    throw new Error(`Connection '${connectionId}' requires both userName and password for username authentication`);
  }

  return {
    type: 1,
    userName: config.userIdentity.userName,
    password: config.userIdentity.password,
  };
}

export async function checkOpcuaSourceConnection(connectionId: string, config: OpcuaConnectionConfig): Promise<void> {
  const client = OPCUAClient.create(createClientOptions(connectionId, config));
  let session: ClientSession | undefined;

  try {
    await client.connect(config.endpointUrl);
    session = await client.createSession(resolveUserIdentity(connectionId, config));
  } finally {
    if (session) {
      await session.close().catch(() => undefined);
      session.removeAllListeners();
    }
    await client.disconnect().catch(() => undefined);
    client.removeAllListeners();
  }
}
