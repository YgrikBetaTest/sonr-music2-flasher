SONR Music 2 flasher - macOS
============================

NOTHING TO INSTALL to flash. No driver, no certificate, no admin.
WebUSB works out of the box in Chrome or Edge on macOS.

How to flash:
  1. Open  https://ygrikbetatest.github.io/sonr-music2-flasher/  in Chrome or Edge.
  2. Hold "+", plug in the USB cable, make sure the LED is OFF (board in BOOT).
  3. Press Update. In the browser pop-up, select "SONR ... Bootloader" and click Connect.
  4. A factory board is read-protected: the tool removes protection, resets the chip, and asks
     you to "press Update again". Keep holding "+", press Update once more and re-select the same
     device - this second pass writes the firmware. Wait for the confetti.

OPTIONAL - remove the second device-picker (single-pass flashing)
-----------------------------------------------------------------
Install the configuration profile SONR-WebUSB.mobileconfig once per Mac. It grants Chrome/Edge
standing permission to the bootloader, so there is no device picker and the mid-flash reconnect
is automatic (same one-tap flow as Windows).

  1. Download SONR-WebUSB.mobileconfig and double-click it.
  2. Open  System Settings > General > Device Management (or "Profiles")  and click Install.
     (macOS may warn the profile is unsigned - that is expected; Install anyway.)
  3. Fully quit and reopen Chrome/Edge. Verify at chrome://policy that WebUsbAllowDevicesForUrls
     is present.

To remove it later: System Settings > Device Management > select the profile > "-" / Remove.
