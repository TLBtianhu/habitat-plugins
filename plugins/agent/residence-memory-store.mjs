// 分场所持久记忆：JSONL、TTL、脱敏、重启恢复与 owner-approved 共享。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const MODES = new Set(['ephemeral', 'residence', 'persistent']);
function hashScope(scope) { return crypto.createHash('sha256').update(scope).digest('hex').slice(0, 24); }
export function redactMemoryText(text) {
  return String(text || '')
    .slice(0, 2000)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [redacted]')
    .replace(/SESSDATA=\S+/gi, 'SESSDATA=[redacted]')
    .replace(/streamKey=\S+/gi, 'streamKey=[redacted]')
    .replace(/\bsk-[A-Za-z0-9]{20,}\b/g, '[redacted-api-key]');
}

export class ResidenceMemoryStore {
  constructor({ root = '/var/lib/habitat/memory', now = () => Date.now(), halfLifeMs = 3600000, residenceTtlMs = 30 * 86400000 } = {}) {
    this.root = root;
    this.now = now;
    this.halfLifeMs = halfLifeMs;
    this.residenceTtlMs = residenceTtlMs;
    this.items = new Map();
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    this._load();
  }

  _file(scope) { return path.join(this.root, `${hashScope(scope)}.jsonl`); }
  _load() {
    for (const file of fs.readdirSync(this.root).filter((f) => f.endsWith('.jsonl'))) {
      const full = path.join(this.root, file);
      const lines = fs.readFileSync(full, 'utf8').split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        try {
          const item = JSON.parse(line);
          if (!item.id || !item.scope || typeof item.fact !== 'string') continue;
          if (item.expiresAt && item.expiresAt <= this.now()) continue;
          this.items.set(item.id, item);
        } catch {}
      }
    }
  }

  _append(item) {
    const file = this._file(item.scope);
    fs.appendFileSync(file, JSON.stringify(item) + '\n', { mode: 0o600 });
    this.items.set(item.id, item);
  }

  remember(fact, { scope = 'system', mode = scope === 'system' ? 'persistent' : 'residence', tags = [], importance = 1, at = this.now(), sourceResidenceId = scope, source = sourceResidenceId, isPrivate = false, episodeId = null, visibility = scope === 'system' ? 'core' : 'residence', checkpointId = null } = {}) {
    if (!MODES.has(mode)) throw new Error('invalid memory mode');
    if (mode === 'ephemeral') return { skipped: true, reason: 'ephemeral' };
    const item = {
      id: crypto.randomUUID(),
      fact: redactMemoryText(fact),
      tags: [...tags],
      importance,
      at,
      scope,
      sourceResidenceId,
      source,
      private: isPrivate,
      episodeId,
      visibility,
      checkpointId,
      mode,
      expiresAt: mode === 'residence' ? at + this.residenceTtlMs : null,
    };
    if (!item.fact.trim()) throw new Error('memory fact required');
    this._append(item);
    return item;
  }

  workingSet(now = this.now(), { scope = 'system', limit = 12, source = null, includePrivate = false } = {}) {
    return this.list({ scope, source, includePrivate })
      .map((item) => ({ ...item, score: item.importance * Math.exp(-(now - item.at) / this.halfLifeMs) }))
      .filter((item) => item.score > 0.05)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((item) => item.fact);
  }

  recall(query, { scope = 'system', limit = 5, source = null, includePrivate = false } = {}) {
    const q = String(query || '').toLowerCase();
    if (!q) return [];
    return this.list({ scope, source, includePrivate })
      .filter((item) => item.fact.toLowerCase().includes(q) || item.tags.some((tag) => tag.toLowerCase().includes(q)))
      .slice(-limit)
      .map((item) => item.fact);
  }

  list({ scope = null, source = null, includePrivate = false } = {}) {
    return [...this.items.values()]
      .filter((item) => (!scope || item.scope === scope) && (!item.expiresAt || item.expiresAt > this.now()))
      .filter((item) => includePrivate || !item.private || item.source === source)
      .sort((a, b) => a.at - b.at);
  }

  share({ factId, targetResidenceId, approvedBy }) {
    if (approvedBy !== 'owner') throw new Error('owner approval required');
    const source = this.items.get(factId);
    if (!source) throw new Error('memory fact not found');
    if (source.scope === targetResidenceId) throw new Error('same residence');
    const target = {
      ...source,
      id: crypto.randomUUID(),
      scope: targetResidenceId,
      mode: 'residence',
      at: this.now(),
      expiresAt: this.now() + this.residenceTtlMs,
      sharedFrom: { scope: source.scope, itemId: source.id },
      approvedBy,
      sharedAt: this.now(),
    };
    this._append(target);
    return target;
  }

  compact() {
    const live = new Map(this.list().map((item) => [item.id, item]));
    this.items = live;
    const byScope = new Map();
    for (const item of live.values()) {
      if (!byScope.has(item.scope)) byScope.set(item.scope, []);
      byScope.get(item.scope).push(item);
    }
    for (const [scope, items] of byScope) {
      const file = this._file(scope);
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, items.map((item) => JSON.stringify(item)).join('\n') + '\n', { mode: 0o600 });
      fs.renameSync(tmp, file);
    }
  }
}
