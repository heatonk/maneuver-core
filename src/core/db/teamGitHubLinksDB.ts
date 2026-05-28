/**
 * teamGitHubLinksDB — persists team→GitHub repo mappings so the same info is
 * available across devices via the remote-sync layer. Auto files themselves
 * are intentionally NOT persisted — they're fetched on demand from GitHub and
 * shown transiently, since the repo address is the only thing teams need to
 * share durably.
 */

import Dexie, { type Table } from 'dexie';

export type RepoSource = 'tba' | 'search' | 'manual';

export interface TeamRepoLink {
  teamNumber: number;
  owner: string;
  repo: string;
  source: RepoSource;
  discoveredAt: number;
  // Optional human note when source === 'manual' or to record why a search
  // result was preferred. Stored verbatim alongside the link.
  notes?: string;
}

export class TeamGitHubLinksDB extends Dexie {
  repos!: Table<TeamRepoLink, number>;

  constructor() {
    super('TeamGitHubLinksDB');

    this.version(1).stores({
      repos: 'teamNumber, owner, source'
    });
  }
}

export const teamGitHubLinksDB = new TeamGitHubLinksDB();

teamGitHubLinksDB.open().catch(error => {
  console.error('Failed to open TeamGitHubLinksDB:', error);
});

export async function getRepoForTeam(teamNumber: number): Promise<TeamRepoLink | undefined> {
  return teamGitHubLinksDB.repos.get(teamNumber);
}

export async function saveRepoLink(link: TeamRepoLink): Promise<void> {
  await teamGitHubLinksDB.repos.put(link);
}

export async function deleteRepoLink(teamNumber: number): Promise<void> {
  await teamGitHubLinksDB.repos.delete(teamNumber);
}

export async function loadAllRepoLinks(): Promise<TeamRepoLink[]> {
  return teamGitHubLinksDB.repos.toArray();
}

export async function clearAllTeamGitHubData(): Promise<void> {
  await teamGitHubLinksDB.repos.clear();
}
