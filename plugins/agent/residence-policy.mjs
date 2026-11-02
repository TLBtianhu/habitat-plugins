// ResidenceContext + ChannelPolicy：人格共享，场所/权限/记忆/输出隔离。
import fs from 'node:fs';

const SYSTEM_DEFAULT = {
  read: true,
  respond: 'always',
  tools: ['system.say', 'voice.speak'],
  memory: 'persistent',
  proactive: true,
  rateLimitMs: 0,
};
const DEFAULTS = {
  'qq.group': { read: true, respond: 'disabled', tools: [], memory: 'ephemeral', proactive: false, rateLimitMs: 5000 },
  'qq.private': { read: true, respond: 'disabled', tools: [], memory: 'residence', proactive: false, rateLimitMs: 2000 },
  'bilibili.room': { read: true, respond: 'disabled', tools: [], memory: 'ephemeral', proactive: false, rateLimitMs: 5000 },
  'mc.world': { read: true, respond: 'addressed', tools: ['mc.say'], memory: 'residence', proactive: false, rateLimitMs: 1000 },
};

export class ChannelPolicy {
  constructor({ config = null, configPath = null, ownerIds = [], botNames = ['大肥鱼', '开发态habitat大肥鱼'], now = () => Date.now() } = {}) {
    let loaded = config;
    if (!loaded && configPath && fs.existsSync(configPath)) loaded = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    this.config = loaded || { version: 1, residences: {}, ownerIds, botNames };
    if (this.config.version !== 1) throw new Error('residence policy schemaVersion must be 1');
    this.ownerIds = new Set((this.config.ownerIds || ownerIds).map(String));
    this.botNames = this.config.botNames || botNames;
    this.now = now;
    this.lastRespondAt = new Map();
  }

  fromOneBot(event, connectionId = 0) {
    const kind = event.message_type === 'group' ? 'group' : 'private';
    const peerId = String(kind === 'group' ? event.group_id : event.user_id);
    const speakerId = String(event.user_id || '');
    const selfId = String(event.self_id || '');
    const addressed = this._addressed(event, selfId, kind);
    let speakerRole = 'viewer';
    if (speakerId === selfId) speakerRole = 'self';
    else if (this.ownerIds.has(speakerId)) speakerRole = kind === 'private' ? 'owner' : 'trusted';
    return {
      residenceId: `qq.${kind}.${peerId}`,
      channel: 'qq',
      kind,
      peerId,
      selfId,
      speakerId,
      speakerRole,
      trust: speakerRole,
      connectionId,
      addressed,
    };
  }

  _addressed(event, selfId, kind) {
    if (kind === 'private' || event.to_me === true) return true;
    const segments = Array.isArray(event.message) ? event.message : [];
    if (segments.some((s) => s?.type === 'at' && String(s?.data?.qq) === selfId)) return true;
    const text = String(event.raw_message || '');
    return this.botNames.some((name) => name && text.includes(name));
  }

  policyFor(residenceId) {
    const kind = residenceId.split('.').slice(0, 2).join('.');
    const base = residenceId === 'system' ? SYSTEM_DEFAULT : DEFAULTS[kind] || DEFAULTS['qq.group'];
    return { ...base, ...(this.config.residences?.[residenceId] || {}) };
  }

  evaluateInput(context) {
    const policy = this.policyFor(context.residenceId);
    if (!policy.read) return { read: false, shouldRespond: false, reason: 'read_disabled', policy };
    if (context.speakerRole === 'self' || context.from === 'dafeiyu') {
      return { read: true, shouldRespond: false, reason: 'self_message', policy };
    }
    const eligible = policy.respond === 'always' || (policy.respond === 'addressed' && context.addressed);
    const last = this.lastRespondAt.get(context.residenceId) || 0;
    const limited = policy.rateLimitMs > 0 && this.now() - last < policy.rateLimitMs;
    return {
      read: true,
      shouldRespond: Boolean(eligible && !limited),
      reason: !eligible ? 'not_addressed' : limited ? 'rate_limited' : 'ok',
      route: { channel: context.channel, residenceId: context.residenceId, peerId: context.peerId },
      memoryScope: this.memoryScope(context),
      policy,
    };
  }

  authorizeReply(context, args = {}) {
    if (!context || context.channel !== 'qq') throw new Error('reply_requires_qq_residence');
    for (const key of ['groupId', 'userId', 'peerId', 'residenceId', 'target']) {
      if (args[key] != null) throw new Error('reply_target_is_policy_bound');
    }
    const decision = this.evaluateInput(context);
    if (!decision.shouldRespond) throw new Error(decision.reason || 'reply_disabled');
    if (!decision.policy.tools.includes('qq.reply')) throw new Error('qq.reply_not_allowed');
    if (typeof args.text !== 'string' || !args.text.trim()) throw new Error('text_required');
    return decision;
  }

  noteOutput(residenceId) { this.lastRespondAt.set(residenceId, this.now()); }

  authorizeCrossChannel(task) {
    if (task.type !== 'cross_channel.message') throw new Error('not_cross_channel_task');
    if (task.sourceResidenceId !== 'system') throw new Error('cross_channel_requires_system_owner');
    if (!['approved', 'executing'].includes(task.status)) throw new Error('cross_channel_not_approved');
    const match = /^qq\.(group|private)\.(\d+)$/.exec(task.targetResidenceId || '');
    if (!match) throw new Error('invalid_cross_channel_target');
    const [, kind, peerId] = match;
    const residenceId = `qq.${kind}.${peerId}`;
    const policy = this.policyFor(residenceId);
    if (!policy.read) throw new Error('read_disabled');
    if (!policy.tools.includes('qq.reply')) throw new Error('qq.reply_not_allowed');
    const last = this.lastRespondAt.get(residenceId) || 0;
    if (policy.rateLimitMs > 0 && this.now() - last < policy.rateLimitMs) throw new Error('rate_limited');
    if (typeof task.text !== 'string' || !task.text.trim()) throw new Error('text_required');
    return { channel: 'qq', kind, peerId, targetResidenceId: residenceId, policy };
  }

  memoryScope(context) {
    const policy = this.policyFor(context.residenceId);
    return { mode: policy.memory, key: `memory://${context.channel}/${context.kind}/${context.peerId}` };
  }

  canProactive(context) { return Boolean(this.policyFor(context.residenceId).proactive); }
}

export function loadChannelPolicy(path = '/etc/habitat/residence-policy.json') {
  return new ChannelPolicy({ configPath: path });
}
