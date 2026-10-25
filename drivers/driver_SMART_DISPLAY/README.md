# Smart Display E10

This driver adds the Eufy Smart Display E10 / T87A0 as a device in Homey so you can view the information Eufy reports for the display itself.

Set up the display in the Eufy mobile app and give the Eufy account used by Homey access to it. In Homey, select **Eufy Security → Smart Display E10** and complete the existing account login, CAPTCHA, or two-factor authentication steps if requested. Displays already added to Homey are excluded from the list.

Pairing reads both the legacy device list and Eufy Mega's global and house-specific inventories using the client's existing authenticated session. No additional login or background polling is started. The account must have access to the display; repair the Eufy login or retry later if display discovery is unavailable.

Open the device's advanced settings to see its reported model, firmware version, hardware version, device serial number, and station serial number. These fields are read-only. Information that Eufy does not report cannot be inferred from a connected camera or HomeBase, or from unknown display parameters. Battery level appears only when the display reports a valid battery percentage. Use **Refresh information** under maintenance actions to request a fresh snapshot. A failed refresh keeps the last values and reports failure.

Screen brightness, volume, screen wake, firmware installation, camera viewing, and other display controls have no verified implementation in the bundled client. Use the Eufy mobile app or the display itself for those settings. This driver does not issue HomeBase alarm, reboot, or streaming commands to the display.

Account discovery and displayed information still require validation against a live E10. Compare the reported firmware and serial numbers with the Eufy app after pairing.
