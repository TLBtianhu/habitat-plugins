// 原生 MC AI Client：通过 mcpfabric 读写原版客户端，不把世界服务端当身份
export class NativeMcClient {
  constructor({ rpc = 'http://127.0.0.1:25600/rpc', token } = {}) {
    this.rpc = rpc;
    this.token = token;
  }

  async call(method, params = {}) {
    const r = await fetch(this.rpc, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(12000),
    });
    const data = await r.json();
    if (!data.ok) throw new Error(data.error?.message || method);
    return data.result;
  }

  info() { return this.call('session.info'); }
  state() { return this.call('player.getState'); }
  scene() { return this.call('vision.describeScene'); }
  screen() { return this.call('screen.get'); }

  lookAt(x, y, z) { return this.call('control.lookAt', { x, y, z }); }
  look(yaw, pitch) { return this.call('control.look', { yaw, pitch }); }
  chat(message) { return this.call('chat.send', { message }); }
  stop() { return this.call('control.stop'); }

  async obs() {
    const [self, scene] = await Promise.all([this.state(), this.scene()]);
    const hits = (scene.rays || []).filter((r) => r.hit && r.id && !/air|water/.test(r.id));
    return {
      mode: 'play',
      self: {
        pos: [self.x, self.y, self.z],
        yaw: self.yaw,
        pitch: self.pitch,
        health: self.health,
        food: self.food,
      },
      action: { current: 'idle', isIdle: true },
      nearby: {
        blocks: hits.slice(0, 8).map((h) => ({ name: h.id, nearest: h.distance })),
        entities: scene.entities || [],
      },
      world: { dimension: self.dimension },
    };
  }

  async act(intent) {
    if (intent.verb === 'mc.say') return this.chat(intent.args.text);
    if (intent.verb === 'look') {
      const a = intent.args || {};
      if (a.yaw != null || a.pitch != null) return this.look(a.yaw ?? 0, a.pitch ?? 0);
      const p = Array.isArray(a.target) ? a.target : Array.isArray(a.pos) ? a.pos : [a.x, a.y, a.z];
      return this.lookAt(p[0], p[1], p[2]);
    }
    if (intent.verb === 'stop') return this.stop();
    throw new Error(`unsupported native verb: ${intent.verb}`);
  }
}
