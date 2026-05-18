/**
 * remoteSyncQRPayload — pure helpers for the "share via QR / scan to import"
 * flow on the Remote Sync settings sheet. The payload deliberately carries
 * only the config-shape fields (connection details), not per-device runtime
 * fields like `enabled`, `acknowledgedWarning`, `lastSyncAt`, or `lastError`.
 */

import type { RemoteSyncSettings } from '@/core/contexts/SettingsContext';

const QR_TYPE = 'maneuver-remote-sync';
const QR_VERSION = 1;

export type RemoteSyncConfigShare = Pick<
  RemoteSyncSettings,
  'useHttps' | 'host' | 'port' | 'databaseName' | 'username' | 'password'
>;

interface QRPayload {
  v: number;
  type: string;
  config: RemoteSyncConfigShare;
}

export type ParseResult =
  | { ok: true; config: RemoteSyncConfigShare }
  | { ok: false; reason: string };

export function encodeRemoteSyncQR(draft: RemoteSyncSettings): string {
  const payload: QRPayload = {
    v: QR_VERSION,
    type: QR_TYPE,
    config: {
      useHttps: draft.useHttps,
      host: draft.host,
      port: draft.port,
      databaseName: draft.databaseName,
      username: draft.username,
      password: draft.password
    }
  };
  return JSON.stringify(payload);
}

export function parseRemoteSyncQR(raw: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'Not a Maneuver sync QR (invalid JSON).' };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, reason: 'Not a Maneuver sync QR (unexpected payload).' };
  }
  const candidate = parsed as Partial<QRPayload>;
  if (candidate.type !== QR_TYPE) {
    return { ok: false, reason: 'Not a Maneuver remote-sync QR.' };
  }
  if (candidate.v !== QR_VERSION) {
    return { ok: false, reason: `Unsupported QR version (${candidate.v ?? 'missing'}).` };
  }
  const config = candidate.config;
  if (!config || typeof config !== 'object') {
    return { ok: false, reason: 'QR is missing config fields.' };
  }
  if (
    typeof config.useHttps !== 'boolean' ||
    typeof config.host !== 'string' ||
    typeof config.port !== 'string' ||
    typeof config.databaseName !== 'string' ||
    typeof config.username !== 'string' ||
    typeof config.password !== 'string'
  ) {
    return { ok: false, reason: 'QR config fields have unexpected types.' };
  }
  return {
    ok: true,
    config: {
      useHttps: config.useHttps,
      host: config.host,
      port: config.port,
      databaseName: config.databaseName,
      username: config.username,
      password: config.password
    }
  };
}
