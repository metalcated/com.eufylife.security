# Smart Lock

Pair the lock with the Eufy Security mobile app first, then give the Eufy account used by Homey access to the lock. Confirm that this account can lock and unlock it remotely before adding it to Homey.

In Homey, select **Eufy Security → Smart Lock** and complete the existing account login, CAPTCHA, or two-factor authentication steps if requested. Locks already added to Homey are excluded from the list.

Bluetooth locks require a compatible Eufy Wi-Fi bridge configured in the Eufy app. Homey does not connect directly to the lock over Bluetooth. Keep its bridge or HomeBase online when using the lock through Homey.

The driver groups the Bluetooth/bridge, Wi-Fi, and advanced Wi-Fi lock families that the bundled Eufy client can control, including its supported R10/R20 variants. A lock is offered only when the client supports its lock/unlock command and reports a writable lock state. Recognition of a model name alone does not establish support for a newer lock.

This includes S230/T8510P and Video Smart Lock S330/T8530. The latter requires its Wi-Fi bridge or compatible HomeBase. Locks that advertise a livestream command in the Eufy client also expose camera snapshots and, on supported Homey platforms, live video. The device keeps its lock tile, state, and lock/unlock controls. An ordinary lock does not acquire camera controls because its model name resembles a video lock.

For a video lock, open its camera in Homey or use the **Take snapshot** Flow action. Camera initialization failures leave valid lock control available. A HomeBase can provide one P2P camera feed at a time; stop an existing feed before opening another camera or requesting its snapshot. Manual/external lock-state updates on video and FamiLock models require live validation because of gaps in the pinned client's MQTT handling.

C30 (T85D0) and Video Smart Lock E330 (T8531) are currently excluded because the bundled client does not implement their lock/unlock commands. This driver does not manage PIN codes, fingerprints, access schedules, or lock users.

After pairing, check the displayed state against the Eufy app and test lock/unlock with the door open. Battery level and temperature are shown only when the lock reports those values. A lost connection or a rejected command must be resolved before relying on remote control.
