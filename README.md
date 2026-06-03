# SMS RPG Studio

Tiny RPG Studio with a Sega Master System ROM exporter.

## Contents

```
tiny-rpg-studio-changes/
  index.html                     Modified: Firebase stubs + SMS ROM button + status bar
  src/runtime/infra/TinyRpgApi.ts  Modified: exposes window.TinyRPGMaker

base-rom/                        SMS-Puzzle-Maker base ROM (Z80/C source + prebuilt .sms)
  puzzle_maker_base_rom.c        Z80 game loop: loads resources, renders map, moves player
  actor.c / actor.h              Sprite/actor system
  lib/                           devkitSMS / SMSlib headers and pre-linked objects
  Makefile                       Build with SDCC + devkitSMS
  dist/puzzle_maker_base_rom.sms Prebuilt 32 KB ROM (use this if you can't recompile)

sms-generator.js                 Client-side SMS ROM generator (injected into the HTML)
build.py                         Assembles sms-rpg-studio.html from all sources
sms-rpg-studio.html              Ready-to-use deliverable (open in any browser)
```

## Using the deliverable

Open `sms-rpg-studio.html` in any browser. Design your game in the full Tiny RPG
Studio editor, then click **🕹 SMS ROM** in the toolbar to download a `.sms` file.

**Emulators:** Emulicious · Meka · RetroArch (Genesis Plus GX core)

Note: downloads are blocked inside Claude's artifact sandbox — open the HTML
file locally in a browser for the download to work.

## Building from source

### 1. Apply changes to Tiny RPG Studio

```bash
git clone https://github.com/andredarcie/tiny-rpg-studio
cd tiny-rpg-studio

# Apply our two modified files:
cp ../tiny-rpg-studio-changes/index.html .
cp ../tiny-rpg-studio-changes/src/runtime/infra/TinyRpgApi.ts src/runtime/infra/

npm install
npm run build   # produces docs/
cd ..
```

### 2. (Optional) Recompile the base ROM

Requires SDCC + devkitSMS toolchain:

```bash
cd base-rom
make
# produces dist/puzzle_maker_base_rom.sms
cd ..
```

### 3. Assemble the final HTML

```bash
python3 build.py \
  --tiny-rpg  tiny-rpg-studio \
  --base-rom  base-rom/dist/puzzle_maker_base_rom.sms \
  --output    sms-rpg-studio.html
```

## How the SMS export works

When you click **SMS ROM**, `sms-generator.js` runs entirely client-side:

1. **Palette** — 16 PICO-8/custom hex colors → SMS 6-bit bytes (`R | G<<2 | B<<4`)
2. **Tiles** — each 8×8 pixel grid → 4 bitplanes × 8 rows = 32 bytes/tile
3. **Maps** — 9 rooms × 8×8 tile indices → `level001.map` … `level009.map`
4. **Resource filesystem** — binary layout from SMS-Puzzle-Maker:
   `rsc\0` header + sorted file entries + 16 KB paged content
5. **ROM assembly** — 32 KB base ROM (Z80 program) + resource pages → `.sms`

## Source changes explained

### `TinyRpgApi.ts`
`setTinyRpgApi()` already stores the engine API in a module-private variable.
We add one line to also assign it to `window.TinyRPGMaker` so `sms-generator.js`
can access it from a separate classic script tag.

### `index.html`
- **Firebase block**: the original loads Firebase via ES `import{}` statements in
  a `<script type="module">`. When inlined into a standalone HTML file as a classic
  `<script>`, those imports cause a syntax error that silently aborts the entire
  script. We replace the block with plain `var` assignments that stub the globals
  the app reads (`window.TinyRPGFirebaseDb` etc.), disabling the online
  share/explore features while preserving all editor and game functionality.
- **SMS ROM button**: added to the toolbar alongside JOGO/EDITOR/EXPLORAR/REINICIAR.
- **Status bar**: a `<div>` below the toolbar that shows export progress and result.

## Credits

- [Tiny RPG Studio](https://github.com/andredarcie/tiny-rpg-studio) — Andre Darcie & Diego Penha
- [SMS-Puzzle-Maker](https://github.com/haroldo-ok/SMS-Puzzle-Maker) — Haroldo-OK
- [devkitSMS / SMSlib](https://github.com/sverx/devkitSMS) — sverx
