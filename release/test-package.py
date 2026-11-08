"""Exercise release packaging through its public command."""
import json
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest


class Package(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.root / 'source'
        files = {'packages/modgud/package.json': '{"version":"9.8.7"}',
                 '.gitignore': '.env\n*.sqlite\n',
                 'LICENSE': 'application license', 'release/INSTALLING.md': 'install',
                 'release/NOTICE-AUDIT.md': 'notices'}
        for name, content in files.items():
            path = self.source / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content)
        self.git('init', '-q')
        self.git('add', '.')
        self.git('-c', 'user.name=Test', '-c', 'user.email=test@example.com',
                 '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Fixture')
        self.commit = self.git('rev-parse', 'HEAD').strip()
        self.binary = self.root / 'binary'
        self.binary.write_bytes(b'fixture executable')
        self.notices = self.root / 'notices'
        self.notices.mkdir()
        (self.notices / 'LICENSE').write_text('dependency license')
        self.output = self.root / 'output'

    def git(self, *args):
        return subprocess.check_output(['git', '-C', str(self.source), *args],
                                       text=True, stderr=subprocess.PIPE, timeout=15)

    def invoke(self, *args):
        return subprocess.run([sys.executable, str(Path(__file__).with_name('package.py')),
                               '--source', str(self.source), '--binary', str(self.binary),
                               '--notices', str(self.notices), '--out', str(self.output), *args],
                              capture_output=True, text=True, timeout=30)

    def test_package_version_controls_names_and_provenance(self):
        result = self.invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.output / 'modgud-9.8.7-source.tar.gz').is_file())
        self.assertTrue((self.output / 'modgud-9.8.7-linux-x64.tar.gz').is_file())
        self.assertEqual((self.output / 'modgud-9.8.7-linux-x64').read_bytes(), b'fixture executable')
        self.assertEqual(json.loads((self.output / 'PROVENANCE.json').read_text())['version'], '9.8.7')

    def test_source_archive_uses_committed_bytes_and_excludes_local_state(self):
        for name in ['.env', 'private.sqlite', 'untracked.txt']:
            (self.source / name).write_text('private local state')
        (self.source / 'LICENSE').write_text('uncommitted license')
        result = self.invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        with tarfile.open(self.output / 'modgud-9.8.7-source.tar.gz') as archive:
            self.assertEqual(set(archive.getnames()), set(self.git('ls-files').splitlines()))
            self.assertEqual(archive.extractfile('LICENSE').read(), b'application license')
        provenance = json.loads((self.output / 'PROVENANCE.json').read_text())
        self.assertEqual(provenance['source_commit'], self.commit)
        self.assertNotIn('source_diff', provenance)
        with tarfile.open(self.output / 'modgud-9.8.7-linux-x64.tar.gz') as archive:
            self.assertEqual(json.load(archive.extractfile('PROVENANCE.json')), provenance)

    def test_missing_notices_fail_before_writing_release_files(self):
        self.notices = self.root / 'missing-notices'
        result = self.invoke()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.output.exists())

    def test_source_symlink_cannot_import_external_private_data(self):
        (self.source / 'linked').symlink_to(self.binary)
        self.git('add', 'linked')
        self.git('-c', 'user.name=Test', '-c', 'user.email=test@example.com',
                 '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Linked fixture')
        result = self.invoke()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.output.exists())

    def test_notice_symlink_cannot_import_external_private_data(self):
        (self.notices / 'linked').symlink_to(self.binary)
        result = self.invoke()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.output.exists())

    def test_version_cannot_escape_output_directory(self):
        (self.source / 'packages/modgud/package.json').write_text('{"version":"../escape"}')
        self.git('add', 'packages/modgud/package.json')
        self.git('-c', 'user.name=Test', '-c', 'user.email=test@example.com',
                 '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Invalid version')
        result = self.invoke()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.output.exists())

    def test_invalid_source_fails_before_writing_release_files(self):
        self.source = self.root / 'missing'
        result = self.invoke()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.output.exists())


if __name__ == '__main__':
    unittest.main()
