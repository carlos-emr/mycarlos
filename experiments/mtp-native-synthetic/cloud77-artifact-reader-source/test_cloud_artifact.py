"""Small data-only archive/API/ELF controls; no downloaded or native file is executed."""
import copy
import gzip
import hashlib
import io
from pathlib import Path
import stat
import struct
from tempfile import TemporaryDirectory
import tarfile
import unittest
import zipfile
import qualify_cloud_native as q

class ArtifactControls(unittest.TestCase):
    def root(self):
        t=TemporaryDirectory();self.addCleanup(t.cleanup);return Path(t.name)
    def archive(self,root,extra=None,alter=False,zip_link=False):
        data={n:b'SYNTHETIC DATA ONLY' for n in q.FILES-{'SHA256SUMS'}}
        data['SHA256SUMS']=''.join(hashlib.sha256(v).hexdigest()+'  '+n+'\n' for n,v in sorted(data.items())).encode()
        if alter:data['commands.txt']=b'changed after checksum'
        buf=io.BytesIO()
        with tarfile.open(fileobj=buf,mode='w:gz') as tar:
            if extra:
                info=tarfile.TarInfo(extra[0]);info.size=len(extra[1]);info.mode=0o644
                if len(extra)>2:info.type=tarfile.SYMTYPE;info.linkname=extra[2]
                tar.addfile(info,io.BytesIO(extra[1]))
            for name,value in sorted(data.items()):
                info=tarfile.TarInfo(name);info.size=len(value);info.mode=0o400 if name=='bundle/root-library.rlib' else 0o500 if name.startswith('bundle/') else 0o644
                tar.addfile(info,io.BytesIO(value))
        z=root/'download.zip'
        with zipfile.ZipFile(z,'w') as out:
            info=zipfile.ZipInfo('mycarlos-mtp-native.tar.gz');info.external_attr=(stat.S_IFLNK|0o777)<<16 if zip_link else (stat.S_IFREG|0o644)<<16
            out.writestr(info,buf.getvalue())
        return z
    def test_valid_exact_payload_is_checksum_verified_and_staged_nonexecutable(self):
        root=self.root();z=self.archive(root);digest,files=q.unpack(z,root/'stage')
        self.assertEqual(set(files),q.FILES);self.assertEqual(len(digest),64)
        self.assertTrue(all(stat.S_IMODE((root/'stage'/n).stat().st_mode)==0o600 for n in files))
    def test_tar_traversal_and_duplicate_member_refused(self):
        for name in ('../outside','bundle/helper'):
            root=self.root();z=self.archive(root,(name,b'bad'))
            with self.subTest(name=name),self.assertRaises(ValueError):q.unpack(z,root/'stage')
            self.assertFalse((root/'outside').exists())
    def test_tar_and_zip_links_refused(self):
        root=self.root();z=self.archive(root,('bundle/helper',b'', '/tmp/forbidden'))
        with self.assertRaises(ValueError):q.unpack(z,root/'stage')
        root=self.root();z=self.archive(root,zip_link=True)
        with self.assertRaises(ValueError):q.unpack(z,root/'stage')
    def test_oversized_pax_metadata_and_regular_size_refused_before_payload_allocation(self):
        for kind,size in ((tarfile.XHDTYPE,3*1024*1024),(tarfile.REGTYPE,q.MAX+1)):
            root=self.root();header=tarfile.TarInfo('bundle/helper');header.type=kind;header.size=size;header.mode=0o500
            raw=gzip.compress(header.tobuf()+b'\0'*1024);z=root/'download.zip'
            with zipfile.ZipFile(z,'w') as out:out.writestr('mycarlos-mtp-native.tar.gz',raw)
            with self.assertRaises(ValueError):q.unpack(z,root/'stage')
    def test_checksum_mismatch_refused(self):
        root=self.root();z=self.archive(root,alter=True)
        with self.assertRaises(ValueError):q.unpack(z,root/'stage')
    def api(self):
        repo={'full_name':q.REPO,'id':42}
        run={'id':q.RUN,'head_sha':q.HEAD,'event':'pull_request','repository':repo,'head_repository':repo}
        job={'id':q.JOB,'run_id':q.RUN,'head_sha':q.HEAD,'name':'Experimental MTP native artifacts (build only)','status':'completed','conclusion':'success','steps':[{'name':n,'conclusion':'success'} for n in ('Build native evaluation targets with explicit MTP and stub features','Package selected native files and Cargo witnesses only','Upload build-only MTP artifacts')]}
        commit={'sha':q.HEAD,'commit':{'tree':{'sha':q.TREE},'verification':{'verified':True}}}
        artifact={'id':1,'expired':False,'name':'mycarlos-mtp-native-'+q.HEAD,'workflow_run':{'id':q.RUN,'head_sha':q.HEAD,'repository_id':42,'head_repository_id':42},'digest':'sha256:'+'a'*64,'size_in_bytes':1}
        return artifact,run,job,commit
    def test_provider_head_digest_and_success_are_independently_required(self):
        q.api(*self.api(),'a'*64,1)
        for which,key,value in ((0,'digest','sha256:'+'b'*64),(1,'head_sha','0'*40),(2,'conclusion','failure'),(3,'sha','0'*40)):
            rows=copy.deepcopy(self.api());rows[which][key]=value
            with self.subTest(key=key),self.assertRaises(ValueError):q.api(*rows,'a'*64,1)
    def test_duplicate_json_keys_refused(self):
        with self.assertRaises(ValueError):q.parse('{"head":"one","head":"two"}')
    def test_helper_literal_must_be_in_readonly_elf_load_segment(self):
        root=self.root();needle=b'/opt/SYNTHETIC/target/debug/helper';interp=b'/lib64/ld-linux-x86-64.so.2\0'
        for flags in (4,6):
            b=bytearray(512+len(needle));b[:6]=b'\x7fELF\x02\x01';struct.pack_into('<H',b,16,3);struct.pack_into('<H',b,18,62);struct.pack_into('<Q',b,32,64);struct.pack_into('<HH',b,54,56,2)
            struct.pack_into('<IIQQQQQQ',b,64,3,4,256,0,0,len(interp),len(interp),1);b[256:256+len(interp)]=interp
            struct.pack_into('<IIQQQQQQ',b,120,1,flags,512,0,0,len(needle),len(needle),1);b[512:]=needle;p=root/'ELF-data';p.write_bytes(b)
            if flags==4:self.assertTrue(q.elf(p,needle)['helper_literal_found'])
            else:
                with self.assertRaises(ValueError):q.elf(p,needle)

class BoundedParserPolicyControls(ArtifactControls):
    # Inherit archive helpers only; unittest also repeats inherited8 controls intentionally excluded below.
    def test_zip_metadata_is_rejected_before_ZipFile_allocation(self):
        from unittest.mock import patch
        root=self.root();z=self.archive(root);original=z.read_bytes();at=original.rfind(b'PK\x05\x06')
        for offset,fmt,value in ((10,'H',50000),(12,'I',1048576),(16,'I',len(original))):
            changed=bytearray(original);struct.pack_into('<'+fmt,changed,at+offset,value);bad=root/('bad'+str(offset)+'.zip');bad.write_bytes(changed)
            with patch.object(q.zipfile,'ZipFile',side_effect=AssertionError('must not allocate central directory')):
                with self.assertRaises(ValueError):q.unpack(bad,root/('stage'+str(offset)))
    def test_cargo_stream_retains_four_witnesses_and_bounds_line_count_terminal(self):
        import json
        root=self.root();p=root/'cargo.jsonl'
        four=[{'reason':'compiler-artifact','manifest_path':str(q.SOURCE/'src-tauri/Cargo.toml'),'target':{'name':name}} for name in ('helper','harness','libtest','root-library')]
        end={'reason':'build-finished','success':True}
        p.write_text(''.join(json.dumps(r)+'\n' for r in [{'reason':'compiler-message'}]*2000+four+[end]))
        self.assertEqual(len(q.cargo_rows(p)),5)
        for raw in (b'x'*(1024*1024+1),b'{}\n'*10001,(json.dumps(end)+'\n{}\n').encode()):
            p.write_bytes(raw)
            with self.assertRaises(ValueError):q.cargo_rows(p)
    def test_cpu_allowlist_rejects_all_undeclared_math_ISA_optimization_flags(self):
        base=['-O3','-DNDEBUG','-msse4.2','-mf16c','-mfma','-mbmi2','-mavx','-mavx2','-fPIC','-m64','-std=gnu11','-Wpedantic']
        q.cpu_words(base)
        for bad in ('-Ofast','-O2','-ffast-math','-funsafe-math-optimizations','-fno-signed-zeros',
                    '-march=x86-64-v4','-march=native','-mavxvnni','-mavxvnniint8','-mfma4','-mno-avx2',
                    '-mavx512f','-Xclang','-Wa,-march=skylake','-fopenmp'):
            with self.subTest(flag=bad),self.assertRaises(ValueError):q.cpu_words(base+[bad])

# Use shared helper methods without rediscovering the8 inherited tests twice.
for _name in list(vars(ArtifactControls)):
    if _name.startswith('test_'):setattr(BoundedParserPolicyControls,_name,None)
