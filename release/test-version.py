import subprocess, sys
p=subprocess.run([sys.argv[1], '--version'],capture_output=True,text=True,timeout=15)
assert p.returncode == 0 and p.stdout.strip() == 'modgud v0.1.0', (p.returncode,p.stdout,p.stderr)
print('version interface PASS: 0.1.0')
