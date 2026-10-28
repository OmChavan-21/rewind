# Rewind — Public GitHub Publishing & Vercel Preview Deployment Report

**Date:** October 28, 2026  
**Repository Working Copy:** `C:\Rewind\rewind-security`  
**Master Checkout:** Untouched (`C:\Rewind\rewind` on `master` protected)  
**Public GitHub Repository:** [https://github.com/OmChavan-21/rewind](https://github.com/OmChavan-21/rewind)  
**Vercel Project:** `rewind-preview`  

---

## 1. Final Branch and Commit

- **Branch:** `security-hardening`
- **Current HEAD Commit:** `3681476`
- **Commit Message:** `docs(readme): sanitize local path link to relative firestore rules reference`
- **Key Parent Commits:**
  - `07fb8ed`: `feat(storage): implement Firestore-backed file storage with 256KB chunking for Spark plan preview`
  - `930dd90`: `fix(c2): complete pre-deployment safety gate with transactional snapshot recovery, route rate limiting, AI disabled mode, and session entropy checks`
  - `ba49077`: `fix(audit): reconcile all 30 routes with async project access, add strict distributed rate limit fail-closed guard, and enhance cloud snapshot rollback cleanup`
- **Working Tree State:** Clean (`git status` reports working tree clean, all files tracked and committed).

---

## 2. Public GitHub Security Audit Results

A full, multi-phase secret and privacy scan was performed on the repository prior to publishing:

### 2.1 Tracked File Audit
- **Ignored Files:** `.env.local`, `.env*.local`, `.next/`, `.rewind_store/`, `.vercel/`, `node_modules/`, `*.pem`, `*.key`, `*.tsbuildinfo` are strictly verified in [`.gitignore`](file:///C:/Rewind/rewind-security/.gitignore).
- **Service Account Files:** Zero Google Service Account JSON files or credentials are tracked in Git.
- **Environment Template:** Checked [`.env.example`](file:///C:/Rewind/rewind-security/.env.example). All entries are blank strings (`""`) or generic placeholder strings. `AI_PROVIDER="disabled"` is set by default.
- **Documentation Sanitization:** Audited [`README.md`](file:///C:/Rewind/rewind-security/README.md), [`OPERATIONS_GUIDE.md`](file:///C:/Rewind/rewind-security/OPERATIONS_GUIDE.md), [`VERCEL_MIGRATION_PLAN.md`](file:///C:/Rewind/rewind-security/VERCEL_MIGRATION_PLAN.md), and [`FIREBASE.md`](file:///C:/Rewind/rewind-security/FIREBASE.md). Fixed an internal local file link (`file:///c:/Rewind/...`) to a relative path [`./firestore.rules`](file:///C:/Rewind/rewind-security/firestore.rules). Confirmed that all API keys and emails in documentation are descriptive placeholders (e.g., `<AIzaSy...YourClientApiKey>`).

### 2.2 Git History Secret Audit
- Scanned entire commit history (`git log -S` and patch analysis) for:
  - Google / Firebase API keys (`AIzaSy...`)
  - Private keys (`-----BEGIN PRIVATE KEY-----` / `-----BEGIN RSA PRIVATE KEY-----`)
  - NVIDIA API keys (`nvapi-...`)
  - OpenAI / Third-party keys (`sk-...`)
  - GitHub personal access tokens (`ghp_...`, `github_pat_...`)
  - AWS access keys (`AKIA...`)
  - Firebase project identifiers (`rewind-0`)
- **Findings:** Zero live credentials, private keys, or actual secrets have ever been committed into the Git history of `security-hardening`. All historical matches in Git diffs were documentation placeholders or test assertions verifying that keys are masked.

---

## 3. Untracked Firestore Storage Adapter Audit

An exhaustive technical review of [`src/server/storage/firestoreStorageBucket.ts`](file:///C:/Rewind/rewind-security/src/server/storage/firestoreStorageBucket.ts) and its integration with [`src/server/storage/cloudStorageAdapter.ts`](file:///C:/Rewind/rewind-security/src/server/storage/cloudStorageAdapter.ts) was conducted:

### 3.1 Completeness & Contract Adherence
- **Contract Fulfillment:** Correctly and fully implements the `StorageBucket` and `StorageFile` interfaces used by `CloudStorageAdapter` (`file()`, `getFiles()`, `save()`, `download()`, `delete()`, `exists()`).
- **File Representation:** Uses a parent metadata document in `storage_files` collection and a subcollection `chunks` (`storage_files/{encodedKey}/chunks/{chunkIndex}`).
- **Key Encoding:** Arbitrary file paths (e.g. `projects/p1/workspace/src/app.ts`) are safely encoded via reversible `base64url` (`encodeStorageKey` / `decodeStorageKey`), avoiding illegal Firestore document ID characters and subpath routing issues.

### 3.2 1 MiB Document Limit Safety & Chunking
- **Chunk Size:** Enforces bounded `256 KB` (`262,144` bytes) binary chunks.
- **Document Payload:** Base64 encoding expands a 256 KB chunk to ~341.3 KB, well below the Firestore 1,048,576-byte (1 MiB) per-document hard ceiling (~35% utilization).
- **Integrity Verification:** Calculates and stores SHA-256 hashes on both the overall file level and per-chunk level. Downloads verify chunk-by-chunk and full-file checksums, failing closed with HTTP 500 if corruption or tampering is detected.
- **Stale Chunk Cleanup:** When overwriting an existing file with smaller content, any leftover higher-index chunk documents from prior writes are explicitly deleted.

### 3.3 Multi-Tenant Isolation & Ownership
- Tenant workspace isolation is enforced at both the path namespace level (`projects/{projectId}/workspace/...` and `projects/{projectId}/snapshots/{snapshotId}/files/...`) and through `assertProjectOwnership(projectId, userId)` in `CloudStorageAdapter`.
- Cross-tenant file reads, writes, and snapshot restorations strictly reject unauthorized users with HTTP 403 Forbidden.

### 3.4 Integration & Environment Behavior
- **Is `STORAGE_DRIVER=firestore` Genuine?**  
  **No.** `STORAGE_DRIVER` was merely a proposed variable in a prior report; it was never recognized in code.
- **Actual Semantic Resolution:**  
  In [`src/server/storage/cloudStorageAdapter.ts`](file:///C:/Rewind/rewind-security/src/server/storage/cloudStorageAdapter.ts), `getBucket()` dynamically inspects `FIREBASE_STORAGE_BUCKET`.
  - If `FIREBASE_STORAGE_BUCKET` is configured with an explicit bucket, it attempts Google Cloud Storage.
  - If `FIREBASE_STORAGE_BUCKET` is omitted or empty (the default on Firebase Spark free tier), it automatically and safely routes to `FirestoreStorageBucket(db)`.
  - Zero Cloud Storage buckets, zero Blaze billing upgrades, and zero credit card fees are required.

---

## 4. Files Changed and Tests Added

1. **`src/server/storage/firestoreStorageBucket.ts`** (Added):  
   Core Firestore-backed bucket adapter with bounded 256 KB chunking, reversible base64url path keys, SHA-256 verification, and chunk cleanup.
2. **`src/server/storage/cloudStorageAdapter.ts`** (Updated):  
   Integrated `FirestoreStorageBucket` fallback when `FIREBASE_STORAGE_BUCKET` is omitted; reinforced `assertProjectOwnership` across workspace and snapshot operations.
3. **`.env.example`** (Updated):  
   Documented optional status of `FIREBASE_STORAGE_BUCKET` and automatic Spark-plan Firestore fallback.
4. **`README.md`** (Updated):  
   Sanitized file links to standard relative Markdown paths.
5. **`tests/phaseC3FirestoreStorage.test.ts`** (Added):  
   428-line comprehensive test suite covering:
   - Chunking boundaries (0-byte handling, multi-chunk >256 KB files, 1 MB max size enforcement)
   - SHA-256 chunk tampering detection and stale chunk cleanup on file shrinkage
   - Full workspace read, write, list, and delete operations via `CloudStorageAdapter`
   - Strict cross-tenant isolation and 403 authorization guards
   - Multi-file snapshot creation, full workspace restore, post-snapshot rogue file cleanup, and transactional rollback

---

## 5. Verification Results (Test, Lint, Build, Audit)

| Verification Stage | Command Executed | Result | Details |
| :--- | :--- | :--- | :--- |
| **Unit & Integration Tests** | `npm test` (`tsx --test tests/**/*.test.ts`) | **PASS (246/246)** | 246 passed across 45 suites (including 9 Phase C.3 Firestore storage tests). 0 failed, 0 skipped. |
| **Code Quality & Lint** | `npm run lint` (`eslint`) | **PASS (0 errors, 0 warnings)** | Clean exit code 0. |
| **Next.js Production Build** | `npm run build` (`next build`) | **PASS** | Turbopack compilation succeeded; all 32 dynamic and static API/page routes built cleanly with TypeScript type-checking. |
| **Security Audit** | `npm audit` | **PASS (0 vulnerabilities)** | Found 0 vulnerabilities. |

---

## 6. GitHub Push Result and Branch URL

- **Remote:** `origin` (`https://github.com/OmChavan-21/rewind.git`)
- **Target Branch:** `security-hardening` (pushed as a separate branch)
- **Main Branch Status:** `main` (initial commit `9f39292`) was untouched and preserved. No force-pushes or merges into `main` occurred.
- **GitHub Push Output:**
  ```
  To https://github.com/OmChavan-21/rewind.git
   * [new branch]      security-hardening -> security-hardening
  branch 'security-hardening' set up to track 'origin/security-hardening'.
  ```
- **Public Branch URL:**  
  [https://github.com/OmChavan-21/rewind/tree/security-hardening](https://github.com/OmChavan-21/rewind/tree/security-hardening)
- **Pull Request Creation URL:**  
  [https://github.com/OmChavan-21/rewind/pull/new/security-hardening](https://github.com/OmChavan-21/rewind/pull/new/security-hardening)

---

## 7. Vercel Preview Deployment & Live Verification

### 7.1 Deployment Details
- **Project:** `rewind-preview` (Team: `ommoney8055-5075s-projects`)
- **Deployment ID:** `dpl_5MmSnUps1g1Qef2RwxkvvcmkJMd4`
- **Inspect URL:** [https://vercel.com/ommoney8055-5075s-projects/rewind-preview/5MmSnUps1g1Qef2RwxkvvcmkJMd4](https://vercel.com/ommoney8055-5075s-projects/rewind-preview/5MmSnUps1g1Qef2RwxkvvcmkJMd4)
- **Live Preview URL:** [https://rewind-preview-ocw9wtz7v-ommoney8055-5075s-projects.vercel.app](https://rewind-preview-ocw9wtz7v-ommoney8055-5075s-projects.vercel.app)
- **Deployment Status:** `READY`

### 7.2 Pre-Configured Vercel Environment Variables
The following safe, non-secret and generated security parameters were configured directly on Vercel:

| Variable Name | Environment | Value / Status | Purpose |
| :--- | :--- | :--- | :--- |
| `AI_PROVIDER` | Preview & Production | `"disabled"` | Prohibits outbound LLM API calls; avoids charges |
| `AUTH_SESSION_SECRET` | Preview & Production | Generated 64-char hex | High-entropy HMAC signing key for sessions |
| `FIREBASE_PROJECT_ID` | Preview & Production | `"rewind-0"` | Connects to existing Firebase project |
| `REQUIRE_DISTRIBUTED_RATE_LIMIT`| Preview & Production | `"false"` | Allows in-memory sliding-window rate limiting |

### 7.3 Live Smoke Tests
Smoke tests were executed live against the deployment using `vercel curl` with deployment bypass authentication:

1. **Dashboard UI (`GET /`):**  
   **HTTP 200 OK.** Returned full React DOM with meta headers, styling, and navigation.
2. **AI Status (`GET /api/ai/status`):**  
   **HTTP 200 OK.** Correctly reported AI provider unconfigured/disabled (`AI_PROVIDER=disabled`). Outbound charges are completely prevented.
3. **System Limits & Memory (`GET /api/system/limits`):**  
   **HTTP 200 OK.** Responded with active system quotas, low memory pressure (91% system free), and Firebase connection inspection:
   ```json
   {
     "projectId": "rewind-0",
     "firebaseStatus": {
       "configured": true,
       "state": "failed",
       "projectId": "rewind-0",
       "clientEmail": "",
       "message": "Failed to initialize Firebase Admin SDK. Please check credentials formatting."
     }
   }
   ```
   *Note: This status confirms `FIREBASE_PROJECT_ID` was read successfully by the serverless function, and is gracefully failing closed until service account credentials are added.*

---

## 8. Exact Vercel Environment Configuration Still Required

To enable live Firebase Authentication and durable Cloud Firestore persistence on the preview deployment, the following 3 environment variables must be added in the **Vercel Project Dashboard** (`Settings -> Environment Variables`):

1. **`FIREBASE_CLIENT_EMAIL`**
   - **Value:** The service account email from Firebase Console (`Project Settings -> Service Accounts -> Firebase Admin SDK`).
   - **Example:** `firebase-adminsdk-xxxxx@rewind-0.iam.gserviceaccount.com`
   - **Target Environments:** Preview, Production

2. **`FIREBASE_PRIVATE_KEY`**
   - **Value:** The private key string from the downloaded service account JSON file.
   - **Format:** Including `-----BEGIN PRIVATE KEY-----` and `-----END PRIVATE KEY-----`. Newlines should be escaped as `\n`.
   - **Target Environments:** Preview, Production

3. **`NEXT_PUBLIC_FIREBASE_API_KEY`**
   - **Value:** The Web API Key found in `Firebase Console -> Project Settings -> General -> Web API Key`.
   - **Target Environments:** Preview, Production

*(Do NOT configure `FIREBASE_STORAGE_BUCKET`. Leaving it unset instructs Rewind to automatically use the Firestore storage adapter with 256 KB chunking on the Spark free plan, completely bypassing Firebase Cloud Storage and Blaze billing.)*

---

## 9. Known Limitations & Next Actions

### Known Limitations
1. **Python Subprocess AST Diagnostics on Vercel:**  
   Next.js serverless functions running on Vercel use minimal Node.js runtimes where `python3` is not bundled. Python syntax diagnostics automatically fall back to static text pattern checks.
2. **Local Windows Symlink Error in Vercel CLI:**  
   Running `vercel build` locally on Windows fails with `EPERM` unless run as Administrator or in Developer Mode because Vercel CLI attempts to create symlinks in `.vercel/output/`. However, remote cloud deployments (`vercel deploy` and GitHub Git integrations) build cleanly on Linux containers without this issue.
3. **1 MB File Size Limit in Firestore Storage:**  
   The Firestore storage adapter chunks files up to Rewind's maximum workspace file limit of 1 MiB (`1,048,576` bytes). Files larger than 1 MiB are rejected with HTTP 400.

### Next Action for Developer
1. Go to the **Vercel Dashboard** for `rewind-preview` (`Settings -> Environment Variables`).
2. Add `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`, and `NEXT_PUBLIC_FIREBASE_API_KEY` for Preview and Production.
3. Test logging in and uploading files at:  
   [https://rewind-preview-ocw9wtz7v-ommoney8055-5075s-projects.vercel.app](https://rewind-preview-ocw9wtz7v-ommoney8055-5075s-projects.vercel.app)
