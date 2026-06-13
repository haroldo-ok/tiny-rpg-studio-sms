SMS RPG Studio — emulator integration notes
=============================================

The build script (build.py) starts from html_base.html (the raw
TRS UI template), injects two new buttons into the toolbar right
after the "Reset" button:

  - 🕹 SMS ROM   — downloads the ROM as a .sms file
  - ▶ Play       — generates a ROM and runs it in EmulatorJS

It then injects the #sms-emulator-modal markup before </body>, and
finally appends the TRS bundle JS and our SMS-generator JS before
the closing </body>.

Don't try to open html_base.html directly — it's just the raw
template, missing the bundled JS/CSS that build.py inlines.
Always use sms-rpg-studio.html (the build output).

EmulatorJS:
  - Core: segaMS (from CDN at cdn.emulatorjs.org/stable/data/)
  - No BIOS needed for SMS
  - Controls: arrow keys + Z, X
