"""Inspect the actual APK payload; does not install or start any device."""
from pathlib import Path
import hashlib, json, zipfile, sys

root = Path(__file__).resolve().parents[2]
apk = (root / sys.argv[1]) if len(sys.argv) > 1 else root / 'artifacts/noetic-atlas-debug.apk'
with zipfile.ZipFile(apk) as archive:
    files = set(archive.namelist())
    assert 'classes.dex' in files
    assert any(b'Lcn/noetic/atlas/LearningFileSharePlugin;' in archive.read(name)
               for name in files if name.startswith('classes') and name.endswith('.dex')), 'APK must carry the explicit-MIME generated file sharing plugin'
    assert not any(Path(name).name == 'native-seed.json' or '/content-packs/' in name or '/content-sources/' in name
                   or Path(name).suffix.lower() in {'.sqlite', '.db'} for name in files), 'Software APK must not include question packs or a database'
    configuration_bytes = archive.read('assets/public/config/defaults.json')
    assert configuration_bytes == (root / 'config/defaults.json').read_bytes(), 'APK must carry the current clean base configuration'
    configuration = json.loads(configuration_bytes)
    assert set(configuration) == {'format', 'schemaVersion', 'exportedAt', 'system', 'ai'}
    assert configuration['format'] == 'noetic-atlas-configuration' and configuration['schemaVersion'] == 1
    assert configuration['system']['examDurationMinutes'] == 120
    assert configuration['system']['maxDraftsPerPaper'] == 3
    assert configuration['ai']['enabled'] is False and configuration['ai']['baseUrl'] == '' and configuration['ai']['model'] == ''
    assert not {'key', 'token', 'apiKey'}.intersection(configuration['ai']), 'Base configuration must not carry credentials'
    wasm = archive.read('assets/public/sql-wasm.wasm')
    assert wasm[:4] == b'\x00asm'
    assert wasm == (root / 'node_modules/sql.js/dist/sql-wasm.wasm').read_bytes()
    font_sources = [path for path in (root / 'web/assets/fonts').iterdir() if path.suffix.lower() in {'.ttf', '.otf'}]
    assert font_sources, 'Offline PDF font must exist'
    for font in font_sources:
        matching = [name for name in files if name.startswith('assets/public/assets/') and name.endswith(font.suffix.lower())]
        assert any(archive.read(name) == font.read_bytes() for name in matching), 'APK must carry the offline Chinese PDF font'
    assert archive.read('assets/public/licenses/NotoSansCJK-OFL.txt') == (root / 'web/assets/fonts/OFL-NotoSansCJK.txt').read_bytes()
    config = json.loads(archive.read('assets/capacitor.config.json'))
    assert config['appId'] == 'cn.noetic.atlas'
    assert config['appName'] == '认知星图'
    assert 'url' not in config['server'], 'Offline APK must not point to a computer/web host'
    assert config['server']['androidScheme'] == 'https'
    assert not any(Path(name).name in {'main.md', '.env'} or name.endswith('.docx') for name in files)
    html = archive.read('assets/public/index.html').decode()
    assert 'viewport-fit=cover' in html
    expected_public = set()
    for source in (root / 'dist/mobile').rglob('*'):
        if source.is_file():
            packaged = 'assets/public/' + source.relative_to(root / 'dist/mobile').as_posix()
            expected_public.add(packaged)
            assert archive.read(packaged) == source.read_bytes(), f'APK contains stale web asset: {packaged}'
    # Capacitor adds only these two compatibility files. Old hash-named JS or
    # retired fonts must not survive a rebuild and inflate the portable APK.
    packaged_public = {name for name in files if name.startswith('assets/public/') and not name.endswith('/')}
    unexpected_public = packaged_public - expected_public - {'assets/public/cordova.js', 'assets/public/cordova_plugins.js'}
    assert not unexpected_public, f'APK carries retired web assets: {sorted(unexpected_public)}'
    assert all(name in files for name in ['AndroidManifest.xml', 'resources.arsc'])
    compressed_payload = sum(entry.compress_size for entry in archive.infolist())
    archive_overhead = apk.stat().st_size - compressed_payload
    # Fresh debug archives need ZIP headers, alignment and a signature block,
    # not megabytes of retired entry data from incremental APK rewriting.
    assert archive_overhead < 1_048_576 + len(files) * 512, 'APK retains unreferenced incremental archive data; rebuild with :app:clean'
result = {
    'apk': str(apk.relative_to(root)), 'sizeBytes': apk.stat().st_size,
    'sha256': hashlib.sha256(apk.read_bytes()).hexdigest(),
    'questions': 0, 'publishedQuestions': 0, 'pendingQuestions': 0,
    'questionTypes': {}, 'domains': 0, 'categories': 0, 'tags': 0, 'questionBanks': 0,
    'installation': 'empty-install', 'includesQuestionData': False,
    'baseConfigurationSha256': hashlib.sha256(configuration_bytes).hexdigest(),
    'wasmSha256': hashlib.sha256(wasm).hexdigest(),
    'noRemoteServer': True, 'payloadVerified': True, 'allFinalWebAssetsMatched': True,
    'offlinePdfFontAndLicenseIncluded': True,
    'nativeGeneratedFileSharePlugin': True,
    'noRetiredWebAssets': True,
    'compressedPayloadBytes': compressed_payload, 'archiveOverheadBytes': archive_overhead,
}
(root / 'test-results').mkdir(exist_ok=True)
report_name = 'android-release-apk-report.json' if 'release' in apk.stem else 'android-apk-report.json'
(root / 'test-results' / report_name).write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(result, ensure_ascii=False))
