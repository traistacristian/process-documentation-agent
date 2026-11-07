# PyInstaller spec for the Windows desktop agent. Built by .github/workflows/ci.yml on windows-latest:
#   py -m pip install -r desktop-agent/requirements.txt pyinstaller
#   py -m PyInstaller deploy/desktop-agent/pda_agent.spec --distpath dist --workpath build
# Produces dist/ProcessDocAgent/ProcessDocAgent.exe (one-folder build: starts faster and is not
# flagged by AV as often as one-file builds). Sign it with signtool before packaging for Intune.
import os
here = os.path.abspath(os.path.join(SPECPATH, '..', '..', 'desktop-agent'))

a = Analysis(
    [os.path.join(SPECPATH, 'entry.py')],
    pathex=[here],
    hiddenimports=['pda_agent.core', 'pda_agent.platforms', 'pda_agent.machine_policy', 'pynput.keyboard._win32', 'pynput.mouse._win32', 'uiautomation', 'psutil', 'mss', 'PIL'],
    excludes=['pytest'],
)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name='ProcessDocAgent', console=False, version=None)
coll = COLLECT(exe, a.binaries, a.datas, name='ProcessDocAgent')
