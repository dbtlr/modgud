import hashlib, os, pathlib, subprocess, tempfile, unittest
ROOT=pathlib.Path(__file__).resolve().parents[1]
INSTALLER=ROOT/'packages/modgud/install.sh'
class Installer(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR'))
  self.addCleanup(self.temp.cleanup)
  self.root=pathlib.Path(self.temp.name);self.bin=self.root/'tools';self.bin.mkdir()
  self.home=self.root/'home';self.home.mkdir();self.target=self.home/'.local/bin/modgud';self.target.parent.mkdir(parents=True);self.target.write_bytes(b'old binary')
  self.notice=self.target.with_name('modgud.NOTICES.txt');self.notice.write_bytes(b'old notices')
  self.payload=b'new binary fixture';(self.root/'payload').write_bytes(self.payload)
  curl=self.bin/'curl';curl.write_text('''#!/usr/bin/env python3
import os,sys,pathlib,hashlib
p=pathlib.Path(os.environ['FIXTURE'])
u=sys.argv[-1]
with (p/'urls').open('a') as f:f.write(u+'\\n')
if os.environ.get('FAIL_DOWNLOAD'):sys.exit(22)
if u.endswith('/modgud-NOTICES.txt'):
 if os.environ.get('FAIL_NOTICE'):sys.exit(22)
 sys.stdout.buffer.write(b'bad notices' if os.environ.get('BAD_NOTICE') else b'full notices');sys.exit(0)
if u.endswith('/SHA256SUMS'):
 digest=hashlib.sha256((p/'payload').read_bytes()).hexdigest() if not os.environ.get('BAD_DIGEST') else '0'*64
 print(hashlib.sha256(b'full notices').hexdigest()+'  modgud-NOTICES.txt')
 for asset in ['modgud-linux-x64','modgud-darwin-arm64','modgud-darwin-x64']:print(digest+'  '+asset)
else:sys.stdout.buffer.write((p/'payload').read_bytes())
''');curl.chmod(0o700)
  uname=self.bin/'uname';uname.write_text('#!/usr/bin/env python3\nimport os,sys\nprint(os.environ.get("FIXTURE_OS","Linux") if sys.argv[1]=="-s" else os.environ.get("FIXTURE_ARCH","x86_64"))\n');uname.chmod(0o700)
  ldd=self.bin/'ldd';ldd.write_text('#!/usr/bin/env python3\nimport os\nprint(os.environ.get("FIXTURE_LIBC","glibc"))\n');ldd.chmod(0o700)
  self.env=dict(os.environ,HOME=str(self.home),XDG_STATE_HOME=str(self.home/'state'),FIXTURE=str(self.root),PATH=str(self.bin)+':'+os.environ['PATH'])
 def invoke(self,*args,**env):
  return subprocess.run(['sh',str(INSTALLER),*args],env=dict(self.env,**env),capture_output=True,timeout=15)
 def test_requires_version_pin(self):
  p=self.invoke();self.assertNotEqual(p.returncode,0);self.assertFalse((self.root/'urls').exists());self.assertEqual(self.target.read_bytes(),b'old binary')
 def test_pinned_install_and_rerun_update(self):
  for payload in [self.payload,b'updated fixture']:
   (self.root/'payload').write_bytes(payload);p=self.invoke('0.1.0');self.assertEqual(p.returncode,0,p.stderr);self.assertEqual(self.target.read_bytes(),payload);self.assertEqual(self.notice.read_bytes(),b'full notices')
  self.assertTrue(all('/releases/download/v0.1.0/' in u for u in (self.root/'urls').read_text().splitlines()))
 def test_checksum_failure_preserves_binary(self):
  p=self.invoke('0.1.0',BAD_DIGEST='1');self.assertNotEqual(p.returncode,0);self.assertEqual(self.target.read_bytes(),b'old binary')
 def test_notice_failure_preserves_binary_and_notices(self):
  p=self.invoke('0.1.0',FAIL_NOTICE='1');self.assertNotEqual(p.returncode,0);self.assertEqual(self.target.read_bytes(),b'old binary');self.assertEqual(self.notice.read_bytes(),b'old notices')
 def test_notice_checksum_failure_preserves_binary_and_notices(self):
  p=self.invoke('0.1.0',BAD_NOTICE='1');self.assertNotEqual(p.returncode,0);self.assertEqual(self.target.read_bytes(),b'old binary');self.assertEqual(self.notice.read_bytes(),b'old notices')
 def test_download_failure_preserves_binary(self):
  p=self.invoke('0.1.0',FAIL_DOWNLOAD='1');self.assertNotEqual(p.returncode,0);self.assertEqual(self.target.read_bytes(),b'old binary')
 def test_unsupported_platforms_fail_before_download(self):
  for values in [dict(FIXTURE_OS='Darwin',FIXTURE_ARCH='arm64'),dict(FIXTURE_ARCH='aarch64'),dict(FIXTURE_LIBC='musl'),dict(FIXTURE_OS='FreeBSD')]:
   with self.subTest(values=values):
    p=self.invoke('0.1.0',**values);self.assertNotEqual(p.returncode,0);self.assertIn(b'Linux x64 with glibc',p.stderr);self.assertFalse((self.root/'urls').exists());self.assertEqual(self.target.read_bytes(),b'old binary');self.assertEqual(self.notice.read_bytes(),b'old notices')
if __name__=='__main__':unittest.main()
