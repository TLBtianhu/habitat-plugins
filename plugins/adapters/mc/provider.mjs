// MC 应用运行时：只创建 mcpfabric 客户端；不存在持续的本地假连接。
import { NativeMcClient } from '../../clients/mc-native.mjs';
import { loadMcpfabricToken } from '../../clients/mcpfabric-token.mjs';

export function createRuntime({ env = process.env, mcClientFactory = null, client: providedClient = null } = {}) {
  const client = mcClientFactory
    ? mcClientFactory()
    : providedClient || new NativeMcClient({
      rpc: env.HABITAT_MCPFABRIC_RPC || 'http://127.0.0.1:25600/rpc',
      token: loadMcpfabricToken(),
    });
  let state = 'stopped';
  let lastError = null;
  return {
    client,
    async start() { state = 'ready'; lastError = null; },
    async stop() { state = 'stopped'; },
    status() { return { state, lastError, enabled: state !== 'stopped' }; },
    async obs() {
      if (state === 'stopped') throw new Error('mc runtime stopped');
      try {
        const observation = await client.obs();
        lastError = null;
        return observation;
      } catch (error) {
        lastError = error.message;
        throw error;
      }
    },
  };
}

export function createHandlers({ client, runtime }) {
  const mc = client || runtime;
  if (!mc) throw new Error('mc runtime unavailable');
  return {
    obs: () => mc.obs(),
    say: (args) => (client || runtime.client).act({ verb: 'mc.say', args: { text: args.text } }),
    look: (args) => (client || runtime.client).act({ verb: 'look', args }),
    stop: () => (client || runtime.client).act({ verb: 'stop', args: {} }),
  };
}
