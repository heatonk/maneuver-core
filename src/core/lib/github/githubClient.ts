/**
 * githubClient — thin browser-side wrapper around the GitHub REST API.
 *
 * Uses anonymous requests by default (60 req/hr per IP). When the user has
 * supplied a personal access token via the API Data page, it's read from
 * localStorage and sent as Authorization: Bearer. GitHub supports CORS for
 * api.github.com so no proxy is required.
 */

const GITHUB_PAT_STORAGE_KEY = 'maneuver_github_pat';

const API_BASE = 'https://api.github.com';

export interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  owner: { login: string; type: 'User' | 'Organization' };
  description: string | null;
  html_url: string;
  pushed_at: string;
  fork: boolean;
  archived: boolean;
  default_branch: string;
}

export interface GitHubContentEntry {
  name: string;
  path: string;
  sha: string;
  size: number;
  type: 'file' | 'dir' | 'symlink' | 'submodule';
  download_url: string | null;
}

export interface GitHubFileContent {
  name: string;
  path: string;
  sha: string;
  size: number;
  content: string;
  encoding: 'base64' | 'utf-8' | string;
}

export interface GitHubSearchRepoItem extends GitHubRepo {
  score: number;
}

export interface GitHubRateLimitInfo {
  remaining: number;
  limit: number;
  resetAt: number;
}

let lastRateLimit: GitHubRateLimitInfo | null = null;

export function getLastRateLimit(): GitHubRateLimitInfo | null {
  return lastRateLimit;
}

export function getStoredGitHubPat(): string {
  try {
    return localStorage.getItem(GITHUB_PAT_STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

export function setStoredGitHubPat(pat: string): void {
  try {
    if (pat.trim()) {
      localStorage.setItem(GITHUB_PAT_STORAGE_KEY, pat.trim());
    } else {
      localStorage.removeItem(GITHUB_PAT_STORAGE_KEY);
    }
  } catch (err) {
    console.warn('Failed to persist GitHub PAT to localStorage:', err);
  }
}

function authHeaders(): HeadersInit {
  const pat = getStoredGitHubPat();
  const headers: HeadersInit = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  };
  if (pat) {
    (headers as Record<string, string>).Authorization = `Bearer ${pat}`;
  }
  return headers;
}

function recordRateLimit(response: Response): void {
  const remaining = Number(response.headers.get('x-ratelimit-remaining'));
  const limit = Number(response.headers.get('x-ratelimit-limit'));
  const reset = Number(response.headers.get('x-ratelimit-reset'));
  if (Number.isFinite(remaining) && Number.isFinite(limit) && Number.isFinite(reset)) {
    lastRateLimit = { remaining, limit, resetAt: reset * 1000 };
  }
}

export class GitHubRateLimitError extends Error {
  resetAt: number;
  constructor(message: string, resetAt: number) {
    super(message);
    this.name = 'GitHubRateLimitError';
    this.resetAt = resetAt;
  }
}

export class GitHubNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitHubNotFoundError';
  }
}

async function ghFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const url = path.startsWith('http') ? path : `${API_BASE}${path}`;
  const response = await fetch(url, {
    ...init,
    headers: { ...authHeaders(), ...(init?.headers || {}) }
  });
  recordRateLimit(response);

  if (response.status === 403 && lastRateLimit && lastRateLimit.remaining === 0) {
    const resetDate = new Date(lastRateLimit.resetAt).toLocaleTimeString();
    throw new GitHubRateLimitError(
      `GitHub API rate limit reached. Resets at ${resetDate}.`,
      lastRateLimit.resetAt
    );
  }
  if (response.status === 404) {
    throw new GitHubNotFoundError(`Not found: ${path}`);
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`GitHub API ${response.status}: ${text || response.statusText}`);
  }

  return response.json() as Promise<T>;
}

/**
 * List public repos for a user or organization. Tries the user endpoint first
 * and falls back to the org endpoint if that 404s — GitHub responds 404 when
 * the login type doesn't match.
 */
export async function listLoginRepos(login: string): Promise<GitHubRepo[]> {
  const trimmed = login.trim();
  if (!trimmed) return [];
  const path = `/users/${encodeURIComponent(trimmed)}/repos?per_page=100&type=public&sort=pushed`;
  try {
    return await ghFetch<GitHubRepo[]>(path);
  } catch (err) {
    if (err instanceof GitHubNotFoundError) {
      return ghFetch<GitHubRepo[]>(`/orgs/${encodeURIComponent(trimmed)}/repos?per_page=100&type=public&sort=updated`);
    }
    throw err;
  }
}

export async function searchRepos(query: string): Promise<GitHubSearchRepoItem[]> {
  const path = `/search/repositories?q=${encodeURIComponent(query)}&per_page=30`;
  const result = await ghFetch<{ items: GitHubSearchRepoItem[] }>(path);
  return result.items || [];
}

export interface GitHubUserSearchItem {
  login: string;
  id: number;
  type: 'User' | 'Organization';
  html_url: string;
}

export async function searchUsers(query: string): Promise<GitHubUserSearchItem[]> {
  const path = `/search/users?q=${encodeURIComponent(query)}&per_page=20`;
  const result = await ghFetch<{ items: GitHubUserSearchItem[] }>(path);
  return result.items || [];
}

export async function listDir(owner: string, repo: string, dirPath: string, ref?: string): Promise<GitHubContentEntry[]> {
  const ranchSuffix = ref ? `?ref=${encodeURIComponent(ref)}` : '';
  const result = await ghFetch<GitHubContentEntry[] | GitHubContentEntry>(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodePath(dirPath)}${ranchSuffix}`
  );
  // Contents API returns an array for directories, a single object for files.
  return Array.isArray(result) ? result : [];
}

export async function getFile(owner: string, repo: string, filePath: string, ref?: string): Promise<GitHubFileContent> {
  const ranchSuffix = ref ? `?ref=${encodeURIComponent(ref)}` : '';
  const result = await ghFetch<GitHubFileContent>(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodePath(filePath)}${ranchSuffix}`
  );
  return result;
}

/**
 * Convert base64 GitHub file content into a UTF-8 string. PathPlanner and
 * Choreo files are JSON so decoding is safe to do in-browser.
 */
export function decodeBase64Content(content: string): string {
  // GitHub returns content with embedded newlines. atob ignores whitespace per
  // spec but be safe and strip them anyway.
  const stripped = content.replace(/\s/g, '');
  const binary = atob(stripped);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder('utf-8').decode(bytes);
}

function encodePath(p: string): string {
  // GitHub's contents API expects URL-encoded segments but not the slashes.
  return p.split('/').map(encodeURIComponent).join('/');
}

/**
 * Parse `owner/repo` or a full GitHub URL into its components. Returns null
 * for inputs we can't recognize so callers can surface a clear error.
 */
export function parseRepoIdentifier(input: string): { owner: string; repo: string } | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const urlMatch = trimmed.match(/github\.com[/:]([^/]+)\/([^/?#]+)/i);
  if (urlMatch && urlMatch[1] && urlMatch[2]) {
    return { owner: urlMatch[1], repo: urlMatch[2].replace(/\.git$/i, '') };
  }
  const slashMatch = trimmed.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (slashMatch && slashMatch[1] && slashMatch[2]) {
    return { owner: slashMatch[1], repo: slashMatch[2].replace(/\.git$/i, '') };
  }
  return null;
}
