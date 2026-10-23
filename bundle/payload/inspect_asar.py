import argparse
import json
import pathlib
import struct


def read_header(archive):
    with archive.open('rb') as stream:
        marker, header_size, _, json_size = struct.unpack('<4I', stream.read(16))
        if marker != 4 or not 0 < json_size < 100_000_000:
            raise ValueError('Unexpected ASAR header')
        tree = json.loads(stream.read(json_size))
    return tree, 8 + header_size


def entry(tree, name):
    current = tree
    for part in name.split('/'):
        if part in ('', '.', '..'):
            raise ValueError('Invalid member path')
        current = current['files'][part]
    return current


def extract(archive, destination, members):
    tree, data_offset = read_header(archive)
    with archive.open('rb') as stream:
        for name in members:
            info = entry(tree, name)
            if info.get('unpacked') or 'link' in info or 'files' in info:
                raise ValueError(f'Unsupported member: {name}')
            stream.seek(data_offset + int(info['offset']))
            data = stream.read(info['size'])
            if len(data) != info['size']:
                raise ValueError(f'Truncated member: {name}')
            target = destination.joinpath(*name.split('/'))
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            print(json.dumps({'member': name, 'bytes': len(data), 'output': str(target)}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('archive', type=pathlib.Path)
    parser.add_argument('destination', type=pathlib.Path)
    parser.add_argument('members', nargs='+')
    args = parser.parse_args()
    extract(args.archive, args.destination, args.members)
