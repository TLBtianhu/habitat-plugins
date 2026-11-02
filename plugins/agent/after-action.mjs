// AfterActionReport：自评与验证分离，证据不足只能 unknown，不能宣称成功。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { redactMemoryText } from './residence-memory-store.mjs';

function hasEvidence(value) {
  return value !== undefined && value !== null && value !== '' && !(Array.isArray(value) && value.length === 0);
}

export function verifyChecks(checks = []) {
  if (!checks.length) return { outcome: 'unknown', memoryWrite: false, checks: [] };
  const normalized = checks.map((check) => ({
    name: String(check.name || 'check'),
    ok: check.ok === true,
    optional: check.optional === true,
    evidence: check.evidence,
  }));
  if (normalized.some((check) => check.ok === false && check.optional !== true)) return { outcome: 'verified_failure', memoryWrite: false, checks: normalized };
  if (normalized.some((check) => !hasEvidence(check.evidence))) return { outcome: 'unknown', memoryWrite: false, checks: normalized };
  if (normalized.some((check) => check.optional === true)) return { outcome: 'verified_partial', memoryWrite: false, checks: normalized };
  return { outcome: 'verified_success', memoryWrite: true, checks: normalized };
}

export class AfterActionStore {
  constructor({ file = '/var/lib/habitat/after-action.jsonl' } = {}) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  }

  record({ taskId, residenceId, goal, selfReport = null, checks = [] }) {
    const verification = verifyChecks(checks);
    const report = {
      id: crypto.randomUUID(),
      taskId,
      residenceId,
      goal: redactMemoryText(goal),
      selfReport: selfReport ? {
        outcome: selfReport.outcome || 'unknown',
        summary: redactMemoryText(selfReport.summary || ''),
        friction: redactMemoryText(selfReport.friction || ''),
        confidence: Number.isFinite(selfReport.confidence) ? Math.max(0, Math.min(1, selfReport.confidence)) : 0,
      } : null,
      verification,
      createdAt: Date.now(),
    };
    fs.appendFileSync(this.file, JSON.stringify(report) + '\n', { mode: 0o600 });
    return report;
  }

  list({ residenceId = null } = {}) {
    let lines = [];
    try { lines = fs.readFileSync(this.file, 'utf8').split(/\r?\n/).filter(Boolean); } catch { return []; }
    return lines.map((line) => JSON.parse(line)).filter((r) => !residenceId || r.residenceId === residenceId);
  }
}
