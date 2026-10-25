import {
  ensureWorkspaceAndStore,
  getDefaultStoreRoot,
} from "../engine/recoveryEngine";
import {
  loadProjectsRegistry,
  resolveProjectWorkspace,
} from "../engine/projectManager";
import { validateProjectId, SecurityError } from "../security/boundaries";

/**
 * Returns canonical paths for workspace and application data storage.
 * Workspace and snapshot store are isolated from each other.
 * Supports multi-project workspace selection with strict existence validation.
 */
export function getContextRoots(projectId?: string) {
  const storeRoot = getDefaultStoreRoot();
  const registry = loadProjectsRegistry(storeRoot);

  if (projectId) {
    validateProjectId(projectId);
    if (!registry.projects[projectId] && projectId !== "demo-workspace") {
      throw new SecurityError(`Project '${projectId}' does not exist.`);
    }
  }

  const targetProjectId = projectId || registry.activeProjectId || "demo-workspace";
  const workspaceRoot = resolveProjectWorkspace(targetProjectId, storeRoot);

  // Ensure initialized
  ensureWorkspaceAndStore(workspaceRoot, storeRoot);

  return { workspaceRoot, storeRoot, projectId: targetProjectId };
}
