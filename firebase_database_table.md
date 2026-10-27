# Rewind — Database Tables & Columns Specification

This file defines the exact **table names**, **column names**, **data types**, **constraints**, **default values**, and **column descriptions** required to store all user authentication, per-user memory, multi-project workspaces, snapshots, AI proposals, audit logs, dual accounting, and RAG vector search data.

It provides both the **Relational Table View** (compatible with PostgreSQL, Firebase Data Connect, BigQuery) and the **Cloud Firestore Collection Mapping**.

---

## 1. Complete Database Table Inventory

| # | Table Name | Firestore Collection Equivalent | Purpose |
|---|---|---|---|
| 1 | `auth_users` | Firebase Authentication (`users`) | User authentication, identity, credentials & JWT claims |
| 2 | `user_profiles` | `/users/{userId}` | User display metadata, role, credit allowance & active project |
| 3 | `user_memories` | `/users/{userId}/memories/{memoryId}` | Per-user long-term memory, conventions & compiler fix guidelines |
| 4 | `chat_sessions` | `/users/{userId}/sessions/{sessionId}` | Multi-turn conversational sessions with the AI engine |
| 5 | `chat_messages` | `/users/{userId}/sessions/{sessionId}/messages` | Turn-by-turn prompts, reasoning traces, responses & token counts |
| 6 | `projects` | `/users/{userId}/projects/{projectId}` | Isolated multi-project code workspaces |
| 7 | `recovery_snapshots` | `.../projects/{projectId}/snapshots/{snapshotId}` | Rollback safety checkpoints and recovery metadata |
| 8 | `snapshot_files` | Nested inside snapshot document (`files` array) | File inventory with SHA-256 hashes and sizes |
| 9 | `ai_proposals` | `.../projects/{projectId}/proposals/{proposalId}` | AI-generated candidate code modifications and approval state |
| 10 | `proposal_modifications` | Nested inside proposal document (`modifications` array) | File-level modification diffs, replacement content & baseline hashes |
| 11 | `audit_logs` | `.../projects/{projectId}/audit_logs/{actionId}` | Immutable audit trail for all file mutations and recoveries |
| 12 | `credit_ledger` | `.../projects/{projectId}/credit_ledger/{taskId}` | Dual accounting task deduplication, credit charges & provider costs |
| 13 | `rag_documents` | `.../projects/{projectId}/documents/{documentId}` | Codebase files indexed for retrieval-augmented generation |
| 14 | `rag_chunks` | `.../projects/{projectId}/documents/{docId}/chunks` | Text segments with dense vector embeddings |

---

## 2. Table-by-Table Column Specifications

### Table 1: `auth_users`
Manages user authentication and identity credentials.

| Column Name | SQL Data Type | Firestore Type | Constraints | Default | Description |
|---|---|---|---|---|---|
| `id` | `VARCHAR(128)` | `string` | **PRIMARY KEY** | — | Unique user ID (`request.auth.uid`) |
| `email` | `VARCHAR(255)` | `string` | **UNIQUE, NOT NULL** | — | User's verified email address |
| `email_verified` | `BOOLEAN` | `boolean` | **NOT NULL** | `false` | Email verification status |
| `password_hash` | `VARCHAR(255)` | Managed by Auth | **NULLABLE** | `null` | Hashed password (or null if using OAuth) |
| `auth_provider` | `VARCHAR(50)` | `string` | **NOT NULL** | `'password'` | Provider: `'password'`, `'google.com'`, `'github.com'` |
| `created_at` | `TIMESTAMPTZ` | `timestamp` | **NOT NULL** | `CURRENT_TIMESTAMP` | Account registration timestamp |
| `last_login_at` | `TIMESTAMPTZ` | `timestamp` | **NULLABLE** | `null` | Last authentication timestamp |
| `is_disabled` | `BOOLEAN` | `boolean` | **NOT NULL** | `false` | Whether the account is locked/disabled |

---

### Table 2: `user_profiles`
Stores developer profile settings, credit allowances, and active context.

| Column Name | SQL Data Type | Firestore Type | Constraints | Default | Description |
|---|---|---|---|---|---|
| `user_id` | `VARCHAR(128)` | `string` | **PRIMARY KEY, FK (`auth_users.id`)** | — | Foreign key to user account |
| `display_name` | `VARCHAR(150)` | `string` | **NOT NULL** | `''` | Full user display name |
| `photo_url` | `VARCHAR(512)` | `string` | **NULLABLE** | `null` | Profile photo / avatar URL |
| `role` | `VARCHAR(30)` | `string` | **NOT NULL** | `'developer'` | Role: `'admin'`, `'developer'`, `'viewer'` |
| `active_project_id`| `VARCHAR(64)` | `string` | **NOT NULL** | `'demo-workspace'`| Current workspace project pointer |
| `credit_allowance` | `INTEGER` | `number` | **NOT NULL** | `100` | Free Rewind credit allowance cap |
| `credits_used` | `INTEGER` | `number` | **NOT NULL** | `0` | Cumulative credits consumed |
| `created_at` | `TIMESTAMPTZ` | `timestamp` | **NOT NULL** | `CURRENT_TIMESTAMP` | Profile creation timestamp |
| `updated_at` | `TIMESTAMPTZ` | `timestamp` | **NOT NULL** | `CURRENT_TIMESTAMP` | Last profile update timestamp |

---

### Table 3: `user_memories`
Stores per-user long-term memory, learned guidelines, and frequent error repair patterns.

| Column Name | SQL Data Type | Firestore Type | Constraints | Default | Description |
|---|---|---|---|---|---|
| `id` | `VARCHAR(64)` | `string` | **PRIMARY KEY** | — | Memory ID (`mem_{timestamp}_{hash}`) |
| `user_id` | `VARCHAR(128)` | `string` | **NOT NULL, FK (`auth_users.id`)** | — | Owner user reference |
| `project_id` | `VARCHAR(64)` | `string` | **NULLABLE, FK (`projects.id`)** | `null` | Project scope (null = global across projects) |
| `memory_type` | `VARCHAR(40)` | `string` | **NOT NULL** | `'coding_preference'` | `'coding_preference'`, `'frequent_error_fix'`, `'architectural_rule'` |
| `title` | `VARCHAR(200)` | `string` | **NOT NULL** | — | Short memory summary headline |
| `content` | `TEXT` | `string` | **NOT NULL** | — | Detailed memory body injected into prompts |
| `tags` | `TEXT[]` | `array<string>`| **NOT NULL** | `ARRAY[]` | Tags (e.g. `['typescript', 'invariants']`) |
| `confidence` | `REAL` | `number` | **NOT NULL** | `1.0` | Confidence rating (`0.0` to `1.0`) |
| `hit_count` | `INTEGER` | `number` | **NOT NULL** | `0` | Number of times injected into context |
| `created_at` | `TIMESTAMPTZ` | `timestamp` | **NOT NULL** | `CURRENT_TIMESTAMP` | Memory capture timestamp |
| `updated_at` | `TIMESTAMPTZ` | `timestamp` | **NOT NULL** | `CURRENT_TIMESTAMP` | Memory update timestamp |

---

### Table 4: `chat_sessions`
Interactive conversational sessions between user and AI engine.

| Column Name | SQL Data Type | Firestore Type | Constraints | Default | Description |
|---|---|---|---|---|---|
| `id` | `VARCHAR(64)` | `string` | **PRIMARY KEY** | — | Session UUID (`sess_{timestamp}_{hash}`) |
| `user_id` | `VARCHAR(128)` | `string` | **NOT NULL, FK (`auth_users.id`)** | — | Owner user reference |
| `project_id` | `VARCHAR(64)` | `string` | **NOT NULL, FK (`projects.id`)** | — | Workspace project reference |
| `title` | `VARCHAR(255)` | `string` | **NOT NULL** | `'New Conversation'`| Conversation title |
| `active_model` | `VARCHAR(120)` | `string` | **NOT NULL** | — | Active model (e.g. `nvidia/nemotron-3.5-lightning-30b-a3b`) |
| `message_count` | `INTEGER` | `number` | **NOT NULL** | `0` | Total turns in conversation |
| `created_at` | `TIMESTAMPTZ` | `timestamp` | **NOT NULL** | `CURRENT_TIMESTAMP` | Session start time |
| `updated_at` | `TIMESTAMPTZ` | `timestamp` | **NOT NULL** | `CURRENT_TIMESTAMP` | Most recent message time |

---

### Table 5: `chat_messages`
Turn-by-turn prompts, reasoning outputs, and assistant answers.

| Column Name | SQL Data Type | Firestore Type | Constraints | Default | Description |
|---|---|---|---|---|---|
| `id` | `VARCHAR(64)` | `string` | **PRIMARY KEY** | — | Message UUID (`msg_{timestamp}_{hash}`) |
| `session_id` | `VARCHAR(64)` | `string` | **NOT NULL, FK (`chat_sessions.id`)** | — | Parent conversation session |
| `role` | `VARCHAR(20)` | `string` | **NOT NULL** | — | Message role: `'user'`, `'assistant'`, `'system'` |
| `content` | `TEXT` | `string` | **NOT NULL** | — | Prompt markdown or model response text |
| `proposal_id` | `VARCHAR(64)` | `string` | **NULLABLE, FK (`ai_proposals.id`)** | `null` | Associated AI code proposal (if code was produced) |
| `prompt_tokens` | `INTEGER` | `number` | **NOT NULL** | `0` | Input tokens consumed |
| `completion_tokens`| `INTEGER` | `number` | **NOT NULL** | `0` | Output tokens generated |
| `total_tokens` | `INTEGER` | `number` | **NOT NULL** | `0` | Aggregate tokens consumed |
| `created_at` | `TIMESTAMPTZ` | `timestamp` | **NOT NULL** | `CURRENT_TIMESTAMP` | Message timestamp |

---

### Table 6: `projects`
Multi-project workspace containers.

| Column Name | SQL Data Type | Firestore Type | Constraints | Default | Description |
|---|---|---|---|---|---|
| `id` | `VARCHAR(64)` | `string` | **PRIMARY KEY** | — | Project ID (e.g. `proj_recovery_a1b2c3`) |
| `user_id` | `VARCHAR(128)` | `string` | **NOT NULL, FK (`auth_users.id`)** | — | Owner user reference |
| `name` | `VARCHAR(80)` | `string` | **NOT NULL** | — | Project display name |
| `description` | `VARCHAR(255)` | `string` | **NULLABLE** | `null` | Optional project description |
| `workspace_path`| `VARCHAR(512)` | `string` | **NOT NULL** | — | Filesystem workspace folder path |
| `template` | `VARCHAR(20)` | `string` | **NOT NULL** | `'demo'` | Template: `'demo'`, `'empty'` |
| `file_count` | `INTEGER` | `number` | **NOT NULL** | `0` | Number of files in workspace |
| `total_size_bytes`| `BIGINT` | `number` | **NOT NULL** | `0` | Total workspace size in bytes |
| `snapshot_count` | `INTEGER` | `number` | **NOT NULL** | `0` | Total recovery snapshots |
| `status` | `VARCHAR(20)` | `string` | **NOT NULL** | `'active'` | Status: `'active'`, `'archived'` |
| `is_default` | `BOOLEAN` | `boolean` | **NOT NULL** | `false` | True for default demo workspace |
| `created_at` | `TIMESTAMPTZ` | `timestamp` | **NOT NULL** | `CURRENT_TIMESTAMP` | Creation timestamp |
| `updated_at` | `TIMESTAMPTZ` | `timestamp` | **NOT NULL** | `CURRENT_TIMESTAMP` | Last updated timestamp |

---

### Table 7: `recovery_snapshots`
Immutable workspace safety checkpoints.

| Column Name | SQL Data Type | Firestore Type | Constraints | Default | Description |
|---|---|---|---|---|---|
| `id` | `VARCHAR(64)` | `string` | **PRIMARY KEY** | — | Snapshot ID (`snap_{timestamp}_{hash}`) |
| `project_id` | `VARCHAR(64)` | `string` | **NOT NULL, FK (`projects.id`)** | — | Attributed workspace project |
| `user_id` | `VARCHAR(128)` | `string` | **NOT NULL, FK (`auth_users.id`)** | — | Creator user reference |
| `name` | `VARCHAR(120)` | `string` | **NOT NULL** | — | Snapshot title (e.g. *"Pre-AI: Refactor evaluator"*) |
| `description` | `VARCHAR(255)` | `string` | **NULLABLE** | `null` | Reason or automated trigger details |
| `total_files` | `INTEGER` | `number` | **NOT NULL** | `0` | File count in snapshot |
| `total_bytes` | `BIGINT` | `number` | **NOT NULL** | `0` | Aggregate snapshot size in bytes |
| `storage_bucket_uri`| `VARCHAR(512)`| `string` | **NULLABLE** | `null` | Cloud Storage URI (`gs://...`) if backed up |
| `created_at` | `TIMESTAMPTZ` | `timestamp` | **NOT NULL** | `CURRENT_TIMESTAMP` | Snapshot timestamp |

---

### Table 8: `snapshot_files`
Individual file inventory records and SHA-256 hashes within snapshots.

| Column Name | SQL Data Type | Firestore Type | Constraints | Default | Description |
|---|---|---|---|---|---|
| `id` | `VARCHAR(64)` | `string` | **PRIMARY KEY** | — | Record UUID |
| `snapshot_id` | `VARCHAR(64)` | `string` | **NOT NULL, FK (`recovery_snapshots.id`)** | — | Parent snapshot reference |
| `file_path` | `VARCHAR(512)` | `string` | **NOT NULL** | — | Relative workspace file path (`src/evaluator.ts`) |
| `file_hash` | `CHAR(64)` | `string` | **NOT NULL** | — | SHA-256 content hash |
| `file_size` | `INTEGER` | `number` | **NOT NULL** | `0` | File size in bytes |
| `modified_at` | `TIMESTAMPTZ` | `timestamp` | **NOT NULL** | — | Filesystem modification time |

---

### Table 9: `ai_proposals`
Generated candidate patches, self-repair attempts, and verification state.

| Column Name | SQL Data Type | Firestore Type | Constraints | Default | Description |
|---|---|---|---|---|---|
| `id` | `VARCHAR(64)` | `string` | **PRIMARY KEY** | — | Proposal ID (`prop_{timestamp}_{hash}`) |
| `project_id` | `VARCHAR(64)` | `string` | **NOT NULL, FK (`projects.id`)** | — | Target workspace project |
| `user_id` | `VARCHAR(128)` | `string` | **NOT NULL, FK (`auth_users.id`)** | — | Requesting user reference |
| `model_id` | `VARCHAR(120)` | `string` | **NOT NULL** | — | Model ID (e.g. `nvidia/nemotron-3.5-lightning-30b-a3b`) |
| `user_prompt` | `VARCHAR(3000)`| `string` | **NOT NULL** | — | User's prompt request |
| `summary` | `VARCHAR(255)` | `string` | **NOT NULL** | — | High-level summary of proposed change |
| `reasoning` | `TEXT` | `string` | **NOT NULL** | — | Model's rationale |
| `verification_status`| `VARCHAR(30)` | `string` | **NOT NULL** | `'pending'` | `'verified'`, `'verification_failed'`, `'repair_exhausted'` |
| `verified_in_sandbox`| `BOOLEAN` | `boolean` | **NOT NULL** | `false` | True if passed isolated sandbox compiler & invariants |
| `repair_attempts_count`| `INTEGER` | `number` | **NOT NULL** | `0` | Compiler-in-the-loop repair count (`0-2`) |
| `status` | `VARCHAR(25)` | `string` | **NOT NULL** | `'pending_approval'` | `'pending_approval'`, `'approved'`, `'applied'`, `'rejected'` |
| `snapshot_before_id`| `VARCHAR(64)` | `string` | **NULLABLE, FK (`recovery_snapshots.id`)** | `null` | Pre-apply safety checkpoint snapshot |
| `applied_at` | `TIMESTAMPTZ` | `timestamp` | **NULLABLE** | `null` | Execution timestamp when user approved |
| `created_at` | `TIMESTAMPTZ` | `timestamp` | **NOT NULL** | `CURRENT_TIMESTAMP` | Proposal creation timestamp |

---

### Table 10: `proposal_modifications`
Individual file diffs and replacement contents within a proposal.

| Column Name | SQL Data Type | Firestore Type | Constraints | Default | Description |
|---|---|---|---|---|---|
| `id` | `VARCHAR(64)` | `string` | **PRIMARY KEY** | — | Modification UUID |
| `proposal_id` | `VARCHAR(64)` | `string` | **NOT NULL, FK (`ai_proposals.id`)** | — | Parent proposal reference |
| `target_path` | `VARCHAR(512)` | `string` | **NOT NULL** | — | Target relative workspace path |
| `operation` | `VARCHAR(20)` | `string` | **NOT NULL** | `'modify'` | Operation: `'modify'`, `'create'`, `'delete'` |
| `expected_current_hash`| `CHAR(64)` | `string` | **NULLABLE** | `null` | Expected baseline SHA-256 for conflict detection |
| `replacement_content`| `TEXT` | `string` | **NOT NULL** | — | Full replacement file content |
| `unified_diff` | `TEXT` | `string` | **NULLABLE** | `null` | Generated unified diff string |

---

### Table 11: `audit_logs`
Immutable log of workspace mutations and security events.

| Column Name | SQL Data Type | Firestore Type | Constraints | Default | Description |
|---|---|---|---|---|---|
| `id` | `VARCHAR(64)` | `string` | **PRIMARY KEY** | — | Action ID (`act_{timestamp}_{hash}`) |
| `project_id` | `VARCHAR(64)` | `string` | **NOT NULL, FK (`projects.id`)** | — | Workspace project reference |
| `user_id` | `VARCHAR(128)` | `string` | **NOT NULL, FK (`auth_users.id`)** | — | Actor user reference |
| `action_type` | `VARCHAR(40)` | `string` | **NOT NULL** | — | `'snapshot_create'`, `'file_modify'`, `'file_upload'`, `'restore'`, `'validate'` |
| `summary` | `VARCHAR(255)` | `string` | **NOT NULL** | — | Event description |
| `status` | `VARCHAR(20)` | `string` | **NOT NULL** | — | Status: `'success'`, `'failure'` |
| `target_path` | `VARCHAR(512)` | `string` | **NULLABLE** | `null` | File target (if applicable) |
| `snapshot_id_before`| `VARCHAR(64)` | `string` | **NULLABLE** | `null` | Baseline snapshot ID |
| `snapshot_id_after` | `VARCHAR(64)` | `string` | **NULLABLE** | `null` | Post-action snapshot ID |
| `details_json` | `JSONB` | `map` | **NOT NULL** | `'{}'` | Contextual JSON payload |
| `timestamp` | `TIMESTAMPTZ` | `timestamp` | **NOT NULL** | `CURRENT_TIMESTAMP` | Event timestamp |

---

### Table 12: `credit_ledger`
Idempotent task tracking for free credits and provider costs.

| Column Name | SQL Data Type | Firestore Type | Constraints | Default | Description |
|---|---|---|---|---|---|
| `task_id` | `VARCHAR(128)` | `string` | **PRIMARY KEY** | — | Unique task ID (idempotent key) |
| `project_id` | `VARCHAR(64)` | `string` | **NOT NULL, FK (`projects.id`)** | — | Project reference |
| `user_id` | `VARCHAR(128)` | `string` | **NOT NULL, FK (`auth_users.id`)** | — | User reference |
| `credits_charged` | `INTEGER` | `number` | **NOT NULL** | `1` | Credits deducted (`1-5`) |
| `complexity` | `VARCHAR(40)` | `string` | **NOT NULL** | `'standard_refactor'` | Task complexity category |
| `provider_cost_usd`| `DECIMAL(10,6)`| `number` | **NOT NULL** | `0.000000` | Estimated or confirmed USD provider cost |
| `cost_status` | `VARCHAR(20)` | `string` | **NOT NULL** | `'estimated'` | `'confirmed'`, `'estimated'`, `'unavailable'` |
| `prompt_tokens` | `INTEGER` | `number` | **NOT NULL** | `0` | Input tokens consumed |
| `completion_tokens`| `INTEGER` | `number` | **NOT NULL** | `0` | Output tokens generated |
| `total_tokens` | `INTEGER` | `number` | **NOT NULL** | `0` | Total tokens consumed |
| `model_id` | `VARCHAR(120)` | `string` | **NOT NULL** | — | Model ID used |
| `charged_at` | `TIMESTAMPTZ` | `timestamp` | **NOT NULL** | `CURRENT_TIMESTAMP` | Deduction timestamp |

---

### Table 13: `rag_documents`
Codebase knowledge base documents.

| Column Name | SQL Data Type | Firestore Type | Constraints | Default | Description |
|---|---|---|---|---|---|
| `id` | `VARCHAR(64)` | `string` | **PRIMARY KEY** | — | Document ID (`doc_{hash}`) |
| `project_id` | `VARCHAR(64)` | `string` | **NOT NULL, FK (`projects.id`)** | — | Project reference |
| `file_name` | `VARCHAR(512)` | `string` | **NOT NULL** | — | Workspace file path (e.g. `src/evaluator.ts`) |
| `mime_type` | `VARCHAR(100)` | `string` | **NOT NULL** | `'text/plain'` | MIME type |
| `size_bytes` | `INTEGER` | `number` | **NOT NULL** | `0` | File byte size |
| `page_count` | `INTEGER` | `number` | **NULLABLE** | `null` | Page count (for PDF files) |
| `chunk_count` | `INTEGER` | `number` | **NOT NULL** | `0` | Total vector chunks generated |
| `status` | `VARCHAR(20)` | `string` | **NOT NULL** | `'indexed'` | Status: `'indexed'`, `'processing'`, `'failed'` |
| `embedding_model`| `VARCHAR(80)` | `string` | **NOT NULL** | `'deterministic-local-projection'` | Model used for embeddings |
| `created_at` | `TIMESTAMPTZ` | `timestamp` | **NOT NULL** | `CURRENT_TIMESTAMP` | Ingestion timestamp |

---

### Table 14: `rag_chunks`
Text segments with vector embeddings.

| Column Name | SQL Data Type | Firestore Type | Constraints | Default | Description |
|---|---|---|---|---|---|
| `id` | `VARCHAR(64)` | `string` | **PRIMARY KEY** | — | Chunk ID (`chk_{hash}`) |
| `document_id` | `VARCHAR(64)` | `string` | **NOT NULL, FK (`rag_documents.id`)**| — | Parent document reference |
| `project_id` | `VARCHAR(64)` | `string` | **NOT NULL, FK (`projects.id`)** | — | Project reference |
| `chunk_index` | `INTEGER` | `number` | **NOT NULL** | `0` | Sequential index (`0, 1, 2...`) |
| `text_content` | `TEXT` | `string` | **NOT NULL** | — | Chunk text excerpt |
| `embedding_vector`| `REAL[]` | `array<number>`| **NOT NULL** | — | Float vector array (64-dim local projection) |
| `char_count` | `INTEGER` | `number` | **NOT NULL** | `0` | Character count |
| `token_estimate` | `INTEGER` | `number` | **NOT NULL** | `0` | Estimated token count |
| `created_at` | `TIMESTAMPTZ` | `timestamp` | **NOT NULL** | `CURRENT_TIMESTAMP` | Creation timestamp |

---

## 3. SQL DDL Script (PostgreSQL / Firebase Data Connect)

```sql
-- 1. Authentication Table
CREATE TABLE IF NOT EXISTS auth_users (
    id VARCHAR(128) PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    email_verified BOOLEAN NOT NULL DEFAULT FALSE,
    password_hash VARCHAR(255),
    auth_provider VARCHAR(50) NOT NULL DEFAULT 'password',
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_login_at TIMESTAMPTZ,
    is_disabled BOOLEAN NOT NULL DEFAULT FALSE
);

-- 2. User Profiles Table
CREATE TABLE IF NOT EXISTS user_profiles (
    user_id VARCHAR(128) PRIMARY KEY REFERENCES auth_users(id) ON DELETE CASCADE,
    display_name VARCHAR(150) NOT NULL DEFAULT '',
    photo_url VARCHAR(512),
    role VARCHAR(30) NOT NULL DEFAULT 'developer',
    active_project_id VARCHAR(64) NOT NULL DEFAULT 'demo-workspace',
    credit_allowance INTEGER NOT NULL DEFAULT 100,
    credits_used INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 3. User Memories Table
CREATE TABLE IF NOT EXISTS user_memories (
    id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(128) NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
    project_id VARCHAR(64),
    memory_type VARCHAR(40) NOT NULL DEFAULT 'coding_preference',
    title VARCHAR(200) NOT NULL,
    content TEXT NOT NULL,
    tags TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    confidence REAL NOT NULL DEFAULT 1.0,
    hit_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 4. Projects Table
CREATE TABLE IF NOT EXISTS projects (
    id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(128) NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
    name VARCHAR(80) NOT NULL,
    description VARCHAR(255),
    workspace_path VARCHAR(512) NOT NULL,
    template VARCHAR(20) NOT NULL DEFAULT 'demo',
    file_count INTEGER NOT NULL DEFAULT 0,
    total_size_bytes BIGINT NOT NULL DEFAULT 0,
    snapshot_count INTEGER NOT NULL DEFAULT 0,
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    is_default BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 5. Chat Sessions Table
CREATE TABLE IF NOT EXISTS chat_sessions (
    id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(128) NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
    project_id VARCHAR(64) NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL DEFAULT 'New Conversation',
    active_model VARCHAR(120) NOT NULL,
    message_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 6. Chat Messages Table
CREATE TABLE IF NOT EXISTS chat_messages (
    id VARCHAR(64) PRIMARY KEY,
    session_id VARCHAR(64) NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
    role VARCHAR(20) NOT NULL,
    content TEXT NOT NULL,
    proposal_id VARCHAR(64),
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 7. Recovery Snapshots Table
CREATE TABLE IF NOT EXISTS recovery_snapshots (
    id VARCHAR(64) PRIMARY KEY,
    project_id VARCHAR(64) NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id VARCHAR(128) NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
    name VARCHAR(120) NOT NULL,
    description VARCHAR(255),
    total_files INTEGER NOT NULL DEFAULT 0,
    total_bytes BIGINT NOT NULL DEFAULT 0,
    storage_bucket_uri VARCHAR(512),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 8. Snapshot Files Table
CREATE TABLE IF NOT EXISTS snapshot_files (
    id VARCHAR(64) PRIMARY KEY,
    snapshot_id VARCHAR(64) NOT NULL REFERENCES recovery_snapshots(id) ON DELETE CASCADE,
    file_path VARCHAR(512) NOT NULL,
    file_hash CHAR(64) NOT NULL,
    file_size INTEGER NOT NULL DEFAULT 0,
    modified_at TIMESTAMPTZ NOT NULL
);

-- 9. AI Change Proposals Table
CREATE TABLE IF NOT EXISTS ai_proposals (
    id VARCHAR(64) PRIMARY KEY,
    project_id VARCHAR(64) NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id VARCHAR(128) NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
    model_id VARCHAR(120) NOT NULL,
    user_prompt VARCHAR(3000) NOT NULL,
    summary VARCHAR(255) NOT NULL,
    reasoning TEXT NOT NULL,
    verification_status VARCHAR(30) NOT NULL DEFAULT 'pending',
    verified_in_sandbox BOOLEAN NOT NULL DEFAULT FALSE,
    repair_attempts_count INTEGER NOT NULL DEFAULT 0,
    status VARCHAR(25) NOT NULL DEFAULT 'pending_approval',
    snapshot_before_id VARCHAR(64) REFERENCES recovery_snapshots(id),
    applied_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 10. Proposal Modifications Table
CREATE TABLE IF NOT EXISTS proposal_modifications (
    id VARCHAR(64) PRIMARY KEY,
    proposal_id VARCHAR(64) NOT NULL REFERENCES ai_proposals(id) ON DELETE CASCADE,
    target_path VARCHAR(512) NOT NULL,
    operation VARCHAR(20) NOT NULL DEFAULT 'modify',
    expected_current_hash CHAR(64),
    replacement_content TEXT NOT NULL,
    unified_diff TEXT
);

-- 11. Application Audit Logs Table
CREATE TABLE IF NOT EXISTS audit_logs (
    id VARCHAR(64) PRIMARY KEY,
    project_id VARCHAR(64) NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id VARCHAR(128) NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
    action_type VARCHAR(40) NOT NULL,
    summary VARCHAR(255) NOT NULL,
    status VARCHAR(20) NOT NULL,
    target_path VARCHAR(512),
    snapshot_id_before VARCHAR(64),
    snapshot_id_after VARCHAR(64),
    details_json JSONB NOT NULL DEFAULT '{}'::JSONB,
    timestamp TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 12. Credit Ledger Table
CREATE TABLE IF NOT EXISTS credit_ledger (
    task_id VARCHAR(128) PRIMARY KEY,
    project_id VARCHAR(64) NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id VARCHAR(128) NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
    credits_charged INTEGER NOT NULL DEFAULT 1,
    complexity VARCHAR(40) NOT NULL DEFAULT 'standard_refactor',
    provider_cost_usd DECIMAL(10,6) NOT NULL DEFAULT 0.000000,
    cost_status VARCHAR(20) NOT NULL DEFAULT 'estimated',
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    model_id VARCHAR(120) NOT NULL,
    charged_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 13. RAG Documents Table
CREATE TABLE IF NOT EXISTS rag_documents (
    id VARCHAR(64) PRIMARY KEY,
    project_id VARCHAR(64) NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    file_name VARCHAR(512) NOT NULL,
    mime_type VARCHAR(100) NOT NULL DEFAULT 'text/plain',
    size_bytes INTEGER NOT NULL DEFAULT 0,
    page_count INTEGER,
    chunk_count INTEGER NOT NULL DEFAULT 0,
    status VARCHAR(20) NOT NULL DEFAULT 'indexed',
    embedding_model VARCHAR(80) NOT NULL DEFAULT 'deterministic-local-projection',
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 14. RAG Chunks Table
CREATE TABLE IF NOT EXISTS rag_chunks (
    id VARCHAR(64) PRIMARY KEY,
    document_id VARCHAR(64) NOT NULL REFERENCES rag_documents(id) ON DELETE CASCADE,
    project_id VARCHAR(64) NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL DEFAULT 0,
    text_content TEXT NOT NULL,
    embedding_vector REAL[] NOT NULL,
    char_count INTEGER NOT NULL DEFAULT 0,
    token_estimate INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```
