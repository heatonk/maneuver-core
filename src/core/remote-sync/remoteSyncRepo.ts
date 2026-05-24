/**
 * remoteSyncRepo — maps Maneuver record types ↔ CouchDB documents.
 *
 * The sync layer treats every record's `gameData` field as opaque JSON.
 * No field inside `gameData` is read or written here, so the layer is
 * year-agnostic and survives annual game schema changes untouched.
 */

import type { ScoutingEntryBase } from '@/core/types/scouting-entry';
import type { PitScoutingEntryBase } from '@/core/types/pit-scouting';
import type { Scout, MatchPrediction } from '@/core/types/gamification';
import type { ScoutAchievement } from '@/game-template/gamification/types';
import type { RemoteDoc } from './remoteSyncClient';

export type RecordType = 'match' | 'pit' | 'gam-scout' | 'gam-prediction' | 'gam-achievement';

export type MatchRecord = ScoutingEntryBase;
export type PitRecord = PitScoutingEntryBase;
export type ScoutRecord = Scout;
export type PredictionRecord = MatchPrediction;
export type AchievementRecord = ScoutAchievement;

export type AnyRecord = MatchRecord | PitRecord | ScoutRecord | PredictionRecord | AchievementRecord;

const PREFIX: Record<RecordType, string> = {
  match: 'match',
  pit: 'pit',
  'gam-scout': 'gam-scout',
  'gam-prediction': 'gam-prediction',
  'gam-achievement': 'gam-achievement'
};

export function getPrefix(type: RecordType): string {
  return PREFIX[type];
}

/**
 * Compute the CouchDB `_id` for a local record. Match and pit records carry an
 * `id` field; gamification records have varying natural keys, so we derive a
 * stable id per type.
 */
export function localKeyForRecord(record: AnyRecord, type: RecordType): string {
  switch (type) {
    case 'match':
    case 'pit':
      return (record as MatchRecord | PitRecord).id;
    case 'gam-scout':
      return (record as ScoutRecord).name;
    case 'gam-prediction':
      return (record as PredictionRecord).id;
    case 'gam-achievement': {
      const a = record as AchievementRecord;
      return `${a.scoutName}::${a.achievementId}`;
    }
  }
}

export function toRemoteDoc(record: AnyRecord, type: RecordType): RemoteDoc {
  const prefix = PREFIX[type];
  const localKey = localKeyForRecord(record, type);
  return {
    _id: `${prefix}::${localKey}`,
    type,
    payload: { ...(record as unknown as Record<string, unknown>) }
  };
}

export function fromRemoteDoc<T extends AnyRecord>(doc: RemoteDoc, type: RecordType): T | null {
  const prefix = PREFIX[type];
  if (!doc._id.startsWith(`${prefix}::`)) return null;
  const payload = (doc as RemoteDoc & { payload?: unknown }).payload;
  if (!payload || typeof payload !== 'object') return null;
  // Strip CouchDB-only fields (`_id`, `_rev`, `type`, `payload`) by returning a
  // fresh copy of just the payload — that's the only thing local stores care
  // about.
  return { ...(payload as object) } as T;
}
