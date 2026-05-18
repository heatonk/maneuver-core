/**
 * useRemoteSyncStatus — React hook exposing the live remote sync status and
 * mirroring the current settings into the service module so save-site
 * fire-and-forget pushes know where to send.
 */

import { useEffect, useState } from 'react';
import { useSettings } from '@/core/contexts/SettingsContext';
import { getStatus, setRemoteSyncSettings, subscribeStatus } from './remoteSyncService';

export function useRemoteSyncStatus() {
  const { settings } = useSettings();
  const [status, setStatus] = useState(getStatus());

  useEffect(() => {
    setRemoteSyncSettings(settings.remoteSync);
  }, [settings.remoteSync]);

  useEffect(() => {
    return subscribeStatus(setStatus);
  }, []);

  return {
    enabled: settings.remoteSync.enabled,
    settings: settings.remoteSync,
    ...status
  };
}
