// Durable Outbox：稳定 intent 身份、幂等、终态与迟发结果，替代盲目重试。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const TERMINAL = new Set(['succeeded', 'failed', 'interrupted']);
export class DurableOutbox {
  constructor({ file }) {
    this.file = file;
    this.records = new Map();
    this._load();
  }

  _load() {
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const record of saved.records || []) {
        if (record.state === 'accepted' || record.state === 'running') {
          record.state = 'interrupted';
          record.error = 'outbox restarted before terminal result';
          record.updatedAt = Date.now();
        }
        this.records.set(record.key, record);
      }
    } catch {}
  }

  _save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    const records = [...this.records.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .filter((r, i) => !TERMINAL.has(r.state) || i < 1000)
      .slice(0, 1500);
    fs.writeFileSync(tmp, JSON.stringify({ schemaVersion: 1, records }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  get(key) { return this.records.get(key) || null; }

  async execute({ key = null, verb, args = {}, run, timeoutMs = 0 }) {
    const intentKey = key || crypto.randomUUID();
    const existing = this.records.get(intentKey);
    if (existing) {
      if (existing.state === 'succeeded') return { ...existing.result, deduped: true };
      if (existing.state === 'failed' || existing.state === 'interrupted') {
        return { ok: false, state: existing.state, error: existing.error || existing.state, accepted: true, deduped: true };
      }
      return { ok: false, state: existing.state, error: 'in_progress', accepted: true, deduped: true };
    }
    const record = {
      key: intentKey,
      verb,
      args,
      state: 'accepted',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      result: null,
      error: null,
    };
    this.records.set(intentKey, record);
    this._save();

    let tracked;
    try {
      record.state = 'running';
      record.updatedAt = Date.now();
      this._save();
      tracked = Promise.resolve().then(run);
      const result = timeoutMs > 0
        ? await Promise.race([
            tracked,
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
          ])
        : await tracked;
      record.state = 'succeeded';
      record.result = result;
      record.error = null;
      record.updatedAt = Date.now();
      this._save();
      return result;
    } catch (error) {
      record.state = 'failed';
      record.error = String(error?.message || error);
      record.updatedAt = Date.now();
      this._save();
      throw error;
    } finally {
      // 如果调用方超时/放弃，provider 仍可能晚完成。只补事实，不反向覆盖终态。
      tracked?.then((lateResult) => {
        if (record.state === 'failed' && record.error === 'timeout') {
          record.state = 'succeeded';
          record.result = lateResult;
          record.late = true;
          record.updatedAt = Date.now();
          this._save();
        }
      }, () => {});
    }
  }

  status() {
    const counts = {};
    for (const record of this.records.values()) counts[record.state] = (counts[record.state] || 0) + 1;
    return { counts, total: this.records.size };
  }
}
