"""SMS RPG Studio — build script (matches the previously-working version
and just adds a Play button next to SMS ROM)."""
import base64
from pathlib import Path

BASE = Path('/home/claude/work/SMS-Puzzle-Maker-master/base-rom')

rom    = (BASE / 'puzzle_maker_base_rom.sms').read_bytes()
romb64 = base64.b64encode(rom).decode()

bundle   = open('/tmp/main_js_patched.js').read()
html     = open('/tmp/html_base.html').read()
ebjs     = open('/tmp/export_bundle.js').read()
sms_tmpl = open('/tmp/sms_script_template.txt').read()
sms_script = sms_tmpl.replace('"BASE_ROM_PLACEHOLDER"', f'"{romb64}"')

# Stub out Firebase imports
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

# Inject SMS ROM + Play buttons into the toolbar, next to the Reset button.
# (Same approach as the previously-working build, just adds Play button too.)
old_reset = '<button id="btn-reset" class="tab-action-button" type="button" data-text-key="buttons.reset" data-aria-label-key="aria.reset"></button'
new_buttons = (old_reset + '>\n'
    '                    <button id="btn-generate-sms-rom" class="tab-action-button" type="button" '
    'style="background:#1a3a6a;border-color:#3a70d0;color:#6af;font-weight:bold;">'
    '&#x1F579; SMS ROM</button>\n'
    '                    <button id="btn-play-sms-rom" class="tab-action-button" type="button" '
    'style="background:#1a4a1a;border-color:#3aa03a;color:#6f6;font-weight:bold;">'
    '&#x25B6; Play</button')
html = html.replace(old_reset, new_buttons)

# Status bar under the toolbar (same as previously-working build)
html = html.replace(
    '</div>\n            <div class="project-save-controls">',
    '</div>\n            <div id="sms-rom-status" style="display:none;padding:6px 16px;'
    'font-size:11px;background:#0a1020;border-bottom:2px solid #1a3a6a;text-align:center;'
    'font-family:monospace;"></div>\n            <div class="project-save-controls">'
)

# Add the emulator modal right before </body>
emulator_modal = '''    <div id="sms-emulator-modal" style="display:none;position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgba(0,0,0,0.85);z-index:99999;align-items:center;justify-content:center;flex-direction:column;">
        <div style="background:#1a1a1a;border:2px solid #4ac04a;border-radius:8px;padding:14px 18px;max-width:96vw;max-height:96vh;display:flex;flex-direction:column;align-items:center;gap:10px;box-shadow:0 8px 32px rgba(0,0,0,0.8);">
            <div style="display:flex;align-items:center;justify-content:space-between;width:100%;gap:16px;">
                <span style="color:#4ac04a;font-family:monospace;font-size:13px;letter-spacing:1px;">&#x25B6; SMS EMULATOR</span>
                <div style="display:flex;gap:8px;">
                    <button id="sms-emulator-reload" style="background:#1a4080;border:1px solid #3a70d0;color:#fff;padding:5px 10px;cursor:pointer;font-family:inherit;font-size:11px;">&#x21BB; Reload</button>
                    <button id="sms-emulator-close" style="background:#802020;border:1px solid #c04040;color:#fff;padding:5px 10px;cursor:pointer;font-family:inherit;font-size:11px;">&#x2716; Close</button>
                </div>
            </div>
            <div id="sms-emulator-host" style="width:640px;height:480px;max-width:88vw;max-height:78vh;background:#000;">
                <div id="sms-emulator-target"></div>
            </div>
            <div style="color:#888;font-family:monospace;font-size:10px;">Controls: arrow keys + Z, X &middot; Powered by EmulatorJS</div>
        </div>
    </div>
</body>'''
html = html.replace('</body>', emulator_modal)

# Final assembly
final = html.replace(
    '</body>',
    f'<script>\n{patched}\n</script>\n<script>\n{ebjs}\n</script>\n{sms_script}\n</body>',
    1
)

out = Path('/mnt/user-data/outputs/sms-rpg-studio.html')
out.write_text(final)
print(f'Built: {len(final.encode())//1024} KB → {out}')

# Sanity checks
assert final.count('id="btn-generate-sms-rom"') == 2, "expected 2 occurrences (toolbar + sidebar)"
assert final.count('id="btn-play-sms-rom"')     == 1, "expected 1 Play button"
assert final.count('id="sms-emulator-modal"')   == 1, "expected 1 modal"
assert 'cdn.emulatorjs.org' in final
print('All checks passed.')
