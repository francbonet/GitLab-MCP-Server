#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const GITLAB_TOKEN = process.env.GITLAB_TOKEN;
const GITLAB_BASE_URL = (process.env.GITLAB_BASE_URL ?? "https://gitlab.com").replace(/\/$/, "");
const GITLAB_AUDIT_MODEL_OVERRIDE = process.env.GITLAB_AUDIT_MODEL?.trim();
const PROJECT_CATALOG_URI = "gitlab://projects/catalog";
const PROJECT_CATALOG_PAGE_SIZE = 100;
const PROJECT_CATALOG_MAX_PAGES = 10;
const PROJECT_CATALOG_TTL_MS = 60_000;

if (!GITLAB_TOKEN) {
  process.stderr.write("Error: GITLAB_TOKEN environment variable is required.\n");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// GitLab API helpers
// ---------------------------------------------------------------------------

interface GitLabApiOptions {
  method?: string;
  body?: unknown;
  params?: Record<string, string | number | boolean | undefined>;
}

async function gitlabRequest<T>(
  path: string,
  { method = "GET", body, params }: GitLabApiOptions = {}
): Promise<T> {
  const url = new URL(`${GITLAB_BASE_URL}/api/v4${path}`);

  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
  }

  const response = await fetch(url.toString(), {
    method,
    headers: {
      "PRIVATE-TOKEN": GITLAB_TOKEN!,
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  if (!response.ok) {
    let detail: string;
    try {
      const err = (await response.json()) as { message?: string; error?: string };
      detail = err.message ?? err.error ?? "";
    } catch {
      detail = await response.text();
    }
    throw new McpError(
      ErrorCode.InternalError,
      `GitLab API error ${response.status}: ${detail || response.statusText}`
    );
  }

  // 204 No Content
  if (response.status === 204) return undefined as unknown as T;

  return response.json() as Promise<T>;
}

/** Encode a project ID for use in URL path segments */
function encodeProject(id: string): string {
  try {
    return encodeURIComponent(decodeURIComponent(id));
  } catch {
    return encodeURIComponent(id);
  }
}

function decodeResourceId(id: string): string {
  try {
    return decodeURIComponent(id);
  } catch {
    return id;
  }
}

function isNumericId(value: string): boolean {
  return /^\d+$/.test(value);
}

interface ProjectRef {
  raw: string;
  encoded: string;
}

interface ProjectSummary {
  id: number;
  name: string;
  path: string;
  path_with_namespace: string;
  description: string | null;
  web_url: string;
  last_activity_at: string;
}

let activeProject: ProjectRef | undefined;
let projectCatalogCache:
  | {
      fetchedAt: number;
      projects: ProjectSummary[];
    }
  | undefined;

function setActiveProject(project: ProjectRef): void {
  activeProject = project;
}

function clearActiveProject(): ProjectRef | undefined {
  const previousProject = activeProject;
  activeProject = undefined;
  return previousProject;
}

function resolveGroupScope(group?: string): ProjectRef | undefined {
  const value = group?.trim();
  if (!value) return undefined;

  return {
    raw: decodeResourceId(value),
    encoded: encodeProject(value),
  };
}

async function searchProjects(
  search?: string,
  { group, perPage = 20, page = 1 }: { group?: string; perPage?: number; page?: number } = {}
): Promise<{ projects: ProjectSummary[]; scopeLabel: string }> {
  const scope = resolveGroupScope(group);
  const params = {
    search,
    per_page: perPage,
    page,
    order_by: "last_activity_at",
    sort: "desc",
    simple: true,
  } as const;

  if (scope) {
    const projects = await gitlabRequest<ProjectSummary[]>(
      `/groups/${scope.encoded}/projects`,
      {
        params: {
          ...params,
          include_subgroups: true,
        },
      }
    );

    return { projects, scopeLabel: `group ${scope.raw}` };
  }

  const projects = await gitlabRequest<ProjectSummary[]>("/projects", {
    params,
  });

  return { projects, scopeLabel: "accessible projects" };
}

async function listAccessibleProjectsCatalog(forceRefresh = false): Promise<ProjectSummary[]> {
  const now = Date.now();
  if (!forceRefresh && projectCatalogCache && now - projectCatalogCache.fetchedAt < PROJECT_CATALOG_TTL_MS) {
    return projectCatalogCache.projects;
  }

  const projects = new Map<number, ProjectSummary>();

  for (let page = 1; page <= PROJECT_CATALOG_MAX_PAGES; page += 1) {
    const result = await searchProjects(undefined, {
      perPage: PROJECT_CATALOG_PAGE_SIZE,
      page,
    });

    for (const project of result.projects) {
      projects.set(project.id, project);
    }

    if (result.projects.length < PROJECT_CATALOG_PAGE_SIZE) {
      break;
    }
  }

  const catalog = Array.from(projects.values());
  projectCatalogCache = {
    fetchedAt: now,
    projects: catalog,
  };
  return catalog;
}

function normalizeProjectLookup(value: string): string {
  return decodeResourceId(value)
    .trim()
    .toLowerCase()
    .replace(/[/_.-]+/g, " ")
    .replace(/\s+/g, " ");
}

function extractProjectPathFromGitLabUrl(value: string): string | undefined {
  if (!/^https?:\/\//i.test(value)) {
    return undefined;
  }

  let parsedUrl: URL;
  let baseUrl: URL;
  try {
    parsedUrl = new URL(value);
    baseUrl = new URL(GITLAB_BASE_URL);
  } catch {
    return undefined;
  }

  if (parsedUrl.origin.toLowerCase() !== baseUrl.origin.toLowerCase()) {
    return undefined;
  }

  const segments = parsedUrl.pathname
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);

  if (segments.length === 0) {
    return undefined;
  }

  const separatorIndex = segments.indexOf("-");
  const projectSegments = separatorIndex >= 0 ? segments.slice(0, separatorIndex) : segments;

  if (projectSegments.length === 0) {
    return undefined;
  }

  const lastIndex = projectSegments.length - 1;
  projectSegments[lastIndex] = projectSegments[lastIndex].replace(/\.git$/i, "");

  return projectSegments.filter(Boolean).join("/");
}

function canonicalizeProjectInput(value: string): string {
  const decoded = decodeResourceId(value).trim();
  const extractedProjectPath = extractProjectPathFromGitLabUrl(decoded);
  const candidate = extractedProjectPath ?? decoded;

  if (!candidate.includes("/")) {
    return candidate.replace(/\s+/g, " ");
  }

  return candidate
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean)
    .join("/");
}

function buildProjectSearchTerms(query: string): string[] {
  const canonical = canonicalizeProjectInput(query);
  const normalized = normalizeProjectLookup(canonical);
  const tokens = normalized.split(" ").filter(Boolean);
  const searchTerms = new Set<string>([canonical]);

  if (normalized && normalized !== canonical.toLowerCase()) {
    searchTerms.add(normalized);
  }

  if (tokens.length > 0) {
    searchTerms.add(tokens[tokens.length - 1]);
  }

  if (tokens.length > 1) {
    searchTerms.add(tokens.join("/"));
    searchTerms.add(tokens.join("-"));
  }

  return Array.from(searchTerms).filter(Boolean);
}

function tokenizeProjectLookup(value: string): string[] {
  return normalizeProjectLookup(value).split(" ").filter(Boolean);
}

async function searchProjectsForResolution(
  query: string
): Promise<{ projects: ProjectSummary[]; scopeLabel: string }> {
  const candidates = new Map<number, ProjectSummary>();
  let scopeLabel = "accessible projects";

  for (const term of buildProjectSearchTerms(query)) {
    const result = await searchProjects(term, { perPage: 100 });
    scopeLabel = result.scopeLabel;

    for (const project of result.projects) {
      candidates.set(project.id, project);
    }
  }

  const currentCandidates = Array.from(candidates.values());
  if (!pickResolvedProject(currentCandidates, query)) {
    const catalogProjects = await listAccessibleProjectsCatalog();
    for (const project of catalogProjects) {
      candidates.set(project.id, project);
    }
  }

  return {
    projects: Array.from(candidates.values()),
    scopeLabel,
  };
}

function pickResolvedProject(projects: ProjectSummary[], query: string): ProjectSummary | undefined {
  const canonicalQuery = canonicalizeProjectInput(query);
  const normalizedQuery = normalizeProjectLookup(canonicalQuery);

  const pathNamespaceMatch = projects.filter(
    (project) => project.path_with_namespace.toLowerCase() === canonicalQuery.toLowerCase()
  );
  if (pathNamespaceMatch.length === 1) return pathNamespaceMatch[0];

  const pathMatch = projects.filter(
    (project) => project.path.toLowerCase() === canonicalQuery.toLowerCase()
  );
  if (pathMatch.length === 1) return pathMatch[0];

  const nameMatch = projects.filter(
    (project) => project.name.toLowerCase() === canonicalQuery.toLowerCase()
  );
  if (nameMatch.length === 1) return nameMatch[0];

  const normalizedPathNamespaceMatch = projects.filter(
    (project) => normalizeProjectLookup(project.path_with_namespace) === normalizedQuery
  );
  if (normalizedPathNamespaceMatch.length === 1) return normalizedPathNamespaceMatch[0];

  const normalizedPathMatch = projects.filter(
    (project) => normalizeProjectLookup(project.path) === normalizedQuery
  );
  if (normalizedPathMatch.length === 1) return normalizedPathMatch[0];

  const normalizedNameMatch = projects.filter(
    (project) => normalizeProjectLookup(project.name) === normalizedQuery
  );
  if (normalizedNameMatch.length === 1) return normalizedNameMatch[0];

  const queryTokens = tokenizeProjectLookup(canonicalQuery);

  const pathNamespaceSequenceMatch = projects.filter((project) =>
    hasTokenSequence(tokenizeProjectLookup(project.path_with_namespace), queryTokens)
  );
  if (pathNamespaceSequenceMatch.length === 1) return pathNamespaceSequenceMatch[0];

  const pathSequenceMatch = projects.filter((project) =>
    hasTokenSequence(tokenizeProjectLookup(project.path), queryTokens)
  );
  if (pathSequenceMatch.length === 1) return pathSequenceMatch[0];

  const nameSequenceMatch = projects.filter((project) =>
    hasTokenSequence(tokenizeProjectLookup(project.name), queryTokens)
  );
  if (nameSequenceMatch.length === 1) return nameSequenceMatch[0];

  // Only fall back to a single result when the query has no namespace separator,
  // i.e. the user gave a bare project name rather than a full path. When the
  // query contains "/" the caller is being explicit and we must not silently
  // substitute a different project.
  if (projects.length === 1 && !canonicalizeProjectInput(query).includes("/")) {
    return projects[0];
  }

  return undefined;
}

function toProjectRef(project: ProjectSummary): ProjectRef {
  return {
    raw: project.path_with_namespace,
    encoded: encodeProject(project.path_with_namespace),
  };
}

function isGitLabStatusError(error: unknown, status: number): error is McpError {
  return error instanceof McpError && error.message.startsWith(`GitLab API error ${status}:`);
}

function renderIssueDetails(issue: Issue, project: ProjectRef, workItemStatus?: string | null): string {
  const assignees = issue.assignees.map((a) => `${a.name} (@${a.username})`).join(", ") || "unassigned";

  const lines = [
    `## Issue #${issue.iid}: ${issue.title}`,
    "",
    `**Project:** ${project.raw}`,
    `**State:** ${issue.state}`,
  ];

  if (workItemStatus !== undefined) {
    lines.push(`**Work Item Status:** ${workItemStatus ?? "_(not set)_"}`);
  }

  lines.push(
    `**Author:** ${issue.author.name} (@${issue.author.username})`,
    `**Assignees:** ${assignees}`,
    `**Labels:** ${issue.labels.join(", ") || "none"}`,
    `**Milestone:** ${issue.milestone?.title ?? "none"}`,
    `**Due date:** ${issue.due_date ?? "none"}`,
    `**Weight:** ${issue.weight ?? "none"}`,
    `**Created:** ${issue.created_at}`,
    `**Updated:** ${issue.updated_at}`,
    `**Closed:** ${issue.closed_at ?? "—"}`,
    `**URL:** ${issue.web_url}`,
    "",
    "### Description",
    issue.description || "_No description provided._"
  );

  return lines.join("\n");
}

function renderProjectCatalog(projects: ProjectSummary[]): string {
  if (projects.length === 0) {
    return "No accessible GitLab projects were found for this token.";
  }

  const lines = projects.map((project) =>
    [
      `### ${project.name}`,
      `- **Path:** ${project.path_with_namespace}`,
      `- **Project ID:** ${project.id}`,
      `- **Last activity:** ${project.last_activity_at}`,
      `- **URL:** ${project.web_url}`,
      `- **Description:** ${project.description ?? "none"}`,
    ].join("\n")
  );

  return [
    "# GitLab Project Catalog",
    "",
    "Use this catalog to resolve natural repository references before calling issue, MR, pipeline, or file tools.",
    "",
    lines.join("\n\n"),
  ].join("\n");
}

async function findIssueInMatchingProjects(
  projectQuery: string,
  iid: number,
  excludedProject?: string
): Promise<Array<{ project: ProjectRef; issue: Issue }>> {
  const { projects } = await searchProjectsForResolution(projectQuery);
  const candidates = projects.filter((project) => project.path_with_namespace !== excludedProject).slice(0, 20);
  const matches: Array<{ project: ProjectRef; issue: Issue }> = [];

  for (const candidate of candidates) {
    try {
      const issue = await gitlabRequest<Issue>(`/projects/${candidate.id}/issues/${iid}`);
      matches.push({ project: toProjectRef(candidate), issue });
    } catch (error) {
      if (isGitLabStatusError(error, 404)) {
        continue;
      }
      throw error;
    }
  }

  return matches;
}

interface ResolveProjectOptions {
  persist?: boolean;
}

async function resolveProject(
  project?: string,
  { persist = false }: ResolveProjectOptions = {}
): Promise<ProjectRef> {
  const value = project?.trim();

  if (!value) {
    if (activeProject) {
      return activeProject;
    }

    throw new McpError(
      ErrorCode.InvalidParams,
      "Project is required. Pass `project` (for example `group-name/project-name`, `group-name project-name`, or `project-name`) or call `select_project` first."
    );
  }

  const canonicalValue = canonicalizeProjectInput(value);
  if (isNumericId(canonicalValue)) {
    const resolvedProject = {
      raw: canonicalValue,
      encoded: encodeProject(canonicalValue),
    };
    if (persist) setActiveProject(resolvedProject);
    return resolvedProject;
  }

  const { projects, scopeLabel } = await searchProjectsForResolution(canonicalValue);
  const resolved = pickResolvedProject(projects, canonicalValue);

  if (!resolved) {
    const suggestions = projects
      .slice(0, 5)
      .map((candidate) => candidate.path_with_namespace)
      .join(", ");

    if (projects.length === 0) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Project "${canonicalValue}" was not found in ${scopeLabel}. Use \`list_projects\` or pass the full namespace/path.`
      );
    }

    throw new McpError(
      ErrorCode.InvalidParams,
      `Project "${canonicalValue}" is ambiguous in ${scopeLabel}. Matching projects: ${suggestions}. Pass the full namespace/path.`
    );
  }

  const resolvedProject = {
    raw: resolved.path_with_namespace,
    encoded: encodeProject(resolved.path_with_namespace),
  };
  if (persist) setActiveProject(resolvedProject);
  return resolvedProject;
}

function getNumericIdentifier(
  args: Record<string, unknown>,
  keys: string[],
  label: string
): number {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }

  throw new McpError(
    ErrorCode.InvalidParams,
    `${label} is required. Pass one of: ${keys.map((key) => `\`${key}\``).join(", ")}.`
  );
}

function normalizePerPage(value: number | undefined, fallback = 20): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(100, Math.max(1, Math.trunc(value)));
}

function parseRequestedLabels(labels?: string): string[] {
  if (!labels) return [];

  const values = labels
    .split(",")
    .map((label) => label.trim())
    .filter(Boolean);

  return Array.from(new Set(values));
}

function normalizeLabelLookup(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function tokenizeLabel(value: string): string[] {
  return normalizeLabelLookup(value)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

function hasTokenSequence(tokens: string[], queryTokens: string[]): boolean {
  if (queryTokens.length === 0 || queryTokens.length > tokens.length) {
    return false;
  }

  for (let start = 0; start <= tokens.length - queryTokens.length; start += 1) {
    const matches = queryTokens.every((token, index) => tokens[start + index] === token);
    if (matches) {
      return true;
    }
  }

  return false;
}

async function listProjectLabels(project: ProjectRef): Promise<ProjectLabel[]> {
  const labels: ProjectLabel[] = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    const batch = await gitlabRequest<ProjectLabel[]>(
      `/projects/${project.encoded}/labels`,
      {
        params: {
          per_page: perPage,
          page,
          include_ancestor_groups: true,
        },
      }
    );

    labels.push(...batch.filter((label) => !label.archived));

    if (batch.length < perPage) {
      break;
    }

    page += 1;
  }

  return labels;
}

async function resolveRequestedIssueLabels(
  project: ProjectRef,
  labels?: string
): Promise<Array<{ requested: string; resolved: string }>> {
  const requestedLabels = parseRequestedLabels(labels);
  const resolvedLabels: Array<{ requested: string; resolved: string }> = [];
  const availableLabels = requestedLabels.length > 0 ? await listProjectLabels(project) : [];

  for (const requested of requestedLabels) {
    const exactMatch = availableLabels.find((label) => label.name.trim() === requested);

    if (exactMatch) {
      resolvedLabels.push({ requested, resolved: exactMatch.name });
      continue;
    }

    const normalizedRequested = normalizeLabelLookup(requested);
    const exactInsensitiveMatches = availableLabels.filter(
      (label) => normalizeLabelLookup(label.name) === normalizedRequested
    );

    if (exactInsensitiveMatches.length === 1) {
      resolvedLabels.push({ requested, resolved: exactInsensitiveMatches[0].name });
      continue;
    }

    if (exactInsensitiveMatches.length > 1) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Label "${requested}" is ambiguous in ${project.raw}. Matching labels: ${exactInsensitiveMatches
          .map((label) => label.name)
          .join(", ")}.`
      );
    }

    const queryTokens = tokenizeLabel(requested);
    const tokenMatches = availableLabels.filter((label) =>
      hasTokenSequence(tokenizeLabel(label.name), queryTokens)
    );

    if (tokenMatches.length === 1) {
      resolvedLabels.push({ requested, resolved: tokenMatches[0].name });
      continue;
    }

    if (tokenMatches.length > 1) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Label "${requested}" is ambiguous in ${project.raw}. Matching labels: ${tokenMatches
          .map((label) => label.name)
          .join(", ")}. Pass the full label name.`
      );
    }

    throw new McpError(
      ErrorCode.InvalidParams,
      `Label "${requested}" was not found in ${project.raw}. Pass the full label name used in GitLab.`
    );
  }

  return resolvedLabels;
}

function issueHasAllRequestedLabels(issueLabels: string[], requestedLabels: string[]): boolean {
  if (requestedLabels.length === 0) return true;

  const issueLabelSet = new Set(issueLabels);
  return requestedLabels.every((label) => issueLabelSet.has(label));
}

function textResult(text: string) {
  return {
    content: [{ type: "text" as const, text }],
  };
}

// ---------------------------------------------------------------------------
// GitLab GraphQL helpers (Work Items API — status not available in REST)
// ---------------------------------------------------------------------------

async function gitlabGraphQL<T = unknown>(
  query: string,
  variables?: Record<string, unknown>
): Promise<T> {
  const url = `${GITLAB_BASE_URL}/api/graphql`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "PRIVATE-TOKEN": GITLAB_TOKEN!,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    let detail: string;
    try {
      const err = (await response.json()) as { message?: string; error?: string };
      detail = err.message ?? err.error ?? "";
    } catch {
      detail = await response.text();
    }
    throw new McpError(
      ErrorCode.InternalError,
      `GitLab GraphQL error ${response.status}: ${detail || response.statusText}`
    );
  }

  const result = (await response.json()) as {
    data?: T;
    errors?: Array<{ message: string }>;
  };

  if (result.errors && result.errors.length > 0) {
    throw new McpError(
      ErrorCode.InternalError,
      `GitLab GraphQL errors: ${result.errors.map((e) => e.message).join(", ")}`
    );
  }

  return result.data as T;
}

interface WorkItemStatusInfo {
  iid: string;
  title: string;
  status: string | null;
}

const WORK_ITEM_STATUS_QUERY = `
  query GetWorkItemStatus($fullPath: ID!, $iids: [String!]) {
    project(fullPath: $fullPath) {
      workItems(iids: $iids) {
        nodes {
          iid
          title
          widgets {
            ... on WorkItemWidgetStatus {
              status {
                name
              }
            }
          }
        }
      }
    }
  }
`;

async function fetchWorkItemStatus(
  projectFullPath: string,
  iid: number
): Promise<WorkItemStatusInfo | null> {
  try {
    const data = await gitlabGraphQL<{
      project: {
        workItems: {
          nodes: Array<{
            iid: string;
            title: string;
            widgets: Array<{ status?: { name: string } }>;
          }>;
        } | null;
      } | null;
    }>(WORK_ITEM_STATUS_QUERY, { fullPath: projectFullPath, iids: [String(iid)] });

    const workItem = data?.project?.workItems?.nodes?.[0];
    if (!workItem) return null;

    const statusWidget = workItem.widgets.find(
      (w): w is { status: { name: string } } => "status" in w && w.status != null
    );

    return {
      iid: workItem.iid,
      title: workItem.title,
      status: statusWidget?.status.name ?? null,
    };
  } catch {
    // GraphQL status fetch is best-effort — don't fail the whole request
    return null;
  }
}

function getAuditClientLabel(): string {
  const client = server.getClientVersion();
  if (!client?.name) {
    return "unknown MCP client";
  }

  return client.version ? `${client.name} ${client.version}` : client.name;
}

function getAuditModelLabel(meta?: Record<string, unknown>): string {
  if (GITLAB_AUDIT_MODEL_OVERRIDE) {
    return GITLAB_AUDIT_MODEL_OVERRIDE;
  }

  const metaModel = meta?.["gitlab-mcp/model"];
  if (typeof metaModel === "string" && metaModel.trim()) {
    return metaModel.trim();
  }

  return "unknown (MCP client did not expose model)";
}

function addAiAuditHeader(text?: string, meta?: Record<string, unknown>): string | undefined {
  if (!text || text.includes("<!-- gitlab-mcp-ai-audit -->")) {
    return text;
  }

  return [
    "<!-- gitlab-mcp-ai-audit -->",
    "> AI-generated content",
    `> Model: ${getAuditModelLabel(meta)}`,
    `> Client: ${getAuditClientLabel()}`,
    "> Generated by: gitlab-mcp MCP server",
    `> Generated at: ${new Date().toISOString()}`,
    "",
    text,
  ].join("\n");
}

function hasDefinedValue(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

// ---------------------------------------------------------------------------
// Type definitions (subset of GitLab API responses)
// ---------------------------------------------------------------------------

interface MergeRequest {
  iid: number;
  title: string;
  state: string;
  author: { username: string; name: string };
  assignees: Array<{ username: string; name: string }>;
  target_branch: string;
  source_branch: string;
  web_url: string;
  created_at: string;
  updated_at: string;
  description: string;
  labels: string[];
}

interface Note {
  id: number;
  body: string;
  author: { username: string; name: string };
  created_at: string;
  updated_at: string;
  system: boolean;
}

interface Pipeline {
  id: number;
  iid: number;
  status: string;
  ref: string;
  sha: string;
  web_url: string;
  created_at: string;
  updated_at: string;
}

interface Job {
  id: number;
  name: string;
  stage: string;
  status: string;
  web_url: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  duration: number | null;
  runner: { description: string } | null;
}

interface Issue {
  iid: number;
  title: string;
  description: string;
  state: string;
  labels: string[];
  assignees: Array<{ username: string; name: string }>;
  author: { username: string; name: string };
  web_url: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  milestone: { title: string } | null;
  due_date: string | null;
  weight: number | null;
}

interface ProjectLabel {
  id: number;
  name: string;
  description?: string | null;
  color?: string;
  text_color?: string;
  open_issues_count?: number;
  closed_issues_count?: number;
  priority?: number | null;
  is_project_label?: boolean;
  archived?: boolean;
}

interface Branch {
  name: string;
  merged: boolean;
  protected: boolean;
  default: boolean;
  web_url: string;
  commit: { id: string; short_id: string; title: string; committed_date: string };
}

interface FileContent {
  file_name: string;
  file_path: string;
  size: number;
  encoding: string;
  content: string;
  ref: string;
  blob_id: string;
  last_commit_id: string;
}

interface CreatedNote {
  id: number;
  body: string;
  author: { username: string; name: string };
  created_at: string;
}

const projectInputSchema = {
  type: "string",
  description:
    `Numeric GitLab project ID, namespace/path (for example \`group-name/project-name\`), a natural namespace-and-name form like \`group-name project-name\`, a short project name like \`project-name\`, or a full GitLab URL on this host. If omitted, the active project for the current MCP session is used. When the user names a repository or pastes a GitLab URL, pass \`project\` explicitly. Passing \`project\` also updates that active project. When repository names are ambiguous, consult the \`${PROJECT_CATALOG_URI}\` resource first.`,
} as const;

const groupInputSchema = {
  type: "string",
  description:
    "Optional numeric GitLab group ID or group path (for example `group-name`) used to scope project discovery for this request.",
} as const;

const explicitProjectGuidance =
  "Pass `project` explicitly when the user's latest message names a repository or pastes a GitLab URL; otherwise the active project from this MCP session is used.";

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

const server = new Server(
  { name: "gitlab-mcp", version: "1.0.0" },
  {
    capabilities: {
      tools: {},
      resources: {},
    },
    instructions:
      `When the user switches repositories mid-conversation or pastes a GitLab URL, do not rely on the previously active project. Resolve the full GitLab path first and either call \`select_project\` or pass \`project\` explicitly on the next tool call. Consult the ${PROJECT_CATALOG_URI} resource before selecting a project when the repository name is ambiguous. Use \`select_project\` when the user wants follow-up requests to stay in the new repository. If the repository context looks stale, call \`clear_active_project\` before retrying.`,
  }
);

// ---------------------------------------------------------------------------
// Resource definitions
// ---------------------------------------------------------------------------

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    {
      uri: PROJECT_CATALOG_URI,
      name: "GitLab Project Catalog",
      description:
        "Catalog of GitLab projects accessible to the configured token. Use it to map natural repository names to full namespace paths before calling tools.",
      mimeType: "text/markdown",
    },
  ],
}));

server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
  resourceTemplates: [],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;

  if (uri !== PROJECT_CATALOG_URI) {
    throw new McpError(ErrorCode.InvalidParams, `Resource ${uri} not found`);
  }

  const projects = await listAccessibleProjectsCatalog();
  const text = renderProjectCatalog(projects);

  return {
    contents: [
      {
        uri: PROJECT_CATALOG_URI,
        mimeType: "text/markdown",
        text,
      },
    ],
  };
});

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    // ── Merge Requests ──────────────────────────────────────────────────────
    {
      name: "select_project",
      description:
        "Resolve and store the active GitLab project for this MCP session. Use this when the user wants to switch repositories for follow-up requests.",
      inputSchema: {
        type: "object",
        properties: {
          project: projectInputSchema,
        },
        required: ["project"],
      },
    },
    {
      name: "clear_active_project",
      description:
        "Clear the active GitLab project stored for this MCP session so later tool calls must pass `project` explicitly or call `select_project` again.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "list_projects",
      description:
        "List projects available to the authenticated user. Optionally scope discovery to a specific GitLab group/organization.",
      inputSchema: {
        type: "object",
        properties: {
          search: {
            type: "string",
            description: "Optional search term to filter projects by name or path",
          },
          group: groupInputSchema,
          per_page: {
            type: "number",
            description: "Number of results per page (default: 20, max: 100)",
          },
        },
      },
    },
    {
      name: "list_labels",
      description:
        `List labels available in a project. Use this to inspect exact GitLab label names before filtering issues. ${explicitProjectGuidance}`,
      inputSchema: {
        type: "object",
        properties: {
          project: projectInputSchema,
          search: {
            type: "string",
            description: "Optional case-insensitive substring filter on label names",
          },
        },
      },
    },
    {
      name: "list_merge_requests",
      description:
        `List merge requests for a project. Defaults to open MRs and can filter by state and assignee username. ${explicitProjectGuidance}`,
      inputSchema: {
        type: "object",
        properties: {
          project: projectInputSchema,
          state: {
            type: "string",
            enum: ["opened", "merged", "closed", "all"],
            description: "Filter by MR state (default: opened)",
          },
          assignee_username: {
            type: "string",
            description: "Filter by assignee GitLab username",
          },
          per_page: {
            type: "number",
            description: "Number of results per page (default: 20, max: 100)",
          },
        },
      },
    },
    {
      name: "get_merge_request_diff",
      description: `Get the full diff of a specific merge request by its IID. ${explicitProjectGuidance}`,
      inputSchema: {
        type: "object",
        properties: {
          project: projectInputSchema,
          iid: {
            type: "number",
            description: "The internal ID (IID) of the merge request",
          },
        },
        required: ["iid"],
      },
    },
    {
      name: "get_merge_request_comments",
      description: `Get all comments and notes on a specific merge request. ${explicitProjectGuidance}`,
      inputSchema: {
        type: "object",
        properties: {
          project: projectInputSchema,
          iid: {
            type: "number",
            description: "The internal ID (IID) of the merge request",
          },
        },
        required: ["iid"],
      },
    },
    {
      name: "add_merge_request_comment",
      description:
        `Post a comment on a specific merge request. Comments created through this MCP are automatically marked as AI-generated for audit purposes. ${explicitProjectGuidance}`,
      inputSchema: {
        type: "object",
        properties: {
          project: projectInputSchema,
          iid: {
            type: "number",
            description: "The internal ID (IID) of the merge request",
          },
          body: {
            type: "string",
            description: "The comment text (Markdown supported)",
          },
        },
        required: ["iid", "body"],
      },
    },

    // ── Pipelines ────────────────────────────────────────────────────────────
    {
      name: "list_pipelines",
      description: `List recent pipelines for a project. Optionally filter by status. ${explicitProjectGuidance}`,
      inputSchema: {
        type: "object",
        properties: {
          project: projectInputSchema,
          status: {
            type: "string",
            enum: ["created", "waiting_for_resource", "preparing", "pending", "running", "success", "failed", "canceled", "skipped", "manual", "scheduled"],
            description: "Filter pipelines by status",
          },
          ref: {
            type: "string",
            description: "Filter by branch or tag name",
          },
          per_page: {
            type: "number",
            description: "Number of results per page (default: 20, max: 100)",
          },
        },
      },
    },
    {
      name: "get_pipeline_jobs",
      description: `Get all jobs for a specific pipeline by its ID. ${explicitProjectGuidance}`,
      inputSchema: {
        type: "object",
        properties: {
          project: projectInputSchema,
          pipeline_id: {
            type: "number",
            description: "The numeric ID of the pipeline",
          },
        },
        required: ["pipeline_id"],
      },
    },

    // ── Issues ───────────────────────────────────────────────────────────────
    {
      name: "list_issues",
      description:
        `List issues for a project. Optionally filter by state and labels. ${explicitProjectGuidance}`,
      inputSchema: {
        type: "object",
        properties: {
          project: projectInputSchema,
          state: {
            type: "string",
            enum: ["opened", "closed", "all"],
            description: "Filter by issue state (default: opened)",
          },
          labels: {
            type: "string",
            description:
              "Comma-separated list of label names to filter by. Exact label-name matches are case-insensitive, unique shorthands like `blocked` can resolve to `Status Blocked`, and issues must contain all resolved labels.",
          },
          assignee_username: {
            type: "string",
            description: "Filter by assignee GitLab username",
          },
          per_page: {
            type: "number",
            description: "Number of results per page (default: 20, max: 100)",
          },
        },
      },
    },
    {
      name: "get_issue",
      description:
        `Get full details of a specific GitLab issue or ticket, including title, description, labels, assignees, and metadata. ${explicitProjectGuidance}`,
      inputSchema: {
        type: "object",
        properties: {
          project: projectInputSchema,
          iid: {
            type: "number",
            description: "The internal ID (IID) of the issue",
          },
          issue: {
            type: "number",
            description: "Alias for the internal issue ID (IID)",
          },
          ticket: {
            type: "number",
            description: "Alias for the internal issue ID (IID)",
          },
        },
      },
    },
    {
      name: "get_issue_comments",
      description:
        `Get all comments and notes on a specific GitLab issue or ticket, in chronological order. ${explicitProjectGuidance}`,
      inputSchema: {
        type: "object",
        properties: {
          project: projectInputSchema,
          iid: {
            type: "number",
            description: "The internal ID (IID) of the issue",
          },
          issue: {
            type: "number",
            description: "Alias for the internal issue ID (IID)",
          },
          ticket: {
            type: "number",
            description: "Alias for the internal issue ID (IID)",
          },
        },
      },
    },
    {
      name: "add_issue_comment",
      description:
        `Post a comment on a specific GitLab issue or ticket. Comments created through this MCP are automatically marked as AI-generated for audit purposes. ${explicitProjectGuidance}`,
      inputSchema: {
        type: "object",
        properties: {
          project: projectInputSchema,
          iid: {
            type: "number",
            description: "The internal ID (IID) of the issue",
          },
          issue: {
            type: "number",
            description: "Alias for the internal issue ID (IID)",
          },
          ticket: {
            type: "number",
            description: "Alias for the internal issue ID (IID)",
          },
          body: {
            type: "string",
            description: "The comment text (Markdown supported)",
          },
        },
        required: ["body"],
      },
    },
    {
      name: "update_issue",
      description:
        `Update an existing GitLab issue or ticket. Any description written through this MCP is automatically marked as AI-generated for audit purposes. ${explicitProjectGuidance}`,
      inputSchema: {
        type: "object",
        properties: {
          project: projectInputSchema,
          iid: {
            type: "number",
            description: "The internal ID (IID) of the issue",
          },
          issue: {
            type: "number",
            description: "Alias for the internal issue ID (IID)",
          },
          ticket: {
            type: "number",
            description: "Alias for the internal issue ID (IID)",
          },
          title: {
            type: "string",
            description: "Updated issue title",
          },
          description: {
            type: "string",
            description: "Updated issue description (Markdown supported)",
          },
          labels: {
            type: "string",
            description: "Comma-separated list of labels to set on the issue",
          },
          add_labels: {
            type: "string",
            description: "Comma-separated list of labels to add without replacing existing labels",
          },
          remove_labels: {
            type: "string",
            description: "Comma-separated list of labels to remove",
          },
          assignee_ids: {
            type: "array",
            items: { type: "number" },
            description: "Array of user IDs to assign the issue to",
          },
          due_date: {
            type: "string",
            description: "Due date in YYYY-MM-DD format",
          },
          weight: {
            type: "number",
            description: "Issue weight",
          },
          state_event: {
            type: "string",
            enum: ["close", "reopen"],
            description: "Close or reopen the issue",
          },
        },
      },
    },
    {
      name: "list_work_item_statuses",
      description:
        `List all work items in a project with their Work Item Status in a single call. Uses the GitLab GraphQL Work Items API because the status field is not available in the REST API. Useful for getting a full status overview of all tickets in a project. ${explicitProjectGuidance}`,
      inputSchema: {
        type: "object",
        properties: {
          project: projectInputSchema,
          per_page: {
            type: "number",
            description: "Maximum number of work items to return (default: 100, max: 100)",
          },
        },
      },
    },
    {
      name: "get_issue_status",
      description:
        `Get the Work Item status of a specific GitLab issue or ticket (e.g. "In Dev Review", "Ready for QA"). Uses the GraphQL Work Items API because the status field is not available in the REST API. ${explicitProjectGuidance}`,
      inputSchema: {
        type: "object",
        properties: {
          project: projectInputSchema,
          iid: {
            type: "number",
            description: "The internal ID (IID) of the issue",
          },
          issue: {
            type: "number",
            description: "Alias for the internal issue ID (IID)",
          },
          ticket: {
            type: "number",
            description: "Alias for the internal issue ID (IID)",
          },
        },
      },
    },
    {
      name: "create_issue",
      description:
        `Create a new issue in a project. Any description written through this MCP is automatically marked as AI-generated for audit purposes. ${explicitProjectGuidance}`,
      inputSchema: {
        type: "object",
        properties: {
          project: projectInputSchema,
          title: {
            type: "string",
            description: "The issue title",
          },
          description: {
            type: "string",
            description: "The issue description (Markdown supported)",
          },
          labels: {
            type: "string",
            description: "Comma-separated list of label names to apply",
          },
          assignee_ids: {
            type: "array",
            items: { type: "number" },
            description: "Array of user IDs to assign the issue to",
          },
        },
        required: ["title"],
      },
    },

    // ── Repository ───────────────────────────────────────────────────────────
    {
      name: "get_file_contents",
      description: `Read the contents of a file from the repository at a given branch or ref. ${explicitProjectGuidance}`,
      inputSchema: {
        type: "object",
        properties: {
          project: projectInputSchema,
          file_path: {
            type: "string",
            description: "Path to the file in the repository (e.g. src/components/App.ts)",
          },
          ref: {
            type: "string",
            description: "Branch name, tag, or commit SHA (default: main)",
          },
        },
        required: ["file_path"],
      },
    },
    {
      name: "list_branches",
      description: `List branches in a project. Optionally search by name. ${explicitProjectGuidance}`,
      inputSchema: {
        type: "object",
        properties: {
          project: projectInputSchema,
          search: {
            type: "string",
            description: "Search branches by name (supports partial match)",
          },
          per_page: {
            type: "number",
            description: "Number of results per page (default: 20, max: 100)",
          },
        },
      },
    },
  ],
}));

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  try {
    switch (name) {
      // ── select_project ───────────────────────────────────────────────────
      case "select_project": {
        const { project: projectArg } = args as { project: string };
        const project = await resolveProject(projectArg, { persist: true });

        return {
          content: [
            {
              type: "text",
              text: `✅ Active project set to **${project.raw}** for this MCP session.`,
            },
          ],
        };
      }

      case "clear_active_project": {
        const previousProject = clearActiveProject();
        return textResult(
          previousProject
            ? `✅ Cleared active project **${previousProject.raw}** for this MCP session.`
            : "No active project was set for this MCP session."
        );
      }

      // ── list_projects ────────────────────────────────────────────────────
      case "list_projects": {
        const { search, group, per_page = 20 } = args as {
          search?: string;
          group?: string;
          per_page?: number;
        };

        const { projects, scopeLabel } = await searchProjects(search, {
          group,
          perPage: per_page,
        });

        if (projects.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: search
                  ? `No projects found for "${search}" in ${scopeLabel}.`
                  : `No projects found in ${scopeLabel}.`,
              },
            ],
          };
        }

        const lines = projects.map((project) =>
          [
            `### ${project.name}`,
            `- **Path:** ${project.path_with_namespace}`,
            `- **Project ID:** ${project.id}`,
            `- **Last activity:** ${project.last_activity_at}`,
            `- **URL:** ${project.web_url}`,
            `- **Description:** ${project.description ?? "none"}`,
          ].join("\n")
        );

        return {
          content: [
            {
              type: "text",
              text: `## Projects\n\n**Scope:** ${scopeLabel}\n\n${lines.join("\n\n")}`,
            },
          ],
        };
      }

      // ── list_labels ──────────────────────────────────────────────────────
      case "list_labels": {
        const { project: projectArg, search } = args as {
          project?: string;
          search?: string;
        };
        const project = await resolveProject(projectArg, { persist: true });
        const normalizedSearch = search ? normalizeLabelLookup(search) : undefined;
        const labels = (await listProjectLabels(project))
          .filter((label) =>
            normalizedSearch ? normalizeLabelLookup(label.name).includes(normalizedSearch) : true
          )
          .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

        if (labels.length === 0) {
          return textResult(
            search
              ? `No labels found in ${project.raw} matching "${search}".`
              : `No labels found in ${project.raw}.`
          );
        }

        const lines = labels.map((label) => {
          const scope = label.is_project_label === false ? "group" : "project";
          const usage = `${label.open_issues_count ?? 0} open / ${label.closed_issues_count ?? 0} closed`;
          return [
            `### ${label.name}`,
            `- **Scope:** ${scope}`,
            `- **Color:** ${label.color ?? "unknown"} (${label.text_color ?? "unknown"} text)`,
            `- **Usage:** ${usage}`,
            `- **Priority:** ${label.priority ?? "none"}`,
            `- **Description:** ${label.description ?? "none"}`,
          ].join("\n");
        });

        return {
          content: [
            {
              type: "text",
              text: [
                "## Labels",
                "",
                `**Project:** ${project.raw}`,
                `**Total labels:** ${labels.length}`,
                ...(search ? [`**Search:** ${search}`] : []),
                "",
                lines.join("\n\n"),
              ].join("\n"),
            },
          ],
        };
      }

      // ── list_merge_requests ──────────────────────────────────────────────
      case "list_merge_requests": {
        const { project: projectArg, state = "opened", assignee_username, per_page = 20 } = args as {
          project?: string;
          state?: string;
          assignee_username?: string;
          per_page?: number;
        };
        const project = await resolveProject(projectArg, { persist: true });

        const mrs = await gitlabRequest<MergeRequest[]>(
          `/projects/${project.encoded}/merge_requests`,
          {
            params: {
              state,
              assignee_username,
              per_page,
              order_by: "updated_at",
              sort: "desc",
            },
          }
        );

        if (mrs.length === 0) {
          return textResult(`No merge requests found with state="${state}".`);
        }

        const lines = mrs.map((mr) => {
          const assignees = mr.assignees.map((a) => a.username).join(", ") || "unassigned";
          return [
            `### MR !${mr.iid}: ${mr.title}`,
            `- **State:** ${mr.state}`,
            `- **Author:** ${mr.author.username}`,
            `- **Assignees:** ${assignees}`,
            `- **Branches:** \`${mr.source_branch}\` → \`${mr.target_branch}\``,
            `- **Labels:** ${mr.labels.join(", ") || "none"}`,
            `- **Updated:** ${mr.updated_at}`,
            `- **URL:** ${mr.web_url}`,
          ].join("\n");
        });

        return {
          content: [
            {
              type: "text",
              text: `## Merge Requests (${state})\n\n**Project:** ${project.raw}\n\n${lines.join("\n\n")}`,
            },
          ],
        };
      }

      // ── get_merge_request_diff ───────────────────────────────────────────
      case "get_merge_request_diff": {
        const { project: projectArg, iid } = args as { project?: string; iid: number };
        const project = await resolveProject(projectArg, { persist: true });

        const diffs = await gitlabRequest<Array<{
          old_path: string;
          new_path: string;
          diff: string;
          new_file: boolean;
          deleted_file: boolean;
          renamed_file: boolean;
        }>>(`/projects/${project.encoded}/merge_requests/${iid}/diffs`);

        if (diffs.length === 0) {
          return textResult(`No diff found for MR !${iid}.`);
        }

        const sections = diffs.map((d) => {
          const fileLabel = d.renamed_file
            ? `${d.old_path} → ${d.new_path}`
            : d.new_file
            ? `${d.new_path} (new file)`
            : d.deleted_file
            ? `${d.old_path} (deleted)`
            : d.new_path;

          return `### ${fileLabel}\n\`\`\`diff\n${d.diff}\n\`\`\``;
        });

        return {
          content: [
            {
              type: "text",
              text: `## Diff for MR !${iid}\n\n**Project:** ${project.raw}\n\n${sections.join("\n\n")}`,
            },
          ],
        };
      }

      // ── get_merge_request_comments ───────────────────────────────────────
      case "get_merge_request_comments": {
        const { project: projectArg, iid } = args as { project?: string; iid: number };
        const project = await resolveProject(projectArg, { persist: true });

        const notes = await gitlabRequest<Note[]>(
          `/projects/${project.encoded}/merge_requests/${iid}/notes`,
          { params: { sort: "asc", order_by: "created_at", per_page: 100 } }
        );

        const userNotes = notes.filter((n) => !n.system);

        if (userNotes.length === 0) {
          return textResult(`No comments on MR !${iid} yet.`);
        }

        const lines = userNotes.map((n) =>
          `**${n.author.username}** (${n.created_at}):\n${n.body}`
        );

        return {
          content: [
            {
              type: "text",
              text: `## Comments on MR !${iid}\n\n**Project:** ${project.raw}\n\n${lines.join("\n\n---\n\n")}`,
            },
          ],
        };
      }

      // ── add_merge_request_comment ────────────────────────────────────────
      case "add_merge_request_comment": {
        const { project: projectArg, iid, body } = args as { project?: string; iid: number; body: string };
        const project = await resolveProject(projectArg, { persist: true });
        const auditedBody = addAiAuditHeader(body, request.params._meta) ?? body;

        const note = await gitlabRequest<CreatedNote>(
          `/projects/${project.encoded}/merge_requests/${iid}/notes`,
          { method: "POST", body: { body: auditedBody } }
        );

        return {
          content: [
            {
              type: "text",
              text: `✅ Comment posted on MR !${iid} in ${project.raw} by ${note.author.username} at ${note.created_at} (note ID: ${note.id}).`,
            },
          ],
        };
      }

      // ── list_pipelines ───────────────────────────────────────────────────
      case "list_pipelines": {
        const { project: projectArg, status, ref, per_page = 20 } = args as {
          project?: string;
          status?: string;
          ref?: string;
          per_page?: number;
        };
        const project = await resolveProject(projectArg, { persist: true });

        const pipelines = await gitlabRequest<Pipeline[]>(
          `/projects/${project.encoded}/pipelines`,
          {
            params: {
              status,
              ref,
              per_page,
              order_by: "updated_at",
              sort: "desc",
            },
          }
        );

        if (pipelines.length === 0) {
          return textResult("No pipelines found.");
        }

        const lines = pipelines.map((p) =>
          [
            `### Pipeline #${p.id} (iid: ${p.iid})`,
            `- **Status:** ${p.status}`,
            `- **Ref:** \`${p.ref}\``,
            `- **SHA:** \`${p.sha.slice(0, 8)}\``,
            `- **Updated:** ${p.updated_at}`,
            `- **URL:** ${p.web_url}`,
          ].join("\n")
        );

        return {
          content: [
            {
              type: "text",
              text: `## Pipelines\n\n**Project:** ${project.raw}\n\n${lines.join("\n\n")}`,
            },
          ],
        };
      }

      // ── get_pipeline_jobs ────────────────────────────────────────────────
      case "get_pipeline_jobs": {
        const { project: projectArg, pipeline_id } = args as { project?: string; pipeline_id: number };
        const project = await resolveProject(projectArg, { persist: true });

        const jobs = await gitlabRequest<Job[]>(
          `/projects/${project.encoded}/pipelines/${pipeline_id}/jobs`,
          { params: { per_page: 100 } }
        );

        if (jobs.length === 0) {
          return textResult(`No jobs found for pipeline #${pipeline_id}.`);
        }

        // Group by stage
        const byStage = jobs.reduce<Record<string, Job[]>>((acc, job) => {
          (acc[job.stage] ??= []).push(job);
          return acc;
        }, {});

        const sections = Object.entries(byStage).map(([stage, stageJobs]) => {
          const jobLines = stageJobs.map((j) => {
            const duration = j.duration != null ? `${Math.round(j.duration)}s` : "—";
            return `  - **${j.name}** [${j.status}] duration: ${duration} — ${j.web_url}`;
          });
          return `**Stage: ${stage}**\n${jobLines.join("\n")}`;
        });

        return {
          content: [
            {
              type: "text",
              text: `## Jobs for Pipeline #${pipeline_id}\n\n**Project:** ${project.raw}\n\n${sections.join("\n\n")}`,
            },
          ],
        };
      }

      // ── list_issues ──────────────────────────────────────────────────────
      case "list_issues": {
        const { project: projectArg, state = "opened", labels, assignee_username, per_page = 20 } = args as {
          project?: string;
          state?: string;
          labels?: string;
          assignee_username?: string;
          per_page?: number;
        };
        const project = await resolveProject(projectArg, { persist: true });
        const resolvedLabelMappings = await resolveRequestedIssueLabels(project, labels);
        const requestedLabels = resolvedLabelMappings.map((mapping) => mapping.resolved);
        const requestedPerPage = normalizePerPage(per_page);
        const issues: Issue[] = [];

        if (requestedLabels.length === 0) {
          issues.push(
            ...(await gitlabRequest<Issue[]>(
              `/projects/${project.encoded}/issues`,
              {
                params: {
                  state,
                  assignee_username,
                  per_page: requestedPerPage,
                  order_by: "updated_at",
                  sort: "desc",
                },
              }
            ))
          );
        } else {
          let page = 1;
          const batchSize = 100;

          while (issues.length < requestedPerPage) {
            const batch = await gitlabRequest<Issue[]>(
              `/projects/${project.encoded}/issues`,
              {
                params: {
                  state,
                  assignee_username,
                  per_page: batchSize,
                  page,
                  order_by: "updated_at",
                  sort: "desc",
                },
              }
            );

            if (batch.length === 0) {
              break;
            }

            for (const issue of batch) {
              if (issueHasAllRequestedLabels(issue.labels, requestedLabels)) {
                issues.push(issue);
              }

              if (issues.length >= requestedPerPage) {
                break;
              }
            }

            if (batch.length < batchSize) {
              break;
            }

            page += 1;
          }
        }

        if (issues.length === 0) {
          const filters = [`state="${state}"`];
          if (requestedLabels.length > 0) {
            filters.push(`labels="${requestedLabels.join(", ")}"`);
          }
          if (assignee_username) {
            filters.push(`assignee="${assignee_username}"`);
          }
          return textResult(`No issues found with ${filters.join(", ")}.`);
        }

        const lines = issues.map((issue) => {
          const assignees = issue.assignees.map((a) => a.username).join(", ") || "unassigned";
          return [
            `### Issue #${issue.iid}: ${issue.title}`,
            `- **State:** ${issue.state}`,
            `- **Author:** ${issue.author.username}`,
            `- **Assignees:** ${assignees}`,
            `- **Labels:** ${issue.labels.join(", ") || "none"}`,
            `- **Milestone:** ${issue.milestone?.title ?? "none"}`,
            `- **Updated:** ${issue.updated_at}`,
            `- **URL:** ${issue.web_url}`,
          ].join("\n");
        });

        return {
          content: [
            {
              type: "text",
              text: [
                `## Issues (${state})`,
                "",
                `**Project:** ${project.raw}`,
                ...(resolvedLabelMappings.length > 0
                  ? [
                      `**Labels filter:** ${resolvedLabelMappings
                        .map((mapping) =>
                          mapping.requested === mapping.resolved
                            ? mapping.resolved
                            : `${mapping.requested} -> ${mapping.resolved}`
                        )
                        .join(", ")} (resolved to exact project labels)`,
                    ]
                  : []),
                "",
                lines.join("\n\n"),
              ].join("\n"),
            },
          ],
        };
      }

      // ── get_issue ────────────────────────────────────────────────────────
      case "get_issue": {
        const { project: projectArg } = args as { project?: string };
        const iid = getNumericIdentifier(args as Record<string, unknown>, ["iid", "issue", "ticket"], "Issue IID");
        const project = await resolveProject(projectArg, { persist: false });
        let resolvedProject = project;
        let issue: Issue;

        try {
          issue = await gitlabRequest<Issue>(`/projects/${project.encoded}/issues/${iid}`);
        } catch (error) {
          if (isGitLabStatusError(error, 404) && projectArg) {
            const matches = await findIssueInMatchingProjects(projectArg, iid, project.raw);

            if (matches.length === 1) {
              resolvedProject = matches[0].project;
              issue = matches[0].issue;
            } else if (matches.length > 1) {
              return textResult(
                `Issue #${iid} was not found in ${project.raw}, but it exists in multiple matching projects: ${matches
                  .map((match) => match.project.raw)
                  .join(", ")}. Pass the full namespace/path.`
              );
            } else {
              return textResult(
                `Issue #${iid} was not found in ${project.raw}. If you meant a different matching project, pass the full namespace/path explicitly.`
              );
            }
          } else if (isGitLabStatusError(error, 404)) {
            return textResult(
              `Issue #${iid} was not found in the active project ${project.raw}. If you meant another repository, pass \`project\` explicitly or call \`select_project\` first.`
            );
          } else {
            throw error;
          }
        }

        setActiveProject(resolvedProject);

        // Fetch Work Item status in parallel (best-effort — REST API doesn't expose it)
        const workItemStatus = await fetchWorkItemStatus(resolvedProject.raw, iid);

        return {
          content: [
            {
              type: "text",
              text: renderIssueDetails(issue!, resolvedProject, workItemStatus?.status ?? null),
            },
          ],
        };
      }

      // ── get_issue_comments ───────────────────────────────────────────────
      case "get_issue_comments": {
        const { project: projectArg } = args as { project?: string };
        const iid = getNumericIdentifier(args as Record<string, unknown>, ["iid", "issue", "ticket"], "Issue IID");
        const project = await resolveProject(projectArg, { persist: false });
        let resolvedProject = project;

        try {
          await gitlabRequest<Issue>(`/projects/${project.encoded}/issues/${iid}`);
        } catch (error) {
          if (isGitLabStatusError(error, 404) && projectArg) {
            const matches = await findIssueInMatchingProjects(projectArg, iid, project.raw);

            if (matches.length === 1) {
              resolvedProject = matches[0].project;
            } else if (matches.length > 1) {
              return textResult(
                `Issue #${iid} was not found in ${project.raw}, but it exists in multiple matching projects: ${matches
                  .map((match) => match.project.raw)
                  .join(", ")}. Pass the full namespace/path.`
              );
            } else {
              return textResult(
                `Issue #${iid} was not found in ${project.raw}. If you meant a different matching project, pass the full namespace/path explicitly.`
              );
            }
          } else if (isGitLabStatusError(error, 404)) {
            return textResult(
              `Issue #${iid} was not found in the active project ${project.raw}. If you meant another repository, pass \`project\` explicitly or call \`select_project\` first.`
            );
          } else {
            throw error;
          }
        }

        setActiveProject(resolvedProject);

        const notes = await gitlabRequest<Note[]>(
          `/projects/${resolvedProject.encoded}/issues/${iid}/notes`,
          { params: { sort: "asc", order_by: "created_at", per_page: 100 } }
        );

        const userNotes = notes.filter((n) => !n.system);

        if (userNotes.length === 0) {
          return textResult(`No comments on issue #${iid} yet.`);
        }

        const lines = userNotes.map((n) =>
          `**${n.author.username}** (${n.created_at}):\n${n.body}`
        );

        return {
          content: [
            {
              type: "text",
              text: `## Comments on Issue #${iid}\n\n**Project:** ${resolvedProject.raw}\n\n${lines.join("\n\n---\n\n")}`,
            },
          ],
        };
      }

      // ── add_issue_comment ────────────────────────────────────────────────
      case "add_issue_comment": {
        const { project: projectArg, body } = args as { project?: string; body: string };
        const iid = getNumericIdentifier(args as Record<string, unknown>, ["iid", "issue", "ticket"], "Issue IID");
        const project = await resolveProject(projectArg, { persist: true });
        const auditedBody = addAiAuditHeader(body, request.params._meta) ?? body;

        const note = await gitlabRequest<CreatedNote>(
          `/projects/${project.encoded}/issues/${iid}/notes`,
          { method: "POST", body: { body: auditedBody } }
        );

        return textResult(
          `✅ Comment posted on issue #${iid} in ${project.raw} by ${note.author.username} at ${note.created_at} (note ID: ${note.id}).`
        );
      }

      // ── update_issue ─────────────────────────────────────────────────────
      case "update_issue": {
        const {
          project: projectArg,
          title,
          description,
          labels,
          add_labels,
          remove_labels,
          assignee_ids,
          due_date,
          weight,
          state_event,
        } = args as {
          project?: string;
          title?: string;
          description?: string;
          labels?: string;
          add_labels?: string;
          remove_labels?: string;
          assignee_ids?: number[];
          due_date?: string;
          weight?: number;
          state_event?: "close" | "reopen";
        };

        const iid = getNumericIdentifier(args as Record<string, unknown>, ["iid", "issue", "ticket"], "Issue IID");
        const project = await resolveProject(projectArg, { persist: true });
        const hasUpdates = [
          title,
          description,
          labels,
          add_labels,
          remove_labels,
          assignee_ids,
          due_date,
          weight,
          state_event,
        ].some(hasDefinedValue);

        if (!hasUpdates) {
          throw new McpError(
            ErrorCode.InvalidParams,
            "No issue updates were provided. Pass at least one field such as `title`, `description`, `labels`, `assignee_ids`, `due_date`, `weight`, or `state_event`."
          );
        }

        const auditedDescription = addAiAuditHeader(description, request.params._meta);

        const issue = await gitlabRequest<Issue>(
          `/projects/${project.encoded}/issues/${iid}`,
          {
            method: "PUT",
            body: {
              title,
              description: auditedDescription,
              labels,
              add_labels,
              remove_labels,
              assignee_ids,
              due_date,
              weight,
              state_event,
            },
          }
        );

        return {
          content: [
            {
              type: "text",
              text: [
                `✅ Issue updated in **${project.raw}**: **#${issue.iid} — ${issue.title}**`,
                `- **State:** ${issue.state}`,
                `- **Labels:** ${issue.labels.join(", ") || "none"}`,
                `- **Updated:** ${issue.updated_at}`,
                `- **URL:** ${issue.web_url}`,
              ].join("\n"),
            },
          ],
        };
      }

      // ── list_work_item_statuses ───────────────────────────────────────────
      case "list_work_item_statuses": {
        const { project: projectArg, per_page = 100 } = args as {
          project?: string;
          per_page?: number;
        };
        const project = await resolveProject(projectArg, { persist: true });
        const limit = normalizePerPage(per_page, 100);

        const query = `
          query ListWorkItemStatuses($fullPath: ID!, $first: Int!) {
            project(fullPath: $fullPath) {
              workItems(first: $first) {
                nodes {
                  iid
                  title
                  state
                  widgets {
                    ... on WorkItemWidgetStatus {
                      status {
                        name
                      }
                    }
                  }
                }
              }
            }
          }
        `;

        const data = await gitlabGraphQL<{
          project: {
            workItems: {
              nodes: Array<{
                iid: string;
                title: string;
                state: string;
                widgets: Array<{ status?: { name: string } }>;
              }>;
            } | null;
          } | null;
        }>(query, { fullPath: project.raw, first: limit });

        const nodes = data?.project?.workItems?.nodes ?? [];

        if (nodes.length === 0) {
          return textResult(`No work items found in ${project.raw}.`);
        }

        const lines = nodes.map((item) => {
          const statusWidget = item.widgets.find(
            (w): w is { status: { name: string } } => "status" in w && w.status != null
          );
          const status = statusWidget?.status.name ?? "_(not set)_";
          return `| #${item.iid} | ${item.title} | ${item.state} | ${status} |`;
        });

        return textResult(
          [
            `## Work Item Statuses`,
            ``,
            `**Project:** ${project.raw}`,
            `**Total:** ${nodes.length} work items`,
            ``,
            `| IID | Title | State | Work Item Status |`,
            `|---|---|---|---|`,
            ...lines,
          ].join("\n")
        );
      }

      // ── get_issue_status ─────────────────────────────────────────────────
      case "get_issue_status": {
        const { project: projectArg } = args as { project?: string };
        const iid = getNumericIdentifier(args as Record<string, unknown>, ["iid", "issue", "ticket"], "Issue IID");
        const project = await resolveProject(projectArg, { persist: false });

        const statusInfo = await gitlabGraphQL<{
          project: {
            workItems: {
              nodes: Array<{
                iid: string;
                title: string;
                widgets: Array<{ status?: { name: string } }>;
              }>;
            } | null;
          } | null;
        }>(WORK_ITEM_STATUS_QUERY, { fullPath: project.raw, iids: [String(iid)] });

        const workItem = statusInfo?.project?.workItems?.nodes?.[0];

        if (!workItem) {
          return textResult(
            `Work item #${iid} was not found in ${project.raw} via the GraphQL Work Items API. Make sure the issue exists and the Work Items feature is enabled for this project.`
          );
        }

        const statusWidget = workItem.widgets.find(
          (w): w is { status: { name: string } } => "status" in w && w.status != null
        );

        const statusName = statusWidget?.status.name ?? null;

        return textResult(
          [
            `## Work Item Status for #${iid}: ${workItem.title}`,
            "",
            `**Project:** ${project.raw}`,
            `**Work Item Status:** ${statusName ?? "_(no status set — the Status widget may not be enabled for this project)_"}`,
          ].join("\n")
        );
      }

      // ── create_issue ─────────────────────────────────────────────────────
      case "create_issue": {
        const { project: projectArg, title, description, labels, assignee_ids } = args as {
          project?: string;
          title: string;
          description?: string;
          labels?: string;
          assignee_ids?: number[];
        };
        const project = await resolveProject(projectArg, { persist: true });
        const auditedDescription = addAiAuditHeader(description, request.params._meta);

        const issue = await gitlabRequest<Issue>(
          `/projects/${project.encoded}/issues`,
          {
            method: "POST",
            body: {
              title,
              description: auditedDescription,
              labels,
              assignee_ids,
            },
          }
        );

        return {
          content: [
            {
              type: "text",
              text: [
                `✅ Issue created in **${project.raw}**: **#${issue.iid} — ${issue.title}**`,
                `- **State:** ${issue.state}`,
                `- **Labels:** ${issue.labels.join(", ") || "none"}`,
                `- **URL:** ${issue.web_url}`,
              ].join("\n"),
            },
          ],
        };
      }

      // ── get_file_contents ─────────────────────────────────────────────────
      case "get_file_contents": {
        const { project: projectArg, file_path, ref = "main" } = args as {
          project?: string;
          file_path: string;
          ref?: string;
        };
        const project = await resolveProject(projectArg, { persist: true });

        const file = await gitlabRequest<FileContent>(
          `/projects/${project.encoded}/repository/files/${encodeURIComponent(file_path)}`,
          { params: { ref } }
        );

        const content =
          file.encoding === "base64"
            ? Buffer.from(file.content, "base64").toString("utf-8")
            : file.content;

        return {
          content: [
            {
              type: "text",
              text: [
                `## \`${file.file_path}\` @ \`${file.ref}\``,
                `- **Project:** ${project.raw}`,
                `- **Size:** ${file.size} bytes`,
                `- **Last commit:** ${file.last_commit_id.slice(0, 8)}`,
                "",
                "```",
                content,
                "```",
              ].join("\n"),
            },
          ],
        };
      }

      // ── list_branches ─────────────────────────────────────────────────────
      case "list_branches": {
        const { project: projectArg, search, per_page = 20 } = args as {
          project?: string;
          search?: string;
          per_page?: number;
        };
        const project = await resolveProject(projectArg, { persist: true });

        const branches = await gitlabRequest<Branch[]>(
          `/projects/${project.encoded}/repository/branches`,
          { params: { search, per_page, order_by: "updated", sort: "desc" } }
        );

        if (branches.length === 0) {
          return textResult("No branches found.");
        }

        const lines = branches.map((b) => {
          const flags = [
            b.default ? "default" : null,
            b.protected ? "protected" : null,
            b.merged ? "merged" : null,
          ]
            .filter(Boolean)
            .join(", ");

          return [
            `- **\`${b.name}\`**${flags ? ` (${flags})` : ""}`,
            `  Last commit: ${b.commit.short_id} — "${b.commit.title}" (${b.commit.committed_date})`,
          ].join("\n");
        });

        return {
          content: [
            {
              type: "text",
              text: `## Branches\n\n**Project:** ${project.raw}\n\n${lines.join("\n")}`,
            },
          ],
        };
      }

      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
  } catch (error) {
    if (error instanceof McpError && error.code !== ErrorCode.MethodNotFound) {
      return textResult(error.message);
    }
    if (error instanceof McpError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new McpError(ErrorCode.InternalError, `Unexpected error: ${message}`);
  }
});

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(
    `GitLab MCP server running (active project: ${activeProject?.raw ?? "none"}, base: ${GITLAB_BASE_URL})\n`
  );
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
