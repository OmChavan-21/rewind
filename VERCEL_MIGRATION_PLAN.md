# Rewind — Vercel Serverless Architecture & Migration Plan

This plan establishes the architecture and phased roadmap for deploying **Rewind** onto **Vercel Serverless (Node.js)** while transitioning off persistent local disk storage to durable cloud backends (Firebase/Firestore & Object Storage).

---

## 1. API Route Compatibility Audit

Rewind consists of 30 API route files (32 distinct endpoints). In a Vercel serverless environment:
- The function root filesystem (`/var/task`) is strictly **read-only**.
- Only `/tmp` is writable (ephemeral 512MB–1024MB scratchpad, wiped when containers recycle, isolated per instance).
- Processes cannot assume shared memory across requests or instances.

### Route-by-Route Vercel Compatibility Matrix

| Category | Routes / Endpoints | Current Backend | Vercel Serverless Status | Required Migration / Changes |
| :--- | :--- | :--- | :--- | :--- |
| **Authentication** | `POST /api/auth/register`<br>`POST /api/auth/login`<br>`POST /api/auth/logout`<br>`GET /api/auth/me`<br>`POST /api/auth/google` | Firebase Admin SDK + Auth cookies (dev fallback uses `.rewind_store`) | **Compatible** (Node.js Functions) | In production, operates 100% via Firebase REST & Admin SDK. Ensure local dev user fallback is disabled in prod. Distributed rate-limiting recommended for edge scalability. |
| **System & AI Status** | `GET /api/ai/status`<br>`GET /api/system/limits` | In-memory config + local disk stats | **Compatible with adaptations** | `api/ai/status` runs cleanly. `api/system/limits` requires adapting disk measurement to report Cloud Storage/Firestore usage rather than local disk. |
| **Audit Logging** | `GET /api/audit` | Append-only `.rewind_store/audit/history.jsonl` | **Requires Backend Migration** | Local file append is ephemeral on Vercel. Migrate to Firestore collection `audit_logs` (scoped by `userId` and `projectId`). |
| **Chat & Membrane** | `GET/POST /api/chat/sessions`<br>`GET/DELETE /api/chat/sessions/[id]`<br>`GET/POST /api/chat/messages`<br>`GET/POST /api/projects/[id]/memories` | Dual-write: `.rewind_store/projects/[id]/` + Firestore sync | **Requires Backend Migration** | Switch Firestore from a secondary sync target to the **primary source of truth**. Remove local JSON file writes. Runs purely in Vercel Node.js functions. |
| **Project Registry** | `GET/POST /api/projects`<br>`GET/DELETE /api/projects/[id]` | `.rewind_store/projects.json` + local folders | **Requires Backend Migration** | Migrate project registry to Firestore (`users/{userId}/projects/{projectId}`). Directory creation on disk replaced with Object Storage prefixes. |
| **Workspace Files** | `GET /api/workspace`<br>`GET /api/workspace/files`<br>`GET /api/workspace/file`<br>`POST /api/workspace/upload` | Reads/writes local directory `projects/<id>/workspace/` | **Requires Backend Migration** | Migrate workspace files to **Object Storage** (e.g., Firebase Cloud Storage or AWS S3 / Vercel Blob). Reading and multipart uploads interact directly with bucket APIs or presigned URLs. |
| **Snapshots & Rollback** | `GET/POST /api/snapshots`<br>`GET /api/snapshots/[id]`<br>`POST /api/snapshots/[id]/restore` | `.rewind_store/snapshots/<id>/` (files & metadata) | **Requires Backend Migration** | Snapshot metadata moves to Firestore (`projects/{id}/snapshots/{snapshotId}`). File archives stored as immutable `.tar.gz` in Object Storage. Restoration copies archive over live bucket prefix. |
| **Code Diagnostics & Invariants** | `GET /api/workspace/diagnostics`<br>`POST /api/actions/validate`<br>`POST /api/actions/demo-break`<br>`POST /api/actions/modify` | TypeScript Compiler API + Invariants + Python subprocess | **Partially Compatible** | TypeScript AST (`ts.createSourceFile`) and JSON parsing run in-process on Vercel. Python subprocess (`python -c "import ast..."`) fails on default Vercel Node.js images where Python is not pre-installed (safely falls back to static scanner). For full native Python AST, requires an external worker or Wasm engine. |
| **AI Proposals & Repair** | `POST /api/ai/propose`<br>`POST /api/ai/apply` | LLM invocation + staging sandbox (`os.tmpdir()`) + credit accounting | **Requires Backend Migration** | AI provider remains disabled unless explicitly configured. Staging sandbox can run in ephemeral `/tmp`, downloading files from Object Storage for the single request. Credit accounting must migrate from local JSON + in-memory map to atomic Firestore transactions. |
| **RAG Knowledge Base** | `POST /api/rag/ask`<br>`GET /api/rag/documents`<br>`POST /api/rag/ingest` | `.rewind_store/vectors/[id].json` + PDF parse | **Requires Backend Migration** | PDF parsing runs in Node.js. Vector storage must migrate to Firestore (using Firestore Vector Search or document subcollection) rather than local vector files. |

---

## 2. Inventory of Ephemeral State & Non-Persistent Dependencies

To transition to Vercel serverless without data loss or corruption, every instance of stateful local storage must be addressed:

1. **Local Filesystem Paths (`.rewind_store/` & `projects/`):**
   - `src/engine/recoveryEngine.ts`: Root paths `getDefaultStoreRoot()` and `getDefaultWorkspaceRoot()`.
   - `src/engine/storage.ts`: `atomicWriteFileSync`, `saveSnapshotRecord`, `ensureStoreLayout`.
   - `src/engine/projectManager.ts`: `loadProjectsRegistry`, `saveProjectsRegistry`, `resolveProjectWorkspace`.
   - `src/engine/chatMemoryStore.ts`: `loadSessionsMap`, `saveSessionsMap`, `loadProjectMemories`.
   - `src/server/ragService.ts`: `saveRAGStore`, `loadRAGStore`.
   - `src/server/ai/dualAccounting.ts`: `readProjectCreditStore`, `writeProjectCreditStore`.
2. **Synchronous Python Subprocesses:**
   - `src/engine/pythonValidator.ts`: `spawnSync("python", ...)` / `spawnSync("python3", ...)`. Vercel standard Node.js runtimes do not bundle the Python runtime.
3. **In-Memory Concurrency Locks & Maps:**
   - `src/server/ai/dualAccounting.ts`: `taskLedger` (prevents double deductions) and `activeReservations` (in-flight credit reservation locking). These do not persist across serverless instances and will cause race conditions under parallel lambdas.
   - `src/server/ragService.ts`: `activeRAGJobs` and `queuedRAGChunks` counters.
4. **Rate Limiting:**
   - `src/security/rateLimiter.ts`: `rateLimitStore = new Map()`. Per-instance sliding window in memory. On Vercel, requests are distributed across multiple function instances, diluting rate limits unless backed by Upstash Redis or Vercel KV.

---

## 3. Target Serverless Architecture

```
                   ┌──────────────────────────────────────────────┐
                   │               Vercel Edge / CDN              │
                   └──────────────────────┬───────────────────────┘
                                          │
                                          ▼
                   ┌──────────────────────────────────────────────┐
                   │        Vercel Serverless Functions           │
                   │               (Next.js 16)                   │
                   │                                              │
                   │  - Firebase Auth / Session Cookie Check      │
                   │  - CSRF Header Verification                  │
                   │  - TypeScript Compiler API (In-Process)      │
                   │  - Security Content Scanner & Invariants     │
                   │  - Ephemeral /tmp Staging Sandbox            │
                   └──────────┬───────────────────┬───────────────┘
                              │                   │
               Firestore Data │                   │ Object Storage
               (Metadata API) │                   │ (Source Code / Files)
                              ▼                   ▼
    ┌───────────────────────────────┐   ┌───────────────────────────────┐
    │     Google Cloud Firestore    │   │  Firebase / GCS Cloud Storage │
    │                               │   │                               │
    │  - users/{uid}                │   │  projects/{pid}/workspace/*   │
    │  - projects/{pid}             │   │  projects/{pid}/snapshots/*.gz│
    │  - chat_sessions & messages   │   │  projects/{pid}/documents/*   │
    │  - memories (Memory Membrane) │   └───────────────────────────────┘
    │  - audit_logs (isolated)      │
    │  - credits (atomic txn)       │
    │  - rag_vectors & chunks       │
    └───────────────────────────────┘
```

### Durable Storage Components
1. **Google Cloud Firestore (Document & Metadata Database):**
   - **Authentication & User Profile:** Already wired via `src/server/auth.ts`.
   - **Project Metadata:** `users/{userId}/projects/{projectId}`.
   - **Conversation & Memory Membrane:** `users/{userId}/projects/{projectId}/chat_sessions` and `memories`.
   - **Audit Trail:** Append-only documents in `users/{userId}/projects/{projectId}/audit_logs`.
   - **Credit Accounting:** Atomic updates using `firestore.runTransaction()` to guarantee single-charge and prevent race conditions without in-memory locks.
2. **Firebase Cloud Storage / Google Cloud Storage (File & Snapshot Storage):**
   - Reuses existing Firebase project credentials (`FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`).
   - Bucket layout:
     - `projects/{projectId}/workspace/{relativeFilePath}` for live project code files.
     - `projects/{projectId}/snapshots/{snapshotId}.tar.gz` for immutable rollback archives.
   - Files are fetched into `/tmp/rewind-stage-<uuid>` only during active analysis/staging, then immediately cleaned up.
3. **Execution Sandbox Strategy for Python Validation:**
   - **Tier 1 (Zero-Infrastructure Fallback):** Safe static syntax scanning in TypeScript (already active in `pythonValidator.ts` when Python is absent).
   - **Tier 2 (Serverless Worker):** A standalone Google Cloud Run container or AWS Lambda running Python 3.11 with `ast.parse()`, invoked over authenticated HTTPS only when native AST deep validation is enabled.

---

## 4. Preservation of Security Controls

The migration preserves all existing security invariants:
1. **Firebase Authentication:** Server-side verification of official 7-day session cookies (`getAuth().verifySessionCookie(cookie, false)`).
2. **Fail-Closed Production:** Local developer authentication remains strictly forbidden in production (`isFirebaseRequired()` rejects local auth).
3. **CSRF Defenses:** Origin and Referer header verification enforced on mutating requests (`POST`, `PUT`, `DELETE`).
4. **Tenant Isolation:** Enforced via `assertProjectAccess` checking ownership in Firestore rules and bucket paths.
5. **Approval Gates:** AI proposals remain non-destructive candidates requiring explicit user review before `api/ai/apply`.
6. **Immutable Snapshots:** Pre-change snapshots committed to Object Storage before applying file modifications, guaranteeing instant rollback.
7. **AI Providers:** Kept strictly disabled by default (`NVIDIA_API_KEY` unconfigured, `NEBIUS_API_KEY` inactive). Zero paid model calls.

---

## 5. Phased Migration Plan

### Phase A — Vercel-Compatible Deployment Preparation (Current)
- [x] Inspect all API routes for serverless constraints.
- [x] Inventory all filesystem, subprocess, lock, and credit storage dependencies.
- [x] Update `src/engine/pythonValidator.ts` to attempt `python` and `python3`, with graceful ENOENT fallback for environments without Python.
- [x] Update `src/security/limits.ts` to honor `process.env.REWIND_STORE_DIR` and `process.env.REWIND_WORKSPACE_DIR`.
- [x] Create comprehensive Vercel serverless migration architecture document (`VERCEL_MIGRATION_PLAN.md`).
- [x] Verify tests pass (209 passing), linting is clean (0 errors), and production build succeeds.

### Phase B — Durable Storage & Execution Migration
- [ ] Implement a Storage Provider abstraction (`IProjectStorage`, `ISnapshotStorage`) supporting both Local Disk (for local development/testing) and Cloud Storage (for Vercel production).
- [ ] Migrate `chatMemoryStore.ts` to read directly from Firestore when Firebase credentials are present, bypassing local `.rewind_store`.
- [ ] Migrate `projectManager.ts` to read/write project metadata in Firestore.
- [ ] Migrate `dualAccounting.ts` to execute credit balance updates inside atomic Firestore transactions (`runTransaction`).
- [ ] Migrate audit logging to Firestore collection `audit_logs`.
- [ ] Implement Cloud Storage bucket adapter for workspace file upload, listing, and download.

### Phase C — Security Verification & Preview Deployment
- [ ] Write integration test suite verifying Firestore + Cloud Storage adapter under simulated serverless conditions (separate processes, zero shared disk).
- [ ] Connect a private Vercel Preview environment without public exposure or custom domains.
- [ ] Verify environment variables in Vercel Project Settings (Firebase Web API Key, Firebase Admin credentials, Session Secret).
- [ ] Validate end-to-end user registration, login, project creation, file upload, chat session persistence, and snapshot restoration in the Vercel Preview deployment.

### Phase D — Production Go-Live
- [ ] Obtain explicit user approval before configuring production domains or DNS.
- [ ] Configure custom domain in Vercel with automated SSL.
- [ ] Enable Upstash Redis or Vercel KV for edge rate limiting across lambda instances.
- [ ] Verify production fail-closed behavior, Firestore security rules, and backup schedule.

---

## 6. Required Environment Variables for Vercel

```ini
# Runtime
NODE_ENV=production
REWIND_ALLOW_LOCAL_AUTH_IN_PROD=false
SESSION_SECRET=<64+ character random hex string: openssl rand -hex 32>

# Firebase Client SDK (Public credentials used in browser)
NEXT_PUBLIC_FIREBASE_API_KEY=<Your Firebase Web API Key>
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=<project-id>.firebaseapp.com
NEXT_PUBLIC_FIREBASE_PROJECT_ID=<project-id>
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=<project-id>.appspot.com
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=<Sender ID>
NEXT_PUBLIC_FIREBASE_APP_ID=<Firebase App ID>

# Firebase Admin SDK (Serverless Function credentials)
FIREBASE_PROJECT_ID=<project-id>
FIREBASE_CLIENT_EMAIL=firebase-adminsdk-xxxxx@<project-id>.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC...\n-----END PRIVATE KEY-----\n"
FIREBASE_STORAGE_BUCKET=<project-id>.appspot.com

# Optional Python AST Execution Worker (for deep Python AST checks)
# PYTHON_VALIDATOR_URL=https://<worker-url>/validate

# AI Provider Configuration (Disabled by default)
# NVIDIA_API_KEY=
# NEBIUS_API_KEY=
```
