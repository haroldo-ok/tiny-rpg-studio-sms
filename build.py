"""SMS RPG Studio — final build script (with emulator support)."""
import base64, os
from pathlib import Path

BASE = Path('/home/claude/work/SMS-Puzzle-Maker-master/base-rom')

rom    = (BASE / 'puzzle_maker_base_rom.sms').read_bytes()
romb64 = base64.b64encode(rom).decode()

bundle   = open('/tmp/main_js_patched.js').read()
html     = open('/tmp/html_base.html').read()
ebjs     = open('/tmp/export_bundle.js').read()
sms_tmpl = open('/tmp/sms_script_template.txt').read()
sms_script = sms_tmpl.replace('"BASE_ROM_PLACEHOLDER"', f'"{romb64}"')

# Stub out Firebase imports (no analytics in standalone build)
old_imports = ('import{initializeApp as qt}from"https://www.gstatic.com/firebasejs/12.8.0/firebase-app.js";'
               'import{getAnalytics as Xt}from"https://www.gstatic.com/firebasejs/12.8.0/firebase-analytics.js";'
               'import{getFirestore as $t,startAfter as Jt,limit as Zt,orderBy as Qt,query as ei,getDocs as ti,'
               'serverTimestamp as ii,collection as ai,addDoc as ni}'
               'from"https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js";')
stubs = ('var qt=function(){return{apps:[],app:function(){return null}}};'
         'var Xt=function(){};var $t=function(){return{}};var Jt=function(){};'
         'var Zt=function(){};var Qt=function(){};var ei=function(){};'
         'var ti=async function(){return{docs:[]}};var ii=function(){return new Date()};'
         'var ai=function(){};var ni=async function(){};')
patched = bundle.replace(old_imports, stubs, 1)

# Assemble final HTML
final = html.replace(
    '</body>',
    f'<script>\n{patched}\n</script>\n<script>\n{ebjs}\n</script>\n{sms_script}\n</body>',
    1
)

out = Path('/mnt/user-data/outputs/sms-rpg-studio.html')
out.write_text(final)
print(f'Built: {len(final.encode())//1024} KB → {out}')

# Verify single button id
btn_count = final.count('id="btn-generate-sms-rom"')
play_count = final.count('id="btn-play-sms-rom"')
modal_count = final.count('id="sms-emulator-modal"')
print(f'btn-generate-sms-rom: {btn_count}× (must be 1)')
print(f'btn-play-sms-rom:     {play_count}× (must be 1)')
print(f'sms-emulator-modal:   {modal_count}× (must be 1)')
assert btn_count == 1
assert play_count == 1
assert modal_count == 1
