/**
 * repoDiscovery — resolver chain to find an FRC team's GitHub repo.
 *
 * Strategies (each independent; callers can invoke individually):
 *   1. TBA social media → github-profile → list repos → pick top by score
 *   2. Owner search     → find users/orgs whose login contains the team number
 *                         (e.g. `frc461`) → list their repos → pick top by score
 *   3. Repo name search → search repos by team-number naming patterns
 *   4. Manual override  → user pastes a repo URL/identifier
 *
 * Owner search exists because many teams name their repos for the season
 * (e.g. `frc461/Rowdy26`) rather than the team number — repo-name search
 * misses those even though the owner login is a dead giveaway.
 *
 * Design note: an earlier version probed each candidate for FRC-shape
 * directories (`vendordeps/`, pathplanner, choreo, .wpilib) as a hard gate.
 * That rejected too many legitimate repos (Python projects, non-standard
 * deploy layouts, repos where the build outputs the deploy folder at build
 * time, etc.) and burned through the rate limit before producing answers. We
 * trust the scoring (name match + recent activity + FRC signals in the
 * description) and let the user override manually when discovery picks wrong.
 */

import { getTeamSocialMedia, getTeamGitHubProfile } from '@/core/lib/tba/tbaUtils';
import {
  listLoginRepos,
  parseRepoIdentifier,
  searchRepos,
  searchUsers,
  type GitHubRepo,
  type GitHubSearchRepoItem
} from './githubClient';
import {
  saveRepoLink,
  type RepoSource,
  type TeamRepoLink
} from '@/core/db/teamGitHubLinksDB';

export interface DiscoveryAttempt {
  teamNumber: number;
  source: RepoSource | null;
  link: TeamRepoLink | null;
  reason: string;
}

const TBA_MIN_SCORE = -2;      // TBA registration is a strong trust signal; almost anything goes
const OWNER_MIN_SCORE = -2;    // Owner login matched team number → trust the org, pick most active repo
const SEARCH_MIN_SCORE = 4;    // Repo-name search needs stronger evidence (name match or combos)

/**
 * Match the team number with digit boundaries so "234" doesn't match "2344"
 * or "23456". JavaScript's \b treats digits as word chars, so we use explicit
 * negative lookbehind/lookahead against digits instead.
 */
function teamNumberRegex(teamNumber: number): RegExp {
  return new RegExp(`(?<!\\d)${teamNumber}(?!\\d)`);
}

/**
 * Score a repo's likelihood of being an FRC robot project. Lightweight enough
 * to run on listing data (no extra requests).
 */
export function scoreFrcRepoFromMetadata(repo: GitHubRepo, teamNumber: number): number {
  let score = 0;
  const name = repo.name.toLowerCase();
  const desc = (repo.description || '').toLowerCase();
  const teamRe = teamNumberRegex(teamNumber);
  // Labeled mentions ("team 234" / "frc 234" / "frc-234") in the description
  // are stronger evidence than a bare number appearing somewhere.
  const labeledRe = new RegExp(`(?:team[\\s-]+|frc[\\s-]*)${teamNumber}(?!\\d)`, 'i');

  if (teamRe.test(name)) score += 4;
  if (labeledRe.test(desc)) score += 3;
  else if (teamRe.test(desc)) score += 1;
  if (name.includes('frc')) score += 2;
  if (desc.includes('frc') || desc.includes('first robotics')) score += 2;
  // "robot" appears in a huge fraction of FRC repo names.
  if (/\brobot\b/.test(name)) score += 1;
  // Year hint — most teams name repos like "Robot2024" or "Reefscape2025"…
  if (/20\d{2}/.test(name)) score += 1;
  // …or use a 2-digit season suffix like "Rowdy26".
  if (/(^|[a-z_-])2[0-9]($|[-_])/i.test(repo.name)) score += 1;
  // Common season-name signals
  if (/reefscape|crescendo|charged.up|rapid.react|infinite.recharge/.test(name)) score += 2;
  if (repo.fork) score -= 2;
  if (repo.archived) score -= 1;

  // Newer activity is better. Convert "pushed in last 18 months" to a small
  // boost so dormant repos lose to recently-updated ones.
  const pushedMs = Date.parse(repo.pushed_at);
  if (Number.isFinite(pushedMs)) {
    const ageMonths = (Date.now() - pushedMs) / (1000 * 60 * 60 * 24 * 30);
    if (ageMonths < 6) score += 3;
    else if (ageMonths < 18) score += 1;
    else if (ageMonths > 60) score -= 2;
  }

  return score;
}

/**
 * Strategy 1 — TBA. Returns null if the team has no github-profile registered.
 * If a profile is registered, picks the highest-scoring repo from that owner;
 * the registration itself is a strong signal so we don't probe further.
 */
export async function discoverViaTba(teamNumber: number, tbaApiKey?: string): Promise<TeamRepoLink | null> {
  const social = await getTeamSocialMedia(teamNumber, tbaApiKey);
  const login = getTeamGitHubProfile(social);
  if (!login) return null;

  const repos = await listLoginRepos(login);
  if (repos.length === 0) return null;

  const scored = repos
    .map(r => ({ repo: r, score: scoreFrcRepoFromMetadata(r, teamNumber) }))
    .sort((a, b) => b.score - a.score);

  const winner = scored.find(c => c.score >= TBA_MIN_SCORE);
  if (!winner) return null;

  return {
    teamNumber,
    owner: winner.repo.owner.login,
    repo: winner.repo.name,
    source: 'tba',
    discoveredAt: Date.now()
  };
}

/**
 * Strategy 2 — owner search. Find GitHub users/orgs whose login contains the
 * team number (e.g. searching `frc461` finds the `frc461` org), then list each
 * candidate's repos and pick the highest-scoring one across all candidates.
 *
 * This catches teams whose repos are named for the season (Rowdy26, Reefscape,
 * etc.) — the repo name doesn't include the team number, but the owner login
 * does. We require the candidate login to contain the team number as a
 * substring so an account named "Robot461Driver" gets in but unrelated logins
 * don't.
 */
export async function discoverViaOwnerSearch(teamNumber: number): Promise<TeamRepoLink | null> {
  const ts = String(teamNumber);
  const queries = [
    `frc${ts} in:login`,
    `frc-${ts} in:login`,
    `team${ts} in:login`,
    `team-${ts} in:login`,
    `${ts}frc in:login`
  ];

  const candidateLogins = new Set<string>();
  const teamRe = teamNumberRegex(teamNumber);
  for (const q of queries) {
    try {
      const users = await searchUsers(q);
      for (const u of users) {
        // Reject substring matches like `frc2344` when looking for team 234.
        if (teamRe.test(u.login.toLowerCase())) {
          candidateLogins.add(u.login);
        }
      }
    } catch {
      // One bad query (rate limit, network) doesn't sink the strategy.
      continue;
    }
  }

  if (candidateLogins.size === 0) return null;

  const allScored: Array<{ owner: string; repo: GitHubRepo; score: number }> = [];
  for (const login of candidateLogins) {
    try {
      const repos = await listLoginRepos(login);
      for (const r of repos) {
        allScored.push({ owner: login, repo: r, score: scoreFrcRepoFromMetadata(r, teamNumber) });
      }
    } catch {
      continue;
    }
  }

  allScored.sort((a, b) => b.score - a.score);
  const winner = allScored.find(c => c.score >= OWNER_MIN_SCORE);
  if (!winner) return null;

  return {
    teamNumber,
    owner: winner.owner,
    repo: winner.repo.name,
    source: 'search',
    discoveredAt: Date.now()
  };
}

/**
 * Strategy 3 — GitHub repository search by name patterns. Catches teams whose
 * repo name itself includes the team number (e.g. `frc-1234-robot-code`).
 */
export async function discoverViaRepoSearch(teamNumber: number): Promise<TeamRepoLink | null> {
  const queries = [
    `frc-${teamNumber} in:name`,
    `frc${teamNumber} in:name`,
    `team-${teamNumber} in:name`,
    `team${teamNumber} in:name`,
    `${teamNumber}-robot in:name`,
    `robot-${teamNumber} in:name`,
    `frc ${teamNumber}`,
    `team ${teamNumber} frc`
  ];

  const seen = new Set<string>();
  const allCandidates: GitHubSearchRepoItem[] = [];
  for (const q of queries) {
    try {
      const items = await searchRepos(q);
      for (const item of items) {
        if (seen.has(item.full_name)) continue;
        seen.add(item.full_name);
        allCandidates.push(item);
      }
    } catch {
      // Search errors (rate limit, network) on one query shouldn't kill the
      // others — try them all.
      continue;
    }
  }

  if (allCandidates.length === 0) return null;

  // Require an actual digit-bounded team-number match somewhere on the repo
  // before considering it. Otherwise GitHub's search can return any FRC repo
  // whose name happens to share a substring (e.g. `frc-2344-…` for team 234),
  // which scoring alone won't filter out.
  const teamRe = teamNumberRegex(teamNumber);
  const labeledRe = new RegExp(`(?:team[\\s-]+|frc[\\s-]*)${teamNumber}(?!\\d)`, 'i');
  const filtered = allCandidates.filter(r => {
    const name = r.name.toLowerCase();
    const desc = (r.description || '').toLowerCase();
    return teamRe.test(name) || labeledRe.test(desc);
  });
  if (filtered.length === 0) return null;

  const scored = filtered
    .map(r => ({ repo: r, score: scoreFrcRepoFromMetadata(r, teamNumber) }))
    .sort((a, b) => b.score - a.score);

  const winner = scored[0];
  if (!winner || winner.score < SEARCH_MIN_SCORE) return null;

  return {
    teamNumber,
    owner: winner.repo.owner.login,
    repo: winner.repo.name,
    source: 'search',
    discoveredAt: Date.now()
  };
}

/**
 * Strategy 3 — manual override. The user pastes a URL or owner/repo string.
 * Validation is purely structural; we don't probe the repo here so the user
 * can save a link even if rate-limited.
 */
export function buildManualLink(teamNumber: number, input: string, notes?: string): TeamRepoLink | null {
  const parsed = parseRepoIdentifier(input);
  if (!parsed) return null;
  const link: TeamRepoLink = {
    teamNumber,
    owner: parsed.owner,
    repo: parsed.repo,
    source: 'manual',
    discoveredAt: Date.now()
  };
  if (notes && notes.trim()) {
    link.notes = notes.trim();
  }
  return link;
}

/**
 * Try strategies in order (tba → ownerSearch → repoSearch) and persist the
 * first hit. The `reason` field tells the user exactly which strategy ran and
 * why it succeeded or stopped — useful when a team needs a manual override.
 */
export async function discoverAndSave(teamNumber: number, tbaApiKey?: string): Promise<DiscoveryAttempt> {
  const reasons: string[] = [];

  try {
    const viaTba = await discoverViaTba(teamNumber, tbaApiKey);
    if (viaTba) {
      await saveRepoLink(viaTba);
      return {
        teamNumber,
        source: 'tba',
        link: viaTba,
        reason: `Matched via TBA → ${viaTba.owner}/${viaTba.repo}`
      };
    }
    reasons.push('TBA: no github-profile');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    reasons.push(`TBA: ${message}`);
  }

  try {
    const viaOwner = await discoverViaOwnerSearch(teamNumber);
    if (viaOwner) {
      await saveRepoLink(viaOwner);
      return {
        teamNumber,
        source: 'search',
        link: viaOwner,
        reason: `Matched via owner search → ${viaOwner.owner}/${viaOwner.repo}`
      };
    }
    reasons.push('Owner search: no matching account');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    reasons.push(`Owner search: ${message}`);
  }

  try {
    const viaRepo = await discoverViaRepoSearch(teamNumber);
    if (viaRepo) {
      await saveRepoLink(viaRepo);
      return {
        teamNumber,
        source: 'search',
        link: viaRepo,
        reason: `Matched via repo search → ${viaRepo.owner}/${viaRepo.repo}`
      };
    }
    reasons.push(`Repo search: no result scoring ≥ ${SEARCH_MIN_SCORE}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    reasons.push(`Repo search: ${message}`);
  }

  return {
    teamNumber,
    source: null,
    link: null,
    reason: reasons.join(' • ')
  };
}
