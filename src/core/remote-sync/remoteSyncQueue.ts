/**
 * remoteSyncQueue — local Dexie-backed retry queue for records whose remote
 * push failed (offline, server down, auth error, etc). Failures land here;
 * the drain step retries them in batches.
 */

import Dexie, { type Table } from 'dexie';
import type { AnyRecord, RecordType } from './remoteSyncRepo';

export interface PendingSyncEntry {
  queueId: string;
  recordId: string;
  type: RecordType;
  snapshot: AnyRecord;
  attempts: number;
  lastAttemptAt: number;
  lastError: string;
  createdAt: number;
}

class RemoteSyncQueueDB extends Dexie {
  pending!: Table<PendingSyncEntry, string>;

  constructor() {
    super('RemoteSyncQueueDB');
    this.version(1).stores({
      pending: 'queueId, recordId, type, attempts, lastAttemptAt, createdAt, [type+recordId]'
    });
  }
}

const queueDB = new RemoteSyncQueueDB();

function newQueueId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `q-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function enqueueFailures(
  failures: Array<{ record: AnyRecord; type: RecordType; recordId: string; error: string }>
): Promise<void> {
  if (failures.length === 0) return;
  const now = Date.now();
  // Deduplicate: if an entry already exists for the same (type, recordId), update it.
  for (const failure of failures) {
    const existing = await queueDB.pending
      .where('[type+recordId]')
      .equals([failure.type, failure.recordId])
      .first();
    if (existing) {
      await queueDB.pending.put({
        ...existing,
        snapshot: failure.record,
        attempts: existing.attempts + 1,
        lastAttemptAt: now,
        lastError: failure.error
      });
    } else {
      await queueDB.pending.put({
        queueId: newQueueId(),
        recordId: failure.recordId,
        type: failure.type,
        snapshot: failure.record,
        attempts: 1,
        lastAttemptAt: now,
        lastError: failure.error,
        createdAt: now
      });
    }
  }
}

export async function getQueueSize(): Promise<number> {
  return queueDB.pending.count();
}

export async function getAllPending(): Promise<PendingSyncEntry[]> {
  return queueDB.pending.orderBy('createdAt').toArray();
}

export async function removeByQueueIds(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await queueDB.pending.bulkDelete(ids);
}

export async function markAttempted(ids: string[], error: string): Promise<void> {
  if (ids.length === 0) return;
  const now = Date.now();
  await queueDB.transaction('rw', queueDB.pending, async () => {
    for (const id of ids) {
      const entry = await queueDB.pending.get(id);
      if (!entry) continue;
      await queueDB.pending.put({
        ...entry,
        attempts: entry.attempts + 1,
        lastAttemptAt: now,
        lastError: error
      });
    }
  });
}

export async function clearQueue(): Promise<void> {
  await queueDB.pending.clear();
}
