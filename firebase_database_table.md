# Rewind — Database Tables & Columns Specification

This file defines the exact **table names**, **column names**, **data types**, **constraints**, **default values**, and **column descriptions** required to run Rewind with:
1. **Multi-Tenant User Authentication** via Firebase Auth / SQL.
2. **Project-Scoped Chat Continuity:** Every chat session opens directly under the uploaded project workspace (`/projects/{projectId}/chat_sessions/{sessionId}`).
3. **The Memory Membrane (Selective Intent Distillation):** Core user intentions, architectural decisions, and technical constraints are extracted from project chats into a dedicated project memory membrane (`/projects/{projectId}/memories/{memoryId}`), rather than flooding LLM context with raw chat transcripts.
4. **Safety Checkpoints, Code Self-Repair & Dual Accounting.**

Both the **Relational Table View** (compatible with PostgreSQL, Firebase Data Connect, BigQuery) and the **Cloud Firestore Collection Mapping** are documented below.

---

## 1. Complete Database Table Inventory

| # | Table Name | Firestore Collection Equivalent | Purpose |
|---|---|---|---|
| 1 | `auth_users` | Firebase Auth (`users`) | User authentication, identity, credentials & JWT claims |
| 2 | `user_profiles` | `/users/{userId}` | User display metadata, role, credit allowance & active project pointer |
| 3 | `user_global_memories` | `/users/{userId}/global_memories/{memoryId}` | Global cross-project developer preferences & coding conventions |
| 4 | `projects` | `/users/{userId}/projects/{projectId}` | Uploaded project workspaces with isolated filesystems |
| 5 | `chat_sessions` | `/users/{userId}/projects/{projectId}/chat_sessions/{sessionId}` | Chat sessions opened directly under uploaded projects |
| 6 | `chat_messages` | `.../chat_sessions/{sessionId}/messages/{messageId}` | Turn-by-turn prompts, reasoning traces, responses & token counts |
| 7 | `project_memories` | `/users/{userId}/projects/{projectId}/memories/{memoryId}` | **The Memory Membrane:** Distilled core intentions & architecture |
| 8 | `recovery_snapshots` | `.../projects/{projectId}/snapshots/{snapshotId}` | Rollback safety checkpoints and recovery metadata |
| 9 | `snapshot_files` | Nested inside snapshot doc (`files` array) | File inventory with SHA-256 hashes and byte sizes |
| 10 | `ai_proposals` | `.../projects/{projectId}/proposals/{proposalId}` | AI candidate code modifications, compiler repairs & approval state |
| 11 | `proposal_modifications`| Nested inside proposal doc (`modifications` array) | File modification diffs, replacement content & baseline hashes |
| 12 | `audit_logs` | `.../projects/{projectId}/audit_logs/{actionId}` | Immutable audit trail for all file mutations and rollback events |
| 13 | `credit_ledger` | `.../projects/{projectId}/credit_ledger/{taskId}` | Dual accounting task deduplication, credit charges & provider costs |
| 14 | `rag_documents` | `.../projects/{projectId}/documents/{documentId}` | Codebase files indexed for retrieval-augmented generation |
| 15 | `rag_chunks` | `.../projects/{projectId}/documents/{docId}/chunks` | Text segments with dense vector embeddings |

---

## 2. The Memory Membrane: Why Chat and Memory Are Separated

```text
[User Prompts in Project Chat]
       │
       ▼
[Turn-by-Turn Chat Messages] ──► Preserved under /projects/{pid}/chat_sessions/{sid}/messages
       │
       ▼ (Automated Intent Distillation Filter)
       ├─ Discard conversational noise ("thanks", "fix this typo", intermediate trial-and-error)
       └─ Extract CORE INTENTIONS & DECISIONS:
            • Project Goals (e.g. "Add a real-time markdown preview with KaTeX")
            • Architectural Decisions (e.g. "Store state in Zustand, avoid Redux")
            • Technical Constraints (e.g. "Never alter src/evaluator.ts invariants")
            • Confirmed Fixes (e.g. "Always use named exports for icon modules")
       │
       ▼
[Project Memory Membrane] ─────► Stored in /projects/{pid}/memories/{memoryId}
       │
       ▼
[Injected into LLM Prompt] ────► Project Developer LLM receives crystal-clear user intention!
```

---

## 3. Table-by-Table Column Specifications

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
Stores developer profile settings, credit allowances, and active workspace pointer.

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

### Table 3: `user_global_memories`
Stores global developer coding preferences that apply across all projects.

| Column Name | SQL Data Type | Firestore Type | Constraints | Default | Description |
|---|---|---|---|---|---|
| `id` | `VARCHAR(64)` | `string` | **PRIMARY KEY** | — | Unique memory ID (`gmem_xxxx`) |
| `user_id` | `VARCHAR(128)` | `string` | **NOT NULL, FK (`auth_users.id`)** | — | Owner user UID |
| `category` | `VARCHAR(40)` | `string` | **NOT NULL** | `'coding_preference'` | `'coding_preference'`, `'general_rule'`, `'tooling'` |
| `title` | `VARCHAR(150)` | `string` | **NOT NULL** | — | Short title (e.g. *"Strict TypeScript No Any"*) |
| `content` | `TEXT` | `string` | **NOT NULL** | — | Universal developer coding guideline |
| `tags` | `TEXT[]` | `array<string>` | **NOT NULL** | `'{}'` | Search tags (e.g. `['typescript', 'strict']`) |
| `created_at` | `TIMESTAMPTZ` | `timestamp` | **NOT NULL** | `CURRENT_TIMESTAMP` | Creation timestamp |
| `updated_at` | `TIMESTAMPTZ` | `timestamp` | **NOT NULL** | `CURRENT_TIMESTAMP` | Last updated timestamp |

---

### Table 4: `projects`
Manages uploaded and created multi-project code workspaces.

| Column Name | SQL Data Type | Firestore Type | Constraints | Default | Description |
|---|---|---|---|---|---|
| `id` | `VARCHAR(64)` | `string` | **PRIMARY KEY** | — | Project ID (e.g. `demo-workspace`, `proj_xxxx`) |
| `user_id` | `VARCHAR(128)` | `string` | **NOT NULL, FK (`auth_users.id`)** | — | Owner user UID |
| `name` | `VARCHAR(100)` | `string` | **NOT NULL** | — | Project display name |
| `description` | `TEXT` | `string` | **NOT NULL** | `''` | Project description and goals |
| `template` | `VARCHAR(30)` | `string` | **NOT NULL** | `'demo'` | Template: `'demo'`, `'empty'` |
| `workspace_path` | `VARCHAR(512)` | `string` | **NOT NULL** | — | Disk workspace directory |
| `file_count` | `INTEGER` | `number` | **NOT NULL** | `0` | Number of tracked code/text files |
| `total_size_bytes`| `BIGINT` | `number` | **NOT NULL** | `0` | Total project workspace size in bytes |
| `snapshot_count` | `INTEGER` | `number` | **NOT NULL** | `0` | Number of stored safety snapshots |
| `chat_session_count`| `INTEGER` | `number` | **NOT NULL** | `0` | Total chat sessions under this project |
| `status` | `VARCHAR(20)` | `string` | **NOT NULL** | `'active'` | Status: `'active'`, `'archived'` |
| `is_default` | `BOOLEAN` | `boolean` | **NOT NULL** | `false` | Whether this is the default workspace |
| `created_at` | `TIMESTAMPTZ` | `timestamp` | **NOT NULL** | `CURRENT_TIMESTAMP` | Project creation timestamp |
| `updated_at` | `TIMESTAMPTZ` | `timestamp` | **NOT NULL** | `CURRENT_TIMESTAMP` | Last modified timestamp |

---

### Table 5: `chat_sessions`
Opens conversational sessions **directly under the uploaded project** to preserve continuity.

| Column Name | SQL Data Type | Firestore Type | Constraints | Default | Description |
|---|---|---|---|---|---|
| `id` | `VARCHAR(64)` | `string` | **PRIMARY KEY** | — | Session ID (`sess_xxxx`) |
| `project_id` | `VARCHAR(64)` | `string` | **NOT NULL, FK (`projects.id`)** | — | **Parent project workspace ID** |
| `user_id` | `VARCHAR(128)` | `string` | **NOT NULL, FK (`auth_users.id`)** | — | Owner user UID |
| `title` | `VARCHAR(200)` | `string` | **NOT NULL** | `'New Project Chat'` | Topic summary |
| `active_model` | `VARCHAR(120)` | `string` | **NOT NULL** | `'auto'` | Active model ID |
| `routing_mode` | `VARCHAR(20)` | `string` | **NOT NULL** | `'auto'` | Routing mode: `'auto'`, `'manual'` |
| `message_count` | `INTEGER` | `number` | **NOT NULL** | `0` | Number of turns in this session |
| `extracted_memories_count` | `INTEGER` | `number` | **NOT NULL** | `0` | Core memories distilled into the membrane |
| `created_at` | `TIMESTAMPTZ` | `timestamp` | **NOT NULL** | `CURRENT_TIMESTAMP` | Session start timestamp |
| `last_message_at`| `TIMESTAMPTZ` | `timestamp` | **NOT NULL** | `CURRENT_TIMESTAMP` | Timestamp of most recent message |

---

### Table 6: `chat_messages`
Stores turn-by-turn prompts, reasoning traces, and responses under the project session.

| Column Name | SQL Data Type | Firestore Type | Constraints | Default | Description |
|---|---|---|---|---|---|
| `id` | `VARCHAR(64)` | `string` | **PRIMARY KEY** | — | Message ID (`msg_xxxx`) |
| `session_id` | `VARCHAR(64)` | `string` | **NOT NULL, FK (`chat_sessions.id`)** | — | Parent session ID |
| `project_id` | `VARCHAR(64)` | `string` | **NOT NULL, FK (`projects.id`)** | — | Parent project workspace ID |
| `user_id` | `VARCHAR(128)` | `string` | **NOT NULL, FK (`auth_users.id`)** | — | Owner user UID |
| `role` | `VARCHAR(20)` | `string` | **NOT NULL** | — | Role: `'user'`, `'assistant'`, `'system'` |
| `content` | `TEXT` | `string` | **NOT NULL** | — | Message text content |
| `reasoning` | `TEXT` | `string` | **NULLABLE** | `null` | Assistant chain-of-thought rationale |
| `proposal_id` | `VARCHAR(64)` | `string` | **NULLABLE, FK (`ai_proposals.id`)** | `null` | Linked AI change proposal if generated |
| `contains_core_intent`| `BOOLEAN` | `boolean` | **NOT NULL** | `false` | True if this turn generated a distilled memory |
| `tokens_used` | `INTEGER` | `number` | **NOT NULL** | `0` | Reported token count |
| `created_at` | `TIMESTAMPTZ` | `timestamp` | **NOT NULL** | `CURRENT_TIMESTAMP` | Message timestamp |

---

### Table 7: `project_memories` (The Memory Membrane)
Stores distilled core user intentions, architectural choices, and technical constraints for this project.

| Column Name | SQL Data Type | Firestore Type | Constraints | Default | Description |
|---|---|---|---|---|---|
| `id` | `VARCHAR(64)` | `string` | **PRIMARY KEY** | — | Memory ID (`pmem_xxxx`) |
| `project_id` | `VARCHAR(64)` | `string` | **NOT NULL, FK (`projects.id`)** | — | **Scoped project workspace ID** |
| `user_id` | `VARCHAR(128)` | `string` | **NOT NULL, FK (`auth_users.id`)** | — | Owner user UID |
| `source_session_id`| `VARCHAR(64)`| `string` | **NULLABLE, FK (`chat_sessions.id`)**| `null` | Chat session where intent was articulated |
| `source_message_id`| `VARCHAR(64)`| `string` | **NULLABLE** | `null` | Specific chat message turn |
| `category` | `VARCHAR(40)` | `string` | **NOT NULL** | `'project_intent'` | `'project_intent'`, `'architectural_decision'`, `'technical_constraint'`, `'resolved_pattern'` |
| `title` | `VARCHAR(150)` | `string` | **NOT NULL** | — | Short summary (e.g. *"Offline SQLite Store"*) |
| `distilled_intent` | `TEXT` | `string` | **NOT NULL** | — | **Distilled user intention injected into LLM** |
| `importance` | `INTEGER` | `number` | **NOT NULL** | `3` | Importance rating (`1` to `5`) |
| `tags` | `TEXT[]` | `array<string>` | **NOT NULL** | `'{}'` | Search tags (e.g. `['database', 'sqlite']`) |
| `is_active` | `BOOLEAN` | `boolean` | **NOT NULL** | `true` | Whether this memory is injected into prompt |
| `created_at` | `TIMESTAMPTZ` | `timestamp` | **NOT NULL** | `CURRENT_TIMESTAMP` | Distillation timestamp |
| `updated_at` | `TIMESTAMPTZ` | `timestamp` | **NOT NULL** | `CURRENT_TIMESTAMP` | Last updated timestamp |

---

### Table 8: `recovery_snapshots`
Safety rollback checkpoints captured before file mutations or on demand.

| Column Name | SQL Data Type | Firestore Type | Constraints | Default | Description |
|---|---|---|---|---|---|
| `id` | `VARCHAR(64)` | `string` | **PRIMARY KEY** | — | Snapshot ID (`snap_xxxx`) |
| `project_id` | `VARCHAR(64)` | `string` | **NOT NULL, FK (`projects.id`)** | — | Associated project ID |
| `user_id` | `VARCHAR(128)` | `string` | **NOT NULL, FK (`auth_users.id`)** | — | Creator user UID |
| `name` | `VARCHAR(200)` | `string` | **NOT NULL** | — | Snapshot display label |
| `description` | `TEXT` | `string` | **NOT NULL** | `''` | Trigger cause or user description |
| `total_files` | `INTEGER` | `number` | **NOT NULL** | `0` | Number of files captured |
| `total_bytes` | `BIGINT` | `number` | **NOT NULL** | `0` | Cumulative snapshot size in bytes |
| `created_at` | `TIMESTAMPTZ` | `timestamp` | **NOT NULL** | `CURRENT_TIMESTAMP` | Snapshot capture timestamp |

---

### Table 9: `snapshot_files`
File inventory captured within a recovery snapshot.

| Column Name | SQL Data Type | Firestore Type | Constraints | Default | Description |
|---|---|---|---|---|---|
| `id` | `VARCHAR(64)` | `string` | **PRIMARY KEY** | — | File record ID |
| `snapshot_id` | `VARCHAR(64)` | `string` | **NOT NULL, FK (`recovery_snapshots.id`)** | — | Parent snapshot ID |
| `file_path` | `VARCHAR(512)` | `string` | **NOT NULL** | — | Relative workspace file path |
| `file_hash` | `CHAR(64)` | `string` | **NOT NULL** | — | SHA-256 content checksum |
| `file_size` | `INTEGER` | `number` | **NOT NULL** | `0` | File size in bytes |
| `modified_at` | `TIMESTAMPTZ` | `timestamp` | **NOT NULL** | — | Original file modification time |

---

### Table 10: `ai_proposals`
Tracks AI code proposals, compiler-in-the-loop self-repairs, and user approval.

| Column Name | SQL Data Type | Firestore Type | Constraints | Default | Description |
|---|---|---|---|---|---|
| `id` | `VARCHAR(64)` | `string` | **PRIMARY KEY** | — | Proposal ID (`prop_xxxx`) |
| `project_id` | `VARCHAR(64)` | `string` | **NOT NULL, FK (`projects.id`)** | — | Target project workspace ID |
| `user_id` | `VARCHAR(128)` | `string` | **NOT NULL, FK (`auth_users.id`)** | — | Requesting user UID |
| `model_id` | `VARCHAR(120)` | `string` | **NOT NULL** | — | Provider model ID used |
| `user_prompt` | `VARCHAR(3000)`| `string` | **NOT NULL** | — | Original prompt |
| `summary` | `VARCHAR(255)` | `string` | **NOT NULL** | — | Summary of proposed change |
| `reasoning` | `TEXT` | `string` | **NOT NULL** | — | LLM architectural rationale |
| `verification_status`| `VARCHAR(30)`| `string` | **NOT NULL** | `'pending'` | `'verified'`, `'verification_failed'`, `'repair_exhausted'` |
| `verified_in_sandbox`| `BOOLEAN` | `boolean` | **NOT NULL** | `false` | True if passed isolated sandbox checks |
| `repair_attempts_count`| `INTEGER` | `number` | **NOT NULL** | `0` | Number of compiler self-repairs (`0-2`) |
| `status` | `VARCHAR(25)` | `string` | **NOT NULL** | `'pending_approval'` | `'pending_approval'`, `'approved'`, `'applied'`, `'rejected'` |
| `snapshot_before_id`| `VARCHAR(64)` | `string` | **NULLABLE, FK (`recovery_snapshots.id`)** | `null` | Pre-apply safety checkpoint |
| `applied_at` | `TIMESTAMPTZ` | `timestamp` | **NULLABLE** | `null` | Apply execution timestamp |
| `created_at` | `TIMESTAMPTZ` | `timestamp` | **NOT NULL** | `CURRENT_TIMESTAMP` | Proposal creation timestamp |

---

### Table 11: `proposal_modifications`
Stores individual file modifications, diffs, and replacement contents for a proposal.

| Column Name | SQL Data Type | Firestore Type | Constraints | Default | Description |
|---|---|---|---|---|---|
| `id` | `VARCHAR(64)` | `string` | **PRIMARY KEY** | — | Modification record ID |
| `proposal_id` | `VARCHAR(64)` | `string` | **NOT NULL, FK (`ai_proposals.id`)** | — | Parent proposal ID |
| `target_path` | `VARCHAR(512)` | `string` | **NOT NULL** | — | Target workspace file path |
| `operation` | `VARCHAR(20)` | `string` | **NOT NULL** | `'modify'` | `'modify'`, `'create'`, `'delete'` |
| `expected_current_hash`| `CHAR(64)` | `string` | **NULLABLE** | `null` | Stale hash conflict detector |
| `replacement_content`| `TEXT` | `string` | **NOT NULL** | — | Full updated file content |
| `unified_diff` | `TEXT` | `string` | **NULLABLE** | `null` | Unified diff representation |

---

### Table 12: `audit_logs`
Immutable audit log recording every file write, rollback, upload, and validation.

| Column Name | SQL Data Type | Firestore Type | Constraints | Default | Description |
|---|---|---|---|---|---|
| `id` | `VARCHAR(64)` | `string` | **PRIMARY KEY** | — | Audit action ID (`act_xxxx`) |
| `project_id` | `VARCHAR(64)` | `string` | **NOT NULL, FK (`projects.id`)** | — | Scoped project ID |
| `user_id` | `VARCHAR(128)` | `string` | **NOT NULL, FK (`auth_users.id`)** | — | Triggering user UID |
| `action_type` | `VARCHAR(40)` | `string` | **NOT NULL** | — | `'snapshot_create'`, `'file_modify'`, `'restore'`, etc. |
| `summary` | `VARCHAR(255)` | `string` | **NOT NULL** | — | Short description of event |
| `status` | `VARCHAR(20)` | `string` | **NOT NULL** | — | `'success'`, `'failure'` |
| `target_path` | `VARCHAR(512)` | `string` | **NULLABLE** | `null` | File path mutated (if applicable) |
| `snapshot_id_before` | `VARCHAR(64)` | `string` | **NULLABLE** | `null` | Safety snapshot ID before action |
| `snapshot_id_after` | `VARCHAR(64)` | `string` | **NULLABLE** | `null` | Safety snapshot ID after action |
| `details_json` | `JSONB` | `map` | **NOT NULL** | `'{}'` | Event metadata and parameters |
| `timestamp` | `TIMESTAMPTZ` | `timestamp` | **NOT NULL** | `CURRENT_TIMESTAMP` | Action execution timestamp |

---

### Table 13: `credit_ledger`
Deduplicates tasks and tracks consumption of Rewind credits and upstream provider costs.

| Column Name | SQL Data Type | Firestore Type | Constraints | Default | Description |
|---|---|---|---|---|---|
| `task_id` | `VARCHAR(128)` | `string` | **PRIMARY KEY** | — | Deduplication hash of task |
| `project_id` | `VARCHAR(64)` | `string` | **NOT NULL, FK (`projects.id`)** | — | Associated project ID |
| `user_id` | `VARCHAR(128)` | `string` | **NOT NULL, FK (`auth_users.id`)** | — | User UID charged |
| `credits_charged` | `INTEGER` | `number` | **NOT NULL** | `1` | Rewind credits deducted (`1-5`) |
| `complexity` | `VARCHAR(40)` | `string` | **NOT NULL** | `'standard_refactor'` | Task complexity |
| `provider_cost_usd` | `DECIMAL(10,6)` | `number` | **NOT NULL** | `0.000000` | Estimated or confirmed USD cost |
| `cost_status` | `VARCHAR(20)` | `string` | **NOT NULL** | `'estimated'` | `'confirmed'`, `'estimated'`, `'unavailable'` |
| `prompt_tokens` | `INTEGER` | `number` | **NOT NULL** | `0` | Prompt tokens reported |
| `completion_tokens` | `INTEGER` | `number` | **NOT NULL** | `0` | Completion tokens reported |
| `total_tokens` | `INTEGER` | `number` | **NOT NULL** | `0` | Total tokens consumed |
| `model_id` | `VARCHAR(120)` | `string` | **NOT NULL** | — | Active model identifier |
| `charged_at` | `TIMESTAMPTZ` | `timestamp` | **NOT NULL** | `CURRENT_TIMESTAMP` | Deduction timestamp |

---

### Table 14: `rag_documents`
Tracks indexed codebase files for semantic vector search.

| Column Name | SQL Data Type | Firestore Type | Constraints | Default | Description |
|---|---|---|---|---|---|
| `id` | `VARCHAR(64)` | `string` | **PRIMARY KEY** | — | Document ID (`doc_xxxx`) |
| `project_id` | `VARCHAR(64)` | `string` | **NOT NULL, FK (`projects.id`)** | — | Project workspace ID |
| `file_name` | `VARCHAR(512)` | `string` | **NOT NULL** | — | Relative workspace file path |
| `mime_type` | `VARCHAR(100)` | `string` | **NOT NULL** | `'text/plain'` | File MIME type |
| `size_bytes` | `INTEGER` | `number` | **NOT NULL** | `0` | File byte size |
| `chunk_count` | `INTEGER` | `number` | **NOT NULL** | `0` | Total generated vector chunks |
| `status` | `VARCHAR(20)` | `string` | **NOT NULL** | `'indexed'` | `'indexed'`, `'processing'`, `'failed'` |
| `embedding_model`| `VARCHAR(80)` | `string` | **NOT NULL** | `'local-projection'` | Embedding model ID |
| `created_at` | `TIMESTAMPTZ` | `timestamp` | **NOT NULL** | `CURRENT_TIMESTAMP` | Indexing timestamp |

---

### Table 15: `rag_chunks`
Stores text segments and dense vector embeddings for RAG retrieval.

| Column Name | SQL Data Type | Firestore Type | Constraints | Default | Description |
|---|---|---|---|---|---|
| `id` | `VARCHAR(64)` | `string` | **PRIMARY KEY** | — | Chunk ID (`chk_xxxx`) |
| `document_id` | `VARCHAR(64)` | `string` | **NOT NULL, FK (`rag_documents.id`)** | — | Parent document ID |
| `project_id` | `VARCHAR(64)` | `string` | **NOT NULL, FK (`projects.id`)** | — | Scoped project ID |
| `chunk_index` | `INTEGER` | `number` | **NOT NULL** | `0` | Sequence index (`0, 1, 2...`) |
| `text_content` | `TEXT` | `string` | **NOT NULL** | — | Text excerpt |
| `embedding_vector`| `REAL[]` | `array<number>`| **NOT NULL** | — | Dense vector embedding array |
| `char_count` | `INTEGER` | `number` | **NOT NULL** | `0` | Character count |
| `token_estimate` | `INTEGER` | `number` | **NOT NULL** | `0` | Estimated token count |
| `created_at` | `TIMESTAMPTZ` | `timestamp` | **NOT NULL** | `CURRENT_TIMESTAMP` | Chunk creation timestamp |

---

## 4. Complete SQL DDL Script (PostgreSQL / Firebase Data Connect)

```sql
-- 1. Authentication & Users Table
CREATE TABLE IF NOT EXISTS auth_users (
    id VARCHAR(128) PRIMARY KEY,
    email VARCHAR(255) NOT NULL UNIQUE,
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

-- 3. Global Developer Memories Table (Cross-Project)
CREATE TABLE IF NOT EXISTS user_global_memories (
    id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(128) NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
    category VARCHAR(40) NOT NULL DEFAULT 'coding_preference',
    title VARCHAR(150) NOT NULL,
    content TEXT NOT NULL,
    tags TEXT[] NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 4. Projects Table (Uploaded & Isolated Workspaces)
CREATE TABLE IF NOT EXISTS projects (
    id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(128) NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    template VARCHAR(30) NOT NULL DEFAULT 'demo',
    workspace_path VARCHAR(512) NOT NULL,
    file_count INTEGER NOT NULL DEFAULT 0,
    total_size_bytes BIGINT NOT NULL DEFAULT 0,
    snapshot_count INTEGER NOT NULL DEFAULT 0,
    chat_session_count INTEGER NOT NULL DEFAULT 0,
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    is_default BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 5. Chat Sessions Table (Scoped Directly Under Projects)
CREATE TABLE IF NOT EXISTS chat_sessions (
    id VARCHAR(64) PRIMARY KEY,
    project_id VARCHAR(64) NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id VARCHAR(128) NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
    title VARCHAR(200) NOT NULL DEFAULT 'New Project Chat',
    active_model VARCHAR(120) NOT NULL DEFAULT 'auto',
    routing_mode VARCHAR(20) NOT NULL DEFAULT 'auto',
    message_count INTEGER NOT NULL DEFAULT 0,
    extracted_memories_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_message_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 6. Chat Messages Table
CREATE TABLE IF NOT EXISTS chat_messages (
    id VARCHAR(64) PRIMARY KEY,
    session_id VARCHAR(64) NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
    project_id VARCHAR(64) NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id VARCHAR(128) NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
    role VARCHAR(20) NOT NULL,
    content TEXT NOT NULL,
    reasoning TEXT,
    proposal_id VARCHAR(64),
    contains_core_intent BOOLEAN NOT NULL DEFAULT FALSE,
    tokens_used INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 7. Project Memory Membrane Table (Distilled User Intentions & Architecture)
CREATE TABLE IF NOT EXISTS project_memories (
    id VARCHAR(64) PRIMARY KEY,
    project_id VARCHAR(64) NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id VARCHAR(128) NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
    source_session_id VARCHAR(64) REFERENCES chat_sessions(id) ON DELETE SET NULL,
    source_message_id VARCHAR(64),
    category VARCHAR(40) NOT NULL DEFAULT 'project_intent',
    title VARCHAR(150) NOT NULL,
    distilled_intent TEXT NOT NULL,
    importance INTEGER NOT NULL DEFAULT 3,
    tags TEXT[] NOT NULL DEFAULT '{}',
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 8. Recovery Snapshots Table
CREATE TABLE IF NOT EXISTS recovery_snapshots (
    id VARCHAR(64) PRIMARY KEY,
    project_id VARCHAR(64) NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id VARCHAR(128) NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
    name VARCHAR(200) NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    total_files INTEGER NOT NULL DEFAULT 0,
    total_bytes BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 9. Snapshot Files Table
CREATE TABLE IF NOT EXISTS snapshot_files (
    id VARCHAR(64) PRIMARY KEY,
    snapshot_id VARCHAR(64) NOT NULL REFERENCES recovery_snapshots(id) ON DELETE CASCADE,
    file_path VARCHAR(512) NOT NULL,
    file_hash CHAR(64) NOT NULL,
    file_size INTEGER NOT NULL DEFAULT 0,
    modified_at TIMESTAMPTZ NOT NULL
);

-- 10. AI Change Proposals Table
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

-- 11. Proposal Modifications Table
CREATE TABLE IF NOT EXISTS proposal_modifications (
    id VARCHAR(64) PRIMARY KEY,
    proposal_id VARCHAR(64) NOT NULL REFERENCES ai_proposals(id) ON DELETE CASCADE,
    target_path VARCHAR(512) NOT NULL,
    operation VARCHAR(20) NOT NULL DEFAULT 'modify',
    expected_current_hash CHAR(64),
    replacement_content TEXT NOT NULL,
    unified_diff TEXT
);

-- 12. Application Audit Logs Table
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

-- 13. Credit Ledger Table
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

-- 14. RAG Documents Table
CREATE TABLE IF NOT EXISTS rag_documents (
    id VARCHAR(64) PRIMARY KEY,
    project_id VARCHAR(64) NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    file_name VARCHAR(512) NOT NULL,
    mime_type VARCHAR(100) NOT NULL DEFAULT 'text/plain',
    size_bytes INTEGER NOT NULL DEFAULT 0,
    chunk_count INTEGER NOT NULL DEFAULT 0,
    status VARCHAR(20) NOT NULL DEFAULT 'indexed',
    embedding_model VARCHAR(80) NOT NULL DEFAULT 'local-projection',
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 15. RAG Chunks Table
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
