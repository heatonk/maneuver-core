/**
 * RemoteSyncBridge — mounts the useRemoteSyncStatus hook once at the app
 * root so the service module receives the current settings (URL, enabled
 * flag) without relying on any specific UI component being mounted. Also
 * registers a listener with the gamification module so its writes get
 * pushed to the remote.
 */

import { useEffect } from 'react';
import { useRemoteSyncStatus } from './useRemoteSyncStatus';
import { setGamificationWriteListener } from '@/game-template/gamification/database';
import { pushAfterSave } from './remoteSyncService';
import type { RecordType } from './remoteSyncRepo';

const GAM_KIND_TO_RECORD_TYPE: Record<'scout' | 'prediction' | 'achievement', RecordType> = {
  scout: 'gam-scout',
  prediction: 'gam-prediction',
  achievement: 'gam-achievement'
};

export function RemoteSyncBridge() {
  useRemoteSyncStatus();

  useEffect(() => {
    setGamificationWriteListener((record, kind) => {
      pushAfterSave(record, GAM_KIND_TO_RECORD_TYPE[kind]);
    });
    return () => setGamificationWriteListener(null);
  }, []);

  return null;
}
