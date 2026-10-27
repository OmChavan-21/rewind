export type ChatRole = "user" | "assistant" | "system";

export interface ChatMessage {
  id: string;
  sessionId: string;
  projectId: string;
  userId: string;
  role: ChatRole;
  content: string;
  reasoning?: string;
  proposalId?: string;
  containsCoreIntent?: boolean;
  tokenUsage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  createdAt: string;
}

export interface ChatSession {
  id: string;
  projectId: string;
  userId: string;
  title: string;
  activeModel: string;
  routingMode: "auto" | "manual";
  messageCount: number;
  extractedMemoriesCount: number;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string;
}

export interface CreateChatSessionRequest {
  projectId: string;
  title?: string;
  model?: string;
  routingMode?: "auto" | "manual";
}

export interface PostChatMessageRequest {
  sessionId: string;
  projectId: string;
  content: string;
  role?: ChatRole;
  reasoning?: string;
  proposalId?: string;
  tokenUsage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}
