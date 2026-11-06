# SPDX-License-Identifier: GPL-3.0-or-later
"""Read-only production smoke audit. Never starts the application or a provider."""
import hashlib
import json
import sqlite3
import sys
from pathlib import Path


def require(condition, message):
    if not condition:
        raise ValueError(message)


def database(path):
    return sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True)


def audit(root, fixture_path, after):
    fixture = json.loads((root / 'fixture.json').read_text(encoding='utf-8-sig'))
    require(fixture == dict(mediaId='fixture-media', cardId='fixture-card', segmentCount=20000,
                            mediaPath=str(fixture_path)), 'Unexpected seeded fixture identity')
    require(fixture_path.is_file(), 'Local media fixture missing')
    with database(root / 'learning.sqlite') as db:
        media = db.execute('SELECT id,data FROM media').fetchall()
        require(len(media) == 1 and media[0][0] == 'fixture-media', 'Unexpected media')
        require(json.loads(media[0][1])['path'] == str(fixture_path), 'Unexpected media source')
        cards = db.execute('SELECT id,data FROM cards ORDER BY id').fetchall()
        segments = db.execute('SELECT id,media_id,start_ms,data FROM segments ORDER BY id').fetchall()
        require(len(cards) == 1 and cards[0][0] == 'fixture-card', 'Unexpected cards')
        require(len(segments) == 20000 and all(s[1] == 'fixture-media' for s in segments), 'Unexpected subtitles')
        require(db.execute('SELECT count(*) FROM reviews').fetchone()[0] == 0, 'Playback changed reviews')
        digest = hashlib.sha256(json.dumps([cards, segments], ensure_ascii=False).encode()).hexdigest()
    if after:
        with database(root / 'charges.sqlite') as db:
            for table in ('ai_jobs', 'ai_requests', 'ai_attempts'):
                require(db.execute('SELECT count(*) FROM ' + table).fetchone()[0] == 0, 'AI activity occurred')
            limits = dict(db.execute('SELECT provider,limits_json FROM ai_provider_settings'))
            require(set(limits) == {'vertex', 'openai'}, 'Unexpected providers')
            require(all(json.loads(v) == dict(per_job_microusd=0, daily_microusd=0, monthly_microusd=0)
                        for v in limits.values()), 'A budget was enabled')
        prefs = json.loads((root / 'preferences.json').read_text(encoding='utf-8-sig'))
        for key in ('credential_id', 'openai_credential_id', 'quotes', 'quote_generations', 'ai_continuations'):
            require(not prefs.get(key), 'Unexpected credentials or AI state')
        settings = prefs['settings']
        require(not settings['aiModels'] and not settings['openai']['aiModels'], 'Unexpected saved model')
        require(not settings['credentialConfigured'] and not settings['openai']['credentialConfigured'], 'Credential configured')
        require(prefs['tools'] == {'ffmpeg': {'source': 'managed'}}, 'Unexpected external tool selection')
        require(not any((root / 'credentials').rglob('*')), 'Credential storage was populated')
        require(not any(p.is_file() and (p.suffix.lower() in ('.exe', '.onnx') or p.name in ('ffmpeg', 'ffprobe'))
                        for p in root.rglob('*')), 'An on-demand tool was acquired')
    return dict(learningSha256=digest, mediaCount=1, cardCount=1, subtitleCount=20000, paidRequests=0)


if __name__ == '__main__':
    print(json.dumps(audit(Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3] == 'after')))
