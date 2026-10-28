# Rewind — Production Operations & Deployment Guide

This guide details the single-instance production deployment and operational maintenance for **Rewind** on a dedicated Ubuntu Linux Virtual Machine.

---

## 1. Architecture & Hosting Requirements

### Why Single-Instance Deployment is Required
Rewind is engineered around a deterministic local workspace engine:
1. **Persistent Local Storage:** Project workspaces (`projects/`), audit logs, SQLite/JSON stores, and snapshots (`.rewind_store/`) reside on local persistent disk.
2. **Deterministic Code Diagnostics:** The platform relies on the in-process TypeScript Compiler API (`ts.createSourceFile`) and synchronous Python 3 AST subprocesses (`python3 -c "import ast, sys; ast.parse(...)"`).
3. **Execution Safety:** Workspace operations, AST validations, and snapshot rollbacks require atomic local file locking and containment within safe directory boundaries.

> [!IMPORTANT]
> Do NOT deploy Rewind to multi-instance ephemeral serverless platforms (e.g., Vercel Serverless, AWS Lambda, Cloudflare Workers). It must run on a persistent virtual machine or container with attached persistent storage.

### Hardware & OS Specifications
- **Operating System:** Ubuntu 22.04 LTS or Ubuntu 24.04 LTS
- **CPU:** 2 vCPUs minimum (4 vCPUs recommended for concurrent AST analysis and builds)
- **RAM:** 4 GB minimum (8 GB recommended for Next.js Turbopack compilation and RAG vector processing)
- **Disk:** 40 GB+ NVMe / SSD with daily snapshot backups

### Realistic Monthly Cost Estimates
| Component | Provider / Tier | Estimated Cost |
| :--- | :--- | :--- |
| **Compute & Storage** | Hetzner Cloud (CX32 - 4 vCPU, 8 GB RAM, 80 GB SSD) or DigitalOcean Droplet (4 GB RAM, 2 vCPU) | $12 – $24 / month |
| **Authentication** | Firebase Authentication (Email/Password, Google Sign-in) | $0.00 (Free tier up to 50,000 MAUs) |
| **Metadata Database** | Google Cloud Firestore (Multi-region or regional) | $0.00 (Free tier: 1 GB storage, 50k reads/day) |
| **SSL / TLS Certificate** | Let's Encrypt (Automated via Certbot) | $0.00 (Free) |
| **Total Base Infrastructure** | | **$12 – $24 / month** |

---

## 2. Server Provisioning & Dependencies

Run as `root` or `sudo` user on a fresh Ubuntu instance:

```bash
# Update package repositories
sudo apt-get update && sudo apt-get upgrade -y

# Install essential build tools, NGINX, Python 3, Git, and UFW
sudo apt-get install -y build-essential curl git ufw nginx python3 python3-pip certbot python3-certbot-nginx

# Verify Python 3 AST availability
python3 -c "import ast, sys; print('Python AST engine ready: version', sys.version)"

# Install Node.js 20 LTS via NodeSource
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Verify Node.js and npm versions
node -v   # Expected: v20.x.x
npm -v    # Expected: 10.x.x
```

---

## 3. Dedicated Service User & Directory Setup

Create an isolated, unprivileged system user `rewind` to run the application:

```bash
# Create system group and user
sudo useradd -r -s /bin/bash -m -d /opt/rewind rewind

# Allow rewind user access to run Node.js
sudo chown -R rewind:rewind /opt/rewind
```

Clone the repository and prepare workspaces under `/opt/rewind`:

```bash
# Switch to rewind user
sudo -u rewind -i

# Clone repository into app directory
git clone <YOUR_GIT_REPOSITORY_URL> /opt/rewind/app
cd /opt/rewind/app
git checkout security-hardening

# Install production dependencies and build Next.js application
npm ci
npm run build

# Exit back to sudo/root
exit
```

---

## 4. Production Environment Configuration

Create the secure production environment file at `/opt/rewind/app/.env.local`:

```bash
sudo -u rewind nano /opt/rewind/app/.env.local
```

### Exact Required Environment Variables

```ini
# Production Runtime
NODE_ENV=production
PORT=3000

# Authentication Configuration
# In production, Rewind strictly requires Firebase unless REWIND_ALLOW_LOCAL_AUTH_IN_PROD is explicitly set to true.
REWIND_ALLOW_LOCAL_AUTH_IN_PROD=false

# Session Cookie Signing Secret (64+ random hex characters)
# Generate via: openssl rand -hex 32
SESSION_SECRET=<YOUR_RANDOM_SESSION_SECRET_HEX>

# Firebase Web Client Configuration (Public/Restricted API Key)
NEXT_PUBLIC_FIREBASE_API_KEY=<AIzaSy...YourClientApiKey>
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=<your-project-id>.firebaseapp.com
NEXT_PUBLIC_FIREBASE_PROJECT_ID=<your-project-id>
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=<your-project-id>.appspot.com
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=<your-sender-id>
NEXT_PUBLIC_FIREBASE_APP_ID=<your-app-id>

# Firebase Admin SDK Configuration (Server-Side Service Account)
# Note: Use literal \n in the single-line private key string
FIREBASE_PROJECT_ID=<your-project-id>
FIREBASE_CLIENT_EMAIL=firebase-adminsdk-xxxxx@<your-project-id>.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC...\n-----END PRIVATE KEY-----\n"

# AI Provider Configuration (Keep inactive if not currently used)
NVIDIA_API_KEY=<optional-nvidia-nim-key>
# NEBIUS_API_KEY is inactive
```

Secure the permissions of `.env.local`:
```bash
sudo chown rewind:rewind /opt/rewind/app/.env.local
sudo chmod 600 /opt/rewind/app/.env.local
```

---

## 5. Systemd Service Configuration

Create `/etc/systemd/system/rewind.service`:

```ini
[Unit]
Description=Rewind Autonomous Code Recovery & Analysis Engine
After=network.target

[Service]
Type=simple
User=rewind
Group=rewind
WorkingDirectory=/opt/rewind/app
EnvironmentFile=/opt/rewind/app/.env.local
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=30
StandardOutput=journal
StandardError=journal
SyslogIdentifier=rewind

# Sandboxing and Security Hardening
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=read-only
ReadWritePaths=/opt/rewind/app/.rewind_store /opt/rewind/app/projects /opt/rewind/app/.next
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

Enable and start the service:
```bash
sudo systemctl daemon-reload
sudo systemctl enable rewind
sudo systemctl start rewind

# Verify service status
sudo systemctl status rewind
```

---

## 6. NGINX Reverse Proxy & Security Headers

Create the NGINX server block at `/etc/nginx/sites-available/rewind`:

```nginx
# Rate Limiting Zone: 10 requests per second per IP
limit_req_zone $binary_remote_addr zone=rewind_limit:10m rate=10r/s;

server {
    listen 80;
    server_name rewind.yourdomain.com; # Replace with your actual domain

    # Max body size for file uploads (matches server-side 2MB file limit + metadata)
    client_max_body_size 10M;

    # NGINX Access and Error Logs
    access_log /var/log/nginx/rewind_access.log combined;
    error_log /var/log/nginx/rewind_error.log warn;

    location / {
        limit_req zone=rewind_limit burst=20 nodelay;

        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;

        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }
}
```

Enable the configuration and reload NGINX:
```bash
sudo ln -sf /etc/nginx/sites-available/rewind /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl restart nginx
```

---

## 7. TLS / HTTPS Provisioning via Certbot

Provision a free, automated Let's Encrypt certificate:

```bash
# Ensure DNS records (A record) for your domain point to your VM IP
sudo certbot --nginx -d rewind.yourdomain.com --non-interactive --agree-tos -m admin@yourdomain.com --redirect

# Test automated certificate renewal
sudo certbot renew --dry-run
```

---

## 8. Log Rotation

Configure logrotate for Rewind service logs in `/etc/logrotate.d/rewind`:

```conf
/var/log/nginx/rewind_access.log
/var/log/nginx/rewind_error.log {
    daily
    missingok
    rotate 14
    compress
    delaycompress
    notifempty
    create 0640 www-data adm
    sharedscripts
    postrotate
        [ -f /var/run/nginx.pid ] && kill -USR1 `cat /var/run/nginx.pid`
    endscript
}
```

Systemd journal logs can be inspected with:
```bash
journalctl -u rewind -f
```

---

## 9. Automated Backups & Disaster Recovery

Rewind stores all user data, projects, code files, snapshots, audit history, and memories inside two persistent directories:
- `/opt/rewind/app/.rewind_store/`
- `/opt/rewind/app/projects/`

### Backup Script (`/opt/rewind/backup.sh`)
```bash
#!/bin/bash
set -euo pipefail

BACKUP_DIR="/opt/rewind/backups"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
ARCHIVE_NAME="rewind_backup_${TIMESTAMP}.tar.gz"

mkdir -p "${BACKUP_DIR}"

# Archive store and workspace directories
tar -czf "${BACKUP_DIR}/${ARCHIVE_NAME}" \
    -C /opt/rewind/app \
    .rewind_store projects

# Restrict backup permissions
chmod 600 "${BACKUP_DIR}/${ARCHIVE_NAME}"

# Keep only 7 days of local backups
find "${BACKUP_DIR}" -name "rewind_backup_*.tar.gz" -mtime +7 -delete

echo "Rewind backup completed: ${ARCHIVE_NAME}"
```

Make the script executable:
```bash
sudo chmod +x /opt/rewind/backup.sh
sudo chown rewind:rewind /opt/rewind/backup.sh
```

### Automated Daily Cron Job
Add to `/etc/cron.d/rewind-backup`:
```cron
0 3 * * * rewind /opt/rewind/backup.sh >> /var/log/rewind_backup.log 2>&1
```

### Disaster Recovery / Restore Procedure
To restore Rewind from a backup:
1. Stop the application service:
   ```bash
   sudo systemctl stop rewind
   ```
2. Extract the backup archive:
   ```bash
   sudo -u rewind tar -xzf /opt/rewind/backups/rewind_backup_YYYYMMDD_HHMMSS.tar.gz -C /opt/rewind/app/
   ```
3. Restart the application service:
   ```bash
   sudo systemctl start rewind
   ```
4. Verify system health and project listings:
   ```bash
   curl -s http://127.0.0.1:3000/api/system/limits | grep '"status":"ok"'
   ```
