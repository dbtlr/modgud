import argparse,gzip,hashlib,io,json,pathlib,tarfile
p=argparse.ArgumentParser();p.add_argument('--source',type=pathlib.Path,required=True);p.add_argument('--binary',type=pathlib.Path,required=True);p.add_argument('--notices',type=pathlib.Path,required=True);p.add_argument('--out',type=pathlib.Path,required=True);a=p.parse_args();a.out.mkdir(parents=True,exist_ok=True)
def digest(b):return hashlib.sha256(b).hexdigest()
def collect(root):
 return {str(f.relative_to(root)):f.read_bytes() for f in sorted(root.rglob('*')) if f.is_file() and not any(x in f.relative_to(root).parts for x in ['node_modules','dist','sandbox','.git'])}
def write(name,files):
 with (a.out/name).open('wb') as raw,gzip.GzipFile(fileobj=raw,mode='wb',mtime=0,filename='',compresslevel=9) as z,tarfile.open(fileobj=z,mode='w') as tar:
  for name,data in sorted(files.items()):
   info=tarfile.TarInfo(name);info.size=len(data);info.mtime=0;info.uid=info.gid=0;info.uname=info.gname='';info.mode=0o755 if name in ['bin/modgud','packages/modgud/install.sh'] else 0o644;tar.addfile(info,io.BytesIO(data))
def manifest(files):return {n:{'sha256':digest(b),'bytes':len(b)} for n,b in sorted(files.items())}
src=collect(a.source);runtime={'bin/modgud':a.binary.read_bytes(),'LICENSE':src['LICENSE'],'INSTALLING.md':src['release/INSTALLING.md'],'NOTICE-AUDIT.md':src['release/NOTICE-AUDIT.md']};runtime.update({'notices/'+n:b for n,b in collect(a.notices).items()})
provenance={'upstream_archive_sha256':'fd0d58fe87886ab3aa772e681b6812edeb81819318040146e263d2a2ec6c9725','candidate':True,'published':False,'version':'0.1.0','source_commit':'076794710a6d0c86a5a11204f02ce56afd6122a2','toolchain':'Bun 1.4.4 (38afee6c8), @loomcli/loom 0.18.0','target':'bun-linux-x64','binary_sha256':digest(a.binary.read_bytes()),'binary_bytes':a.binary.stat().st_size,'notice_coverage':'Pinned component sources, full collected license files and source attribution headers; see NOTICE-AUDIT.md and bundled manifests. No blanket legal certification.', 'relink_route_tested':'Recipient-supplied unmodified Bun accepted; modified WebKit not built','corrected_parent_source_sha256':'97f9a5a8d31188bda275c66088aa847e490b7918614e382eeea7e05b53f76630','build':'bun run build','source_diff':'source.diff'}
notice_bytes=src['LICENSE']+b'\n'+b''.join(b'\n===== '+n.encode()+b' =====\n'+data+b'\n' for n,data in sorted(collect(a.notices).items()))
runtime['modgud-NOTICES.txt']=notice_bytes
(a.out/'modgud-NOTICES.txt').write_bytes(notice_bytes)
runtime['PROVENANCE.json']=(json.dumps(provenance,indent=2)+'\n').encode()
write('modgud-0.1.0-source.tar.gz',src);write('modgud-0.1.0-linux-x64.tar.gz',runtime)
for name,files in [('source',src),('runtime',runtime)]: (a.out/(name+'-manifest.json')).write_text(json.dumps(manifest(files),indent=2)+'\n')
(a.out/'PROVENANCE.json').write_text(json.dumps(provenance,indent=2)+'\n')
for name in ['modgud-0.1.0-linux-x64','modgud-linux-x64']:
 target=a.out/name;target.write_bytes(a.binary.read_bytes());target.chmod(0o755)
(a.out/'SHA256SUMS').write_text(''.join(digest(f.read_bytes())+'  '+f.name+'\n' for f in sorted(a.out.iterdir()) if f.is_file() and f.name!='SHA256SUMS'))
