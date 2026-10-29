/**
 * Authentication and authorization types for Rewind.
 */

export type UserRole = "admin" | "developer" | "viewer";

export interface AuthUser {
  uid: string;
  email: string;
  displayName: string;
  photoURL?: string | null;
  role: UserRole;
  activeProjectId?: string;
  creditAllowance: number;
  creditsUsed: number;
  createdAt: string;
  updatedAt: string;
  authProvider: "firebase" | "development" | "google" | "github";
  emailVerified?: boolean;
}

export interface AuthSession {
  userId: string;
  email: string;
  role: UserRole;
  expiresAt: number;
  createdAt: number;
  authProvider: "firebase" | "development" | "google" | "github";
}

export interface RegisterRequest {
  email: string;
  password: string;
  displayName?: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface ForgotPasswordRequest {
  email: string;
}

export interface ForgotPasswordResponse {
  success: boolean;
  message: string;
}

export interface ResetPasswordRequest {
  oobCode: string;
  newPassword: string;
}

export interface ResetPasswordResponse {
  success: boolean;
  message: string;
  email?: string;
}

export interface AuthResponse {
  user: AuthUser;
  token?: string;
}
