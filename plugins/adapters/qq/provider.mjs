// QQ 应用运行时：连接、事件和发送都归属于该插件包。
import fs from 'node:fs';
import { OneBotClient } from '../../clients/onebot.mjs';
import { OneBotConnectionSupervisor } from '../../clients/onebot-supervisor.mjs';

export function createRuntime({
  policy,
  env = process.env,
  onebotClientFactory = null,
  onebotSupervisorFactory = null,
} = {}) {
  const token = String(env.NAPCAT_TOKEN || '').trim() || (
    fs.existsSync('/etc/habitat/napcat.token') ? fs.readFileSync('/etc/habitat/napcat.token', 'utf8').trim() : ''
  );
  const onebotClient = onebotClientFactory
    ? onebotClientFactory()
    : new OneBotClient({ httpUrl: env.HABITAT_ONEBOT_HTTP_URL || 'http://127.0.0.1:3003', accessToken: token });
  const listeners = new Set();
  const wsUrl = env.HABITAT_ONEBOT_WS_URL || '';
  const supervisor = wsUrl
    ? (onebotSupervisorFactory || ((options) => new OneBotConnectionSupervisor(options)))({
      wsUrl,
      accessToken: token,
      policy,
      onEvent: (event) => { for (const listener of listeners) listener(event); },
    })
    : null;
  return {
    onebotClient,
    async start() { await supervisor?.start(); },
    async stop() { await supervisor?.stop(); },
    status() { return supervisor ? { ...supervisor.status(), enabled: true } : { state: 'disabled', enabled: false, lastError: null }; },
    obs() { return supervisor?.obs() || { available: false, state: 'disabled', recent: [], new: [] }; },
    complete(ids) { supervisor?.complete(ids); },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
}

export function createHandlers({ onebotClient, runtime, policy, getResidenceContext }) {
  return {
    reply: async (args) => {
      if (runtime && runtime.status().state !== 'ready') throw new Error('qq connection not ready');
      const client = onebotClient || runtime?.onebotClient;
      if (!client) throw new Error('qq runtime unavailable');
      const context = getResidenceContext();
      const decision = policy.authorizeReply(context, args);
      const result = context.kind === 'group'
        ? await client.sendGroupMsg(Number(context.peerId), args.text)
        : await client.sendPrivateMsg(Number(context.peerId), args.text);
      policy.noteOutput(context.residenceId);
      return { ...result, residenceId: context.residenceId, decisionReason: decision.reason };
    },
  };
}
