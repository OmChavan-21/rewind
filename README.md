# Rewind — AI Agent Reliability, Recovery & Knowledge Platform

> **NVIDIA × Nebius Global AI Hackathon**  
> **Phase 1: Deterministic Recovery Engine & Developer Dashboard**  
> **Phase 2: Real NVIDIA Nemotron Integration via Nebius Token Factory**  
> **Phase 3: Multi-Project Workspaces, File Uploads, AST Error Diagnostics, Firebase & RAG**

**Rewind** is an agent reliability, recovery, and safety platform designed for autonomous AI systems. When autonomous coding or workflow agents execute multi-step tool calls, unexpected errors, invalid syntax modifications, or safety policy violations can leave workspaces corrupted.

Rewind provides a safe, local, deterministic snapshot-based recovery engine coupled with **real NVIDIA open-source models** (Nemotron 30B/70B/120B), multi-project workspace isolation, safe file uploads with conflict protection, non-executing AST error diagnostics, and a cited RAG semantic knowledge base.

---

## What's New in this Release

### 1. File Uploads with Pre-Change Safety Snapshots
- **Visible "Upload Files" Button** located directly in the Workspace Files view, Project header, and RAG Knowledge tab.
- **Drag-and-Drop & Multi-Select Modal**: Upload code files (`.ts`, `.tsx`, `.js`, `.json`, `.md`, etc.) and PDF documentation (`.pdf`).
- **Conflict-Aware Overwrite Protection**: If an uploaded file already exists, Rewind returns `409 Conflict` and requires explicit user confirmation before replacing files.
- **Automatic Pre-Upload Safety Snapshot**: An immutable snapshot is captured immediately before writing any uploaded file to disk.
- **Automatic RAG Ingestion**: Uploaded documents and code can be automatically indexed into the vector knowledge base.

### 2. Code Diagnostics & Error Visibility Engine
- **Non-Executing Static AST Analysis**: Uses the TypeScript Compiler API (`ts.createSourceFile`) to inspect source files without executing untrusted code on the server.
- **Precise Error Localization**: Pinpoints exact file paths, line numbers, column numbers, severity (`error`, `warning`, `info`), diagnostic rule IDs, and actionable remediation suggestions.
- **JSON Syntax & Structure Diagnostics**: Fast parser detecting syntax issues, misplaced commas, and unquoted keys.
- **Deterministic Invariant Checks**: Continuously validates workspace blueprint invariants.
- **Dedicated Diagnostics Panel**: Searchable, filterable by severity, with direct file viewer links and one-click **Rerun Diagnostics**.

### 3. Multi-Project Management & Workspace Isolation
- **Project Switcher & Modal**: Create and manage multiple isolated projects (`ProjectManagerModal.tsx`).
- **Workspace Sandboxing**: Each project workspace is isolated under `.rewind_store/projects/<projectId>/workspace/` or the root `demo-workspace/`. Operations in one project cannot access or overwrite files in another.
- **Persistent Project Registry**: Stored securely in `.rewind_store/projects.json`.
- **Project-Scoped Snapshots**: Snapshots are tagged with project IDs, ensuring restores and comparisons only affect the intended workspace.

### 4. Immutable Snapshot Vault & Disk Layout
- Snapshots are saved to `.rewind_store/snapshots/<snapshotId>/`:
  - `snapshot.json`: Contains snapshot ID, project ID, timestamp, trigger action, total bytes, and file inventory with SHA-256 hashes.
  - `files/`: Contains exact, immutable byte backups of every permitted file in the workspace at that point in time.
- Pre-change checkpoints are created automatically before file uploads, AI modifications, demo breaks, and restores.

### 5. Cloud Firestore Database Integration
- **Server-Only `firebase-admin` Integration**: Uses Cloud Firestore for optional cloud persistence of project metadata, audit trails, and document states.
- **Database Schema**:
  - `users/{userId}/projects/{projectId}`
  - `users/{userId}/projects/{projectId}/snapshots/{snapshotId}`
  - `users/{userId}/projects/{projectId}/audit/{actionId}`
  - `users/{userId}/projects/{projectId}/documents/{documentId}`
- **Production Security Rules**: Configured in [`firestore.rules`](file:///c:/Rewind/rewind/firestore.rules) enforcing strict user-scoped ownership (`request.auth.uid == userId`).
- **Safe Local Fallback**: When Firebase environment variables are unconfigured, Rewind operates entirely in local filesystem mode without errors.

### 6. RAG Semantic Knowledge Base & Vector Pipeline
- **Document Text & PDF Extraction**: Parses source code, Markdown, text, and PDF documents into clean, normalized text (`pdf-parse`).
- **Semantic Chunking**: Splits documents into ~500 character chunks with 100 character overlaps and page metadata.
- **High-Dimensional Vector Embeddings**: Generates unit-normalized vectors with exact cosine similarity matching (`cosineSimilarity`).
- **Zero-Dependency Local Fallback**: Deterministic tokenized projection embedding engine allows full offline search without remote API keys. Optional NVIDIA/OpenAI `/embeddings` support via `ENABLE_REMOTE_EMBEDDINGS="true"`.
- **Project-Scoped Vector Store**: Stored in `.rewind_store/vectors/{projectId}.json`.
- **Context Augmentation & Anti-Injection**: Bounded prompt assembly with delimiter guards and cited answer synthesis using NVIDIA Nemotron.

### 7. Centralized Resource Limits & 5-Tier Memory Metrics
- **Centralized Quotas** (`src/security/limits.ts`):
  - Max code file: 1 MB
  - Max PDF/document: 10 MB
  - Max upload batch: 10 files / 25 MB
  - Max project storage: 100 MB
  - Max snapshots per project: 50
  - Max AI context window: 20 files / 200 KB
- **5-Tier Memory Model**:
  1. *Browser Memory*: Client V8 heap for React DOM, diff viewers, and state stores.
  2. *Server Heap*: Node.js process memory for file buffers and AST parsing.
  3. *Local Disk Storage*: Persistent workspaces and snapshot archives in `.rewind_store/`.
  4. *Cloud Firestore Storage*: Cloud NoSQL document storage for projects and audit records.
  5. *External LLM Quotas*: NVIDIA NIM / Nebius token budgets and rate limits.

---

## Project Structure

```
rewind/
├── src/
│   ├── types/
│   │   ├── recovery.ts            # Recovery engine types (Workspace, Snapshot, FileChange, etc.)
│   │   ├── ai.ts                  # AI proposal & status types
│   │   ├── project.ts             # Multi-project metadata & registry types
│   │   ├── diagnostics.ts         # Code diagnostic items & summaries
│   │   ├── limits.ts              # Resource limits & 5-tier memory metrics
│   │   └── rag.ts                 # RAG document, chunk, vector result, and Q&A types
│   ├── security/
│   │   ├── boundaries.ts          # Path traversal protection, symlink checks, allowlists
│   │   └── limits.ts              # Centralized limits enforcement & memory measurement
│   ├── engine/
│   │   ├── recoveryEngine.ts      # Core snapshot, restore, validation, and safe write engine
│   │   ├── projectManager.ts      # Multi-project workspace isolation & registry
│   │   ├── codeDiagnostics.ts     # Static TypeScript AST analysis & JSON parser diagnostics
│   │   ├── textExtractor.ts       # Text & PDF extraction with semantic chunking
│   │   ├── storage.ts             # Atomic file writes, SHA-256 hashing, .rewind_store manager
│   │   ├── validator.ts           # Deterministic invariant validator
│   │   └── demoWorkspace.ts       # Sample agent workspace initializer
│   ├── server/
│   │   ├── workspaceContext.ts    # Multi-project workspace path resolver
│   │   ├── ragService.ts          # Vector store, cosine similarity, search & grounded Q&A
│   │   ├── firebaseService.ts     # Cloud Firestore persistence & connection status
│   │   ├── nebiusService.ts       # NVIDIA Nemotron client & proposal parser
│   │   └── proposalExecution.ts   # Trusted execution engine with pre-snapshots
│   ├── components/                # Modular developer UI
│   │   ├── Sidebar.tsx            # Navigation tabs (Files, Diagnostics, RAG, AI, Snapshots, Settings)
│   │   ├── TopBar.tsx             # Active project switcher, health badge, action triggers
│   │   ├── FileExplorer.tsx       # Permitted file tree, upload button, live code viewer
│   │   ├── UploadModal.tsx        # Drag-and-drop file upload with overwrite conflict confirmation
│   │   ├── DiagnosticsPanel.tsx   # AST error inspector with severity badges and code snippets
│   │   ├── RAGPanel.tsx           # Document knowledge base, top-K search, cited Nemotron answers
│   │   ├── ProjectManagerModal.tsx# Create and switch isolated project workspaces
│   │   ├── AIAssistantPanel.tsx   # Proposal generator, diff comparator, rollback
│   │   ├── SnapshotHistory.tsx    # Snapshot vault with disk metrics & compare triggers
│   │   ├── DiffViewer.tsx         # Side-by-side unified diff comparison
│   │   ├── TimelinePanel.tsx      # Chronological audit stream
│   │   └── SettingsPanel.tsx      # Resource limits, 5-tier memory explanation, Firebase status
│   └── app/
│       ├── api/                   # 22 typed server-only Next.js App Router endpoints
│       │   ├── workspace/upload   # Multi-file upload with pre-snapshot & conflict checks
│       │   ├── workspace/diagnostics # AST syntax diagnostics pass
│       │   ├── projects/          # Multi-project CRUD & activation
│       │   ├── rag/               # Document ingestion, list, and semantic Q&A
│       │   ├── system/limits      # Resource limits, memory metrics, Firebase status
│       │   ├── snapshots/         # Snapshot capture, details, and atomic restore
│       │   ├── ai/                # Proposal generation, inspection, and execution
│       │   └── audit/             # Immutable audit event log
│       └── page.tsx               # Main developer dashboard with tabbed views
├── firestore.rules                # Production Cloud Firestore security rules
├── tests/
│   ├── recoveryEngine.test.ts     # 9 snapshot & path traversal tests
│   ├── aiIntegration.test.ts      # 8 AI proposal, conflict, and rollback tests
│   ├── nvidiaDiagnostics.test.ts  # 8 NVIDIA API client & reasoning parser tests
│   └── upgradeFeatures.test.ts    # 20 upload limits, AST, project isolation, RAG, Firebase tests
├── .env.example                   # Environment configuration template
└── README.md
```

---

## Getting Started

### 1. Prerequisites
- **Node.js**: v18.18+ or v20+ (tested on Node.js v24)
- **npm**: v9+

### 2. Installation
```bash
git clone https://github.com/your-org/rewind.git
cd rewind
npm install
```

### 3. Environment Configuration
Copy `.env.example` to `.env.local`:
```bash
cp .env.example .env.local
```

Configure your credentials in `.env.local`:
```env
# NVIDIA API Configuration
AI_PROVIDER="nvidia"
NVIDIA_API_KEY="nvapi-your-key-here"
NVIDIA_MODEL="nvidia/nemotron-3.5-lightning-30b-a3b"

# Optional Cloud Firestore (leave blank for local storage)
FIREBASE_PROJECT_ID=""
FIREBASE_CLIENT_EMAIL=""
FIREBASE_PRIVATE_KEY=""
```

### 4. Running the Development Server
```bash
npm run dev
```
Open [http://localhost:3000](http://localhost:3000) in your browser.

---

## Verification & Automated Test Suite

Run the full automated test suite (45 tests across 9 test suites):

```bash
npm test
```

Run ESLint verification (0 errors, 0 warnings):
```bash
npm run lint
```

Run Next.js 16 production build:
```bash
npm run build
```

---

## Security Guarantees

1. **Path Traversal Protection**: Every input path is sanitized and canonicalized with `resolveAndValidatePath`. Symbolic link traversal and relative directory escapes (`..`) are strictly rejected.
2. **Untrusted Code Isolation**: Uploaded files and diagnostic AST analyses run purely in static analysis mode. Untrusted user code is **never executed** on the server.
3. **Pre-Change Automatic Safety Snapshots**: Before writing any file modification—whether from an AI proposal, demo action, or user file upload—an automatic safety snapshot is persisted.
4. **Conflict-Aware Overwrite Protection**: Uploading a file that already exists returns `409 Conflict` until explicitly confirmed by the user.
5. **No Secret Leaks**: API keys, Firebase service account keys, and private credentials remain strictly server-side and are masked in all status endpoints and audit logs.
