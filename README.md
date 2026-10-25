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

Version 3.43.0 also adds **Eufy Security → Smart Display E10** for T87A0. The device's advanced settings show its reported model, firmware version, hardware version, device serial number, and station serial number. Values missing from Eufy's response are labeled as unreported. Firmware comes from the client's explicit software-version field; unknown display parameters are not presented as firmware.

Battery level is added only when display parameter 8001 contains a valid percentage. The adapter keeps the display's parameter space separate from camera events. It uses the existing cloud metadata and update events, without issuing station, camera, or display commands or changing the account polling interval.

The adapter depends on the legacy Eufy device list returning the display. If the account does not enumerate it, a separate Eufy Mega discovery integration is still needed. This has not been verified against a live E10. The [eufy-sdk display research](https://mega-yfue.github.io/smart-display) documents the limited available data; screen brightness, volume, wake, camera-view controls, and firmware installation have no verified command path in the pinned client. These remain managed on the display or in Eufy's app.

## Validation

Run `npm test` with an existing Node runtime; no local dependency installation is required. The suite uses isolated Homey and Eufy doubles to exercise pairing, lock state, command acknowledgments, errors, retries, reconnects, display metadata/battery updates, and the existing sensor/camera event mappings. It does not connect to an Eufy account or Homey hardware. The generated manifest was also checked against Homey's official JSON schema.

Homey packaging and physical-device validation remain necessary. After installing on a Homey test instance, pair each lock, compare its initial state with Eufy's app, test lock/unlock and repeated requests with the door open, verify manual/app changes, then check reconnect, denied access, timeout, and repair. Pair the display and compare firmware, model, serials, and battery against its own information screen; confirm whether the legacy account list includes it. Existing camera streams, snapshots, doorbell events, HomeBase controls, and sensor events also need a live regression check. No live devices or account settings were changed during local development.

---
