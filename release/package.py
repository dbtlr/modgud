"""Package committed source separately from explicitly supplied runtime notices."""
import argparse
import gzip
import hashlib
import io
import json
import pathlib
import re
import subprocess
import tarfile


def digest(data):
    return hashlib.sha256(data).hexdigest()


def git(root, *args):
    return subprocess.check_output(['git', '-C', str(root), *args], stderr=subprocess.PIPE)


def committed_source(root):
    """Read Git objects so local state and uncommitted edits cannot enter a release."""
    root = root.resolve()
    if pathlib.Path(git(root, 'rev-parse', '--show-toplevel').decode().strip()).resolve() != root:
        raise ValueError('--source must be the root of a Git checkout')
    commit = git(root, 'rev-parse', '--verify', 'HEAD^{commit}').decode().strip()
    files, modes = {}, {}
    for entry in git(root, 'ls-tree', '-rz', commit).split(b'\0'):
        if not entry:
            continue
        metadata, name = entry.split(b'\t', 1)
        mode, kind, blob = metadata.split()
        if kind != b'blob' or mode not in (b'100644', b'100755'):
            raise ValueError('Source contains a symlink or submodule: ' + name.decode())
        name = name.decode()
        files[name] = git(root, 'cat-file', 'blob', blob.decode())
        modes[name] = 0o755 if mode == b'100755' else 0o644
    return files, modes, commit


def collect_notices(root):
    """Reject links instead of following them outside the explicit notice input."""
    if not root.is_dir() or root.is_symlink():
        raise ValueError('--notices must be a directory of reviewed notice files')
    files = {}
    for path in sorted(root.rglob('*')):
        if path.is_symlink():
            raise ValueError('Notice input contains a symlink: ' + str(path))
        if path.is_file():
            files[path.relative_to(root).as_posix()] = path.read_bytes()
    if not files:
        raise ValueError('--notices must contain reviewed notice files')
    return files


def write_archive(output, name, files, modes):
    """Normalize archive metadata so identical inputs produce identical bytes."""
    with (output / name).open('wb') as raw:
        with gzip.GzipFile(fileobj=raw, mode='wb', mtime=0, filename='', compresslevel=9) as compressed:
            with tarfile.open(fileobj=compressed, mode='w') as archive:
                for name, data in sorted(files.items()):
                    info = tarfile.TarInfo(name)
                    info.size = len(data)
                    info.mtime = info.uid = info.gid = 0
                    info.uname = info.gname = ''
                    info.mode = modes.get(name, 0o644)
                    archive.addfile(info, io.BytesIO(data))


def manifest(files):
    return {name: {'sha256': digest(data), 'bytes': len(data)} for name, data in sorted(files.items())}


def main():
    parser = argparse.ArgumentParser()
    for name in ['source', 'binary', 'notices', 'out']:
        parser.add_argument('--' + name, type=pathlib.Path, required=True)
    args = parser.parse_args()
    try:
        source, modes, commit = committed_source(args.source)
        notices = collect_notices(args.notices)
        version = json.loads(source['packages/modgud/package.json'])['version']
        if not isinstance(version, str) or not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?', version):
            raise ValueError('Package version must be a semantic version without path separators')
        binary = args.binary.read_bytes()
    except (ValueError, OSError, KeyError, subprocess.CalledProcessError) as error:
        parser.error(str(error))
    runtime = {
        'bin/modgud': binary,
        'LICENSE': source['LICENSE'],
        'INSTALLING.md': source['release/INSTALLING.md'],
        'NOTICE-AUDIT.md': source['release/NOTICE-AUDIT.md'],
    }
    runtime.update({'notices/' + name: data for name, data in notices.items()})
    provenance = {
        'format': 1,
        'candidate': True,
        'published': False,
        'version': version,
        'source_commit': commit,
        'target': 'bun-linux-x64',
        'binary_sha256': digest(binary),
        'binary_bytes': len(binary),
        'build': 'bun run build',
    }
    notice_bytes = source['LICENSE'] + b'\n' + b''.join(
        b'\n===== ' + name.encode() + b' =====\n' + data + b'\n'
        for name, data in sorted(notices.items()))
    runtime['modgud-NOTICES.txt'] = notice_bytes
    runtime['PROVENANCE.json'] = (json.dumps(provenance, indent=2) + '\n').encode()
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / 'modgud-NOTICES.txt').write_bytes(notice_bytes)
    write_archive(args.out, f'modgud-{version}-source.tar.gz', source, modes)
    write_archive(args.out, f'modgud-{version}-linux-x64.tar.gz', runtime, {'bin/modgud': 0o755})
    for name, files in [('source', source), ('runtime', runtime)]:
        (args.out / (name + '-manifest.json')).write_text(json.dumps(manifest(files), indent=2) + '\n')
    (args.out / 'PROVENANCE.json').write_text(json.dumps(provenance, indent=2) + '\n')
    for name in [f'modgud-{version}-linux-x64', 'modgud-linux-x64']:
        target = args.out / name
        target.write_bytes(binary)
        target.chmod(0o755)
    (args.out / 'SHA256SUMS').write_text(''.join(
        digest(path.read_bytes()) + '  ' + path.name + '\n'
        for path in sorted(args.out.iterdir()) if path.is_file() and path.name != 'SHA256SUMS'))


if __name__ == '__main__':
    main()
