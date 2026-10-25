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

This release exposes the locking function of video locks. It does not add their camera streams, snapshots, motion/doorbell events, PINs, fingerprints, or user administration. The underlying client has gaps in MQTT state handling for video/FamiLock devices; manual and external changes need validation on the actual hardware. A successful client acknowledgment is not independent proof of physical deadbolt movement. Low-battery alerts follow the client's transient alert property; battery percentage is shown separately when available.

# Smart Display E10 information

Version 3.43.1 provides **Eufy Security → Smart Display E10** for T87A0 through the existing Eufy Mega session as well as legacy discovery. The device's advanced settings show its reported model, firmware version, hardware version, device serial number, and station serial number. Values missing from Eufy's response are labeled as unreported. Firmware comes from explicit cloud software-version fields; unknown display parameters are not presented as firmware.

Battery level is added only when display parameter 8001 contains a valid percentage. The adapter keeps the display's parameter space separate from camera events and does not register the display as a camera or station. Choose **Refresh information** under the device's maintenance actions to read a fresh snapshot. The adapter issues no station, camera, or display controls and adds no background polling.

The adapter merges the global and house-specific Eufy Mega device lists, because either can omit a display returned by the other. It uses only an already-created valid session and honors the client's failed-login suppression. It does not initiate another login or export credentials. Concurrent queries share a short-lived cache; partial failures retain known display records, and failed manual refreshes preserve the last displayed values while reporting failure. If the existing session is unavailable, repair the Eufy login or retry later. A successful empty inventory can also mean that the Eufy account has no access to the display.

Version 3.43.2 keeps the pairing loading view responsive while display discovery finishes. Completed empty scans stop promptly, and closing or leaving the pairing flow discards late results. Camera and station drivers retain their existing discovery policy. Version 3.43.3 adds failure diagnostics limited to completion flags, a timestamp, safe failure reasons, response types, counts, and fixed protocol field names. Device records, account-provided keys, credentials, and response values are excluded.

Version 3.43.4 handles absent or null cloud collections as empty lists, matching Eufy's SDK. An empty secondary home therefore does not turn a successful display scan into a discovery error. Already paired displays stay excluded from the add-device list.

The [eufy-sdk display research](https://mega-yfue.github.io/smart-display) documents the limited available data; screen brightness, volume, wake, camera-view controls, and firmware installation have no verified command path in the pinned client. These remain managed on the display or in Eufy's app.

## Validation

Run `npm test` with an existing Node runtime; no local dependency installation is required. The suite uses isolated Homey and Eufy doubles to exercise pairing, lock state, command acknowledgments, errors, retries, reconnects, display metadata/battery updates, and the existing sensor/camera event mappings. It does not connect to an Eufy account or Homey hardware. The generated manifest was also checked against Homey's official JSON schema.

Physical-device validation remains necessary. After installing on a Homey test instance, pair each lock, compare its initial state with Eufy's app, test lock/unlock and repeated requests with the door open, verify manual/app changes, then check reconnect, denied access, timeout, and repair. Pair the display and compare model, serials, reported firmware, battery, and manual refresh against its own information screen. Existing camera streams, snapshots, doorbell events, HomeBase controls, and sensor events also need a live regression check. Automated validation does not operate physical locks.

---
