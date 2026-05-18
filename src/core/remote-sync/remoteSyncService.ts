/**
 * remoteSyncService — orchestrates fire-and-forget pushes, the retry queue,
 * initial backfill, and on-demand pulls. The save sites depend only on
 * `pushAfterSave`. Everything else is consumed by the settings UI.
 */

import {
  loadAllScoutingEntries,
  loadAllPitScoutingEntries,
  importScoutingData
} from '@/core/db/database';
import { db as matchDB, pitDB } from '@/core/db/database';
import {
  gamificationDB,
  getAllScouts
} from '@/game-template/gamification/database';
import type { RemoteSyncSettings } from '@/core/contexts/SettingsContext';
import { composeRemoteUrl, ensureDatabaseExists, pingRemote, pullAllDocuments, pushDocuments } from './remoteSyncClient';
import type { PushResult } from './remoteSyncClient';
import {
  fromRemoteDoc,
  getPrefix,
  localKeyForRecord,
  toRemoteDoc,
  type AnyRecord,
  type AchievementRecord,
  type MatchRecord,
  type PitRecord,
  type PredictionRecord,
  type RecordType,
  type ScoutRecord
} from './remoteSyncRepo';
import {
  enqueueFailures,
  getAllPending,
  getQueueSize,
  removeByQueueIds
} from './remoteSyncQueue';

const BATCH_SIZE = 100;

interface ServiceStatus {
  queueSize: number;
  lastSyncAt: number;
  lastError: string;
  isPushing: boolean;
  isPulling: boolean;
  isBackfilling: boolean;
}

type StatusListener = (status: ServiceStatus) => void;

let currentSettings: RemoteSyncSettings | null = null;
let status: ServiceStatus = {
  queueSize: 0,
  lastSyncAt: 0,
  lastError: '',
  isPushing: false,
  isPulling: false,
  isBackfilling: false
};
const listeners = new Set<StatusListener>();

function emit(): void {
  for (const listener of listeners) {
    try {
      listener(status);
    } catch (err) {
      console.warn('remoteSyncService listener error:', err);
    }
  }
}

function patchStatus(patch: Partial<ServiceStatus>): void {
  status = { ...status, ...patch };
  emit();
}

export function getStatus(): ServiceStatus {
  return status;
}

export function subscribeStatus(listener: StatusListener): () => void {
  listeners.add(listener);
  listener(status);
  return () => {
    listeners.delete(listener);
  };
}

export function setRemoteSyncSettings(settings: RemoteSyncSettings | null): void {
  currentSettings = settings;
  if (settings) {
    patchStatus({ lastSyncAt: settings.lastSyncAt, lastError: settings.lastError });
  }
}

export function getActiveUrl(): string {
  if (!currentSettings || !currentSettings.enabled) return '';
  return composeRemoteUrl(currentSettings);
}

async function refreshQueueSize(): Promise<void> {
  const size = await getQueueSize();
  patchStatus({ queueSize: size });
}

/**
 * Fire-and-forget push hook called by every save site. Never blocks, never
 * throws. If sync is disabled or no URL is configured, this is a no-op.
 */
export function pushAfterSave(record: AnyRecord, type: RecordType): void {
  const url = getActiveUrl();
  if (!url) return;
  const snapshot = record;
  void (async () => {
    try {
      const result = await pushDocuments(url, [toRemoteDoc(snapshot, type)]);
      const firstFailure = result.failed[0];
      if (firstFailure) {
        await enqueueFailures([
          {
            record: snapshot,
            type,
            recordId: localKeyForRecord(snapshot, type),
            error: firstFailure.error
          }
        ]);
        patchStatus({ lastError: firstFailure.error });
      } else {
        patchStatus({ lastSyncAt: Date.now(), lastError: '' });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await enqueueFailures([
        {
          record: snapshot,
          type,
          recordId: localKeyForRecord(snapshot, type),
          error: message
        }
      ]);
      patchStatus({ lastError: message });
    } finally {
      await refreshQueueSize();
    }
  })();
}

/**
 * Push every existing local record up to the remote. Idempotent — safe to
 * re-run after a partial failure.
 */
export async function runInitialBackfill(): Promise<{ pushed: number; failed: number }> {
  const url = getActiveUrl();
  if (!url) throw new Error('Remote sync URL is not configured');
  patchStatus({ isBackfilling: true, lastError: '' });
  try {
    await ensureDatabaseExists(url);
    const buckets: Array<{ type: RecordType; records: AnyRecord[] }> = [
      { type: 'match', records: await loadAllScoutingEntries() as MatchRecord[] },
      { type: 'pit', records: await loadAllPitScoutingEntries() as PitRecord[] },
      { type: 'gam-scout', records: await getAllScouts() as ScoutRecord[] },
      { type: 'gam-prediction', records: await gamificationDB.predictions.toArray() as PredictionRecord[] },
      { type: 'gam-achievement', records: await gamificationDB.scoutAchievements.toArray() as AchievementRecord[] }
    ];
    let pushed = 0;
    let failed = 0;
    let lastError = '';
    for (const bucket of buckets) {
      for (let i = 0; i < bucket.records.length; i += BATCH_SIZE) {
        const batch = bucket.records.slice(i, i + BATCH_SIZE);
        const docs = batch.map(record => toRemoteDoc(record, bucket.type));
        const result = await pushDocuments(url, docs);
        pushed += result.succeeded.length;
        failed += result.failed.length;
        if (result.failed.length > 0) {
          const lastFailure = result.failed[result.failed.length - 1];
          if (lastFailure) lastError = lastFailure.error;
          // Mirror failures into the queue so the user can drain them later.
          const fallback = batch[0];
          if (fallback) {
            await enqueueFailures(
              result.failed.map(failure => {
                const recordId = failure.id.replace(`${getPrefix(bucket.type)}::`, '');
                const matching = batch.find(record => localKeyForRecord(record, bucket.type) === recordId);
                return {
                  record: matching ?? fallback,
                  type: bucket.type,
                  recordId,
                  error: failure.error
                };
              })
            );
          }
        }
      }
    }
    patchStatus({
      lastSyncAt: Date.now(),
      lastError: lastError || ''
    });
    await refreshQueueSize();
    return { pushed, failed };
  } finally {
    patchStatus({ isBackfilling: false });
  }
}

/**
 * Drain the retry queue against the configured remote.
 */
export async function drainQueue(): Promise<{ drained: number; remaining: number }> {
  const url = getActiveUrl();
  if (!url) throw new Error('Remote sync URL is not configured');
  patchStatus({ isPushing: true });
  try {
    const pending = await getAllPending();
    if (pending.length === 0) {
      await refreshQueueSize();
      return { drained: 0, remaining: 0 };
    }

    const grouped = new Map<RecordType, typeof pending>();
    for (const entry of pending) {
      const bucket = grouped.get(entry.type) ?? [];
      bucket.push(entry);
      grouped.set(entry.type, bucket);
    }

    let drained = 0;
    let lastError = '';
    for (const [type, entries] of grouped) {
      for (let i = 0; i < entries.length; i += BATCH_SIZE) {
        const batch = entries.slice(i, i + BATCH_SIZE);
        const docs = batch.map(entry => toRemoteDoc(entry.snapshot, type));
        let result: PushResult;
        try {
          result = await pushDocuments(url, docs);
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
          continue;
        }
        const succeededIdSet = new Set(result.succeeded);
        const successQueueIds: string[] = [];
        for (let j = 0; j < batch.length; j++) {
          const doc = docs[j];
          const entry = batch[j];
          if (!doc || !entry) continue;
          if (succeededIdSet.has(doc._id)) successQueueIds.push(entry.queueId);
        }
        if (successQueueIds.length > 0) {
          await removeByQueueIds(successQueueIds);
          drained += successQueueIds.length;
        }
        if (result.failed.length > 0) {
          const lastFailure = result.failed[result.failed.length - 1];
          if (lastFailure) lastError = lastFailure.error;
        }
      }
    }

    const remaining = await getQueueSize();
    patchStatus({
      lastSyncAt: Date.now(),
      lastError: lastError || '',
      queueSize: remaining
    });
    return { drained, remaining };
  } finally {
    patchStatus({ isPushing: false });
  }
}

/**
 * Pull every synced record type from the remote and route them through the
 * existing local importers. Returns a per-type summary.
 */
export async function pullAll(): Promise<{
  match: number;
  pit: number;
  gamificationScouts: number;
  gamificationPredictions: number;
  gamificationAchievements: number;
}> {
  const url = getActiveUrl();
  if (!url) throw new Error('Remote sync URL is not configured');
  patchStatus({ isPulling: true, lastError: '' });
  try {
    const matchDocs = await pullAllDocuments(url, getPrefix('match'));
    const pitDocs = await pullAllDocuments(url, getPrefix('pit'));
    const scoutDocs = await pullAllDocuments(url, getPrefix('gam-scout'));
    const predictionDocs = await pullAllDocuments(url, getPrefix('gam-prediction'));
    const achievementDocs = await pullAllDocuments(url, getPrefix('gam-achievement'));

    const matchRecords = matchDocs
      .map(doc => fromRemoteDoc<MatchRecord>(doc, 'match'))
      .filter((r): r is MatchRecord => r !== null);
    const pitRecords = pitDocs
      .map(doc => fromRemoteDoc<PitRecord>(doc, 'pit'))
      .filter((r): r is PitRecord => r !== null);
    const scoutRecords = scoutDocs
      .map(doc => fromRemoteDoc<ScoutRecord>(doc, 'gam-scout'))
      .filter((r): r is ScoutRecord => r !== null);
    const predictionRecords = predictionDocs
      .map(doc => fromRemoteDoc<PredictionRecord>(doc, 'gam-prediction'))
      .filter((r): r is PredictionRecord => r !== null);
    const achievementRecords = achievementDocs
      .map(doc => fromRemoteDoc<AchievementRecord>(doc, 'gam-achievement'))
      .filter((r): r is AchievementRecord => r !== null);

    if (matchRecords.length > 0) {
      await importScoutingData({ entries: matchRecords }, 'append');
    }
    if (pitRecords.length > 0) {
      // No append-mode helper exists for pit data; mirror the matchScouting
      // pattern manually so deterministic IDs prevent duplicates.
      const existingIds = new Set(await pitDB.pitScoutingData.orderBy('id').keys() as string[]);
      const fresh = pitRecords.filter(record => !existingIds.has(record.id));
      if (fresh.length > 0) await pitDB.pitScoutingData.bulkPut(fresh);
    }
    if (scoutRecords.length > 0) {
      const existingScouts = new Set((await gamificationDB.scouts.toCollection().primaryKeys()) as string[]);
      const fresh = scoutRecords.filter(scout => !existingScouts.has(scout.name));
      if (fresh.length > 0) await gamificationDB.scouts.bulkPut(fresh);
    }
    if (predictionRecords.length > 0) {
      const existingPredictions = new Set((await gamificationDB.predictions.toCollection().primaryKeys()) as string[]);
      const fresh = predictionRecords.filter(prediction => !existingPredictions.has(prediction.id));
      if (fresh.length > 0) await gamificationDB.predictions.bulkPut(fresh);
    }
    if (achievementRecords.length > 0) {
      // Composite primary key is [scoutName, achievementId]; bulkPut tolerates that natively.
      await gamificationDB.scoutAchievements.bulkPut(achievementRecords);
    }

    patchStatus({ lastSyncAt: Date.now(), lastError: '' });
    return {
      match: matchRecords.length,
      pit: pitRecords.length,
      gamificationScouts: scoutRecords.length,
      gamificationPredictions: predictionRecords.length,
      gamificationAchievements: achievementRecords.length
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    patchStatus({ lastError: message });
    throw err;
  } finally {
    patchStatus({ isPulling: false });
  }
}

export async function testConnection(url: string) {
  return pingRemote(url);
}

// Initialize queue size on module load so the indicator shows the right
// number immediately after the app boots.
void refreshQueueSize();

// matchDB is unused in the runtime exports above, but importing it ensures
// Dexie has opened the database before any sync operations run.
void matchDB;
