"""Compile with canonical Loom release metadata and a recipient-supplied Bun."""
import argparse, pathlib, subprocess, os
p=argparse.ArgumentParser();p.add_argument('--runtime',type=pathlib.Path,required=True);p.add_argument('--out',type=pathlib.Path,required=True);p.add_argument('--metafile',type=pathlib.Path);a=p.parse_args()
root=pathlib.Path(__file__).resolve().parents[1]; cwd=root/'packages/modgud'
facts=subprocess.check_output(['bun','run','loom','build','--release','--target','bun-linux-x64','--define'],cwd=cwd,text=True,timeout=60).strip()
subprocess.run(['bun','build','src/main.ts','--compile','--target','bun-linux-x64','--compile-executable-path',str(a.runtime.resolve()),'--outfile',str(a.out.resolve()),'--define',facts,*(['--metafile='+str(a.metafile.resolve())] if a.metafile else [])],cwd=cwd,env=dict(os.environ,NODE_ENV='production'),check=True,timeout=180)
