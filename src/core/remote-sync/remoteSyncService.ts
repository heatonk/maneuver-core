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
import {
  loadAllRepoLinks,
  teamGitHubLinksDB
} from '@/core/db/teamGitHubLinksDB';
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
  type ScoutRecord,
  type TeamRepoRecord
} from './remoteSyncRepo';
import {
  enqueueFailures,
  getAllPending,
  getQueueSize,
  markAttempted,
  removeByQueueIds
} from './remoteSyncQueue';

const BATCH_SIZE = 100;

function deepCloneRecord<T extends AnyRecord>(record: T): T {
  if (typeof structuredClone === 'function') {
    return structuredClone(record);
  }
  return JSON.parse(JSON.stringify(record)) as T;
}

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

function snapshotStatus(): ServiceStatus {
  // Shallow copy is sufficient — ServiceStatus is a flat object of primitives.
  return { ...status };
}

function emit(): void {
  const frozen = snapshotStatus();
  for (const listener of listeners) {
    try {
      listener(frozen);
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
  return snapshotStatus();
}

export function subscribeStatus(listener: StatusListener): () => void {
  listeners.add(listener);
  listener(snapshotStatus());
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
  // Deep-clone the record so any mutation by the caller after this fire-and-
  // forget call returns can't affect the document we eventually push.
  const snapshot = deepCloneRecord(record);
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
      { type: 'gam-achievement', records: await gamificationDB.scoutAchievements.toArray() as AchievementRecord[] },
      { type: 'tgh-repo', records: await loadAllRepoLinks() as TeamRepoRecord[] }
    ];
    let pushed = 0;
    let failed = 0;
    let lastError = '';
    for (const bucket of buckets) {
      for (let i = 0; i < bucket.records.length; i += BATCH_SIZE) {
        const batch = bucket.records.slice(i, i + BATCH_SIZE);
        const docs = batch.map(record => toRemoteDoc(record, bucket.type));
        let result: PushResult;
        try {
          result = await pushDocuments(url, docs);
        } catch (err) {
          // The whole batch faulted (network/CORS/etc). Don't abort backfill —
          // queue every record in the batch for retry and move on so later
          // buckets still get a chance.
          const message = err instanceof Error ? err.message : String(err);
          lastError = message;
          failed += batch.length;
          await enqueueFailures(
            batch.map(record => ({
              record,
              type: bucket.type,
              recordId: localKeyForRecord(record, bucket.type),
              error: message
            }))
          );
          continue;
        }
        pushed += result.succeeded.length;
        failed += result.failed.length;
        if (result.failed.length > 0) {
          const lastFailure = result.failed[result.failed.length - 1];
          if (lastFailure) lastError = lastFailure.error;
          // Mirror failures into the queue so the user can drain them later.
          // If we can't locate the original record for a failure (id mismatch
          // shouldn't happen, but if it does we'd persist the wrong snapshot
          // under that recordId), skip the failure rather than enqueue garbage.
          const failuresToQueue: Array<{ record: AnyRecord; type: RecordType; recordId: string; error: string }> = [];
          for (const failure of result.failed) {
            const recordId = failure.id.replace(`${getPrefix(bucket.type)}::`, '');
            const matching = batch.find(record => localKeyForRecord(record, bucket.type) === recordId);
            if (!matching) {
              console.warn(
                `remoteSyncService: dropping backfill failure with unmatched id "${failure.id}" (recordId="${recordId}", type="${bucket.type}") — no matching record in batch.`
              );
              continue;
            }
            failuresToQueue.push({ record: matching, type: bucket.type, recordId, error: failure.error });
          }
          if (failuresToQueue.length > 0) {
            await enqueueFailures(failuresToQueue);
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
          // Whole batch faulted (network/CORS/etc) — bump attempts and persist
          // the error on every queue entry in this batch so retry metadata
          // reflects reality.
          await markAttempted(batch.map(entry => entry.queueId), lastError);
          continue;
        }
        const succeededIdSet = new Set(result.succeeded);
        const successQueueIds: string[] = [];
        const failedIdToError = new Map(result.failed.map(failure => [failure.id, failure.error] as const));
        const failedQueueAttempts: Array<{ queueId: string; error: string }> = [];
        for (let j = 0; j < batch.length; j++) {
          const doc = docs[j];
          const entry = batch[j];
          if (!doc || !entry) continue;
          if (succeededIdSet.has(doc._id)) {
            successQueueIds.push(entry.queueId);
          } else {
            const docError = failedIdToError.get(doc._id);
            if (docError) failedQueueAttempts.push({ queueId: entry.queueId, error: docError });
          }
        }
        if (successQueueIds.length > 0) {
          await removeByQueueIds(successQueueIds);
          drained += successQueueIds.length;
        }
        // Persist retry metadata per failed queue entry so attempts and
        // lastError reflect this drain attempt, not just the last successful push.
        for (const failure of failedQueueAttempts) {
          await markAttempted([failure.queueId], failure.error);
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
  teamRepos: number;
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
    const teamRepoDocs = await pullAllDocuments(url, getPrefix('tgh-repo'));

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
    const teamRepoRecords = teamRepoDocs
      .map(doc => fromRemoteDoc<TeamRepoRecord>(doc, 'tgh-repo'))
      .filter((r): r is TeamRepoRecord => r !== null);

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
    if (teamRepoRecords.length > 0) {
      // Repo links are keyed by teamNumber, so bulkPut naturally upserts. Remote
      // is authoritative — a more recently-discovered link will overwrite the
      // local copy, which matches user intent (share & sync repo mappings).
      await teamGitHubLinksDB.repos.bulkPut(teamRepoRecords);
    }

    patchStatus({ lastSyncAt: Date.now(), lastError: '' });
    return {
      match: matchRecords.length,
      pit: pitRecords.length,
      gamificationScouts: scoutRecords.length,
      gamificationPredictions: predictionRecords.length,
      gamificationAchievements: achievementRecords.length,
      teamRepos: teamRepoRecords.length
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
