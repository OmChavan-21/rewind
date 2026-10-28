/**
 * Multi-project management types for Rewind.
 */

export interface ProjectMetadata {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
  workspacePath: string;
  fileCount: number;
  totalSizeBytes: number;
  snapshotCount: number;
  status: "active" | "archived";
  isDefault?: boolean;
  userId?: string;
}

export interface CreateProjectRequest {
  name: string;
  description?: string;
  template?: "empty" | "demo";
}

export interface ProjectSummary {
  projects: ProjectMetadata[];
  activeProjectId: string;
  totalProjects: number;
}
