#!/usr/bin/env python3
"""
build.py — Assembles sms-rpg-studio.html from its components.

Prerequisites:
  pip install nothing — pure stdlib only

Steps:
  1. Apply our changes to Tiny RPG Studio source
  2. Build Tiny RPG Studio with npm run build
  3. Run this script

Usage:
  python3 build.py
    [--tiny-rpg   path/to/tiny-rpg-studio-main]   default: ../tiny-rpg-studio-main
    [--base-rom   path/to/base-rom/dist/puzzle_maker_base_rom.sms]
    [--output     sms-rpg-studio.html]

Our source changes to Tiny RPG Studio (apply before building):
  - src/runtime/infra/TinyRpgApi.ts   exposes window.TinyRPGMaker on setTinyRpgApi()
  - index.html                        replaces Firebase CDN module script with stubs,
                                      adds SMS ROM button + status bar to the toolbar
Both modified files are in tiny-rpg-studio-changes/ for reference.
"""

import argparse, base64, re, sys
from pathlib import Path

def build(tiny_rpg: Path, base_rom_path: Path, sms_gen: Path, output: Path):
    docs = tiny_rpg / 'docs'
    if not docs.exists():
        sys.exit(f"ERROR: {docs} not found — run 'npm run build' inside {tiny_rpg} first")

    print(f"Reading built assets from {docs}")
    html = (docs / 'index.html').read_text(encoding='utf-8')
    js_f = next((docs / 'assets').glob('index-*.js'))
    css_f= next((docs / 'assets').glob('index-*.css'))
    print(f"  JS:  {js_f.name}  ({js_f.stat().st_size//1024} KB)")
    print(f"  CSS: {css_f.name} ({css_f.stat().st_size//1024} KB)")

    js   = js_f.read_text(encoding='utf-8')
    css  = css_f.read_text(encoding='utf-8')
    ebjs = (docs / 'export.bundle.js').read_text(encoding='utf-8')

    # Embed fonts as data URIs so the file is truly self-contained
    woff = base64.b64encode((docs / 'pico8-ui.woff').read_bytes()).decode()
    png  = base64.b64encode((docs / 'pico8-font.png').read_bytes()).decode()
    for orig, data in [('"pico8-ui.woff"', f'"data:font/woff;base64,{woff}"'),
                       ('"pico8-font.png"', f'"data:image/png;base64,{png}"')]:
        js   = js.replace(orig, data)
        ebjs = ebjs.replace(orig, data)

    # Inline CSS, remove external references (Vite build artefacts)
    html = re.sub(r'<link rel="stylesheet"[^>]*assets/index-[^>]+>', f'<style>{css}</style>', html)
    html = re.sub(r'<script type="module"[^>]*assets/index-[^>]+></script>', '', html)
    html = re.sub(r'<link rel="manifest"[^>]*>', '', html)
    html = re.sub(r'<script id="vite-plugin-pwa[^>]*></script>', '', html)

    # Embed base ROM and inject SMS generator
    rom_b64 = base64.b64encode(base_rom_path.read_bytes()).decode()
    sms_script = sms_gen.read_text(encoding='utf-8').replace('"BASE_ROM_PLACEHOLDER"', f'"{rom_b64}"')

    # Assemble
    final = html.replace('</body>',
        f'<script>\n{js}\n</script>\n<script>\n{ebjs}\n</script>\n{sms_script}\n</body>')

    output.write_text(final, encoding='utf-8')
    print(f"\n✓ {output}  ({len(final.encode())//1024} KB)")

    # Sanity checks
    assert 'window.TinyRPGMaker' in final,       "FAIL: window.TinyRPGMaker not found"
    assert 'btn-generate-sms-rom' in final,      "FAIL: SMS button not found"
    assert 'firebase-app.js' not in final,       "FAIL: Firebase CDN import still present"
    assert not re.search(r'\bimport\{', final),  "FAIL: ES module import statements present"
    print("✓ Sanity checks passed")

if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--tiny-rpg',  default='../tiny-rpg-studio-main')
    p.add_argument('--base-rom',  default='base-rom/dist/puzzle_maker_base_rom.sms')
    p.add_argument('--sms-gen',   default='sms-generator.js')
    p.add_argument('--output',    default='sms-rpg-studio.html')
    a = p.parse_args()
    build(Path(a.tiny_rpg), Path(a.base_rom), Path(a.sms_gen), Path(a.output))
