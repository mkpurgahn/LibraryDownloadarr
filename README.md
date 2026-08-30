# LibraryDownloadarr

<p align="center">
  <img src="librarydownloadarr.png" alt="LibraryDownloadarr Banner" width="600"/>
</p>

> Your Plex library, ready to download

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Docker](https://img.shields.io/badge/docker-ready-brightgreen.svg)

## Overview

LibraryDownloadarr is a modern, self-hosted web application that provides a beautiful interface for downloading media from your Plex Media Server. Built with a sleek dark theme reminiscent of the *arr ecosystem (Sonarr, Radarr, Overseerr), it offers a user-friendly way to browse Plex libraries and download ready-to-play MP4 video with a single click.

**Key Features:**
- 🎬 **Plex OAuth Integration** - Users sign in with their existing Plex accounts
- 🔒 **Secure & Permission-Aware** - Respects Plex's user access controls and library restrictions
- 📱 **Progressive Web App** - Installable on mobile devices with a native-like experience
- 🎨 **Modern Interface** - Beautiful, responsive design that works on all devices
- 🔍 **Smart Search** - Search across all accessible libraries with relevance-based results
- 💬 **Plex Subtitle Search** - Find OpenSubtitles matches and burn the selected track into the MP4
- 📊 **Admin Dashboard** - Download history, logs, and settings management
- 🚀 **Easy Setup** - Initial setup wizard with guided configuration

---

## Why You Need LibraryDownloadarr

### Common Use Cases

**For Plex Server Owners:**
- **Traveling Users**: Give your users an easy way to download media for offline viewing on flights, road trips, or areas with poor connectivity
- **Backup & Migration**: Provide a simple interface for users to retrieve their content when migrating devices
- **Media Sharing**: Allow authorized users to download content you've shared with them from your server
- **Family & Friends**: Make it easy for less technical users to grab media without needing SSH, FTP, or direct file system access

**For End Users:**
- **Offline Viewing**: Download movies and shows to watch without an internet connection
- **Device Transfers**: Move media to devices that don't have Plex apps (e.g., car entertainment systems, older tablets)
- **Data Management**: Download media to free up Plex server storage while keeping personal backups
- **No Plex Sync Required**: Direct downloads without needing Plex Pass or configuring Plex Sync

### Why Not Just Use Plex?

While Plex is excellent for streaming, it has limitations for downloading:
- **Plex Sync** requires Plex Pass (paid subscription)
- **Mobile Downloads** only work within the Plex app and can't be easily transferred
- **No Bulk Downloads** - downloading multiple items is cumbersome
- **Complex for Non-Technical Users** - accessing media files directly requires server access

LibraryDownloadarr solves these problems with a simple, web-based interface that works everywhere.

---

## Installation Methods

### Prerequisites

Before installing, ensure you have:
- ✅ **Docker** installed on your system ([Get Docker](https://docs.docker.com/get-docker/))
- ✅ **Plex Media Server** running and accessible
- ✅ **Plex Account** with access to your server

### Method 1: Docker Compose (Recommended)

This is the easiest method for most users. Create a `docker-compose.yml` file:

```yaml
version: '3.8'

services:
  librarydownloadarr:
    build: .
    image: librarydownloadarr:local
    container_name: librarydownloadarr
    restart: unless-stopped
    # NPM reaches librarydownloadarr:5069 through the external proxy network.
    # Optional host-local diagnostics:
    # ports:
    #   - "127.0.0.1:5069:5069"
    environment:
      - PORT=5069
      - LOG_LEVEL=info
      - TRUST_PROXY_HOPS=1
      - PLEX_POLL_RATE_LIMIT=75
      - DATABASE_PATH=/app/data/librarydownloadarr.db
      - TOKEN_ENCRYPTION_KEY=${TOKEN_ENCRYPTION_KEY}
      # Match the path Plex reports in Part.file.
      - MEDIA_ROOTS=/data/media
      - BURN_CACHE_DIR=/app/cache
      - PLEX_REQUEST_TIMEOUT_SECONDS=30
      - FFMPEG_VIDEO_ENCODER=h264_vaapi
      - FFMPEG_QSV_DEVICE=/dev/dri/renderD128
      - TZ=America/New_York  # Change to your timezone
    volumes:
      - /mnt/cache/appdata/librarydownloadarr/data:/app/data
      - /mnt/cache/appdata/librarydownloadarr/logs:/app/logs
      - /mnt/cache/appdata/librarydownloadarr/cache:/app/cache
      - /mnt/user/data/media:/data/media:ro
    devices:
      - /dev/dri/renderD128:/dev/dri/renderD128
    networks:
      - proxy

networks:
  proxy:
    external: true
    name: proxy
```

**Start the application:**

```bash
docker-compose up -d
```

In Nginx Proxy Manager, set the upstream hostname to `librarydownloadarr` and
the upstream port to `5069`. Use HTTP between NPM and the container. If your
NPM installation uses `proxy_net` instead, change the external network name in
Compose.

### Method 2: Docker Run

If you prefer using `docker run` directly:

```bash
docker run -d \
  --name librarydownloadarr \
  --restart unless-stopped \
  --network proxy \
  --device /dev/dri/renderD128:/dev/dri/renderD128 \
  -e PORT=5069 \
  -e LOG_LEVEL=info \
  -e TRUST_PROXY_HOPS=1 \
  -e PLEX_POLL_RATE_LIMIT=75 \
  -e DATABASE_PATH=/app/data/librarydownloadarr.db \
  -e TOKEN_ENCRYPTION_KEY="$TOKEN_ENCRYPTION_KEY" \
  -e MEDIA_ROOTS=/data/media \
  -e BURN_CACHE_DIR=/app/cache \
  -e PLEX_REQUEST_TIMEOUT_SECONDS=30 \
  -e FFMPEG_VIDEO_ENCODER=h264_vaapi \
  -e FFMPEG_QSV_DEVICE=/dev/dri/renderD128 \
  -e TZ=America/New_York \
  -v /mnt/cache/appdata/librarydownloadarr/data:/app/data \
  -v /mnt/cache/appdata/librarydownloadarr/logs:/app/logs \
  -v /mnt/cache/appdata/librarydownloadarr/cache:/app/cache \
  -v /mnt/user/data/media:/data/media:ro \
  librarydownloadarr:local
```

The container-side media mount path must match the path Plex reports in
`Part.file`. This Unraid Plex container reports `/data/media/...`, so the
download portal mounts `/mnt/user/data/media` at `/data/media` too.

### Method 3: Build from Source

If you want to build the image yourself:

```bash
# Clone the repository
git clone https://github.com/mkpurgahn/LibraryDownloadarr.git
cd LibraryDownloadarr

# Build and start with Docker Compose
docker-compose up -d --build
```

### Configuration Options

Customize your deployment with environment variables:

| Variable | Description | Default | Example |
|----------|-------------|---------|---------|
| `PORT` | Application port | `5069` | `3000` |
| `TRUST_PROXY_HOPS` | Exact number of trusted reverse-proxy hops; keep `0` for direct deployments | `0` | `1` for Nginx Proxy Manager |
| `PLEX_POLL_RATE_LIMIT` | Plex PIN authentication checks allowed per 15 minutes | `75` | `75` |
| `LOG_LEVEL` | Logging verbosity | `info` | `debug`, `warn`, `error` |
| `DATABASE_PATH` | SQLite database location | `/app/data/librarydownloadarr.db` | `/data/db.sqlite` |
| `TOKEN_ENCRYPTION_KEY` | Required stable secret used to encrypt Plex tokens; minimum 32 characters | none | output of `openssl rand -base64 48` |
| `MEDIA_ROOTS` | Comma-separated local roots allowed for original media resolution | none | `/data/media,/archive` |
| `BURN_CACHE_DIR` | Writable derivative and subtitle cache | `/app/data/burn-cache` | `/app/cache` |
| `DOWNLOAD_TICKET_TTL_SECONDS` | Scoped original/derivative ticket lifetime | `86400` | `43200` |
| `DOWNLOAD_PUBLIC_ORIGIN` | Optional HTTPS origin for ticket URLs so large media can bypass an application tunnel or CDN | relative URLs | `https://files.example.com` |
| `PORTMAP_INTERNAL_HOST` | Internal reverse-proxy address used by the optional `direct-origin` UPnP profile | `192.168.1.158` | `192.168.1.20` |
| `PORTMAP_INTERNAL_PORT` | Internal HTTPS port used by the optional `direct-origin` profile | `443` | `443` |
| `PORTMAP_EXTERNAL_PORT` | Public HTTPS port maintained by the optional `direct-origin` profile | `8443` | `8443` |
| `PORTMAP_LEASE_SECONDS` | Requested UPnP lease duration | `1200` | `1200` |
| `PORTMAP_REFRESH_SECONDS` | Delay between UPnP mapping renewals | `600` | `600` |
| `PLEX_MEMBERSHIP_TTL_SECONDS` | Maximum interval between active-membership checks | `300` | `120` |
| `PLEX_REQUEST_TIMEOUT_SECONDS` | Maximum duration for each Plex metadata, activity, or subtitle transfer request | `30` | `45` |
| `PLEX_ALLOW_INSECURE_TLS` | Explicit opt-in for self-signed/local Plex TLS | `false` | `true` |
| `FFMPEG_PATH` | FFmpeg executable | `ffmpeg` | `/usr/bin/ffmpeg` |
| `FFMPEG_VIDEO_ENCODER` | Burn output encoder | `libx264` | `h264_vaapi` |
| `FFMPEG_QSV_DEVICE` | Intel QSV render device | `/dev/dri/renderD128` | `/dev/dri/renderD128` |
| `BURN_GLOBAL_CONCURRENCY` | Maximum simultaneous burns | `1` | `2` |
| `BURN_PER_USER_CONCURRENCY` | Maximum simultaneous burns per user | `1` | `1` |
| `BURN_ARTIFACT_TTL_HOURS` | Completed derivative retention | `168` | `72` |
| `BURN_CACHE_MAX_GB` | Maximum completed derivative cache size; oldest files are evicted first | `100` | `250` |
| `TZ` | Timezone for logs and dates | `America/New_York` | `Europe/London`, `Asia/Tokyo` |

`TOKEN_ENCRYPTION_KEY` is a required migration secret. On first startup after
upgrading, existing plaintext Plex tokens and session tokens are migrated in
place: Plex tokens are encrypted with AES-256-GCM and sessions are stored only
as SHA-256 token hashes. Keep the secret stable. Startup fails rather than
discarding existing users if it is missing or too short.

When the portal is routed through a tunnel but media should transfer directly,
set `DOWNLOAD_PUBLIC_ORIGIN` to the direct HTTPS hostname. Install a trusted
certificate on that hostname and expose its HTTPS listener. Routers that only
offer short-lived UPnP leases can use the opt-in `direct-origin` Compose profile
to renew the mapping:

```bash
docker compose --profile direct-origin up -d
```

### Initial Setup

1. **Navigate to your LibraryDownloadarr instance** (e.g., `http://localhost:5069`)

2. **Create Bootstrap Credentials** (First-time only):
   - Choose a temporary username and secure password
   - These credentials work only while connecting the first Plex server
   - Re-enter them on the setup page if the bootstrap session expires

3. **Configure Plex Connection** (Settings page):
   - **Plex Server URL**: Your Plex server address (e.g., `http://192.168.1.100:32400`)
   - **Plex Token**: Your Plex authentication token ([How to find your token](https://support.plex.tv/articles/204059436-finding-an-authentication-token-x-plex-token/))
   - Click **Test Connection** to verify
   - Server details (Machine ID and Name) are fetched automatically

4. **Start Using**:
   - Everyone signs in through Plex OAuth
   - The Plex account that owns the configured server receives administrator access

### Reverse Proxy Setup (Production)

For production deployments, use a reverse proxy with HTTPS. The application
port must not be directly exposed to the internet; only the reverse proxy
should be able to reach it. The Compose example attaches LibraryDownloadarr to
the existing external `proxy` network and publishes no host port. Configure
Nginx Proxy Manager with upstream `librarydownloadarr:5069`. It sets
`TRUST_PROXY_HOPS=1` for that one proxy hop so Express and
`express-rate-limit` safely use the forwarded client address.
Never enable proxy trust on a directly exposed deployment, because clients
could spoof forwarding headers.

#### Nginx Example

```nginx
server {
    listen 443 ssl http2;
    server_name downloads.yourdomain.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://localhost:5069;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_request_buffering off;
        proxy_buffering off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        send_timeout 3600s;
    }
}
```

Apply the same buffering and timeout settings to a separate direct-download
host. That host can be restricted to `/api/health` and
`/api/media/downloads/<ticket>`; the browser accelerator does not require any
other public route.

#### Traefik Example (docker-compose.yml)

```yaml
services:
  librarydownloadarr:
    image: ghcr.io/kikootwo/librarydownloadarr:latest
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.librarydownloadarr.rule=Host(`downloads.yourdomain.com`)"
      - "traefik.http.routers.librarydownloadarr.entrypoints=websecure"
      - "traefik.http.routers.librarydownloadarr.tls.certresolver=letsencrypt"
      - "traefik.http.services.librarydownloadarr.loadbalancer.server.port=5069"
```

---

## How It Works

### Authentication Flow

LibraryDownloadarr uses Plex authentication after a one-time local bootstrap:

1. **Initial Bootstrap**:
   - Temporary local credentials configure the first Plex connection
   - Setup can be resumed with those credentials until Plex is configured
   - The local account and its sessions are removed after Plex owner identity is verified

2. **Plex OAuth Authentication**:
   - Users click "Sign in with Plex"
   - Redirected to Plex.tv for authorization
   - LibraryDownloadarr verifies user has access to your configured Plex server
   - User's Plex permissions are automatically enforced
   - Only the exact Plex server owner can access settings, logs, and global download history

### Security Model

**Server Lock**: LibraryDownloadarr stores your Plex server's Machine ID during setup. When users authenticate:
- The app verifies they have access to YOUR specific Plex server
- Users without access to your server are denied
- This prevents random Plex users from accessing your server through your LibraryDownloadarr instance

**Permission Inheritance**: All Plex permissions are respected:
- Users only see libraries they have access to
- Downloads use the user's own Plex token
- Shared library restrictions apply

Membership is checked against the configured exact Plex machine identifier.
There is no fallback to another server in the user's Plex account. Membership
is revalidated on a bounded TTL and whenever a download ticket or subtitle burn
job is created. There is no ongoing local administrator login. Administrator status is derived
from the stable Plex account ID associated with the configured server owner's
token, not from a username supplied by the browser.

### Download Process

1. **User browses libraries** available to their Plex account
2. **Search or browse** for desired media
3. **Click Download MP4** on a movie or episode, or select multiple episodes
4. **Existing MP4 video starts immediately; other video joins the persistent conversion queue**
5. **The download starts automatically** when preparation finishes
6. **A scoped ticket is created** for the exact user, ratingKey, Part, and file
7. **The local file streams with HTTP Range support**, including `HEAD`, `200`,
   `206`, and `416`, so browser retries can resume safely
8. **Download recorded** in history (visible to admins)

Tickets are cryptographically random, stored only as hashes, expire after 24
hours by default, and do not grant API or session access. Originals are never
modified. `Part.file` is resolved with the Plex owner token only after the
user's token proves access, canonicalized with `realpath`, and restricted to
`MEDIA_ROOTS`.

Video is MP4-first automatically. Existing MP4 sources download directly.
H.264/AAC sources in other containers are repackaged without re-encoding,
H.264 sources with other audio keep the video and convert audio to stereo AAC,
and other video codecs are transcoded to H.264/AAC. Audio-only media retains
its original format.

Desktop Chromium browsers automatically split single-file video downloads
across up to four long Range requests and write the chunks directly to a
user-selected file. Pausing commits a non-secret checkpoint; resuming requires
selecting the same partial file. Browsers without the File System Access API
use the native resumable download path. Batch and season conversions queue
safely and start native browser downloads as each MP4 becomes ready.

Selecting an authorized subtitle creates an asynchronous burn job, then starts
the resulting MP4 download automatically. Text subtitles use libass; supported
bitmap subtitles use FFmpeg overlay. If Plex omits real embedded subtitle
streams, the authorized local media file is inspected with `ffprobe`. Outputs
are atomically published into `BURN_CACHE_DIR`.

For videos without a suitable local track, **Find subtitles** searches the
configured Plex server's on-demand subtitle provider. Search results are
represented by short-lived, user-scoped opaque IDs. When a result is selected,
the backend temporarily asks Plex to attach it, copies the subtitle into the
portal cache with a 50 MiB limit and content fingerprint, restores the user's
previous Plex subtitle selection, and removes the temporary Plex stream. The
owner token, provider resource key, and cached subtitle path are never exposed
to the browser.

For Unraid Intel UHD 730, mount `/dev/dri` and set
`FFMPEG_VIDEO_ENCODER=h264_vaapi`; development should use `libx264`. The image
also supports `h264_qsv`, but VAAPI is the verified path for this Unraid host.

Season and album ZIP downloads are no longer supported because streamed
archives cannot resume safely. Download individual episodes or tracks through
scoped tickets instead.

### Download and Burn API

All creation and job-management endpoints require the normal Bearer session
header. The byte route accepts only its scoped ticket.

| Method | Endpoint | Result |
|--------|----------|--------|
| `POST` | `/api/media/download-tickets` with `{ items }` | batch `{ tickets, errors }` |
| `POST` | `/api/media/compatible-jobs` with `{ items }` | batch `202 { jobs, errors }` |
| `POST` | `/api/media/:ratingKey/download-ticket` with `{ partKey }` | `{ url, expiresAt, filename }` |
| `POST` | `/api/media/:ratingKey/compatible-jobs` with `{ partKey }` | `202 { job }` |
| `GET` | `/api/media/:ratingKey/subtitle-search?partKey=...&language=en` | short-lived opaque subtitle results |
| `POST` | `/api/media/:ratingKey/burn-jobs` with `{ partKey, subtitleStreamId }` | `202 { job }` |
| `GET` | `/api/media/burn-jobs/:jobId` | `{ job }` |
| `DELETE` | `/api/media/burn-jobs/:jobId` | cancellation result |
| `POST` | `/api/media/burn-jobs/:jobId/ticket` | `{ url, expiresAt, filename }` |
| `GET` / `HEAD` | `/api/media/downloads/:ticket` | original or derivative bytes with Range semantics |
| `GET` | `/api/media/season/:seasonRatingKey/download` | `410`; download individual episodes |
| `GET` | `/api/media/album/:albumRatingKey/download` | `410`; download individual tracks |

Burn job statuses are `queued`, `preparing`, `ready`, `failed`, and
`cancelled`; progress is reported from 0 to 100 with an error, filename, and
size when applicable. Media metadata includes each Part's authorized subtitle
tracks with stable ID/index, language, display title, codec, forced/SDH flags,
and embedded/external classification.

### Data Storage

- **Database**: SQLite database stores users, sessions, settings, and download history
- **Logs**: Application logs written to `logs/` directory
- **Read-only Media Access**: Original media is mounted read-only and is never deleted or modified
- **Derivative Cache**: Automatically prepared and subtitle-burned MP4 files are stored only in the configured writable cache, cleaned up by TTL, and bounded by `BURN_CACHE_MAX_GB`

### System Requirements

**Minimal:**
- CPU: 1 core
- RAM: 512 MB
- Storage: 100 MB plus logs and enough cache for one generated MP4
- Network: Access to Plex server

**Recommended:**
- CPU: 2+ cores (for concurrent downloads)
- RAM: 1 GB
- Storage: enough cache for the configured burn concurrency and retention TTL
- Network: Good bandwidth between LibraryDownloadarr and Plex server

---

## How to Contribute

We welcome contributions from the community! Here's how you can help:

### Reporting Issues

Found a bug or have a feature request?

1. **Check existing issues** to avoid duplicates
2. **Open a new issue** with:
   - Clear description of the problem/feature
   - Steps to reproduce (for bugs)
   - Expected vs actual behavior
   - Environment details (Docker version, browser, etc.)

### Contributing Code

1. **Fork the repository**
   ```bash
   git fork https://github.com/kikootwo/LibraryDownloadarr.git
   ```

2. **Create a feature branch**
   ```bash
   git checkout -b feature/your-feature-name
   ```

3. **Make your changes**
   - Follow existing code style
   - Add comments for complex logic
   - Update documentation as needed

4. **Test your changes**
   ```bash
   # Backend tests
   cd backend
   npm test

   # Frontend tests
   cd frontend
   npm test

   # Build test
   docker-compose build
   ```

5. **Commit with clear messages**
   ```bash
   git commit -m "Add feature: descriptive message"
   ```

6. **Push and create Pull Request**
   ```bash
   git push origin feature/your-feature-name
   ```

### Development Setup

For local development:

```bash
# Clone repository
git clone https://github.com/kikootwo/LibraryDownloadarr.git
cd LibraryDownloadarr

# Backend (runs on port 5069)
cd backend
npm install
npm run dev

# Frontend (runs on port 5173)
cd frontend
npm install
npm run dev
```

---

## Troubleshooting

### Cannot connect to Plex server

**Symptoms**: "Failed to connect" errors in settings or when browsing

**Solutions**:
1. Verify Plex server URL is correct and accessible from the LibraryDownloadarr container
2. Check Plex token is valid ([Generate new token](https://support.plex.tv/articles/204059436-finding-an-authentication-token-x-plex-token/))
3. Use the **Test Connection** button in Settings
4. Check firewall rules between LibraryDownloadarr and Plex server
5. For Docker: Ensure network connectivity (`docker network inspect`)

### Plex OAuth login fails

**Symptoms**: "Access denied" or "No access to server" errors

**Solutions**:
1. Ensure Plex server Machine ID is correctly configured in Settings
2. Verify user has been granted access to your Plex server
3. Check that user's Plex account is active and not suspended
4. Try logging in directly to Plex web interface to verify account status

### Downloads not starting

**Symptoms**: Download button doesn't work or fails immediately

**Solutions**:
1. Check browser console for JavaScript errors (F12 → Console tab)
2. Verify user has proper Plex library permissions
3. Check file exists and is accessible in Plex
4. Review logs: `docker logs librarydownloadarr`
5. Ensure browser allows popups and downloads

### Port already in use

**Symptoms**: Container fails to start with port binding error

**Solutions**:
1. Change port mapping in docker-compose.yml: `"8080:5069"` (use 8080 or another free port)
2. Find process using port: `lsof -i :5069` or `netstat -tulpn | grep 5069`
3. Stop conflicting service or choose different port

### Container won't start

**Symptoms**: Container exits immediately or won't start

**Solutions**:
1. Check logs: `docker logs librarydownloadarr`
2. Verify volume paths exist and have correct permissions
3. Ensure Docker has enough resources (RAM, CPU)
4. Try pulling latest image: `docker-compose pull`
5. Clean rebuild: `docker-compose down && docker-compose up -d --build`

---

## Security Considerations

**Production Deployment Checklist:**
- ✅ Use HTTPS via reverse proxy (nginx, Traefik, Caddy)
- ✅ Protect the Plex owner account with a strong password and multi-factor authentication
- ✅ Configure proper Plex server URL (not public if on local network)
- ✅ Keep Plex token secure (never commit to version control)
- ✅ Regularly update to latest Docker image
- ✅ Monitor logs for suspicious activity
- ✅ Use network isolation (Docker networks)
- ✅ Implement rate limiting at reverse proxy level

**Built-in Security Features:**
- Session-based authentication with 24-hour expiration
- Machine ID validation prevents unauthorized server access
- Rate limiting on API endpoints
- User permissions inherited from Plex
- All operations logged for audit trails
- CORS protection enabled

---

## Support & Community

- 💬 **Issues**: [GitHub Issues](https://github.com/kikootwo/LibraryDownloadarr/issues)
- 🐛 **Bug Reports**: Use the issue template on GitHub
- 💡 **Feature Requests**: Open an issue with the "enhancement" label

---

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE) file for details.

## Acknowledgments

- Inspired by [Overseerr](https://overseerr.dev) and [Wizarr](https://wizarr.dev)
- Built with [Plex API](https://www.plexopedia.com/plex-media-server/api/)

---

<p align="center">
Made with ❤️ for the Plex community
</p>
