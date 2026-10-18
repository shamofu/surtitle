"""Expand the pinned libmpv source catalog for download and evidence consumers."""
import json
import re


def read_sources(workspace):
    manifest = json.loads((workspace / 'native/build/sources.json').read_text(encoding='utf-8-sig'))
    sources = manifest['sources']
    ids = [source['id'] for source in sources]
    if len(set(ids)) != len(ids):
        raise ValueError('Duplicate native source id')
    for source in sources:
        if (not re.fullmatch(r'[\w.-]+/[\w.-]+', source['repo'])
                or not re.fullmatch(r'[a-f0-9]{40}', source['commit'])
                or not re.fullmatch(r'[a-f0-9]{64}', source['sha256'])
                or not re.fullmatch(r'[\w.-]+', source['id'])):
            raise ValueError('Invalid pinned native source: ' + source['id'])
        if 'parent' in source and source['parent'] not in ids:
            raise ValueError('Unknown native source parent: ' + source['id'])
        source['url'] = f"https://codeload.github.com/{source['repo']}/tar.gz/{source['commit']}"
        source['file'] = f"{source['id']}-{source['commit']}.tar.gz"
        source.setdefault('ref', source['commit'])
        source['submodules'] = [
            {'path': child['destination'], 'sha': child['commit']}
            for child in sources if child.get('parent') == source['id']
        ]
    return manifest
