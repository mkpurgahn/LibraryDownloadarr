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

## Library navigation

Home cards and desktop/mobile library navigation share alphabetical ordering:
**Audiobooks, Books, Movies, Shows** for the standard libraries. Custom and additional
permission-filtered Plex libraries retain their names and IDs; only the standard
`TV Shows` navigation label becomes `Shows`. Nothing is renamed on Plex.
Books contains reading originals, including manga and unsupported-but-downloadable
ebook formats. Audiobooks contains audio originals. A mixed-format title has a
separate presentation in each section: cards, detail controls, original-file lists
and bulk downloads show only that section's format.
Missing or unplayable originals remain discoverable, not silently reclassified.
The sources load independently: a Plex outage does not hide Books/Audiobooks, and a
Books provider outage does not hide Plex.

**Recently Added** and the header search are Plex-only; Books and Audiobooks each
have category-scoped search. Books offers reading and reading-original downloads;
Audiobooks offers listening and audio-original downloads. Reader links return to
Books; player links return to Audiobooks, with active playback preserved across
navigation. Legacy `/ebooks` links redirect to `/audiobooks`; saved reader URLs
under either old prefix still open the same original in Books. Pure-format detail
links in the wrong section redirect to the matching section. Mixed titles never
restore a combined-format detail. These are views, not new permission boundaries,
file migrations, or changes to original identities and saved progress.
Download totals and Settings are compact owner-only Home utilities. Download
History, Logs, and Settings remain under **Management** in the sidebar.

## Books preview (disabled by default)

The Books subsystem uses Audiobookshelf 2.30.0 as its catalog, independently of
Plex and Seekr. Only the explicitly selected `ebooks` library
(`163ac435-50a9-4f56-96d0-276edf9303c1`) is shared with existing authorized Plex
users. Its name does not mean ebook-only: a title may contain ebooks and audio.
Future libraries are not inherited. No extra media mount, scanner, ABS database
access, conversion, or source-file changes are involved.

`BOOKS_ENABLED` defaults to false. Enabling also requires the Plex owner's
separate Books configuration, a verified server-binding record, and a protected
ABS credential for an active non-admin principal restricted to that library.
Required effective permissions are catalog/content access and download, with
update/delete/upload/admin disabled and `accessAllLibraries=false`. Library
visibility alone is not proof of these permissions. Provisioning credentials and
production enablement require an operator decision; the application does not
create users or extract another application's token.

Books credentials are encrypted in their own configuration table using
`TOKEN_ENCRYPTION_KEY`, not ordinary settings. Owner responses never return the
credential or provider origin. Use HTTPS, or an explicitly approved private HTTP
origin. Redirects are rejected. Catalog failures do not invalidate Plex login.
Configuration changes invalidate Books identities and caches. Catalog and cover
responses are private/no-store; files use item-scoped opaque identities rather
than provider paths. Missing optional descriptions or names use placeholders;
invalid chapters fall back to tracks, and invalid timelines disable listening
without hiding independently valid ebooks or original downloads.

Catalog requests may supply `category=books|ebooks` and an optional `q` on the
existing items endpoint. These API names remain unchanged: the Books reading
destination requests `category=ebooks`, while Audiobooks requests `category=books`.
Omitted category preserves the legacy API contract. Reading and single-/multi-file
audio browsing use native filtered pagination.
All-audio browsing combines ABS's disjoint single/multi file partitions before
sorting, counting and pagination; `tracks.audio` is not a supported ABS filter.
The union is sequential and ephemeral: at most 10,000 entries, 102 requests,
32 MiB aggregate accepted JSON bytes and 20 seconds, with the existing 100-item provider pages,
8 MiB per-response and 10-second per-response guards unchanged.
The remaining aggregate allowance is enforced before buffering each body chunk,
including responses without a reliable Content-Length. An over-budget chunk is
discarded and the upstream response is destroyed; Node/OS transport buffers may
already contain additional bytes. This is not a universal wire-byte or total
process-memory ceiling. Catalog list/search/library operations bind the current
session, expiry and configuration generation: revocation, expiry, configuration
changes or client disconnect cancel pending provider work, and identity and
generation are rechecked before delivery. Operation listeners and timers are
removed on success and failure.

Category search preserves ABS 2.30's book matching (title, subtitle, ISBN or ASIN,
not author-name matching). It requests a complete native response before
category/source filtering, selected title/author sorting, counting and pagination.
A full 10,000-match response cannot prove completeness and is rejected, as are
oversized, inconsistent or unavailable responses. No partial result is presented
as a complete page or an empty category. Large searches may require a more
specific query; capacity failures remain explicit. Inventory is refreshed on
each request; there is no persistent index or catalog cache. Item/file access
still uses fresh authorization independently of category membership.

Original Books delivery uses same-origin, session-bound per-file tickets and a
Books-only `HttpOnly; Secure; SameSite=Strict` media cookie. The cookie cannot
authorize mutations or other API groups. GET and HEAD recheck membership and
the current item/file manifest. Logout, configuration changes, and shutdown
cancel Books streams without changing Plex's download transport.
Fresh membership checks belong to the transfer and reader handlers, including
accepted case and trailing-slash aliases.

Original bytes support single bounded, open, and suffix ranges with truthful
HEAD/206/416 headers and If-Range restart behavior. Upstream weak ETags stay
weak; Books never use the Plex segmented accelerator or direct download origin.
A nonmatching If-Range restarts a well-formed single range with full 200,
even when the old offset exceeds the current size; a matching unsatisfiable
range and unsupported multipart ranges still return 416.
Missing safe validators/range support is explicitly fresh-download-only.
Changed representations invalidate the old ticket. Native browser downloads
must be reported as started, not as proven complete. Capacity is two Books file
streams per user and eight globally; file connection and idle deadlines are
10 and 60 seconds respectively, not a short total-transfer deadline.

Reading and listening progress is stored in LibraryDownloadarr, never in ABS's
shared account. Records are isolated by user, provider, library, item, mode,
and original/ordered-audio edition. An explicit writer claim creates a new
epoch; stale devices and out-of-order updates receive a conflict rather than
overwriting newer progress. Intentional rewind is supported, and an identical
retry does not create another revision. Replaced originals retain incompatible
history instead of silently reusing a stale page, section, or track position.
History responses show the latest 100 records; older versions remain stored.
EPUB positions require a current prepared spine and bounded text offset; file
and sanitizer-policy changes make older locations incompatible.
Pending progress requests cannot read or commit after their session is revoked
or expires, even if a provider response arrives later.

All readable originals (CBZ, PDF and EPUB) default to **Continuous** vertical
reading across page or spine-section boundaries. **Reading mode** switches to
**Paged** and remembers the explicit choice for this signed-in user in this
browser. Continuous scrolling stops at the end of the selected original; it
does not repeat the book or open another original. A small current/neighbor
window is retained, not the whole book's DOM, decoded images or canvases.
Previous/next page buttons appear only in Paged mode. Continuous keeps direct
page jumps or Contents, page counts, view options and fullscreen controls;
keyboard and touch navigation remain available in both modes.
CBZ image clicks and taps turn pages only in **Paged** mode. **Continuous** mode
has no click-to-turn action or paging hand cursor; deliberate horizontal swipes,
keyboard navigation and direct page jumps remain available.
Short trailing CBZ pages and EPUB sections get enough trailing scroll space to
reach the top and load the next neighbor, without expanding that window or
preventing backwards scrolling.

Hover a CBZ or PDF page to see its page number; EPUB shows its section number
rather than an invented fixed page count. Keyboard focus also exposes these
labels. Labels overlay the page without changing its text, selection or position.
EPUB book styles remain scoped to the book content, separate from reader labels.

**Full screen** is an explicit action, never automatically restored. A brief
four-second hint explains Escape and the corners. Move the pointer to **any
viewport corner**, tap a corner, or press Tab to reveal all reader controls,
including **Exit full screen**. Controls overlay the book rather than moving it,
stay visible while hovered or focused (including menus), and hide shortly after
leaving. Reader controls retain color and focus feedback without animating their
visibility. Page-turn buttons still appear only in Paged mode. Unsupported or denied
native fullscreen uses an honestly labeled **Viewport-only view**. Errors and partial-preparation
warnings remain visible. Active audio keeps playing without reserving space for
its hidden outside toolbar. Mode, font, zoom and fullscreen changes preserve
logical positions rather than saving layout-clamped offsets.
In fullscreen Paged CBZ reading, the left/right image-edge click areas extend
through the blank margins of the reading viewport. The center stays neutral;
the four corners still reveal controls without turning a page.
PDF presentation changes also retain the pending page/fraction while neighbors
render; an unrendered navigation target does not become saved progress. EPUB
Escape works from both the reading viewport and embedded controls.

The EPUB preview has contents, viewport-sized previous/next reading screens,
scrolling, font size, and private resume. Paged navigation crosses to another
spine section only at the current section's boundary, not on every Next page.
PDF and EPUB do not wrap. Horizontal single-finger swipes work on touch-enabled
desktop/hybrid computers as well as narrow screens: left advances, right goes
back. Vertical touch scrolls; horizontal panning, selections, long presses and
multi-contact gestures do not turn pages.
A second device must explicitly claim the saved
position; conflicts offer **Resume saved position** or **Continue here**.
Positions save every ten seconds and on navigation/visibility changes when
possible. Network failures show an unsaved state; browser-close delivery is
best effort.
First-open preparation includes the initial writer claim; saved-position choices
appear only when a stored or conflicting position exists. EPUB text anchors
retain positions within long paragraphs across font changes and reader reopen.

CBZ manga originals use an image-page reader with compact directional arrows,
page jump, and clickable/tappable outer quarters of the visible page image.
The center and empty margins do not turn pages. Dragging, scrolling, selections,
and long presses do not activate the edges; a swipe never also counts as a tap.
Multi-contact and cancelled touch gestures do not turn or save another page,
including when a second contact starts on the heading or controls.
**View** contains fit-page, fit-width and 50-300% manual zoom; there is no direction
setting. The left arrow, left image edge and Left Arrow key go to the previous
page; the right equivalents go to the next page. Swipe left for next or right
for previous (only when the page is not horizontally scrollable).
Relative navigation loops within the selected original: previous on page 1
opens its last page, and next on its last page opens page 1. A one-page original
stays on page 1 with disabled arrows. Page jumps require a valid literal page
number and never wrap invalid values. Pages are not mirrored or reordered.
Explicit CBZ navigation pauses while a page loads, never crosses to another
original, and never advances automatically. A newly selected page starts at its top-left;
resuming a saved page retains its saved position.
The selected original's filename is
shown in the reader; separate chapter files never borrow another file's pages
or saved position. Vertical and horizontal within-page fractions survive zoom,
viewport resizing (including automatic scroll clamping), and reopening when
scrolling is available. Existing writer claims,
conflicts, intentional rewind and retry semantics apply. History from another
currently present ebook original does not make a new chapter incompatible;
history from removed originals is still retained and surfaced explicitly.

Original MP3/M4B playback uses one native audio element that remains active
across in-app navigation. Tracks follow ABS's included order, not filenames;
valid chapters, global seeking, pause/resume and 0.5-2x speed are available.
Only the current audiobook advances automatically, stopping at its final
track. Playback or timing failures stop instead of skipping a broken track or
starting a transcode. Browser codec checks are hints: actual decode failure
offers the original download, and rejected autoplay offers **Tap to resume**.
Gapless transitions and uninterrupted mobile background playback are not promised.

Listening positions have the same private writer/rewind/version semantics as
reading. Explicit Close stops media immediately and waits for its last save;
abrupt browser shutdown remains best effort. Books configuration changes clear
Books players/readers/ready links across the current browser's tabs without
clearing Plex authentication or Plex jobs. Existing downloaded bytes cannot be
revoked.

EPUB archives are processed in a cancellable worker, never in the main request
thread: 100 MiB compressed, 512 MiB expanded, 10,000 entries, 32 MiB per entry,
100:1 expansion ratio, 30 seconds, and a 256 MiB memory budget. Only one
preparation runs at a time. The separate database-scoped cache is limited to
1 GiB/24 hours and excludes active reads from eviction; handles expire after
30 minutes or with their application session. Restart may require preparation
again, but does not erase durable progress. Unsafe/encrypted/fixed-layout books
remain explicitly original-download-only.

CBZ uses that **same** preparation slot, ZIP validation, worker budget,
authenticated resource broker and 1 GiB cache, not another resource pool.
CBZ originals may be up to **256 MiB compressed**; EPUB retains its **100 MiB**
limit. Originals stream to private disk and the worker reads bounded chunks,
not one whole-archive memory buffer. The 512 MiB expanded, 32 MiB entry,
100:1 ratio and 256 MiB tracked-memory limits remain unchanged. Progressive CBZ
work has one cumulative 30-second processing budget, including directory parsing,
inflation, CRC and raster validation; changing pages or polling never resets it.
Preparation reserves the format's compressed allowance plus the expanded
allowance before downloading: at most 768 MiB for CBZ, leaving 256 MiB within
the existing 1 GiB cache budget for other entries. This is per-preparation
accounting, not a guarantee of free filesystem space or total process RSS.
The original copy rejects actual streamed bytes beyond its declared size or
allowance; a short or changed response is not accepted as a complete archive.
Additional CBZ limits are **1,000 pages**, **16,000,000 decoded pixels per page**, and
**8,192 pixels per side**. Static JPEG, PNG and WebP are supported. New CBZ readers
validate the whole ZIP directory first, then prioritize the first ten pages, or
the saved/requested page and its nearby window. Each page is fully CRC-checked
and decoded before it becomes readable; remaining pages prepare serially in the
background. Pending pages cannot replace the last rendered saved position.
Delayed claim acknowledgements do not replace a newer local position; queued
saves and leaving the reader retain the latest rendered anchor.
Late corruption stops preparation with a persistent partial-failure warning:
validated pages may remain available, but unvalidated pages never do and the
book is not reported complete. Retained pages stay charged to the same cache.
Old clients keep the complete, all-or-nothing preparation endpoint.
CBR/RAR, GIF, APNG, animated WebP, SVG,
HTML and nested archives are not supported. Originals are never modified.

Incremental startup requires exact conditional HTTP ranges from the source.
The broker checks response identity, range boundaries, length and complete EOF,
and spools at most 256 KiB per range. It allows at most 8,192 source requests and
the original's size plus 16 MiB of cumulative received-body allowance, including
interrupted requests. These are application body budgets, not TCP wire-byte
guarantees. Missing range support/validators or an ignored initial range may use
one explicitly labeled full-download fallback before any page is published;
changed/malformed responses never qualify. Lost range support after publication
stops preparation instead of starting a second whole-file transfer.
Rollback to the legacy complete endpoint is allowed only when the initial
progressive start endpoint is unsupported. After an accepted start, status or
descriptor failures terminate that attempt rather than starting fresh budgets.

Network spooling precedes each worker command. A job also has an absolute
five-minute deadline and an unrenewed 60-second preparing lease. One coalesced
two-second status/priority wait renews that lease, not the absolute deadline or
processing budget. Release, session/configuration/source invalidation and shutdown
cancel work and drain workers/streams before cleanup; revoked readers cannot
keep delivering even previously validated pages. Files and original progress
identities are unchanged.

Page order compares NFC-normalized full archive paths case-insensitively,
using locale-independent numeric runs (`1`, `2`, `10`). Equal numeric runs
sort shorter zero padding first (`1`, `01`); remaining ties use code-unit order.
Exact/NFC/case-folded duplicate paths are rejected. Only known non-page junk
is ignored: the root `__MACOSX` tree, AppleDouble `._*` basenames, `.DS_Store`,
`Thumbs.db`, `desktop.ini`, and `ComicInfo.xml`. Metadata is not executed or
used to fetch remote pages; unexpected other files fail explicitly.
ZIP record bounds use raw filename bytes, not the decoded or normalized name;
valid CP437 filenames remain supported with the same local-header, CRC and
native-image checks.

Pinned sharp 0.34.5 validates CBZ rasters inside the worker, with libvips
concurrency explicitly set to **one** (including musl/Alpine) and its operation
cache disabled and a one-second native decode deadline per page. The browser
retains at most three validated page images in Continuous mode and one in Paged
mode (at most 48 million retained decoded pixels and 96 MiB of page blobs in the
continuous window, subject to the existing per-page limits). It displays the
foreground page before waiting for neighbors. Neighbor waits do not replace
the progressive source's latest requested-page priority. Abandoned fetch/decode
work is cancelled and object URLs are released on eviction, session/configuration
changes and close. Counters describe application-owned images, not browser RSS
or compositor memory.
The worker's 256 MiB tracked heap/external budget and V8 heap limits **do not**
bound native libvips allocations or whole-process RSS. Sampled process-RSS
evidence is reported separately, not as a hard memory guarantee. The legacy complete-reader
30-second hard watchdog first requests cooperative cancellation (up to one
second for file-handle cleanup), then waits for worker termination before
releasing its slot and cleaning temporary files. A sub-limit archive can still
be download-only on a constrained runtime. Reader handles renew on demand;
stable original/policy-bound progress survives handle/cache expiry and restart.

The reader uses one opaque-origin sandbox, a self-contained hash-CSP script,
DOMPurify sanitation and parsed CSS restrictions. Book payloads are served as
authenticated, non-executable attachments; only the isolated frame constructs
book DOM. It receives no credentials or provider paths. Conservative additional
bounds are 100,000 XML nodes, 128 levels, one million characters per section,
512 KiB per stylesheet, and **64 MiB aggregate assets across the active window**,
including in-flight assets. Continuous EPUB keeps at most three sanitized spine
sections (one in Paged mode), each with an isolated style scope and a sanitized
Foliate text-anchor mirror. Shared assets use reference-counted object URLs and
are released when their last section is evicted. A bounded request queue feeds
the unchanged two-active-request private resource broker. Dependency
licenses ship at `/books-reader-notices.txt`; Foliate is pinned to reviewed
commit `78914aef4466eb960965702401634c2cb348e9b1`.

The PDF preview uses pinned PDF.js 5.4.624 display/worker APIs, not a PDF plugin
or embedded generic viewer. It offers page controls, scrolling, zoom, accessible
text and private page/within-page resume. Evaluation, XFA, scripting and
interactive annotation/form/link actions are not enabled. Fonts and CMaps come
only from the packaged, allowlisted assets.

PDF limits are **512 MiB source**, **5,000 pages**, **16 million pixels per
rendered page**, and **128 MiB of application-managed retained page/render/range
cache**. The source backing is separate: PDF.js reserves a full-length source
buffer even when only requested ranges arrive. The counters report logical
source backing and owned cache separately, not measured resident memory.
Engine/browser overhead is additional; total memory is not bounded to 128 MiB
or exactly 640 MiB. Large-file support is browser/device-dependent, with explicit
download-only/capability errors rather than a guarantee for every sub-limit PDF.
Current and neighboring pages are retained; abandoned work is canceled and
evicted. Each reader instance owns its document/worker, destroys it on close or
replacement, and aborts its ranges without closing another tab's reader.
An ignored or changed range response never becomes a second full-file download
inside the reader. Original downloads remain available independently.

The Books browse/detail/settings views and original-download queue are available
in the preview. Inventory filters do not promise browser codec compatibility.
For a large selection, **Prepare all downloads** issues individual links in
batches of at most 100 and starts the first available file; the remaining files
have explicit **Save file** actions. This avoids silently exceeding stream limits
when native browser completion cannot be observed. Expired links can be renewed
per file. A valid manual Save changes only that row to **Started**, never Complete;
expired or cancelled handoffs remain ready for renewal or another attempt.
Same-origin Books handoffs use one hidden, script-disabled download frame so
media-capable browsers do not replace the application with an inline original.
The frame is cleared on session/configuration changes and page exit. The server's attachment
headers, including UTF-8 filenames, remain authoritative; a browser may adapt
its suggested local filename. Cancelled automatic handoffs expose an explicit
Save action without being marked Started.

Books queue rows/tickets and in-memory protected views are cleared on user or
session change, including changes in another tab. Existing user-scoped Plex jobs
and accelerated-download checkpoints retain their original storage format.
Logout revokes the current application session and Books streams even when Plex
membership lookup is temporarily unavailable; it never revokes another user's
session.
Do not enable this preview for production until real provider, reader-isolation,
resume, privacy, and preservation acceptance has passed. The isolated read-only
proof entrypoint is `backend\dist\books\proof\verifyAbs.js --read-only --out
artifacts\books\L1`; use protected `BOOKS_PROOF_ABS_TOKEN` or
`BOOKS_PROOF_ABS_TOKEN_FILE` input and a redacted restricted-principal attestation.
Proof never provisions an account or mutates ABS. A successful build is not
provider or playback proof.

`--delivery --fixture-manifest <file>` also exercises the built HTTPS application
with synthetic application sessions and known original hashes. Supply protected
`BOOKS_PROOF_TLS_CERT_FILE` and `BOOKS_PROOF_TLS_KEY_FILE`; do not remove Secure
cookies or substitute HTTP for a missing fixture certificate.
The fixture helper has no test-login route and refuses non-isolated providers.
Headless browser tests first verify their generated fixture CA. Browser-local
test trust is confined to that loopback fixture (Chromium service-worker tests
pin its exact public key); no operating-system trust settings are changed.

External candidate tests use explicit `BOOKS_TEST_URL` (isolated HTTPS),
`BOOKS_TEST_CA_FILE` and owner-only `BOOKS_TEST_SESSION_FILE` inputs. The fixture
CLI writes synthetic application sessions and a private item/ino-to-LDA mapping,
not a public identity endpoint. The harness verifies the actual principal,
binding and built index before using it, and does not mutate an externally
owned fixture. `BOOKS_FIXTURE_MANIFEST` supplies the versioned consumer handoff;
`BOOKS_STREAMED_DELIVERY_PROOF` can link separately saved large-file evidence.
Large proof downloads use bounded streaming and hashes read back from disk,
not whole-audiobook buffers.

Pinned Windows Playwright WebKit currently rejects both generated MP3 and AAC
even in a transport-free codec probe. Its honest unsupported/download fallback
is checked there; positive decode/seek/resume runs on the version-matched Linux
WebKit image. These are distinct labeled results, not physical Safari/iOS
certification. Source backing, retained reader-cache accounting and unmeasured
browser/engine overhead must not be conflated in resource reports.

Use Node 20 for fixture tests, matching the application's native SQLite runtime.
Run `npm run test:books` in `frontend` after the backend/frontend builds. The
wrapper runs the pinned Playwright config headlessly in Chromium, Firefox, and
WebKit at desktop/narrow sizes, scopes profiles/downloads to `.test-data`, and
scrubs capability URLs and credentials from retained diagnostics. Each run has
a distinct evidence directory. `npm run test:books:tools` verifies that scrubber.
Only after a missing-browser failure, `npm run test:books -- install chromium
firefox webkit` installs the required binaries into this worktree. These test
artifacts and protected fixture inputs are excluded from Git and Docker context.

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
| `APP_PUBLIC_ORIGIN` | Canonical HTTPS portal origin for same-origin Books mutations behind TLS-terminating proxy chains; never the separate download hostname | request-derived origin | `https://downloads.example.com` |
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

If TLS terminates before the last proxy (for example, Cloudflare Tunnel reaching
Nginx Proxy Manager over HTTP), that proxy may overwrite `X-Forwarded-Proto` with
`http`. Set `APP_PUBLIC_ORIGIN` to the exact HTTPS origin users open, such as
`https://downloads.example.com`. Books otherwise rejects its media-session
bootstrap with `Same-origin request required`. The value must be one HTTPS
origin with no credentials, path, query or fragment. It pins the allowed Origin;
it does not enable CORS, trust arbitrary forwarded headers, change proxy-hop
trust, or relax bearer, membership, Fetch Metadata or Secure-cookie checks.
Leave it unset for direct deployments or proxies that preserve the public
scheme correctly. Do not use `DOWNLOAD_PUBLIC_ORIGIN` for this value.

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
   - After authorization, the verified user and application token are activated together; the original app opens without needing a reload after closing the Plex popup
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
Source and external subtitle filenames are preserved, including apostrophes,
Unicode, and FFmpeg filter punctuation; no media renaming is required.

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
   Backend tests require FFmpeg with libass and libx264 on `PATH` (or set
   `FFMPEG_PATH`). Subtitle regressions generate tiny temporary videos, compare
   burned frames, and remove their fixtures without touching library media.
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
