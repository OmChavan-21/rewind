import type { ProjectMetadata } from "../types/project";
import type { Snapshot } from "../types/recovery";
import type { RAGDocument } from "../types/rag";

export interface FirebaseConnectionStatus {
  configured: boolean;
  state: "connected" | "unconfigured" | "failed";
  projectId?: string;
  clientEmail?: string;
  message: string;
}

// In-memory or fallback admin reference
let firestoreDbInstance: unknown = null;

function sanitizeEnvVal(val?: string): string {
  if (!val) return "";
  let cleaned = val.trim();
  if (
    (cleaned.startsWith('"') && cleaned.endsWith('"')) ||
    (cleaned.startsWith("'") && cleaned.endsWith("'"))
  ) {
    cleaned = cleaned.slice(1, -1).trim();
  }
  return cleaned;
}

/**
 * Initializes Firebase Admin SDK server-side if environment variables are provided.
 * Never exposes credentials to client.
 */
export async function getFirestoreDb(): Promise<unknown | null> {
  const projectId = sanitizeEnvVal(process.env.FIREBASE_PROJECT_ID);
  const clientEmail = sanitizeEnvVal(process.env.FIREBASE_CLIENT_EMAIL);
  const rawKey = sanitizeEnvVal(process.env.FIREBASE_PRIVATE_KEY);

  if (!projectId || (!clientEmail && !process.env.GOOGLE_APPLICATION_CREDENTIALS)) {
    return null;
  }

  if (firestoreDbInstance) {
    return firestoreDbInstance;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const admin = require("firebase-admin");

    if (!admin.apps.length) {
      const privateKey = rawKey ? rawKey.replace(/\\n/g, "\n") : undefined;

      const credential = privateKey && clientEmail
        ? admin.credential.cert({
            projectId,
            clientEmail,
            privateKey,
          })
        : admin.credential.applicationDefault();

      admin.initializeApp({
        credential,
        projectId,
      });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    firestoreDbInstance = (admin as any).firestore();
    return firestoreDbInstance;
  } catch (err) {
    console.error("[Firebase Admin Initialization Error]:", err);
    return null;
  }
}

/**
 * Checks Firebase connection status.
 */
export async function checkFirebaseStatus(): Promise<FirebaseConnectionStatus> {
  const projectId = sanitizeEnvVal(process.env.FIREBASE_PROJECT_ID);
  const clientEmail = sanitizeEnvVal(process.env.FIREBASE_CLIENT_EMAIL);

  if (!projectId) {
    return {
      configured: false,
      state: "unconfigured",
      message:
        "Firebase is not configured. Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, and FIREBASE_PRIVATE_KEY in .env.local to enable cloud Firestore persistence.",
    };
  }

  try {
    const db = await getFirestoreDb();
    if (!db) {
      return {
        configured: true,
        state: "failed",
        projectId,
        clientEmail,
        message: "Failed to initialize Firebase Admin SDK. Please check credentials formatting.",
      };
    }

    return {
      configured: true,
      state: "connected",
      projectId,
      clientEmail,
      message: `Connected to Cloud Firestore (Project: ${projectId}).`,
    };
  } catch (err) {
    return {
      configured: true,
      state: "failed",
      projectId,
      clientEmail,
      message: `Firebase error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Persists project metadata to Firestore: users/{userId}/projects/{projectId}
 */
export async function syncProjectToFirebase(
  userId: string = "default_user",
  project: ProjectMetadata
): Promise<boolean> {
  try {
    const db = await getFirestoreDb();
    if (!db) return false;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userRef = (db as any).collection("users").doc(userId);
    const projectRef = userRef.collection("projects").doc(project.id);

    await projectRef.set(
      {
        ...project,
        syncedAt: new Date().toISOString(),
      },
      { merge: true }
    );
    return true;
  } catch (err) {
    console.error("[Firebase syncProject Error]:", err);
    return false;
  }
}

/**
 * Persists snapshot metadata to Firestore: users/{userId}/projects/{projectId}/snapshots/{snapshotId}
 */
export async function syncSnapshotToFirebase(
  userId: string = "default_user",
  projectId: string,
  snapshot: Snapshot
): Promise<boolean> {
  try {
    const db = await getFirestoreDb();
    if (!db) return false;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const snapshotRef = (db as any)
      .collection("users")
      .doc(userId)
      .collection("projects")
      .doc(projectId)
      .collection("snapshots")
      .doc(snapshot.id);

    await snapshotRef.set({
      id: snapshot.id,
      workspaceId: snapshot.workspaceId,
      name: snapshot.name,
      description: snapshot.description,
      createdAt: snapshot.createdAt,
      totalFiles: snapshot.totalFiles,
      totalBytes: snapshot.totalBytes,
      syncedAt: new Date().toISOString(),
    });
    return true;
  } catch (err) {
    console.error("[Firebase syncSnapshot Error]:", err);
    return false;
  }
}

/**
 * Persists document metadata to Firestore: users/{userId}/projects/{projectId}/documents/{documentId}
 */
export async function syncDocumentToFirebase(
  userId: string = "default_user",
  projectId: string,
  document: RAGDocument
): Promise<boolean> {
  try {
    const db = await getFirestoreDb();
    if (!db) return false;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const docRef = (db as any)
      .collection("users")
      .doc(userId)
      .collection("projects")
      .doc(projectId)
      .collection("documents")
      .doc(document.id);

    await docRef.set({
      ...document,
      syncedAt: new Date().toISOString(),
    });
    return true;
  } catch (err) {
    console.error("[Firebase syncDocument Error]:", err);
    return false;
  }
}
