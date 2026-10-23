"""Install only official Android API 36/build tools under this project's .localtools.
Does not alter the user's SDK, Java, PATH, or global environment.
"""
from pathlib import Path
import hashlib, shutil, urllib.request, xml.etree.ElementTree as ET, zipfile
from concurrent.futures import ThreadPoolExecutor

root = Path(__file__).resolve().parents[2]
target = root / '.localtools' / 'android-sdk'
downloads = root / '.localtools' / 'downloads'
downloads.mkdir(parents=True, exist_ok=True)
repository = None
for package, destination in [('platforms;android-36', 'platforms/android-36'), ('build-tools;36.0.0', 'build-tools/36.0.0')]:
    folder = target / destination
    if (folder / 'source.properties').exists():
        print(f'Already available: {folder}', flush=True)
        continue
    if repository is None:
        repository = ET.fromstring(urllib.request.urlopen('https://dl.google.com/android/repository/repository2-1.xml', timeout=60).read())
    choices = []
    for item in repository.findall('remotePackage'):
        if item.attrib.get('path') != package:
            continue
        for archive in item.findall('./archives/archive'):
            if archive.findtext('host-os') not in (None, 'windows'):
                continue
            complete = archive.find('complete')
            url = complete.findtext('url')
            if package.startswith('platforms') and '-ext' in url:
                continue
            choices.append((url, complete.findtext('checksum'), int(complete.findtext('size'))))
    if not choices:
        raise RuntimeError(f'Official repository has no Windows artifact: {package}')
    url, digest, size = choices[0]
    archive_path = downloads / Path(url).name
    if not archive_path.exists() or archive_path.stat().st_size != size:
        print(f'Downloading official SDK package: {url} ({size:,} bytes)', flush=True)
        urllib.request.urlretrieve('https://dl.google.com/android/repository/' + url, archive_path)
    if hashlib.sha1(archive_path.read_bytes()).hexdigest() != digest:
        raise RuntimeError(f'Official checksum mismatch: {archive_path}')
    with zipfile.ZipFile(archive_path) as archive:
        names = archive.namelist()
        base = names[0].split('/')[0] + '/'
        folder.mkdir(parents=True, exist_ok=True)
        for member in archive.infolist():
            relative = member.filename.removeprefix(base)
            if not relative:
                continue
            output = (folder / relative).resolve()
            if not output.is_relative_to(folder.resolve()):
                raise RuntimeError('SDK archive escaped destination')
            if member.is_dir():
                output.mkdir(parents=True, exist_ok=True)
            else:
                output.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(member) as src, output.open('wb') as dst:
                    shutil.copyfileobj(src, dst)
    print(f'Installed and verified: {folder}', flush=True)
existing = Path.home() / 'AppData/Local/Android/Sdk/licenses'
if existing.is_dir():
    shutil.copytree(existing, target / 'licenses', dirs_exist_ok=True)
print(f'Project SDK: {target}', flush=True)

# Java URLConnection may not follow the machine's download/proxy settings.
# A checked, project-local Gradle binary also makes subsequent builds portable.
gradle_version = '8.14.3'
gradle_folder = root / '.localtools' / f'gradle-{gradle_version}'
if not (gradle_folder / 'bin/gradle.bat').exists():
    base_url = f'https://downloads.gradle.org/distributions/gradle-{gradle_version}-bin.zip'
    checksum = urllib.request.urlopen(base_url + '.sha256', timeout=60).read().decode().strip().split()[0]
    gradle_archive = downloads / f'gradle-{gradle_version}-bin.zip'
    if not gradle_archive.exists() or hashlib.sha256(gradle_archive.read_bytes()).hexdigest() != checksum:
        print(f'Downloading official Gradle: {base_url}', flush=True)
        # Parallel verified ranges avoid extremely slow single-connection
        # downloads on some networks. No mirror or unsigned binary is used.
        probe = urllib.request.urlopen(urllib.request.Request(base_url, headers={'Range': 'bytes=0-0'}), timeout=60)
        if probe.status != 206:
            raise RuntimeError('Official Gradle host did not honor HTTP Range')
        size = int(probe.headers['Content-Range'].split('/')[-1]); probe.close()
        workers = 16
        step = (size + workers - 1) // workers
        def download_part(index):
            begin, end = index * step, min(size - 1, (index + 1) * step - 1)
            part = downloads / f'gradle-{gradle_version}-bin.part-{index:02d}'
            if part.exists() and part.stat().st_size == end - begin + 1:
                return part
            for attempt in range(3):
                try:
                    response = urllib.request.urlopen(urllib.request.Request(base_url, headers={'Range': f'bytes={begin}-{end}'}), timeout=60)
                    if response.status != 206 or response.headers.get('Content-Range') != f'bytes {begin}-{end}/{size}':
                        raise RuntimeError('Gradle range response did not match requested bytes')
                    with response, part.open('wb') as output:
                        shutil.copyfileobj(response, output)
                    if part.stat().st_size != end - begin + 1:
                        raise RuntimeError('Truncated Gradle range')
                    print(f'Gradle range {index + 1}/{workers} downloaded', flush=True)
                    return part
                except Exception:
                    if attempt == 2:
                        raise
        with ThreadPoolExecutor(max_workers=workers) as executor:
            parts = list(executor.map(download_part, range(workers)))
        with gradle_archive.open('wb') as output:
            for part in parts:
                with part.open('rb') as source:
                    shutil.copyfileobj(source, output)
    if hashlib.sha256(gradle_archive.read_bytes()).hexdigest() != checksum:
        raise RuntimeError('Official Gradle SHA-256 mismatch')
    with zipfile.ZipFile(gradle_archive) as archive:
        for member in archive.infolist():
            output = (root / '.localtools' / member.filename).resolve()
            if not output.is_relative_to(gradle_folder.resolve()):
                raise RuntimeError('Gradle archive escaped destination')
        archive.extractall(root / '.localtools')
    print(f'Installed and verified Gradle {gradle_version}', flush=True)
