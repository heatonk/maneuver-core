import { QRCodeSVG } from 'qrcode.react';
import { AlertTriangleIcon } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/core/components/ui/dialog';
import { Button } from '@/core/components/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/core/components/ui/alert';
import type { RemoteSyncSettings } from '@/core/contexts/SettingsContext';
import { encodeRemoteSyncQR } from '@/core/remote-sync/remoteSyncQRPayload';

interface RemoteSyncShareQRDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  draft: RemoteSyncSettings;
}

export function RemoteSyncShareQRDialog({ open, onOpenChange, draft }: RemoteSyncShareQRDialogProps) {
  const payload = open ? encodeRemoteSyncQR(draft) : '';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Share sync config</DialogTitle>
          <DialogDescription>
            Have another scout open Remote Sync → Scan to import, then point their camera
            at this QR.
          </DialogDescription>
        </DialogHeader>

        <Alert variant="destructive">
          <AlertTriangleIcon />
          <AlertTitle>This QR contains the password</AlertTitle>
          <AlertDescription>
            Anyone who scans or photographs this code receives full write access to your
            CouchDB. Don't leave this screen unattended, and don't post screenshots.
          </AlertDescription>
        </Alert>

        <div className="flex justify-center py-2">
          {payload && (
            <div className="rounded-lg bg-white p-4 shadow">
              <QRCodeSVG value={payload} size={320} level="M" includeMargin={false} />
            </div>
          )}
        </div>

        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
