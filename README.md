# Eufy Security

Add support for Eufy Cam in Homey.
Link: https://homey.app/a/com.eufylife.security


> [!CAUTION]
> # 🚨🚨🚨 APP DEPRECATION NOTICE 🚨🚨🚨
>
> ### ⚠️ Eufy is shutting down the legacy APIs this APP is built on. ⚠️
>
> Eufy is in the middle of a large migration of their ecosystem. The newer **Eufy Mega**
> platform (the "5-in-1" app, covering Security / Clean / Lights / Care) is gradually
> becoming the only supported backend, and Eufy has **already started removing access to
> the legacy APIs** this library was originally built on. Until recently both worked in
> parallel — that is no longer guaranteed.
>
> **🔔 What this means for you:**
>
> - 🟢 A recent PR in https://github.com/bropat/eufy-security-client restores **push notifications** against the new v6 ("eufy_mega")
>   backend, so push works again **for now**. This is a short-term stopgap.
> - 🟡 Other functionality that still depends on legacy endpoints may stop working
>   **without warning** as Eufy continues the rollout. The current Eufy app no longer
>   uses the legacy API at all.
> - 🔴 Once the legacy API is fully shut down, **this library will stop functioning** —
>   no amount of patching here will change that.
>
> **🚧 What's next:**
>
> Join us on Discord to follow the development of the new integration and get updates on the Eufy Mega migration:
>
><a target="_blank" href="https://discord.gg/5wjQ2asb64"><img src="https://dcbadge.limes.pink/api/server/5wjQ2asb64" alt="" /></a>


# Account Information

Because of the way the Eufy Security private API works, an email/password combo cannot
work with _both_ the Eufy Security mobile app _and_ this library. It is recommended to
use the mobile app to create a secondary "guest" account with a separate email address
and use it with this library.

# Usage
- Install this app on your Homey.
- Go to `add devices` 
- Provide your Username and Password. Click Next
- Available devices show up

# Install this fork on Homey Self-Hosted Server

The Docker installer follows the existing Lennox/Rinnai workflow. On your Mac, with Docker running, use:

```bash
HOMEY_AUTH_VOLUME=homey-lennox-cli-auth \
bash /Users/mgomon/Code/homey/com.eufylife.security/scripts/install.sh --via-foreman
```

This explicitly reuses the Homey CLI login volume from the Lennox installer. Select the self-hosted Homey when prompted. If Homey asks for authorization, open the displayed link in your browser and enter any sign-in code only into the terminal. Account credentials stay in the selected Docker volume.

For a separate Eufy login volume, omit `HOMEY_AUTH_VOLUME`. To use a directly reachable Homey, omit `--via-foreman`. The script can be launched by absolute path from any directory; a new checkout uses `bash scripts/install.sh --via-foreman` from its own directory. `HOMEY_ID` optionally selects a known Homey by ID, and `HOMEY_SSH_JUMP`, `HOMEY_SSH_TARGET`, and `HOMEY_TUNNEL_PORT` override the defaults `foreman.gnet.com`, `iot-mgmt`, and `14859`.

The installer builds and tests entirely inside Docker with Node 24 and pinned Homey CLI 4.6.1. It fetches the pinned public Eufy client over HTTPS, without mounting your SSH keys. Installer dependencies are kept outside the app's production dependency tree. The build consumes and checks the real upload archive, including both new drivers' pairing/repair views and the Eufy client's compiled protocol assets.

With `--via-foreman`, installation uses a temporary localhost-only tunnel to the self-hosted server. Before sending authenticated requests through it, the installer verifies that the endpoint belongs to the selected Homey. It uploads with `clean:false`, preserving existing app data and paired devices, and verifies the expected app ID and version become enabled and running. Upload failures are reported as failures even if an older app is still running.

Installation replaces the Eufy app using its existing ID `com.eufylife.security`. It does not pair devices, operate locks, restart the Homey server, or apply the separate Lennox/Homey web patches. Keep a backup of the installed Eufy app and Homey data before upgrading. The SSH tunnel closes on exit; installer containers and the authentication volume are retained.

# Smart locks in this fork

Version 3.43.0 adds **Eufy Security → Smart Lock** in Homey's device picker. It uses Homey's native lock control and Flow cards, reported lock state, and battery readings where the device exposes them. Existing camera, doorbell, sensor, and HomeBase drivers retain their pairing and controls.

The grouped driver includes the command families implemented by the pinned Eufy client:

| Family | Models or variants |
| --- | --- |
| Smart Lock / Touch with Wi-Fi bridge | T8500, T8510 |
| Touch & Wi-Fi, S230, S231 | T8520, **T8510P**, T8520P |
| Video Smart Lock S330 | **T8530**, including the original Kickstarter model |
| Retrofit E110 / R10 and E130 / R20 | T8503, T8504 |
| C210 / E110 and C220 | T8502, T8506 |
| Lever Smart Lock C33 | T85L0 |
| FamiLock S3 and E34 | T85V0, T85P0; client-exposed control needs hardware validation |

Pair the lock in Eufy's app and confirm the account used by Homey can control it remotely. Bluetooth-only T8500/T8510 locks require an Eufy Wi-Fi bridge. The S330/T8530 requires its Wi-Fi bridge or compatible HomeBase. The driver matches the client's supported device type and writable lock property; a similar product name or serial prefix is insufficient. C30/T85D0, E330/T8531, lock keypads, safes, and unrecognized newer locks are not offered as controllable locks.

Commands wait for a matching reported state or a fresh acknowledgment for an unchanged state. Retrofit models wait for their secondary acknowledgment. Rejection, disconnection, and timeout fail the Homey request. A timeout cannot cancel an operation already sent to Eufy, so check the actual lock before retrying. Missing startup state and a lost cloud connection leave the device unavailable. Normal battery-saving station sleep does not disable it.

Version 3.44.0 also exposes camera video and snapshot images for video locks when the client declares its livestream command, including T8530. Ordinary locks retain their existing controls. This does not add motion/doorbell capabilities, PINs, fingerprints, or user administration. The underlying client has gaps in MQTT state handling for video/FamiLock devices; manual and external changes need validation on the actual hardware. A successful client acknowledgment is not independent proof of physical deadbolt movement. Low-battery alerts follow the client's transient alert property; battery percentage is shown separately when available.

# Camera streaming and multi-view

Version 3.44.0 registers **Live** camera video with Homey on platform version 2, including supported doorbells, SoloCams and the S330/T8530 video lock. Homey's video proxy supplies playback to its mobile and web apps. Native NAS/RTSP remains the preferred source when already enabled in Eufy. Other supported cameras use their existing P2P livestream through a loopback-only HTTP MPEG-TS relay. The app does not enable RTSP or change camera privacy settings automatically.

For battery cameras with NAS enabled, version 3.44.2 verifies that the RTSP address actually produces a frame before using it. A cached address and the client's "started" flag alone do not mean a sleeping camera is serving video. If that bounded media check fails, the app falls back to Eufy's direct P2P stream for that device until the client reconnects. Wired cameras retain their existing native RTSP path. The fallback observes the same shared-HomeBase busy guard and changes no Eufy camera settings.

The P2P relay starts only when Homey requests video, shares one source between viewers and snapshot requests, bounds replay/viewer buffers, and stops unused sources. H.264 input is copied without transcoding. Some models, including the original S330 video lock, deliver H.265/HEVC even when H.264 is requested. Version 3.44.1 converts those streams to browser-compatible H.264, bounded to 720p, 15 fps and one encoding thread; snapshots from that relayed source use the same normalized feed. Native H.264/RTSP feeds retain their existing resolution. P2P playback currently carries video only; native RTSP audio remains handled by Homey.

The pinned Eufy client has one P2P video channel per Station connection. The default path therefore reports busy when a second camera requests that same connection. Version 3.44.7 uses opt-in independent Station connections while reusing the app's loaded Eufy library. Every selected P2P camera owns its video connection; unselected cameras retain their account Station path. A running private feed stays on its connection when another camera stops or reopens. The ordinary account Station continues handling controls and events. Each private connection receives only a restricted read-only API for its own station and camera, with no copied account credentials. Startup and media buffers are bounded. Shutdown cancels pending work, prevents reconnection, clears owned timers, and waits for the owned UDP socket to close. These SDK-specific cleanup checks are tied to the pinned client version; unsupported versions fail closed. The previous worker adapter is retained for its existing lifecycle checks, but is no longer the production default because the extra JavaScript runtime exceeded the tested Homey app memory budget. When the actual Node/OpenSSL runtime supports native PKCS#1 v1.5 decryption with implicit rejection, private video-frame keys use that native operation instead of the pinned client's JavaScript RSA implementation. The wrapper applies only to the owned video state and preserves the original key object and other key uses. A runtime capability check selects the existing implementation if native decryption is unavailable; individual ciphertext failures never switch implementations.

The rollout setting `camera_isolated_p2p_devices` lives in Homey's app settings database: an array of Homey device IDs enables selected cameras, `true` enables all eligible P2P cameras, and an absent/false value preserves the existing shared-connection behavior. Changing it affects new sessions; close the selected views before changing modes. There is no additional login or camera pairing. Pending, active, and closing relayed sources share the existing four-source limit; duplicate viewers and snapshots share one source for the same camera. Native RTSP registrations continue using Homey's proxy directly. Hardware concurrency must be checked on the actual HomeBase and cameras before expanding a rollout. Homey's memory warnings and sustained CPU warnings stop the newest private source and briefly block replacement connections. This reduces pressure but cannot guarantee that Homey will keep the app running: its own memory supervisor can still restart an app. Additional VM memory and CPUs do not by themselves raise Homey's fixed per-app watchdog budgets. On the tested Self-Hosted 13.5.3 installation, the memory warning threshold is 150 MiB and the CPU threshold is 10 in its process CPU accounting; neither setting scales with VM resources. Validate sustained playback and independent stop/reopen on the actual installation before expanding the selected cameras.


Battery-camera sessions remain time limited (just under five minutes); reopen the camera after the viewing limit. Homey's proxy can retain an upstream for up to two minutes after frontend keepalives stop, after which the app releases its unused source.

For multi-view on a phone/tablet, create a **Cameras** dashboard in the Homey mobile app: **More → Dashboards → New Dashboard → Add Widget → Homey → camera widget**. Add a camera tile for each feed you want and use multiple columns on a tablet. Homey Dashboards are currently mobile/tablet features. Concurrent P2P tiles must obey the shared HomeBase limit above. The native camera-widget configuration is owned by Homey's mobile app and is not synthesized by this installer.

For a browser camera wall, open **Eufy Security's app settings**. Select up to four cameras, choose **Play selected**, or use each feed's Play/Stop and fullscreen controls. Selections persist in Homey's settings database. Playback is receive-only and muted, stops when the page is hidden, and has a retry action when a camera is busy or offline.

The optional browser wall needs a dedicated **Homey API key with device read permission only**. Create it under Homey **Settings → API Keys**, then enter it in the wall's in-page setup dialog. The backend verifies the key's actual permissions, rejects broader/control/owner keys, and stores it under a separate DB-backed setting that is excluded from the app's logged Eufy configuration. The app requests no broad Homey API permission. Its authenticated offer/keepalive routes accept only its own currently registered camera devices and return ephemeral connection handles and SDP, never source URLs or the key. Removing a saved connection does not revoke the separate Homey key; manage that key in Homey's API-key settings.

Existing snapshot and deprecated recording/stream Flow identities retain their previous snapshot behavior. Snapshot actions also accept camera-capable locks. Fresh snapshots await the actual JPEG result and preserve the previous image if capture fails; they reuse an existing camera source without stopping other viewers. The older, unused stream helper and bundled MediaMTX remain in the repository for compatibility/history; the app's active media path is `lib/helpers/camera-media.helper.js` and does not start MediaMTX.

Authenticated diagnostics are available at the app API **GET `/cameras/status`**. It reports only paired camera names/IDs, registration state, byte counts, timing and safe failure messages. It does not return camera URLs, relay tokens, credentials, or cloud inventories. Homey's persistent app stdout/stderr are bounded memory rings; the public diagnostic-report method uploads logs and is not used for troubleshooting.

# Smart Display E10 information

Version 3.43.1 provides **Eufy Security → Smart Display E10** for T87A0 through the existing Eufy Mega session as well as legacy discovery. The device's advanced settings show its reported model, firmware version, hardware version, device serial number, and station serial number. Values missing from Eufy's response are labeled as unreported. Firmware comes from explicit cloud software-version fields; unknown display parameters are not presented as firmware.

Battery level is added only when display parameter 8001 contains a valid percentage. The adapter keeps the display's parameter space separate from camera events and does not register the display as a camera or station. Choose **Refresh information** under the device's maintenance actions to read a fresh snapshot. The adapter issues no station, camera, or display controls and adds no background polling.

The adapter merges the global and house-specific Eufy Mega device lists, because either can omit a display returned by the other. It uses only an already-created valid session and honors the client's failed-login suppression. It does not initiate another login or export credentials. Concurrent queries share a short-lived cache; partial failures retain known display records, and failed manual refreshes preserve the last displayed values while reporting failure. If the existing session is unavailable, repair the Eufy login or retry later. A successful empty inventory can also mean that the Eufy account has no access to the display.

Version 3.43.2 keeps the pairing loading view responsive while display discovery finishes. Completed empty scans stop promptly, and closing or leaving the pairing flow discards late results. Camera and station drivers retain their existing discovery policy. Version 3.43.3 adds failure diagnostics limited to completion flags, a timestamp, safe failure reasons, response types, counts, and fixed protocol field names. Device records, account-provided keys, credentials, and response values are excluded.

Version 3.43.4 handles absent or null cloud collections as empty lists, matching Eufy's SDK. An empty secondary home therefore does not turn a successful display scan into a discovery error. Already paired displays stay excluded from the add-device list.

The [eufy-sdk display research](https://mega-yfue.github.io/smart-display) documents the limited available data; screen brightness, volume, wake, camera-view controls, and firmware installation have no verified command path in the pinned client. These remain managed on the display or in Eufy's app.

## Validation

Run `npm test` with an existing Node runtime; no local dependency installation is required. The suite uses isolated Homey and Eufy doubles to exercise pairing, lock state, command acknowledgments, errors, retries, reconnects, display metadata/battery updates, media lifecycles, scoped browser-wall permissions, and the existing sensor/camera event mappings. It does not connect to an Eufy account or Homey hardware. The Docker build also runs `scripts/check-media.cjs`: real FFmpeg generates two H.264 sources and a 1080p HEVC source, serves their MPEG-TS output to four real decoders, verifies HEVC conversion produces a 720p H.264 image, captures fresh snapshots, and verifies stopping one source preserves the others. The generated manifest and actual upload archive are checked as part of the same build. Live playback and physical-device behavior remain separate validation steps.

Physical-device validation remains necessary. After installing on a Homey test instance, pair each lock, compare its initial state with Eufy's app, test lock/unlock and repeated requests with the door open, verify manual/app changes, then check reconnect, denied access, timeout, and repair. Pair the display and compare model, serials, reported firmware, battery, and manual refresh against its own information screen. Existing camera streams, snapshots, doorbell events, HomeBase controls, and sensor events also need a live regression check. Automated validation does not operate physical locks.

---

## Live validation on Homey Self-Hosted

The 2026-10-30 trial used Homey Self-Hosted 13.5.3 with 8 GiB VM RAM and four vCPUs. The installed app runtime was Node 22.23.4 / OpenSSL 3.5.9, and both Garage and Doorbell reported native video decryption while delivering full-resolution P2P video. Sustained concurrent playback still exceeded Homey's fixed app CPU budget, so the CPU safeguard stopped the private sources while leaving Eufy running. Browser video clocks continued advancing on the final frame; they are not proof that an upstream remains live. Use fresh `/cameras/status` source state and increasing byte counts alongside decoded video when validating playback.

The in-app concurrent rollout was disabled after this trial. Native RTSP and the existing single-connection P2P path remain available. Additional VM memory/CPU did not remove the app watchdog constraints. The external helper below moves media processing outside the Homey app without changing camera stream settings. Its deployment and recovery checks have passed; sustained concurrent playback on the actual cameras remains a separate acceptance step.

## External media helper (3.45.3)

The optional media helper moves selected P2P camera sessions, FFmpeg, and JPEG decoding into a separate Docker container. Homey continues registering the same Eufy-owned camera device and `main` video slot through its supported SDK. Native RTSP retains its direct path. Account credentials and cloud authentication remain in the Eufy app; the helper receives only scoped camera metadata and the bounded read-only handshake responses required for that camera.

App 3.45.1 and helper 0.1.1 added clearer source timing and bounded failure diagnostics. App 3.45.2 and helper 0.1.2 add coordinated retirement of unused camera leases. The earlier installation, rollback, restart, and live-camera results below retain the versions actually tested; they do not establish live acceptance of the new idle-cleanup behavior.

The helper binds to `127.0.0.1` on the same Linux VM as Homey. Control requests require its persistent private key; video URLs carry a separate opaque media capability. Neither is exposed by the diagnostic API. An active, current lease is required even when an existing media URL is known. Homey validates camera privacy, paired-device identity, Station identity, client identity, and selected-device scope before supplying keys and renewing a lease. Leases last at most 75 seconds without renewal. Explicit Stop, privacy changes, app epoch changes, and cancellation close the camera independently of its peers. At most four pending, active, or closing relayed sources are reserved across the app and helper; native RTSP bypasses this relay count.

Helper 0.1.2 also retires an unused lease after 75 seconds if its first viewer never arrives. Once a viewer has connected, the last HTTP viewer's disconnection starts a five-second grace period for proxy reconnection; an active snapshot keeps the lease in use. After confirmed source cleanup, the helper returns HTTP 410 for the retired lease. App 3.45.2 releases its cached reservation and waits for a new camera request instead of automatically recreating unused video. This idle policy does not extend or shorten the existing maximum camera-session duration, and frontend closure can still precede the Homey proxy's upstream disconnection.

`camera_helper_connection` and `camera_helper_devices` are separate Homey app settings, outside the logged Eufy account configuration. A configured camera that cannot reach its helper reports a camera error instead of silently starting expensive concurrent video inside Homey. Ordinary device controls, events, and account reconnection retain their existing paths. The helper uses the existing bounded Worker adapter and terminates each owned Worker during cleanup. It does not patch Homey's image, runtime, watchdog, or source.

### Installation and connection

The helper deployment files are under `deploy/media-helper/`. Build a reviewed Linux amd64 image from `deploy/media-helper/Dockerfile`; `HELPER_DEPENDENCY_IMAGE` identifies the tested local installer image containing the pinned production dependency tree. That tree contains no native addons. The runtime uses a fixed Node release and Debian FFmpeg, and the actual target image is validated separately from the native build-host installer.

On the VM, place `compose.yaml`, `example.env`, `healthcheck.cjs`, and `manage.py` in a dedicated directory such as `/opt/homey-eufy-media-helper`. The first installation needs a mode-0600 bootstrap file containing 64 lowercase hexadecimal characters. Supply that file only to the management and connection tools; never paste the key into a browser or commit it. With the reviewed image already loaded into Docker, apply it with:

```bash
sudo python3 /opt/homey-eufy-media-helper/manage.py \
  --image metalcated/homey-eufy-media-helper:0.1.2 \
  --image-id sha256:REVIEWED_IMAGE_ID \
  --seed-token /private/path/to/bootstrap.key
```

The manager is restricted to the dedicated `homey-eufy-media-helper` Compose project and labeled external data volume. It verifies the exact image identity, Linux amd64 platform, protocol, SDK, and release labels before changing the container. Runtime configuration uses the immutable image ID. The key remains in the dedicated volume; later updates omit `--seed-token` and preserve it. Compose supplies restart behavior, a read-only root filesystem, dropped capabilities, bounded logs, a 1 GiB memory limit, and a two-CPU limit by default. Ports and resource limits are configured through `runtime.env`; that file contains no secret.

After installing the matching Eufy fork with the usual data-preserving installer, run `scripts/connect-helper.cjs` in the authenticated installer image. Set `HOMEY_ID`, the optional `HOMEY_INSTALL_URL`, and `EUFY_MEDIA_TOKEN_FILE` to the read-only bootstrap file mount. `EUFY_MEDIA_ORIGIN` defaults to `http://127.0.0.1:8769`; `EUFY_MEDIA_DEVICE_IDS` optionally selects a JSON array of existing Eufy camera device IDs. Otherwise all eligible Eufy camera devices are selected, with native RTSP still taking its direct path. The connection tool checks the installed fork version, camera ownership and registrations, and authenticated helper health from Homey before enabling delegation. An existing different identity is never overwritten. Failed setup restores the previous selection and removes only a newly added connection.

### Updates and rollback

Homey server updates preserve installed app code and settings in Homey's persistent user volume. The helper has its own container and external data volume. Its stored key derives stable camera links, and the Homey client automatically revalidates and restores desired leases after a helper restart. No camera pairing or dashboard replacement is part of an ordinary compatible update.

The current Homey updater excludes development-installed apps from routine App Store update checks. Keep this fork and merge/test upstream Eufy changes into it. Explicitly installing the official Store version over the same app ID can replace the helper bridge. Upstream protocol, SDK, and Homey breaking changes still require compatibility work; persistence is not a guarantee that an arbitrary future version is compatible.

App/helper protocol version 1 and the pinned Eufy SDK 4.2.6 are checked before camera creation. A protocol or SDK mismatch prevents creation, but those checks do not detect every behavioral incompatibility. In particular, idle retirement requires the compatible app version:

| Eufy app | Helper | Compatibility |
| --- | --- | --- |
| 3.45.1 | 0.1.1 | Previous compatible pair; dated validation is recorded below. |
| 3.45.2 or 3.45.3 | 0.1.1 | Compatible with the earlier helper behavior; the new idle-slot cleanup is unavailable. |
| 3.45.2 or 3.45.3 | 0.1.2 | Matched versions for coordinated idle retirement; 3.45.3 also cancels failed initial requests instead of warming unused cameras. |
| 3.45.1 | 0.1.2 | Unsupported: the old app treats idle retirement as an outage and can restart unused cameras while retaining cached source slots. |

For these controlled fork updates, **upgrade the app first, then the helper**. **Roll back the helper first, then the app**: restore helper 0.1.1 before downgrading the app to 3.45.1. An app-only downgrade while helper 0.1.2 remains installed is outside the supported rollback procedure. Authenticated health can succeed for that unsupported pair, so use the version matrix as well as the health check. This release uses a paired rollback policy rather than optional idle-feature negotiation.

The management tool keeps before/accepted release records and verifies authenticated health after recreation. A failed helper update automatically restores its previous image and environment; it does not change the installed Homey app. An explicit helper rollback uses the prior recorded image ID for both `--image` and `--image-id`. Keep those images and back up both Homey's user volume and the helper data volume. The updater never prunes images or deletes the external data volume.

The authenticated Eufy API `GET /camera-helper` reports only configuration, availability, protocol, version, SDK, and instance identity. `GET /cameras/status` refreshes bounded helper status and reports source state and byte counts without keys, cloud records, or media URLs. Increasing byte counts and successful decoding are the live validation signals; a browser video clock alone can advance on a stopped frame.

In app 3.45.1 / helper 0.1.1, `leaseStartedAt` identifies the helper lease, while `startedAt` and the optional `firstFrameAt` describe its current media source and first MPEG-TS output. A lease can outlive an individual source, so lease age does not establish continuous video delivery. Helper event logs use fixed, rate-limited categories and messages; they omit device IDs, serials, URLs, keys, and raw SDK errors.

The account-free helper integration check is `scripts/check-camera-helper.cjs`. It exercises the actual client and HTTP service, real SDK Workers and UDP lifecycle, permitted handshake RPC, generated H.264/HEVC decoding and snapshots, privacy cancellation, app-client recreation, helper recreation, incompatible-update rejection, rollback, and final resource cleanup. These generated-media checks do not establish sustained playback from physical cameras.

### Verified deployment and recovery

On 2026-10-30, helper 0.1.0 / protocol 1 was installed on the Homey VM and passed its authenticated health check. The recorded lifecycle test then recreated the dedicated helper container, rejected an incompatible release before mutation, and restored the previous healthy image after a deliberately failed health check. The same persistent helper identity was preserved throughout. This verifies the deployment and recovery path; it does not establish camera-stream continuity during an update or sustained concurrent live playback.

The subsequent live restart trial with app 3.45.0 / helper 0.1.0 preserved that identity and automatically recovered Garage. Its reported source bytes increased from 2,148,464 at 21:25:32 UTC to 7,334,820 at 21:25:52 UTC. Doorbell's existing snapshot Flow also completed a fresh capture successfully.

Three cameras on the same HomeBase were decoded during the live trial: Garage at 2304×1296, Doorbell at 1600×1200, and Backyard Right at 2304×1296. All three were observed streaming, with counters increasing across sampled intervals. Startup retries and later source interruptions or resets also occurred. Sustained, uninterrupted three-camera playback remains unaccepted; these results establish simultaneous decoding and an observed restart recovery without resolving the remaining reliability issues.

The 3.45.0 installer build passed 452 app tests and three helper-configuration tests, Homey debug validation, the SDK/UDP and generated FFmpeg media checks, and the actual installation-archive check. The latter verified the required runtime files and rejection of a failed upload. These build results and the VM lifecycle test are separate from live camera acceptance. Confirm fresh source state, increasing byte counts, decoded video, independent Stop/reopen, and stable Homey resource use before treating concurrent playback as accepted.

The 3.45.1 maintenance build passed 454 app tests and 11 helper configuration/diagnostic tests, plus the real SDK/UDP, H.264/HEVC, snapshot, restart, rollback, Homey validation and archive checks. The exact Linux amd64 helper 0.1.1 image passed the generated-media integration check separately. A data-preserving live update from 3.45.0 to 3.45.1 retained all 87 device IDs, all ten Eufy camera registrations, both native dashboard layouts, app settings (including the helper identity and selection), and the dashboard connection. Matter Bridge remained running. Basement TV also decoded its native RTSP source at 1920×1080 during the live regression check; this source bypasses the external helper.

The subsequent helper update from 0.1.0 to 0.1.1 passed authenticated health, preserved the private identity in its external volume, and left Homey’s main container identity and start time unchanged. The Homey app retained its existing connection throughout; no reconnection setup was performed.

After both maintenance updates, Garage and Doorbell opened through the saved connection without bootstrap or key entry. Across the 21:36:47–21:37:47 UTC samples, their source byte counts increased from 2,238,140 to 17,870,340 and from 1,629,020 to 11,850,956 respectively, with each source timestamp unchanged. Both decoded at 2304×1296 and 1600×1200, and the Eufy app stayed running at about 132 MiB. This is a bounded post-update check, not an endurance guarantee.

The 3.45.2 build passed 482 app tests and 11 helper configuration/diagnostic tests, Homey debug validation, the installation archive checks, and the generated SDK/FFmpeg media suite. The exact Linux amd64 helper 0.1.2 image independently passed the real client/service check, including idle closure, zero remaining server/client reservations, no automatic recreation, and explicit same-camera reopening with the same media capability and decoded video. The data-preserving live app update to 3.45.2 retained all 87 devices, all ten Eufy camera registrations, both native dashboard layouts, app configuration and dashboard connection. The subsequent helper update retained its private identity and left Homey’s main container unchanged.

App 3.45.3 additionally cancels an initial native camera request if it fails before returning a usable video URL. It releases that request after confirmed cleanup and waits for an explicit retry. Failed cleanup keeps its capacity reservation and retries cleanup only. Recovery of an already established feed is unchanged.

The live idle trial with app 3.45.2 / helper 0.1.2 issued four camera requests (Garage, Doorbell, Backyard Right and Backyard Left). Three produced decoded video; Backyard Right did not connect in that round. After closing the views, all four reported stopped at 22:06:56 UTC and remained stopped at 22:07:16 UTC. This validates the native viewer-close path and lack of automatic recreation; it does not establish uninterrupted four-camera playback.

At 22:08:58 UTC, the fifth device (Basement Door video lock) was streaming through helper 0.1.2, with 9,384,772 source bytes and decoded 960×720 video, while the prior four cameras remained stopped. This demonstrates reuse of the released capacity on the actual Homey native-video path.

The final 3.45.3 app build passed 484 app tests and 11 helper tests, plus the SDK/UDP, generated H.264/HEVC, snapshot, restart, rollback, idle cleanup/reopen, Homey validation and installation archive checks. The app-only change does not change the helper’s runtime or protocol.

After the final app update to 3.45.3, the installer again confirmed all 87 devices, ten Eufy camera registrations, both native dashboard layouts, app configuration and dashboard connection were preserved, with Matter Bridge running. A helper-side process/resource sample after closing the previous test views showed no FFmpeg process, authenticated health passing, approximately 119.9 MiB resident memory, and 0.03% CPU.

The final live reopen trial on app 3.45.3 / helper 0.1.2 reopened Garage and Doorbell at 2304×1296 and 1600×1200. Between 22:12:40 and 22:13:00 UTC, their byte counters advanced from 7,672,280 to 11,788,540 and from 5,460,460 to 10,004,984 with unchanged source timestamps. The Eufy app stayed running at approximately 132 MiB. This remains a bounded live check; the earlier multi-camera interruptions are not an accepted endurance result.
