SMS RPG Studio — emulator integration notes
=============================================

The "▶ Play in browser" button:
  1. Calls buildSMSRom() to produce the same ROM bytes the export uses
  2. Wraps them in a Blob → URL.createObjectURL()
  3. Sets EJS_player / EJS_core="segaMS" / EJS_gameUrl / EJS_pathtodata
  4. Injects https://cdn.emulatorjs.org/stable/data/loader.js
  5. Shows a modal overlay with the emulator (640×480 max)

Controls in the emulator:
  - Arrow keys: D-pad
  - Z / X:      buttons 1 / 2

Closing:
  - Click "✖ Close", press Escape, or click outside the modal
  - On close, EJS_emulator.callEvent('exit') is called and all
    EJS_* globals are deleted so the next launch starts fresh.

Files touched (vs the pre-emulator build):
  - html-base-with-emulator.html:   added btn-play-sms-rom + #sms-emulator-modal
  - sms-generator.js:               split generateSMSRom into buildSMSRom + wrappers,
                                    added handlePlayClick + launchEmulatorWithRom
  - build.py:                       simplified (no longer injects a toolbar duplicate)
