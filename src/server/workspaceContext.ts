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
  const cloudStorageRequired =
    process.env.REQUIRE_CLOUD_STORAGE === "true" ||
    process.env.REWIND_STORAGE_PROVIDER === "cloud" ||
    (process.env.NODE_ENV === "production" && process.env.REWIND_ALLOW_LOCAL_STORAGE_IN_PROD !== "true");

  // In cloud mode, Firestore is the source of truth for project ownership and
  // existence. The local project registry does not contain cloud-created IDs.
  if (projectId && !cloudStorageRequired) {
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
