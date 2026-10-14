# -*- coding: utf-8 -*-
"""Which DSH versions expose every attachment-store member this plugin uses.

DSH publishes its whole monorepo at one version, so dsh@X pins
dsh-attachment-local@X. That makes the probe a straight walk over DSH versions:
download the two packages that declare the attachment service, concatenate their
type declarations, and ask which of the members this plugin calls are present.

A version whose declarations could not be fetched is reported as NO DATA, never as
a pass. The first version of this probe returned "OK" for every release because it
looked in the wrong place and treated an empty haystack as an empty list of
missing needles.
"""
import io
import json
import sys
import tarfile
import urllib.request
from concurrent.futures import ThreadPoolExecutor

REG = 'https://registry.npmjs.org'
CACHE = {}

REQUIRED = [
    'admitPromptContent',
    'saveImages',
    'saveFile',
    'readImage',
    'readImageRequest',
    'readFileStream',
    'fileHostPath',
    'imageLimits',
    'maxImagePixels',
    'root',
]

PACKAGES = ['@deepseek-ai/dsh-attachment', '@deepseek-ai/dsh-attachment-local']


def fetch(url, binary=False):
    req = urllib.request.Request(url, headers={'cache-control': 'no-cache',
                                               'user-agent': 'dsh-compat-probe'})
    with urllib.request.urlopen(req, timeout=90) as r:
        return r.read() if binary else r.read().decode('utf-8', 'replace')


def packument(name):
    key = 'meta:' + name
    if key not in CACHE:
        CACHE[key] = json.loads(fetch('%s/%s' % (REG, name.replace('/', '%2F'))))
    return CACHE[key]


def declarations(name, version):
    """Every .d.ts in one published package, or None when there is nothing to read."""
    key = '%s@%s' % (name, version)
    if key in CACHE:
        return CACHE[key]
    CACHE[key] = None
    try:
        entry = packument(name)['versions'].get(version)
        if entry is None:
            return None
        blob = fetch(entry['dist']['tarball'], binary=True)
        text = []
        with tarfile.open(fileobj=io.BytesIO(blob), mode='r:gz') as tar:
            for member in tar.getmembers():
                if member.name.endswith('.d.ts') and member.isfile():
                    text.append(tar.extractfile(member).read().decode('utf-8', 'replace'))
        CACHE[key] = '\n'.join(text) if text else None
    except Exception as error:
        print('  ! %s: %s' % (key, error), file=sys.stderr)
    return CACHE[key]


def main():
    meta = packument('@deepseek-ai/dsh')
    versions = sorted(meta['versions'], key=lambda v: meta['time'][v])

    def probe(version):
        texts = []
        sources = []
        for name in PACKAGES:
            text = declarations(name, version)
            if text:
                texts.append(text)
                sources.append(name.rsplit('/', 1)[-1])
        if not texts:
            return version, None, None
        joined = '\n'.join(texts)
        missing = [member for member in REQUIRED if member not in joined]
        return version, missing, '+'.join(sources)

    with ThreadPoolExecutor(max_workers=6) as pool:
        results = list(pool.map(probe, versions))

    print('%-18s %-9s %s' % ('dsh', 'read from', 'missing members'))
    print('-' * 84)
    state = {}
    for version, missing, sources in results:
        if missing is None:
            label = 'NO DATA'
        elif missing:
            label = ', '.join(missing)
        else:
            label = 'OK'
        state[version] = label
        print('%-18s %-9s %s' % (version, sources or '-', label))

    ok = [v for v in versions if state[v] == 'OK']
    nodata = [v for v in versions if state[v] == 'NO DATA']
    print('\nevery member present : %s' % (', '.join(ok) if ok else 'none'))
    print('no data              : %s' % (', '.join(nodata) if nodata else 'none'))
    if ok:
        print('\n=> continuous support from %s through %s' % (ok[0], ok[-1]))
        first_bad = [v for v in versions[:versions.index(ok[0])]]
        if first_bad:
            print('   versions before it that lack something: %s' % ', '.join(first_bad))


if __name__ == '__main__':
    main()
