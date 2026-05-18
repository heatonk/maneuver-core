import { useState } from 'react';
import { CheckCircle2Icon, CloudIcon, CloudOffIcon, Loader2Icon, SettingsIcon } from 'lucide-react';
import { useRemoteSyncStatus } from '@/core/remote-sync/useRemoteSyncStatus';
import { RemoteSyncSettingsSheet } from './RemoteSyncSettingsSheet';
import { cn } from '@/core/lib/utils';

/**
 * Compact pill shown in the sidebar so a scout can see remote-sync health at
 * a glance, and a discreet entry point when sync is disabled so the settings
 * sheet is reachable. Click anywhere to open the settings sheet.
 */
export function RemoteSyncIndicator() {
  const { enabled, queueSize, lastError, isPushing } = useRemoteSyncStatus();
  const [sheetOpen, setSheetOpen] = useState(false);

  let label: string;
  let dotClass: string;
  let Icon = CloudIcon;
  if (!enabled) {
    label = 'Remote sync · off';
    dotClass = 'bg-muted-foreground/40';
    Icon = SettingsIcon;
  } else if (isPushing) {
    label = 'Syncing…';
    dotClass = 'bg-sky-500';
    Icon = Loader2Icon;
  } else if (queueSize > 0 && lastError) {
    label = `${queueSize} failing`;
    dotClass = 'bg-destructive';
    Icon = CloudOffIcon;
  } else if (queueSize > 0) {
    label = `${queueSize} pending`;
    dotClass = 'bg-amber-500';
    Icon = CloudIcon;
  } else {
    label = 'Synced';
    dotClass = 'bg-emerald-500';
    Icon = CheckCircle2Icon;
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setSheetOpen(true)}
        title={lastError ? `Last error: ${lastError}` : 'Remote sync'}
        className={cn(
          'group flex w-full items-center gap-2 rounded-md border border-border/60 bg-background/60 px-2 py-1.5 text-xs transition-colors hover:bg-accent hover:text-accent-foreground',
          !enabled && 'opacity-70 hover:opacity-100'
        )}
      >
        <span className={cn('inline-block size-2 shrink-0 rounded-full', dotClass)} />
        <Icon className={cn('size-3.5 shrink-0', isPushing && 'animate-spin')} />
        <span className="truncate">{label}</span>
      </button>

      <RemoteSyncSettingsSheet open={sheetOpen} onOpenChange={setSheetOpen} />
    </>
  );
}
