"""Exercise release naming through the packager's public command."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


class Package(unittest.TestCase):
    def test_package_version_controls_names_and_provenance(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'source'
            files = {'packages/modgud/package.json': '{"version":"9.8.7"}',
                     'LICENSE': 'application license', 'release/INSTALLING.md': 'install',
                     'release/NOTICE-AUDIT.md': 'notices'}
            for name, content in files.items():
                path = source / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(content)
            binary = root / 'binary'
            binary.write_bytes(b'fixture executable')
            notices = root / 'notices'
            notices.mkdir()
            (notices / 'LICENSE').write_text('dependency license')
            output = root / 'output'
            result = subprocess.run([sys.executable, str(Path(__file__).with_name('package.py')),
                                     '--source', str(source), '--binary', str(binary),
                                     '--notices', str(notices), '--out', str(output)],
                                    capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue((output / 'modgud-9.8.7-source.tar.gz').is_file())
            self.assertTrue((output / 'modgud-9.8.7-linux-x64.tar.gz').is_file())
            self.assertEqual((output / 'modgud-9.8.7-linux-x64').read_bytes(), b'fixture executable')
            self.assertEqual(json.loads((output / 'PROVENANCE.json').read_text())['version'], '9.8.7')


if __name__ == '__main__':
    unittest.main()
