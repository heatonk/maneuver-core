/**
 * GitHubAutosPage — discover team GitHub repos (durable, remote-synced) and
 * pull the latest PathPlanner/Choreo autos from those repos on demand
 * (transient, not stored).
 *
 * The team→repo mapping is the only thing persisted. Auto files themselves
 * are fetched fresh from GitHub each time the user clicks "View autos" so
 * what's shown is always current and nothing duplicates GitHub as a source
 * of truth.
 *
 * GitHub PAT is read from localStorage (set on the API Data page). Without
 * one, anonymous rate limits (60 req/hr) cap bulk discovery — surfaced as a
 * banner.
 */

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { CloudDownload, Github, Loader2, RefreshCw, Settings2 } from 'lucide-react';
import { Link } from 'react-router-dom';

import { Button } from '@/core/components/ui/button';
import { Input } from '@/core/components/ui/input';
import { Label } from '@/core/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/core/components/ui/card';
import { Badge } from '@/core/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/core/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/core/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@/core/components/ui/table';
import { Separator } from '@/core/components/ui/separator';

import { getAllStoredEventTeams } from '@/core/lib/tba';
import {
  buildManualLink,
  discoverAndSave
} from '@/core/lib/github/repoDiscovery';
import { fetchAutosForTeam, type FetchedAuto } from '@/core/lib/github/autoFetcher';
import {
  deleteRepoLink,
  loadAllRepoLinks,
  saveRepoLink,
  type RepoSource,
  type TeamRepoLink
} from '@/core/db/teamGitHubLinksDB';
import { getStoredGitHubPat } from '@/core/lib/github/githubClient';
import { pushAfterSave } from '@/core/remote-sync/remoteSyncService';

interface TeamRow {
  teamNumber: number;
  link: TeamRepoLink | undefined;
}

const SOURCE_LABEL: Record<RepoSource, string> = {
  tba: 'TBA',
  search: 'Search',
  manual: 'Manual'
};

const SOURCE_VARIANT: Record<RepoSource, 'default' | 'secondary' | 'outline'> = {
  tba: 'default',
  search: 'secondary',
  manual: 'outline'
};

const FORMAT_LABEL: Record<'pathplanner' | 'choreo', string> = {
  pathplanner: 'PathPlanner',
  choreo: 'Choreo'
};

const GitHubAutosPage = () => {
  const [eventOptions, setEventOptions] = useState<Array<{ eventKey: string; teamCount: number }>>([]);
  const [eventKey, setEventKey] = useState<string>('');
  const [teamRows, setTeamRows] = useState<TeamRow[]>([]);
  const [busyTeams, setBusyTeams] = useState<Set<number>>(new Set());
  const [bulkDiscovering, setBulkDiscovering] = useState(false);
  const [manualOpen, setManualOpen] = useState<number | null>(null);
  const [manualUrl, setManualUrl] = useState('');
  const [manualNotes, setManualNotes] = useState('');
  const [autosOpenTeam, setAutosOpenTeam] = useState<number | null>(null);
  const [autosLoading, setAutosLoading] = useState(false);
  const [autosForTeam, setAutosForTeam] = useState<FetchedAuto[]>([]);
  const [autosErrors, setAutosErrors] = useState<string[]>([]);
  const [viewingAuto, setViewingAuto] = useState<FetchedAuto | null>(null);
  const [progressMessage, setProgressMessage] = useState<string>('');
  const [hasPat, setHasPat] = useState<boolean>(() => Boolean(getStoredGitHubPat()));

  useEffect(() => {
    const refreshPat = () => setHasPat(Boolean(getStoredGitHubPat()));
    window.addEventListener('focus', refreshPat);
    window.addEventListener('storage', refreshPat);
    return () => {
      window.removeEventListener('focus', refreshPat);
      window.removeEventListener('storage', refreshPat);
    };
  }, []);

  useEffect(() => {
    const all = getAllStoredEventTeams();
    const options = Object.entries(all)
      .map(([key, teams]) => ({ eventKey: key, teamCount: teams.length }))
      .sort((a, b) => a.eventKey.localeCompare(b.eventKey));
    setEventOptions(options);
    const stored = localStorage.getItem('eventKey');
    if (stored && all[stored]) setEventKey(stored);
    else if (options[0]) setEventKey(options[0].eventKey);
  }, []);

  const refreshRows = useCallback(async (selectedEventKey: string) => {
    if (!selectedEventKey) {
      setTeamRows([]);
      return;
    }
    const all = getAllStoredEventTeams();
    const teams = all[selectedEventKey] || [];
    const allLinks = await loadAllRepoLinks();
    const linkByTeam = new Map(allLinks.map(l => [l.teamNumber, l]));
    const rows: TeamRow[] = teams.map(teamNumber => ({
      teamNumber,
      link: linkByTeam.get(teamNumber)
    }));
    setTeamRows(rows);
  }, []);

  useEffect(() => {
    void refreshRows(eventKey);
  }, [eventKey, refreshRows]);

  const markTeamBusy = (teamNumber: number, busy: boolean) => {
    setBusyTeams(prev => {
      const next = new Set(prev);
      if (busy) next.add(teamNumber);
      else next.delete(teamNumber);
      return next;
    });
  };

  const handleDiscoverOne = async (teamNumber: number) => {
    markTeamBusy(teamNumber, true);
    try {
      const result = await discoverAndSave(teamNumber);
      if (result.link) {
        pushAfterSave(result.link, 'tgh-repo');
        toast.success(`Team ${teamNumber}: ${result.reason}`);
      } else {
        toast.warning(`Team ${teamNumber}: ${result.reason}`);
      }
      await refreshRows(eventKey);
    } catch (err) {
      toast.error(`Team ${teamNumber}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      markTeamBusy(teamNumber, false);
    }
  };

  const handleBulkDiscover = async () => {
    if (teamRows.length === 0) return;
    setBulkDiscovering(true);
    let found = 0;
    let missed = 0;
    let errored = 0;
    try {
      for (const row of teamRows) {
        if (row.link) continue;
        setProgressMessage(`Discovering team ${row.teamNumber}…`);
        try {
          const result = await discoverAndSave(row.teamNumber);
          if (result.link) {
            pushAfterSave(result.link, 'tgh-repo');
            found += 1;
          } else {
            missed += 1;
          }
        } catch {
          errored += 1;
        }
      }
      await refreshRows(eventKey);
      toast.success(`Discovery complete — ${found} matched, ${missed} not found, ${errored} errored.`);
    } finally {
      setBulkDiscovering(false);
      setProgressMessage('');
    }
  };

  const handleViewAutos = async (teamNumber: number) => {
    const row = teamRows.find(r => r.teamNumber === teamNumber);
    if (!row?.link) {
      toast.error(`No repo linked for team ${teamNumber}`);
      return;
    }
    setAutosOpenTeam(teamNumber);
    setAutosForTeam([]);
    setAutosErrors([]);
    setViewingAuto(null);
    setAutosLoading(true);
    try {
      const result = await fetchAutosForTeam(row.link);
      setAutosForTeam(result.autos.sort((a, b) => a.path.localeCompare(b.path)));
      setAutosErrors(result.errors);
      if (result.autos.length === 0 && result.errors.length === 0) {
        toast.info(`No PathPlanner/Choreo files found in ${row.link.owner}/${row.link.repo}.`);
      }
    } catch (err) {
      toast.error(`Failed to load autos: ${err instanceof Error ? err.message : String(err)}`);
      setAutosOpenTeam(null);
    } finally {
      setAutosLoading(false);
    }
  };

  const openManual = (teamNumber: number) => {
    const row = teamRows.find(r => r.teamNumber === teamNumber);
    setManualUrl(row?.link ? `${row.link.owner}/${row.link.repo}` : '');
    setManualNotes(row?.link?.notes || '');
    setManualOpen(teamNumber);
  };

  const handleManualSave = async () => {
    if (manualOpen == null) return;
    const link = buildManualLink(manualOpen, manualUrl, manualNotes);
    if (!link) {
      toast.error('Could not parse the URL. Use owner/repo or a github.com URL.');
      return;
    }
    await saveRepoLink(link);
    pushAfterSave(link, 'tgh-repo');
    toast.success(`Linked team ${manualOpen} → ${link.owner}/${link.repo}.`);
    setManualOpen(null);
    setManualUrl('');
    setManualNotes('');
    await refreshRows(eventKey);
  };

  const handleManualRemove = async () => {
    if (manualOpen == null) return;
    await deleteRepoLink(manualOpen);
    toast.success(`Removed link for team ${manualOpen}.`);
    setManualOpen(null);
    setManualUrl('');
    setManualNotes('');
    await refreshRows(eventKey);
  };

  const linkedCount = teamRows.filter(r => r.link).length;

  return (
    <div className="w-full flex flex-col items-center px-4 pt-12 pb-24">
      <div className="flex flex-col gap-4 max-w-5xl w-full">
        <h1 className="text-2xl font-bold">GitHub Autos</h1>
        <p className="text-muted-foreground">
          Find each team's GitHub repo, then view their latest PathPlanner / Choreo
          autonomous files on demand. Discovered repo links are remote-synced; auto
          files are fetched fresh from GitHub each time you view them.
        </p>

        {!hasPat && (
          <Card className="border-amber-500/50">
            <CardContent className="flex flex-col gap-2 py-4">
              <p className="text-sm">
                <strong>No GitHub PAT set.</strong> Anonymous requests are capped at 60/hour,
                which is too few for a full event. Add a token on the{' '}
                <Link to="/api-data" className="underline">API Data page</Link> for
                5,000/hour limits.
              </p>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle>Event</CardTitle>
            <CardDescription>
              Choose a loaded event. Teams come from the cached TBA event-teams data
              (load an event on the API Data page first if the list is empty).
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <Select value={eventKey} onValueChange={setEventKey}>
              <SelectTrigger>
                <SelectValue placeholder="Select an event" />
              </SelectTrigger>
              <SelectContent>
                {eventOptions.length === 0 ? (
                  <div className="px-3 py-2 text-sm text-muted-foreground">
                    No events loaded. Load one on the API Data page.
                  </div>
                ) : (
                  eventOptions.map(opt => (
                    <SelectItem key={opt.eventKey} value={opt.eventKey}>
                      {opt.eventKey} ({opt.teamCount} teams)
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>

            <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
              <span>{teamRows.length} teams</span>
              <Separator orientation="vertical" className="h-4" />
              <span>{linkedCount} linked</span>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button
                onClick={handleBulkDiscover}
                disabled={bulkDiscovering || teamRows.length === 0}
                variant="outline"
              >
                {bulkDiscovering ? (
                  <Loader2 className="mr-2 size-4 animate-spin" />
                ) : (
                  <Github className="mr-2 size-4" />
                )}
                Discover repos for event
              </Button>
            </div>
            {progressMessage && (
              <p className="text-xs text-muted-foreground">{progressMessage}</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Teams</CardTitle>
            <CardDescription>
              Discover a repo, override it manually, or fetch the team's latest autos
              on demand. Auto files aren't stored — they're fetched from GitHub each time.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Team</TableHead>
                  <TableHead>Repo</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {teamRows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={3} className="text-center text-muted-foreground">
                      No teams loaded for this event.
                    </TableCell>
                  </TableRow>
                ) : (
                  teamRows.map(row => (
                    <TableRow key={row.teamNumber}>
                      <TableCell className="font-mono">{row.teamNumber}</TableCell>
                      <TableCell>
                        {row.link ? (
                          <div className="flex items-center gap-2">
                            <a
                              href={`https://github.com/${row.link.owner}/${row.link.repo}`}
                              target="_blank"
                              rel="noreferrer"
                              className="underline"
                            >
                              {row.link.owner}/{row.link.repo}
                            </a>
                            <Badge variant={SOURCE_VARIANT[row.link.source]}>
                              {SOURCE_LABEL[row.link.source]}
                            </Badge>
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="inline-flex gap-1">
                          {row.link ? (
                            <>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => handleViewAutos(row.teamNumber)}
                                disabled={busyTeams.has(row.teamNumber) || bulkDiscovering}
                                title="Fetch latest autos from GitHub"
                              >
                                <CloudDownload className="size-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => handleDiscoverOne(row.teamNumber)}
                                disabled={busyTeams.has(row.teamNumber) || bulkDiscovering}
                                title="Re-discover repo"
                              >
                                {busyTeams.has(row.teamNumber) ? (
                                  <Loader2 className="size-4 animate-spin" />
                                ) : (
                                  <RefreshCw className="size-4" />
                                )}
                              </Button>
                            </>
                          ) : (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleDiscoverOne(row.teamNumber)}
                              disabled={busyTeams.has(row.teamNumber) || bulkDiscovering}
                              title="Discover repo"
                            >
                              {busyTeams.has(row.teamNumber) ? (
                                <Loader2 className="size-4 animate-spin" />
                              ) : (
                                <Github className="size-4" />
                              )}
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => openManual(row.teamNumber)}
                            title="Set repo manually"
                          >
                            <Settings2 className="size-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>

      <Dialog open={manualOpen != null} onOpenChange={(open) => !open && setManualOpen(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Set repo for team {manualOpen ?? ''}
            </DialogTitle>
            <DialogDescription>
              Paste a GitHub URL or owner/repo. A manual link overrides any discovered link.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="manual-url">Repo</Label>
              <Input
                id="manual-url"
                placeholder="frc-team/robot-2025"
                value={manualUrl}
                onChange={(e) => setManualUrl(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="manual-notes">Notes (optional)</Label>
              <Input
                id="manual-notes"
                value={manualNotes}
                onChange={(e) => setManualNotes(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter className="flex justify-between">
            <Button variant="ghost" onClick={handleManualRemove}>Remove link</Button>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setManualOpen(null)}>Cancel</Button>
              <Button onClick={handleManualSave}>Save</Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={autosOpenTeam != null}
        onOpenChange={(open) => {
          if (!open) {
            setAutosOpenTeam(null);
            setViewingAuto(null);
            setAutosForTeam([]);
            setAutosErrors([]);
          }
        }}
      >
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Autos for team {autosOpenTeam ?? ''}</DialogTitle>
            <DialogDescription>
              Fetched live from GitHub. Click a row to inspect its raw JSON.
            </DialogDescription>
          </DialogHeader>
          {autosLoading ? (
            <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
              <Loader2 className="mr-2 size-4 animate-spin" />
              Fetching from GitHub…
            </div>
          ) : viewingAuto ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-mono text-sm">{viewingAuto.path}</p>
                  <p className="text-xs text-muted-foreground">
                    {FORMAT_LABEL[viewingAuto.format]} • sha {viewingAuto.sha.slice(0, 7)} •
                    fetched {new Date(viewingAuto.fetchedAt).toLocaleString()}
                  </p>
                </div>
                <Button variant="outline" size="sm" onClick={() => setViewingAuto(null)}>Back</Button>
              </div>
              <pre className="max-h-[60vh] overflow-auto rounded-md bg-muted p-3 text-xs">
                {viewingAuto.contentJson}
              </pre>
            </div>
          ) : (
            <div className="max-h-[60vh] overflow-y-auto space-y-3">
              {autosErrors.length > 0 && (
                <div className="rounded-md border border-amber-500/50 bg-amber-500/10 p-2 text-xs">
                  <p className="font-medium">Errors during fetch:</p>
                  <ul className="ml-4 list-disc">
                    {autosErrors.map((err, i) => (
                      <li key={i} className="font-mono">{err}</li>
                    ))}
                  </ul>
                </div>
              )}
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Format</TableHead>
                    <TableHead>SHA</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {autosForTeam.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={3} className="text-center text-muted-foreground">
                        No autos found.
                      </TableCell>
                    </TableRow>
                  ) : (
                    autosForTeam.map(auto => (
                      <TableRow
                        key={auto.path}
                        className="cursor-pointer hover:bg-accent"
                        onClick={() => setViewingAuto(auto)}
                      >
                        <TableCell className="font-mono text-xs">{auto.name}</TableCell>
                        <TableCell>{FORMAT_LABEL[auto.format]}</TableCell>
                        <TableCell className="font-mono text-xs">{auto.sha.slice(0, 7)}</TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default GitHubAutosPage;
