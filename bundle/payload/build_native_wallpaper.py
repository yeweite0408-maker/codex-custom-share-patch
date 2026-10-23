"""Add a local video to a private Codex copy; never edit the Store installation."""
import hashlib
import argparse
import json
import pathlib
import re
import shutil
import struct
import os
import sys
sys.dont_write_bytecode = True

from inspect_asar import entry, read_header


WORK = pathlib.Path(__file__).resolve().parent
SOURCE = pathlib.Path(r'C:\Program Files\WindowsApps\OpenAI.Codex_26.1013.4894.0_x64__2p2nqsd0c76g0\app')
TARGET = WORK / 'private-app'
MEDIA = pathlib.Path(os.environ.get('LOCALAPPDATA', str(pathlib.Path.home() / 'AppData/Local'))) / 'CodexDreamSkin/active-theme/art-20261018-122431-227-f1df1736.mp4'
ASSETS = WORK / 'native-wallpaper'
BLOCK_SIZE = 4 * 1024 * 1024


def digest_file(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def digest_segment(stream, size):
    digest = hashlib.sha256()
    while size:
        block = stream.read(min(size, 1024 * 1024))
        if not block:
            raise ValueError('Truncated archive segment')
        digest.update(block)
        size -= len(block)
    return digest.hexdigest()


def read_member(archive, tree, start, name):
    info = entry(tree, name)
    with archive.open('rb') as stream:
        stream.seek(start + int(info['offset']))
        return stream.read(info['size'])


def main():
    global TARGET, SOURCE, MEDIA
    parser = argparse.ArgumentParser()
    parser.add_argument('--target', type=pathlib.Path)
    parser.add_argument('--source', type=pathlib.Path)
    parser.add_argument('--media', type=pathlib.Path)
    parser.add_argument('--portable', action='store_true', help='Build from the recipient\'s own official application; omit personal wallpaper')
    parser.add_argument('--network-repair', action='store_true')
    parser.add_argument('--usage-footer', action='store_true')
    parser.add_argument('--auto-resume', action='store_true')
    parser.add_argument('--wallpaper-settings', action='store_true')
    parser.add_argument('--check-source', action='store_true', help='Verify supported original resources without creating or modifying an app')
    args = parser.parse_args()
    if args.source:
        SOURCE = args.source.resolve()
    if args.check_source:
        archive = SOURCE / 'resources/app.asar'
        read_header(archive)
        with archive.open('rb') as stream:
            stream.seek(12)
            size = struct.unpack('<I', stream.read(4))[0]
            header = stream.read(size)
        if hashlib.sha256(header).hexdigest() != 'beb6d4c814d5ab5691135d8c6c1ba77834de0476cf049f2bb7b3e182928c822c':
            raise ValueError('Unsupported Codex version: this patch only supports original 26.1013.40934 resources; no application was changed')
        if digest_file(SOURCE / 'ChatGPT.exe') != '2f61eaeb01dcee7fd18d572fbb338c88b686c0d891427487fdd182afdd64b4f6':
            raise ValueError('Original executable does not match the supported source')
        print(json.dumps({'supported': True, 'baseVersion': '26.1013.40934'}))
        return
    if args.media:
        MEDIA = args.media.resolve()
    elif args.portable:
        MEDIA = None
    if args.target:
        TARGET = args.target.resolve()
        if not args.portable and not TARGET.is_relative_to(WORK.parents[3]):
            raise ValueError('Private build target must stay in the Codex workspace')
    if not SOURCE.is_dir() or not TARGET.is_dir() or SOURCE.resolve() == TARGET.resolve() or TARGET.resolve().is_relative_to(SOURCE.resolve()) or SOURCE.resolve().is_relative_to(TARGET.resolve()):
        raise ValueError('Expected the official source and a separate private app copy')
    source_archive = SOURCE / 'resources/app.asar'
    target_archive = TARGET / 'resources/app.asar'
    source_exe = SOURCE / 'ChatGPT.exe'
    target_exe = TARGET / 'ChatGPT.exe'
    if digest_file(source_archive) != digest_file(target_archive):
        raise ValueError('The private archive is not an untouched copy')
    if digest_file(source_exe) != digest_file(target_exe):
        raise ValueError('The private executable is not an untouched copy')

    tree, old_start = read_header(source_archive)
    with source_archive.open('rb') as stream:
        stream.seek(12)
        json_size = struct.unpack('<I', stream.read(4))[0]
        old_header = stream.read(json_size)
    old_header_hash = hashlib.sha256(old_header).hexdigest()
    if old_header_hash != 'beb6d4c814d5ab5691135d8c6c1ba77834de0476cf049f2bb7b3e182928c822c':
        raise ValueError('Unsupported Codex source version; this patch requires original 26.1013.40934 resources')
    index = read_member(source_archive, tree, old_start, 'webview/index.html').decode('utf-8')
    if 'codex-native-wallpaper' in index or index.count('</head>') != 1:
        raise ValueError('Unexpected HTML layout or already patched archive')
    index = index.replace('<html', '<html data-codex-wallpaper-builtin="' + ('true' if MEDIA else 'false') + '"', 1)
    index = index.replace('</head>',
        '  <link rel="stylesheet" href="./assets/codex-native-wallpaper.css" />\n'
        '    <script defer src="./assets/codex-native-wallpaper.js"></script>\n'
        '  </head>', 1)
    replacements = {
        'webview/index.html': index.encode('utf-8'),
        'webview/assets/codex-native-wallpaper.js': (ASSETS / 'codex-native-wallpaper.js').read_bytes(),
        'webview/assets/codex-native-wallpaper.css': (ASSETS / 'codex-native-wallpaper.css').read_bytes(),
    }
    if MEDIA:
        replacements['webview/assets/codex-native-wallpaper.mp4'] = MEDIA.read_bytes()
    if args.wallpaper_settings:
        from patch_wallpaper_settings import patch_appearance
        extension = WORK / 'codex-wallpaper-settings'
        if not extension.is_dir():
            extension = WORK.parent / 'codex-wallpaper-settings'
        index = index.replace('</head>',
            '  <link rel="stylesheet" href="./assets/codex-wallpaper-settings.css" />\n'
            '    <script src="./assets/codex-wallpaper-controller.js"></script>\n'
            '    <script src="./assets/codex-wallpaper-settings.js"></script>\n'
            '  </head>', 1)
        replacements['webview/index.html'] = index.encode('utf-8')
        for source_name, target_name in [('controller.js', 'codex-wallpaper-controller.js'), ('settings.js', 'codex-wallpaper-settings.js'), ('settings.css', 'codex-wallpaper-settings.css')]:
            replacements['webview/assets/' + target_name] = (extension / source_name).read_bytes()
        name = 'webview/assets/appearance-settings-db37cb1d28c1.js'
        replacements[name] = patch_appearance(read_member(source_archive, tree, old_start, name).decode('utf-8')).encode('utf-8')
    if args.usage_footer:
        from patch_usage_footer import patch_initial, patch_turn
        index = index.replace('</head>',
            '  <link rel="stylesheet" href="./assets/codex-usage-footer.css" />\n'
            '    <script src="./assets/codex-usage-footer.js"></script>\n'
            '  </head>', 1)
        replacements['webview/index.html'] = index.encode('utf-8')
        for asset in ['codex-usage-footer.js', 'codex-usage-footer.css']:
            replacements['webview/assets/' + asset] = (ASSETS / asset).read_bytes()
        for name, patch in [
            ('webview/assets/app-initial-5851df3f6cb1.js', patch_initial),
            ('webview/assets/local-conversation-turn-69783815d57d.js', patch_turn),
        ]:
            original = read_member(source_archive, tree, old_start, name).decode('utf-8')
            replacements[name] = patch(original).encode('utf-8')
    if args.auto_resume:
        from patch_auto_resume import patch_initial, patch_header
        extension = WORK / 'codex-auto-resume'
        if not extension.is_dir():
            extension = WORK.parent / 'codex-auto-resume'
        index = index.replace('</head>',
            '  <link rel="stylesheet" href="./assets/codex-auto-resume.css" />\n'
            '    <script src="./assets/codex-auto-resume-engine.js"></script>\n'
            '    <script src="./assets/codex-auto-resume-adapter.js"></script>\n'
            '    <script src="./assets/codex-auto-resume-ui.js"></script>\n'
            '  </head>', 1)
        replacements['webview/index.html'] = index.encode('utf-8')
        for source_name, target_name in [('engine.cjs', 'engine.js'), ('native-adapter.cjs', 'adapter.js'), ('ui.js', 'ui.js'), ('ui.css', '.css')]:
            target_name = 'codex-auto-resume' + (target_name if target_name.startswith('.') else '-' + target_name)
            replacements['webview/assets/' + target_name] = (extension / source_name).read_bytes()
        for name, patch in [
            ('webview/assets/app-initial-5851df3f6cb1.js', patch_initial),
            ('webview/assets/local-conversation-page-4298f8ec98fa.js', patch_header),
        ]:
            original = replacements.get(name) or read_member(source_archive, tree, old_start, name)
            replacements[name] = patch(original.decode('utf-8')).encode('utf-8')
    if args.network_repair:
        bootstrap_name = '.vite/build/bootstrap-cdWF4rWM.js'
        bootstrap = read_member(source_archive, tree, old_start, bootstrap_name).decode('utf-8')
        old_transport = 'this.assertAllowed(n);let r=e instanceof URL?e.href:e;return y.net.fetch(r,t)'
        new_transport = 'this.assertAllowed(n);let r=e instanceof URL?e.href:e;return require("./native-network-fallback.cjs")(r,t,(e,t)=>y.net.fetch(e,t))'
        if bootstrap.count(old_transport) != 1:
            raise ValueError('The guarded application network transport changed')
        bootstrap = bootstrap.replace(old_transport, new_transport, 1)
        default_transport = '},s=y.net.fetch.bind(y.net)){i.signal?.throwIfAborted();'
        repaired_default = '},s=(e,t)=>require("./native-network-fallback.cjs")(e,t,(e,t)=>y.net.fetch(e,t))){i.signal?.throwIfAborted();'
        if bootstrap.count(default_transport) != 1:
            raise ValueError('The authenticated API transport changed')
        bootstrap = bootstrap.replace(default_transport, repaired_default, 1)
        replacements[bootstrap_name] = bootstrap.encode('utf-8')
        replacements['.vite/build/native-network-fallback.cjs'] = (WORK / 'native-network-fallback.cjs').read_bytes()
        early_name = '.vite/build/early-bootstrap.js'
        early = read_member(source_archive, tree, old_start, early_name).decode('utf-8')
        locale_anchor = 'let r=require("electron");'
        if early.count(locale_anchor) != 1:
            raise ValueError('The early locale initialization anchor changed')
        locale_default = 'if(process.platform==="win32"&&!r.app.commandLine.hasSwitch("lang"))r.app.commandLine.appendSwitch("lang","zh-CN");'
        replacements[early_name] = early.replace(locale_anchor, locale_anchor + locale_default, 1).encode('utf-8')
    offset = source_archive.stat().st_size - old_start
    old_data_size = offset
    for name, data in replacements.items():
        node = tree
        parts = name.split('/')
        for part in parts[:-1]:
            node = node.setdefault('files', {}).setdefault(part, {'files': {}})
        node['files'][parts[-1]] = {
            'size': len(data),
            'offset': str(offset),
            'integrity': {
                'algorithm': 'SHA256',
                'hash': hashlib.sha256(data).hexdigest(),
                'blockSize': BLOCK_SIZE,
                'blocks': [hashlib.sha256(data[i:i + BLOCK_SIZE]).hexdigest()
                           for i in range(0, len(data), BLOCK_SIZE)],
            },
        }
        offset += len(data)
    new_header = json.dumps(tree, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    new_header_hash = hashlib.sha256(new_header).hexdigest()
    padding = b'\0' * ((-len(new_header)) % 4)
    header_pickle = struct.pack('<II', 4 + len(new_header) + len(padding), len(new_header)) + new_header + padding
    size_pickle = struct.pack('<II', 4, len(header_pickle))
    new_start = len(size_pickle) + len(header_pickle)
    temp_archive = target_archive.with_suffix('.asar.native-wallpaper-tmp')
    with source_archive.open('rb') as source, temp_archive.open('xb') as destination:
        destination.write(size_pickle)
        destination.write(header_pickle)
        source.seek(old_start)
        shutil.copyfileobj(source, destination, 1024 * 1024)
        for data in replacements.values():
            destination.write(data)

    verify_tree, verify_start = read_header(temp_archive)
    if verify_start != new_start:
        raise ValueError('Archive header size mismatch')
    for name, data in replacements.items():
        if read_member(temp_archive, verify_tree, verify_start, name) != data:
            raise ValueError(f'Written member differs: {name}')
    with source_archive.open('rb') as source, temp_archive.open('rb') as destination:
        source.seek(old_start)
        destination.seek(new_start)
        if digest_segment(source, old_data_size) != digest_segment(destination, old_data_size):
            raise ValueError('Original app payload changed during packaging')

    exe_data = source_exe.read_bytes()
    resource = re.compile(rb'\[\{"file":"resources\\\\app\.asar","alg":"SHA256","value":"([a-f0-9]{64})"\}\]')
    matches = list(resource.finditer(exe_data))
    if len(matches) != 1 or matches[0].group(1).decode() != old_header_hash:
        raise ValueError('Unexpected embedded ASAR integrity resource')
    begin, end = matches[0].span(1)
    new_exe = exe_data[:begin] + new_header_hash.encode('ascii') + exe_data[end:]
    if len(new_exe) != len(exe_data):
        raise ValueError('Executable size unexpectedly changed')
    # Only the expected archive header hash is updated; validation stays enabled.
    temp_exe = target_exe.with_suffix('.exe.native-wallpaper-tmp')
    temp_exe.write_bytes(new_exe)
    temp_archive.replace(target_archive)
    temp_exe.replace(target_exe)
    result = {
        'name': 'Codex 内置动态壁纸',
        'baseVersion': '26.1013.40934',
        'sourceApplication': str(SOURCE),
        'privateApplication': str(TARGET),
        'sourceHeaderSHA256': old_header_hash,
        'patchedHeaderSHA256': new_header_hash,
        'sourceExeSHA256': hashlib.sha256(exe_data).hexdigest(),
        'patchedExeSHA256': hashlib.sha256(new_exe).hexdigest(),
        'mediaSHA256': digest_file(MEDIA) if MEDIA else None,
        'members': {name: hashlib.sha256(data).hexdigest() for name, data in replacements.items()},
        'officialSignaturePreserved': False,
        'archiveIntegrityValidationPreserved': True,
        'separateWallpaperProcessRequired': False,
        'wallpaperScope': 'window',
        'officialReadNetworkFallback': bool(args.network_repair),
        'uiLocaleDefault': 'zh-CN' if args.network_repair else None,
        'composerGlass': {'opacity': 0.52, 'blurPx': 22, 'toolbarOpacity': 0.40},
        'threadDecorationPaintCleared': True,
        'usageFooter': bool(args.usage_footer),
        'quotaAutoResume': bool(args.auto_resume),
        'wallpaperSettings': bool(args.wallpaper_settings),
        'includesBuiltinWallpaper': bool(MEDIA),
    }
    (TARGET / 'native-wallpaper-build.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    if not args.portable:
        (WORK / 'native-wallpaper-build.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
