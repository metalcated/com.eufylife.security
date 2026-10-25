# Smart Lock

Pair the lock with the Eufy Security mobile app first, then give the Eufy account used by Homey access to the lock. Confirm that this account can lock and unlock it remotely before adding it to Homey.

In Homey, select **Eufy Security → Smart Lock** and complete the existing account login, CAPTCHA, or two-factor authentication steps if requested. Locks already added to Homey are excluded from the list.

Bluetooth locks require a compatible Eufy Wi-Fi bridge configured in the Eufy app. Homey does not connect directly to the lock over Bluetooth. Keep its bridge or HomeBase online when using the lock through Homey.

The driver groups the Bluetooth/bridge, Wi-Fi, and advanced Wi-Fi lock families that the bundled Eufy client can control, including its supported R10/R20 variants. A lock is offered only when the client supports its lock/unlock command and reports a writable lock state. Recognition of a model name alone does not establish support for a newer lock.

This includes S230/T8510P and Video Smart Lock S330/T8530. The latter requires its Wi-Fi bridge or compatible HomeBase. Video models expose lock control and battery properties in this driver; camera streams, snapshots, motion, and doorbell events are not included. Manual/external state updates on video and FamiLock models require live validation because of gaps in the pinned client's MQTT handling.

C30 (T85D0) and Video Smart Lock E330 (T8531) are currently excluded because the bundled client does not implement their lock/unlock commands. This driver does not manage PIN codes, fingerprints, access schedules, or lock users.

After pairing, check the displayed state against the Eufy app and test lock/unlock with the door open. Battery level and temperature are shown only when the lock reports those values. A lost connection or a rejected command must be resolved before relying on remote control.
