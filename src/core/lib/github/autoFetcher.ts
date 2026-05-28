/**
 * autoFetcher — fetches PathPlanner and Choreo auto files for a team's
 * registered repo and returns them in-memory. Nothing is persisted — the
 * repo link is what gets shared across devices; individual auto contents are
 * fetched fresh on demand so users always see the latest.
 *
 * PathPlanner files live under `src/main/deploy/pathplanner/autos/` and
 * `.../paths/`. Choreo files live under `src/main/deploy/choreo/`.
 */

import {
  decodeBase64Content,
  GitHubNotFoundError,
  getFile,
  listDir
} from './githubClient';
import { type TeamRepoLink } from '@/core/db/teamGitHubLinksDB';

export type AutoFormat = 'pathplanner' | 'choreo';

export interface FetchedAuto {
  format: AutoFormat;
  path: string;
  name: string;
  sha: string;
  contentJson: string;
  fetchedAt: number;
}

export interface FetchAutosResult {
  teamNumber: number;
  owner: string;
  repo: string;
  autos: FetchedAuto[];
  errors: string[];
}

const PATHPLANNER_DIRS = [
  'src/main/deploy/pathplanner/autos',
  'src/main/deploy/pathplanner/paths'
];
const CHOREO_DIRS = ['src/main/deploy/choreo'];

interface DiscoveredAuto {
  format: AutoFormat;
  path: string;
  name: string;
  sha: string;
}

function isPathPlannerFile(name: string): boolean {
  return name.endsWith('.path') || name.endsWith('.auto');
}

function isChoreoFile(name: string): boolean {
  return name.endsWith('.traj') || name.endsWith('.chor');
}

async function listAutosInDirs(
  owner: string,
  repo: string,
  dirs: string[],
  format: AutoFormat,
  fileFilter: (name: string) => boolean
): Promise<DiscoveredAuto[]> {
  const found: DiscoveredAuto[] = [];
  for (const dir of dirs) {
    try {
      const entries = await listDir(owner, repo, dir);
      for (const entry of entries) {
        if (entry.type !== 'file') continue;
        if (!fileFilter(entry.name)) continue;
        found.push({ format, path: entry.path, name: entry.name, sha: entry.sha });
      }
    } catch (err) {
      if (err instanceof GitHubNotFoundError) continue;
      throw err;
    }
  }
  return found;
}

export async function fetchAutosForTeam(link: TeamRepoLink): Promise<FetchAutosResult> {
  const result: FetchAutosResult = {
    teamNumber: link.teamNumber,
    owner: link.owner,
    repo: link.repo,
    autos: [],
    errors: []
  };

  let discovered: DiscoveredAuto[] = [];
  try {
    const pp = await listAutosInDirs(link.owner, link.repo, PATHPLANNER_DIRS, 'pathplanner', isPathPlannerFile);
    const choreo = await listAutosInDirs(link.owner, link.repo, CHOREO_DIRS, 'choreo', isChoreoFile);
    discovered = [...pp, ...choreo];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result.errors.push(`Listing failed: ${message}`);
    return result;
  }

  if (discovered.length === 0) return result;

  for (const item of discovered) {
    try {
      const file = await getFile(link.owner, link.repo, item.path);
      result.autos.push({
        format: item.format,
        path: item.path,
        name: item.name,
        sha: item.sha,
        contentJson: decodeBase64Content(file.content),
        fetchedAt: Date.now()
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push(`${item.path}: ${message}`);
    }
  }

  return result;
}
