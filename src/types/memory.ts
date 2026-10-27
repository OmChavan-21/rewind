export type MemoryCategory =
  | "project_intent"
  | "architectural_decision"
  | "technical_constraint"
  | "resolved_pattern";

export interface ProjectMemory {
  id: string;
  projectId: string;
  userId: string;
  sourceSessionId?: string;
  sourceMessageId?: string;
  category: MemoryCategory;
  title: string;
  distilledIntent: string;
  importance: number; // 1 to 5
  tags: string[];
  isActive: boolean;
  supersededBy?: string;
  createdAt: string;
  updatedAt: string;
}

export interface UserGlobalMemory {
  id: string;
  userId: string;
  category: "coding_preference" | "general_rule" | "tooling";
  title: string;
  content: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface MemoryExtractionResult {
  extractedMemories: ProjectMemory[];
  skippedReason?: string;
}
