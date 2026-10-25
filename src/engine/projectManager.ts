import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { ProjectMetadata, CreateProjectRequest, ProjectSummary } from "../types/project";
import type { Snapshot } from "../types/recovery";
import { getDefaultWorkspaceRoot, getDefaultStoreRoot, ensureWorkspaceAndStore } from "./recoveryEngine";
import { initializeDemoWorkspace } from "./demoWorkspace";
import { getDirectorySizeBytes } from "../security/limits";
import { listStoredSnapshots, atomicWriteFileSync } from "./storage";
import { SecurityError } from "../security/boundaries";

export const DEFAULT_PROJECT_ID = "demo-workspace";

interface ProjectsRegistry {
  projects: Record<string, ProjectMetadata>;
  activeProjectId: string;
}

function getProjectsRegistryPath(storeRoot: string): string {
  return path.join(storeRoot, "projects.json");
}

/**
 * Loads the project registry or creates initial registry including the default demo-workspace.
 */
export function loadProjectsRegistry(storeRoot: string = getDefaultStoreRoot()): ProjectsRegistry {
  const registryFile = getProjectsRegistryPath(storeRoot);
  const defaultWorkspaceRoot = getDefaultWorkspaceRoot();

  // Ensure default workspace is initialized
  ensureWorkspaceAndStore(defaultWorkspaceRoot, storeRoot);

  const defaultDirStats = getDirectorySizeBytes(defaultWorkspaceRoot);
  const defaultSnapshots = listStoredSnapshots(storeRoot);

  const defaultProject: ProjectMetadata = {
    id: DEFAULT_PROJECT_ID,
    name: "Demo Project (NVIDIA Recovery)",
    description: "Sample workspace containing agent workflow, runtime config, and evaluator.",
    createdAt: "2026-10-15T00:00:00.000Z",
    updatedAt: new Date().toISOString(),
    workspacePath: defaultWorkspaceRoot,
    fileCount: defaultDirStats.fileCount,
    totalSizeBytes: defaultDirStats.totalBytes,
    snapshotCount: defaultSnapshots.length,
    status: "active",
    isDefault: true,
  };

  if (!fs.existsSync(registryFile)) {
    const initial: ProjectsRegistry = {
      projects: { [DEFAULT_PROJECT_ID]: defaultProject },
      activeProjectId: DEFAULT_PROJECT_ID,
    };
    atomicWriteFileSync(registryFile, JSON.stringify(initial, null, 2));
    return initial;
  }

  try {
    const raw = fs.readFileSync(registryFile, "utf-8");
    const parsed: ProjectsRegistry = JSON.parse(raw);

    // Ensure default project is always present and updated
    if (!parsed.projects[DEFAULT_PROJECT_ID]) {
      parsed.projects[DEFAULT_PROJECT_ID] = defaultProject;
    } else {
      parsed.projects[DEFAULT_PROJECT_ID].fileCount = defaultDirStats.fileCount;
      parsed.projects[DEFAULT_PROJECT_ID].totalSizeBytes = defaultDirStats.totalBytes;
      parsed.projects[DEFAULT_PROJECT_ID].snapshotCount = defaultSnapshots.length;
    }

    if (!parsed.activeProjectId || !parsed.projects[parsed.activeProjectId]) {
      parsed.activeProjectId = DEFAULT_PROJECT_ID;
    }

    return parsed;
  } catch {
    const fallback: ProjectsRegistry = {
      projects: { [DEFAULT_PROJECT_ID]: defaultProject },
      activeProjectId: DEFAULT_PROJECT_ID,
    };
    atomicWriteFileSync(registryFile, JSON.stringify(fallback, null, 2));
    return fallback;
  }
}

/**
 * Saves the project registry atomically.
 */
export function saveProjectsRegistry(registry: ProjectsRegistry, storeRoot: string = getDefaultStoreRoot()): void {
  const registryFile = getProjectsRegistryPath(storeRoot);
  atomicWriteFileSync(registryFile, JSON.stringify(registry, null, 2));
}

/**
 * Resolves the absolute workspace path for any project ID safely.
 */
export function resolveProjectWorkspace(projectId: string, storeRoot: string = getDefaultStoreRoot()): string {
  if (!projectId || projectId === DEFAULT_PROJECT_ID) {
    return getDefaultWorkspaceRoot();
  }

  // Sanitize project ID
  if (!/^[a-zA-Z0-9_-]+$/.test(projectId)) {
    throw new SecurityError(`Invalid project ID format: '${projectId}'`);
  }

  const projectsDir = path.join(storeRoot, "projects", projectId);
  const workspaceDir = path.join(projectsDir, "workspace");

  if (!fs.existsSync(workspaceDir)) {
    fs.mkdirSync(workspaceDir, { recursive: true });
  }

  return workspaceDir;
}

/**
 * Lists all registered projects with up-to-date stats.
 */
export function listProjects(storeRoot: string = getDefaultStoreRoot()): ProjectSummary {
  const registry = loadProjectsRegistry(storeRoot);
  const projectsList: ProjectMetadata[] = [];

  for (const project of Object.values(registry.projects)) {
    const workspacePath = resolveProjectWorkspace(project.id, storeRoot);
    const stats = getDirectorySizeBytes(workspacePath);
    const projectSnapshots = listProjectSnapshots(project.id, storeRoot);

    projectsList.push({
      ...project,
      workspacePath,
      fileCount: stats.fileCount,
      totalSizeBytes: stats.totalBytes,
      snapshotCount: projectSnapshots.length,
    });
  }

  // Sort default first, then descending by createdAt
  projectsList.sort((a, b) => {
    if (a.isDefault) return -1;
    if (b.isDefault) return 1;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });

  return {
    projects: projectsList,
    activeProjectId: registry.activeProjectId,
    totalProjects: projectsList.length,
  };
}

/**
 * Gets details for a single project.
 */
export function getProject(projectId: string, storeRoot: string = getDefaultStoreRoot()): ProjectMetadata | null {
  const registry = loadProjectsRegistry(storeRoot);
  const proj = registry.projects[projectId];
  if (!proj) return null;

  const workspacePath = resolveProjectWorkspace(projectId, storeRoot);
  const stats = getDirectorySizeBytes(workspacePath);
  const projectSnapshots = listProjectSnapshots(projectId, storeRoot);

  return {
    ...proj,
    workspacePath,
    fileCount: stats.fileCount,
    totalSizeBytes: stats.totalBytes,
    snapshotCount: projectSnapshots.length,
  };
}

/**
 * Creates a new isolated project workspace.
 */
export function createProject(
  request: CreateProjectRequest,
  storeRoot: string = getDefaultStoreRoot()
): ProjectMetadata {
  const registry = loadProjectsRegistry(storeRoot);

  const name = (request.name || "").trim();
  if (!name) {
    throw new SecurityError("Project name is required.");
  }
  if (name.length > 80) {
    throw new SecurityError("Project name must not exceed 80 characters.");
  }

  // Generate safe project ID
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30);
  const uniqueId = `proj_${slug || "workspace"}_${crypto.randomBytes(3).toString("hex")}`;

  const workspaceDir = resolveProjectWorkspace(uniqueId, storeRoot);

  // If template is demo, seed initial sample files
  if (request.template === "demo") {
    initializeDemoWorkspace(workspaceDir);
  } else {
    // Empty template: create a starter README
    const starterReadme = `# ${name}\n\n${request.description || "Created with Rewind."}\n\nWorkspace initialized: ${new Date().toISOString()}\n`;
    fs.writeFileSync(path.join(workspaceDir, "README.md"), starterReadme, "utf-8");
  }

  const stats = getDirectorySizeBytes(workspaceDir);

  const newProject: ProjectMetadata = {
    id: uniqueId,
    name,
    description: request.description?.trim(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    workspacePath: workspaceDir,
    fileCount: stats.fileCount,
    totalSizeBytes: stats.totalBytes,
    snapshotCount: 0,
    status: "active",
  };

  registry.projects[uniqueId] = newProject;
  registry.activeProjectId = uniqueId;
  saveProjectsRegistry(registry, storeRoot);

  return newProject;
}

/**
 * Sets the active project.
 */
export function setActiveProject(projectId: string, storeRoot: string = getDefaultStoreRoot()): ProjectMetadata {
  const registry = loadProjectsRegistry(storeRoot);
  if (!registry.projects[projectId]) {
    throw new SecurityError(`Project '${projectId}' does not exist.`);
  }

  registry.activeProjectId = projectId;
  saveProjectsRegistry(registry, storeRoot);
  return registry.projects[projectId];
}

/**
 * Lists snapshots associated with a specific project.
 */
export function listProjectSnapshots(projectId: string, storeRoot: string = getDefaultStoreRoot()): Snapshot[] {
  const allSnapshots = listStoredSnapshots(storeRoot);
  return allSnapshots.filter((snap) => {
    // If snapshot.workspaceId matches or if checking default demo workspace
    if (projectId === DEFAULT_PROJECT_ID) {
      return snap.workspaceId === DEFAULT_PROJECT_ID || !snap.workspaceId;
    }
    return snap.workspaceId === projectId;
  });
}
