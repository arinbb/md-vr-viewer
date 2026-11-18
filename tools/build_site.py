"""Copies just the files the hosted app needs into dist/ (git-ignored), ready to upload to any
HTTPS static host (university web space, Netlify, GitHub Pages).

    python tools/build_site.py              # includes the caffeine sample and its tour
    python tools/build_site.py --no-sample  # leaves the students' data out and hides "Load sample"

Nothing here is uploaded anywhere; you upload dist/ yourself. Anyone with the address can
download what is in it, so use --no-sample unless the data may be shared.
"""
import argparse
import os
import shutil

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
FILES = ['index.html', 'manifest.webmanifest', 'sw.js', 'icons/icon-192.png', 'icons/icon-512.png']
# Every module in src/ (so a new one can't be left out of the hosted app).
FILES += sorted('src/' + f for f in os.listdir(os.path.join(ROOT, 'src')) if f.endswith('.js'))
SAMPLE = ['samples/sample.lesson.json', 'samples/caffeine_water.lammpstrj.gz']

ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
ap.add_argument('--no-sample', action='store_true', help="leave out the students' caffeine sample")
ap.add_argument('--out', default=os.path.join(ROOT, 'dist'))
args = ap.parse_args()

out = os.path.abspath(args.out)
if os.path.commonpath([out, ROOT]) == ROOT and out != os.path.join(ROOT, 'dist'):
    raise SystemExit('Use dist/ or a folder outside the repository.')
if os.path.isdir(out):
    shutil.rmtree(out)
for f in FILES + ([] if args.no_sample else SAMPLE):
    dst = os.path.join(out, f)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    shutil.copy2(os.path.join(ROOT, f), dst)
open(os.path.join(out, '.nojekyll'), 'w').close()  # GitHub Pages: serve files as they are

if args.no_sample:
    p = os.path.join(out, 'index.html')
    s = open(p, encoding='utf-8').read()
    a = '<button id="sampleBtn"'
    assert s.count(a) == 1
    open(p, 'w', encoding='utf-8', newline='\n').write(s.replace(a, '<button id="sampleBtn" hidden'))

size = sum(os.path.getsize(os.path.join(d, f)) for d, _, fs in os.walk(out) for f in fs)
print(f'Wrote {out} ({size / 1e6:.1f} MB, sample {"left out" if args.no_sample else "included"}).')
print('Upload the contents of that folder to an HTTPS host, then open the address on the Quest.')
