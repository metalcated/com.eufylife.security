# Smart Display E10

This driver adds the Eufy Smart Display E10 / T87A0 as a device in Homey so you can view the information Eufy reports for the display itself.

Set up the display in the Eufy mobile app and give the Eufy account used by Homey access to it. In Homey, select **Eufy Security → Smart Display E10** and complete the existing account login, CAPTCHA, or two-factor authentication steps if requested. Displays already added to Homey are excluded from the list.

Pairing depends on Eufy returning the display through the cloud account used by this integration. The bundled client uses legacy device discovery, which may omit the E10. If the display is absent, this driver cannot discover it by adding a model name or treating it as a HomeBase.

Open the device's advanced settings to see its reported model, firmware version, hardware version, device serial number, and station serial number. These fields are read-only. Information that Eufy does not report cannot be inferred from a connected camera or HomeBase. Battery level appears only when the display reports a valid battery percentage.

Screen brightness, volume, screen wake, firmware installation, camera viewing, and other display controls have no verified implementation in the bundled client. Use the Eufy mobile app or the display itself for those settings. This driver does not issue HomeBase alarm, reboot, or streaming commands to the display.

Account discovery and displayed information still require validation against a live E10. Compare the reported firmware and serial numbers with the Eufy app after pairing.
