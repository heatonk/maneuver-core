/**
 * remoteSyncClient — stateless HTTP client for a remote CouchDB endpoint.
 *
 * No PouchDB dependency. Each function takes an already-composed URL of the
 * form `<scheme>://<user>:<pass>@<host>[:<port>]/<dbname>`. Credentials are
 * parsed out and sent via an Authorization header so they never appear in the
 * request URL on the wire.
 */

import type { RemoteSyncSettings } from '@/core/contexts/SettingsContext';

export interface PingResult {
  ok: boolean;
  dbExists: boolean;
  error?: string;
}

export interface PushResult {
  succeeded: string[];
  failed: Array<{ id: string; error: string }>;
}

export interface RemoteDoc extends Record<string, unknown> {
  _id: string;
  _rev?: string;
}

interface ParsedRemote {
  origin: string;
  pathname: string;
  dbName: string;
  authHeader: string | undefined;
}

const PASSWORD_MASK = '***';

export function composeRemoteUrl(settings: RemoteSyncSettings): string {
  const scheme = settings.useHttps ? 'https' : 'http';
  const host = settings.host.trim();
  const port = settings.port.trim();
  const db = settings.databaseName.trim();
  const user = settings.username.trim();
  const password = settings.password;
  if (!host || !db) return '';
  const auth = user ? `${encodeURIComponent(user)}:${encodeURIComponent(password)}@` : '';
  const portPart = port ? `:${port}` : '';
  return `${scheme}://${auth}${host}${portPart}/${encodeURIComponent(db)}`;
}

export function composeRemoteUrlForDisplay(settings: RemoteSyncSettings): string {
  const masked: RemoteSyncSettings = { ...settings, password: settings.password ? PASSWORD_MASK : '' };
  // composeRemoteUrl URL-encodes the password; manually re-substitute the literal mask for readability.
  const scheme = masked.useHttps ? 'https' : 'http';
  const host = masked.host.trim();
  const port = masked.port.trim();
  const db = masked.databaseName.trim();
  const user = masked.username.trim();
  if (!host || !db) return '';
  const auth = user ? `${user}${masked.password ? `:${PASSWORD_MASK}` : ''}@` : '';
  const portPart = port ? `:${port}` : '';
  return `${scheme}://${auth}${host}${portPart}/${db}`;
}

function parseRemote(url: string): ParsedRemote {
  const parsed = new URL(url);
  const username = parsed.username ? decodeURIComponent(parsed.username) : '';
  const password = parsed.password ? decodeURIComponent(parsed.password) : '';
  const authHeader = username
    ? `Basic ${typeof btoa === 'function'
        ? btoa(`${username}:${password}`)
        : Buffer.from(`${username}:${password}`).toString('base64')}`
    : undefined;
  const dbName = decodeURIComponent(parsed.pathname.replace(/^\/+/, '').replace(/\/+$/, ''));
  parsed.username = '';
  parsed.password = '';
  return {
    origin: `${parsed.protocol}//${parsed.host}`,
    pathname: parsed.pathname.replace(/\/+$/, ''),
    dbName,
    authHeader
  };
}

function buildHeaders(remote: ParsedRemote, extra?: HeadersInit): Headers {
  const headers = new Headers(extra);
  headers.set('Accept', 'application/json');
  if (remote.authHeader) headers.set('Authorization', remote.authHeader);
  return headers;
}

async function readError(response: Response): Promise<string> {
  try {
    const body = await response.json();
    if (body?.reason) return `${response.status} ${body.reason}`;
    if (body?.error) return `${response.status} ${body.error}`;
  } catch {
    // ignore JSON parse errors
  }
  return `${response.status} ${response.statusText || 'error'}`;
}

/**
 * Classify a thrown fetch error. The browser fetch API rejects with a
 * generic `TypeError` for *both* network failures and CORS blocks, with
 * messages that vary across browsers ("Failed to fetch" / "NetworkError" /
 * "Load failed"), so we can't distinguish the two definitively — but the
 * remediation is almost always "enable CORS on the CouchDB side or check
 * the URL," so we surface that hint when fetch throws.
 */
function describeFetchError(err: unknown, context: string): string {
  if (err instanceof TypeError) {
    return `${context}: the browser blocked the request. This usually means CouchDB CORS is not enabled, or the host/port is wrong. (${err.message})`;
  }
  const message = err instanceof Error ? err.message : String(err);
  return `${context}: ${message}`;
}

export async function pingRemote(url: string): Promise<PingResult> {
  if (!url) return { ok: false, dbExists: false, error: 'No URL configured' };
  let remote: ParsedRemote;
  try {
    remote = parseRemote(url);
  } catch (err) {
    return { ok: false, dbExists: false, error: `Invalid URL: ${(err as Error).message}` };
  }

  try {
    const rootResponse = await fetch(remote.origin, { headers: buildHeaders(remote) });
    if (!rootResponse.ok) {
      return { ok: false, dbExists: false, error: await readError(rootResponse) };
    }
  } catch (err) {
    return { ok: false, dbExists: false, error: describeFetchError(err, 'Cannot reach server') };
  }

  try {
    const dbResponse = await fetch(`${remote.origin}${remote.pathname}`, { headers: buildHeaders(remote) });
    if (dbResponse.status === 404) {
      return { ok: true, dbExists: false };
    }
    if (!dbResponse.ok) {
      return { ok: false, dbExists: false, error: await readError(dbResponse) };
    }
    return { ok: true, dbExists: true };
  } catch (err) {
    return { ok: false, dbExists: false, error: describeFetchError(err, 'Database probe failed') };
  }
}

export async function ensureDatabaseExists(url: string): Promise<void> {
  const remote = parseRemote(url);
  const response = await fetch(`${remote.origin}${remote.pathname}`, {
    method: 'PUT',
    headers: buildHeaders(remote)
  });
  // 201 created, 412 already exists — both acceptable.
  if (response.status === 201 || response.status === 412) return;
  if (response.status === 401 || response.status === 403) {
    throw new Error(`Not authorized to create database (${response.status}). Check credentials.`);
  }
  throw new Error(await readError(response));
}

async function fetchRev(remote: ParsedRemote, id: string): Promise<string | undefined> {
  const response = await fetch(`${remote.origin}${remote.pathname}/${encodeURIComponent(id)}`, {
    method: 'HEAD',
    headers: buildHeaders(remote)
  });
  if (!response.ok) return undefined;
  const etag = response.headers.get('etag');
  if (!etag) return undefined;
  // CouchDB returns ETag wrapped in double quotes.
  return etag.replace(/^"|"$/g, '');
}

interface BulkResponseRow {
  ok?: boolean;
  id: string;
  rev?: string;
  error?: string;
  reason?: string;
}

export async function pushDocuments(url: string, docs: RemoteDoc[]): Promise<PushResult> {
  const result: PushResult = { succeeded: [], failed: [] };
  if (docs.length === 0) return result;

  const remote = parseRemote(url);
  const headers = buildHeaders(remote, { 'Content-Type': 'application/json' });

  const initialResponse = await fetch(`${remote.origin}${remote.pathname}/_bulk_docs`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ docs })
  });

  if (!initialResponse.ok) {
    const err = await readError(initialResponse);
    docs.forEach(doc => result.failed.push({ id: doc._id, error: err }));
    return result;
  }

  const rows = (await initialResponse.json()) as BulkResponseRow[];
  const conflictRetries: RemoteDoc[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const doc = docs[i];
    if (!row || !doc) continue;
    if (row.ok) {
      result.succeeded.push(row.id);
    } else if (row.error === 'conflict') {
      conflictRetries.push(doc);
    } else {
      result.failed.push({ id: row.id, error: row.reason || row.error || 'unknown error' });
    }
  }

  if (conflictRetries.length > 0) {
    const updatedDocs: RemoteDoc[] = [];
    for (const doc of conflictRetries) {
      const rev = await fetchRev(remote, doc._id);
      if (!rev) {
        result.failed.push({ id: doc._id, error: 'conflict — could not fetch current _rev' });
        continue;
      }
      updatedDocs.push({ ...doc, _rev: rev });
    }
    if (updatedDocs.length > 0) {
      const retryResponse = await fetch(`${remote.origin}${remote.pathname}/_bulk_docs`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ docs: updatedDocs })
      });
      if (!retryResponse.ok) {
        const err = await readError(retryResponse);
        updatedDocs.forEach(doc => result.failed.push({ id: doc._id, error: err }));
      } else {
        const retryRows = (await retryResponse.json()) as BulkResponseRow[];
        retryRows.forEach(row => {
          if (row.ok) result.succeeded.push(row.id);
          else result.failed.push({ id: row.id, error: row.reason || row.error || 'unknown error' });
        });
      }
    }
  }

  return result;
}

interface AllDocsResponse {
  rows: Array<{ id: string; doc?: RemoteDoc }>;
}

export async function pullAllDocuments(url: string, prefix: string): Promise<RemoteDoc[]> {
  const remote = parseRemote(url);
  // U+FFF0 is a high-sortkey CouchDB convention for prefix scans.
  const params = new URLSearchParams({
    include_docs: 'true',
    startkey: JSON.stringify(`${prefix}::`),
    endkey: JSON.stringify(`${prefix}::￰`)
  });
  const response = await fetch(
    `${remote.origin}${remote.pathname}/_all_docs?${params.toString()}`,
    { headers: buildHeaders(remote) }
  );
  if (!response.ok) throw new Error(await readError(response));
  const body = (await response.json()) as AllDocsResponse;
  return body.rows
    .map(row => row.doc)
    .filter((doc): doc is RemoteDoc => Boolean(doc) && typeof doc?._id === 'string');
}
