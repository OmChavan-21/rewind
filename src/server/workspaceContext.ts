import {
  ensureWorkspaceAndStore,
  getDefaultStoreRoot,
} from "../engine/recoveryEngine";
import {
  loadProjectsRegistry,
  resolveProjectWorkspace,
} from "../engine/projectManager";

/**
 * Returns canonical paths for workspace and application data storage.
 * Workspace and snapshot store are isolated from each other.
 * Supports multi-project workspace selection.
 */
export function getContextRoots(projectId?: string) {
  const storeRoot = getDefaultStoreRoot();
  const registry = loadProjectsRegistry(storeRoot);

  const targetProjectId = projectId || registry.activeProjectId || "demo-workspace";
  const workspaceRoot = resolveProjectWorkspace(targetProjectId, storeRoot);

  // Ensure initialized
  ensureWorkspaceAndStore(workspaceRoot, storeRoot);

  return { workspaceRoot, storeRoot, projectId: targetProjectId };
}
