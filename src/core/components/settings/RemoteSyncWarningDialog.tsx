import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/core/components/ui/dialog';
import { Checkbox } from '@/core/components/ui/checkbox';
import { Button } from '@/core/components/ui/button';
import { Label } from '@/core/components/ui/label';

interface RemoteSyncWarningDialogProps {
  open: boolean;
  onCancel: () => void;
  onContinue: () => void;
}

export function RemoteSyncWarningDialog({ open, onCancel, onContinue }: RemoteSyncWarningDialogProps) {
  const [ack, setAck] = useState(false);

  const handleOpenChange = (next: boolean) => {
    if (!next) onCancel();
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-destructive">Advanced, unsupported feature</DialogTitle>
          <DialogDescription className="text-sm leading-relaxed text-foreground">
            Remote CouchDB sync is an advanced feature meant for teams running their own
            CouchDB server. It is <strong>not officially supported</strong>. Enabling it
            means:
          </DialogDescription>
        </DialogHeader>

        <ul className="ml-4 list-disc space-y-2 text-sm text-muted-foreground">
          <li>
            Your CouchDB URL, username, and <strong>password are stored locally in plain text</strong>{' '}
            (browser <code>localStorage</code>) and travel with the device.
          </li>
          <li>
            Every scouting record saved on this device will be <strong>sent off-device</strong> to
            the remote server you configure.
          </li>
          <li>
            This breaks Maneuver's offline-first guarantees. You are responsible for the
            server's availability, security, and backups.
          </li>
          <li>
            If something goes wrong, the Maneuver team cannot help debug your CouchDB
            setup.
          </li>
        </ul>

        <div className="flex items-start gap-3 rounded-md border border-destructive/40 bg-destructive/5 p-3">
          <Checkbox
            id="remote-sync-warning-ack"
            checked={ack}
            onCheckedChange={(value) => setAck(value === true)}
          />
          <Label htmlFor="remote-sync-warning-ack" className="text-sm leading-relaxed">
            I understand. I am running my own CouchDB server and accept the risks
            described above.
          </Label>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={!ack}
            onClick={() => {
              setAck(false);
              onContinue();
            }}
          >
            Continue
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
