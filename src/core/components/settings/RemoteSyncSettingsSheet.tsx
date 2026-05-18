import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { AlertTriangleIcon, CheckCircle2Icon, EyeIcon, EyeOffIcon, Loader2Icon, QrCodeIcon, RefreshCwIcon, ScanLineIcon, XCircleIcon } from 'lucide-react';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle
} from '@/core/components/ui/sheet';
import { Button } from '@/core/components/ui/button';
import { Input } from '@/core/components/ui/input';
import { Label } from '@/core/components/ui/label';
import { Checkbox } from '@/core/components/ui/checkbox';
import { Alert, AlertDescription, AlertTitle } from '@/core/components/ui/alert';
import { useSettings, type RemoteSyncSettings } from '@/core/contexts/SettingsContext';
import { useRemoteSyncStatus } from '@/core/remote-sync/useRemoteSyncStatus';
import { composeRemoteUrl, composeRemoteUrlForDisplay, pingRemote } from '@/core/remote-sync/remoteSyncClient';
import { drainQueue, runInitialBackfill, setRemoteSyncSettings } from '@/core/remote-sync/remoteSyncService';
import { RemoteSyncWarningDialog } from './RemoteSyncWarningDialog';
import { RemoteSyncShareQRDialog } from './RemoteSyncShareQRDialog';
import { RemoteSyncScanQRDialog } from './RemoteSyncScanQRDialog';
import type { RemoteSyncConfigShare } from '@/core/remote-sync/remoteSyncQRPayload';

interface RemoteSyncSettingsSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type TestState =
  | { kind: 'idle' }
  | { kind: 'testing' }
  | { kind: 'success'; dbExists: boolean }
  | { kind: 'error'; message: string };

export function RemoteSyncSettingsSheet({ open, onOpenChange }: RemoteSyncSettingsSheetProps) {
  const { settings, updateSettings } = useSettings();
  const status = useRemoteSyncStatus();
  const [draft, setDraft] = useState<RemoteSyncSettings>(settings.remoteSync);
  const [showPassword, setShowPassword] = useState(false);
  const [warningOpen, setWarningOpen] = useState(false);
  const [testState, setTestState] = useState<TestState>({ kind: 'idle' });
  const [backfillSummary, setBackfillSummary] = useState<string>('');
  const [shareQROpen, setShareQROpen] = useState(false);
  const [scanQROpen, setScanQROpen] = useState(false);

  useEffect(() => {
    if (open) {
      setDraft(settings.remoteSync);
      setTestState({ kind: 'idle' });
      setBackfillSummary('');
    }
  }, [open, settings.remoteSync]);

  const composedDisplay = useMemo(() => composeRemoteUrlForDisplay(draft), [draft]);
  const composedUrl = useMemo(() => composeRemoteUrl(draft), [draft]);
  const canTest = composedUrl.length > 0;
  const hasUnsavedChanges = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(settings.remoteSync),
    [draft, settings.remoteSync]
  );

  function handleField<K extends keyof RemoteSyncSettings>(key: K, value: RemoteSyncSettings[K]) {
    setDraft(prev => ({ ...prev, [key]: value }));
    setTestState({ kind: 'idle' });
  }

  function handleEnableToggle(next: boolean) {
    if (next && !draft.acknowledgedWarning) {
      setWarningOpen(true);
      return;
    }
    handleField('enabled', next);
  }

  function handleWarningContinue() {
    setWarningOpen(false);
    setDraft(prev => ({ ...prev, acknowledgedWarning: true, enabled: true }));
  }

  async function handleTestConnection() {
    setTestState({ kind: 'testing' });
    try {
      const result = await pingRemote(composedUrl);
      if (result.ok) {
        setTestState({ kind: 'success', dbExists: result.dbExists });
      } else {
        setTestState({ kind: 'error', message: result.error || 'Unknown error' });
      }
    } catch (err) {
      // pingRemote is internally try/catch-wrapped, but guard here too so an
      // unexpected throw can't leave the button spinning forever.
      const message = err instanceof Error ? err.message : String(err) || 'Unknown error';
      setTestState({ kind: 'error', message });
    }
  }

  async function handleSaveAndBackfill() {
    // Push the draft directly into the service so the backfill below sees the
    // new URL synchronously, instead of waiting on React/useEffect propagation
    // from the context. updateSettings still runs so the value is persisted to
    // localStorage and other consumers stay in sync.
    setRemoteSyncSettings(draft);
    updateSettings({ remoteSync: draft });
    setBackfillSummary('Pushing existing local records to remote…');
    try {
      const summary = await runInitialBackfill();
      setBackfillSummary(`Backfill complete — ${summary.pushed} pushed, ${summary.failed} failed.`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setBackfillSummary(`Backfill failed: ${message}`);
    }
  }

  async function handleSyncNow() {
    setBackfillSummary('Draining queue…');
    try {
      const result = await drainQueue();
      setBackfillSummary(`Drained ${result.drained}, remaining ${result.remaining}.`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setBackfillSummary(`Sync failed: ${message}`);
    }
  }

  function handleSaveOnly() {
    updateSettings({ remoteSync: draft });
  }

  function handleScannedConfig(config: RemoteSyncConfigShare) {
    setDraft(prev => ({ ...prev, ...config }));
    setTestState({ kind: 'idle' });
    toast.success('Sync config imported — review and Save.');
  }

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-xl">
          <SheetHeader>
            <SheetTitle>Remote CouchDB sync</SheetTitle>
            <SheetDescription>
              Optional, advanced feature. Pushes every saved scouting record to a CouchDB
              server you operate.
            </SheetDescription>
          </SheetHeader>

          <div className="space-y-6">
            {draft.acknowledgedWarning && (
              <Alert variant="destructive">
                <AlertTriangleIcon />
                <AlertTitle>Unsupported feature</AlertTitle>
                <AlertDescription>
                  Credentials are stored locally in plain text. Every saved record is sent
                  off-device. Re-open this sheet's confirmation by clearing the
                  acknowledgement below if you want to revisit the warning.
                </AlertDescription>
              </Alert>
            )}

            <div className="flex items-start gap-3">
              <Checkbox
                id="remote-sync-enabled"
                checked={draft.enabled}
                onCheckedChange={(value) => handleEnableToggle(value === true)}
              />
              <div className="flex flex-col">
                <Label htmlFor="remote-sync-enabled" className="text-sm font-medium">
                  Enable remote sync
                </Label>
                <span className="text-xs text-muted-foreground">
                  When on, saves are pushed to the remote and the indicator appears in the
                  sidebar.
                </span>
              </div>
            </div>

            <div className="space-y-4 rounded-md border p-4">
              <h4 className="text-sm font-semibold">Connection</h4>

              <div className="flex items-start gap-3">
                <Checkbox
                  id="remote-sync-https"
                  checked={draft.useHttps}
                  onCheckedChange={(value) => handleField('useHttps', value === true)}
                />
                <Label htmlFor="remote-sync-https" className="text-sm">Use HTTPS</Label>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="col-span-2 space-y-1">
                  <Label htmlFor="remote-sync-host" className="text-xs">Host</Label>
                  <Input
                    id="remote-sync-host"
                    placeholder="couchdb.example.com"
                    value={draft.host}
                    onChange={(e) => handleField('host', e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="remote-sync-port" className="text-xs">Port (optional)</Label>
                  <Input
                    id="remote-sync-port"
                    placeholder={draft.useHttps ? '443' : '5984'}
                    inputMode="numeric"
                    value={draft.port}
                    onChange={(e) => handleField('port', e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="remote-sync-db" className="text-xs">Database name</Label>
                  <Input
                    id="remote-sync-db"
                    placeholder="maneuver"
                    value={draft.databaseName}
                    onChange={(e) => handleField('databaseName', e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="remote-sync-user" className="text-xs">Username</Label>
                  <Input
                    id="remote-sync-user"
                    value={draft.username}
                    onChange={(e) => handleField('username', e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="remote-sync-pass" className="text-xs">Password</Label>
                  <div className="relative">
                    <Input
                      id="remote-sync-pass"
                      type={showPassword ? 'text' : 'password'}
                      value={draft.password}
                      onChange={(e) => handleField('password', e.target.value)}
                    />
                    <button
                      type="button"
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                      onClick={() => setShowPassword(v => !v)}
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                    >
                      {showPassword ? <EyeOffIcon className="size-4" /> : <EyeIcon className="size-4" />}
                    </button>
                  </div>
                </div>
              </div>

              <div className="space-y-1">
                <Label className="text-xs">Composed URL preview</Label>
                <div className="break-all rounded-md bg-muted px-3 py-2 font-mono text-xs">
                  {composedDisplay || <span className="text-muted-foreground">Fill in host and database name above.</span>}
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Button variant="outline" size="sm" disabled={!canTest || testState.kind === 'testing'} onClick={handleTestConnection}>
                  {testState.kind === 'testing' ? <Loader2Icon className="mr-2 size-4 animate-spin" /> : null}
                  Test connection
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!canTest}
                  onClick={() => setShareQROpen(true)}
                  title="Share this config with another scout via QR"
                >
                  <QrCodeIcon className="mr-2 size-4" />
                  Share via QR
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setScanQROpen(true)}
                  title="Import a config from another scout's QR"
                >
                  <ScanLineIcon className="mr-2 size-4" />
                  Scan to import
                </Button>
                {testState.kind === 'success' && (
                  <span className="flex items-center gap-1 text-sm text-emerald-600">
                    <CheckCircle2Icon className="size-4" />
                    {testState.dbExists ? 'Reachable, database exists.' : 'Reachable, database will be created on save.'}
                  </span>
                )}
                {testState.kind === 'error' && (
                  <span className="flex items-center gap-1 text-sm text-destructive">
                    <XCircleIcon className="size-4" />
                    {testState.message}
                  </span>
                )}
              </div>

              {testState.kind === 'error' && /browser blocked|Failed to fetch|NetworkError|Load failed/i.test(testState.message) && (
                <Alert variant="destructive" className="text-xs">
                  <AlertTriangleIcon />
                  <AlertTitle>Likely a CORS or reachability issue</AlertTitle>
                  <AlertDescription className="space-y-2">
                    <p>
                      A terminal <code>curl</code> can hit CouchDB even when the browser cannot, because browsers
                      enforce CORS. CouchDB does not send CORS headers by default — you need to enable them on
                      the server (one-time setup). Replace <code>$URL</code> with your CouchDB admin URL and{' '}
                      <code>$ORIGIN</code> with the exact origin Maneuver is served from (e.g.{' '}
                      <code>https://maneuver.your-team.org</code>). A wildcard <code>*</code> origin is{' '}
                      <strong>not valid</strong> with <code>cors/credentials = true</code> — browsers reject that combination.
                    </p>
                    <pre className="overflow-x-auto rounded-md bg-muted p-2 text-[10px] leading-tight">{`curl -X PUT $URL/_node/_local/_config/httpd/enable_cors -d '"true"'
curl -X PUT $URL/_node/_local/_config/cors/origins -d '"$ORIGIN"'
curl -X PUT $URL/_node/_local/_config/cors/credentials -d '"true"'
curl -X PUT $URL/_node/_local/_config/cors/methods -d '"GET, PUT, POST, HEAD, DELETE"'
curl -X PUT $URL/_node/_local/_config/cors/headers -d '"accept, authorization, content-type, origin, referer"'`}</pre>
                    <p>
                      Also double-check the host/port and that nothing (firewall, reverse proxy) is rewriting
                      the request. Browser DevTools → Network tab will show the underlying error if it is not CORS.
                    </p>
                  </AlertDescription>
                </Alert>
              )}
            </div>

            <div className="space-y-3 rounded-md border p-4">
              <h4 className="text-sm font-semibold">Status</h4>
              <div className="grid grid-cols-2 gap-2 text-sm">
                <span className="text-muted-foreground">Queue size</span>
                <span className="font-mono">{status.queueSize}</span>
                <span className="text-muted-foreground">Last sync</span>
                <span className="font-mono">
                  {status.lastSyncAt ? new Date(status.lastSyncAt).toLocaleString() : '—'}
                </span>
                <span className="text-muted-foreground">Last error</span>
                <span className="font-mono break-all text-destructive">{status.lastError || '—'}</span>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!settings.remoteSync.enabled || status.isPushing}
                  onClick={handleSyncNow}
                >
                  {status.isPushing ? <Loader2Icon className="mr-2 size-4 animate-spin" /> : <RefreshCwIcon className="mr-2 size-4" />}
                  Sync now
                </Button>
              </div>
              {backfillSummary && <p className="text-xs text-muted-foreground">{backfillSummary}</p>}
            </div>
          </div>

          <SheetFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
            <Button
              variant="secondary"
              onClick={handleSaveOnly}
              disabled={!hasUnsavedChanges}
            >
              Save
            </Button>
            <Button
              onClick={handleSaveAndBackfill}
              disabled={testState.kind !== 'success' || status.isBackfilling}
            >
              {status.isBackfilling ? <Loader2Icon className="mr-2 size-4 animate-spin" /> : null}
              Save &amp; backfill
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      <RemoteSyncWarningDialog
        open={warningOpen}
        onCancel={() => setWarningOpen(false)}
        onContinue={handleWarningContinue}
      />

      <RemoteSyncShareQRDialog
        open={shareQROpen}
        onOpenChange={setShareQROpen}
        draft={draft}
      />

      <RemoteSyncScanQRDialog
        open={scanQROpen}
        onOpenChange={setScanQROpen}
        onScanned={handleScannedConfig}
      />
    </>
  );
}
