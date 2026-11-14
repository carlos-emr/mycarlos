"""Source-only GitHub artifact reader. No network, native execution, Cargo, owner or model authority."""
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import struct
import tarfile
import tempfile
import time
import zipfile

HEAD='77f100c6220731c7d73e36c56c152d67ac22cd43'
TREE='87fca3e8c7e6db3ebb1da96dcb5486653406dea4'
RUN=43559099288
JOB=132338634871
REPO='carlos-emr/mycarlos'
BASE=Path('/opt/mycarlos-native')/HEAD
SOURCE=BASE/'source'
TARGET=BASE/'target'
FEATURES=['ai-helper-stub','default','experimental-mtp']
FILES={'bundle/helper','bundle/harness','bundle/libtest','bundle/root-library.rlib',
       'native-config/CMakeCache.txt','native-config/cpu-flags.make','source-inventory.json',
       'cargo-artifact-selection.json','native.jsonl','toolchain.txt','native-environment.txt',
       'commands.txt','SHA256SUMS'}
MAX=512*1024*1024
DEADLINE=None

def check(ok,message):
    if not ok: raise ValueError(message)

def tick():
    check(DEADLINE is None or time.monotonic()<DEADLINE,'artifact reader deadline')

def pairs(rows):
    value={}
    for key,item in rows:
        check(key not in value,'duplicate JSON key');value[key]=item
    return value

def parse(raw):
    return json.loads(raw,object_pairs_hook=pairs,parse_constant=lambda _:check(False,'nonfinite JSON'))

def sha(path):
    h=hashlib.sha256()
    with Path(path).open('rb') as f:
        for block in iter(lambda:f.read(1024*1024),b''):tick();h.update(block)
    return h.hexdigest()

def load(path,limit=2*1024*1024):
    p=Path(path);s=p.lstat();check(stat.S_ISREG(s.st_mode) and s.st_size<=limit,'bounded regular JSON required')
    return parse(p.read_bytes())

def relative(name):
    p=PurePosixPath(name)
    check(isinstance(name,str) and name and '\\' not in name and '\0' not in name and
          not p.is_absolute() and p.as_posix()==name and all(x not in ('','.','..') for x in p.parts),'unsafe archive/source path')
    return name

def api(artifact,run,job,commit,zip_sha,zip_bytes):
    check(run['id']==RUN and run['head_sha']==HEAD and run['event']=='pull_request' and
          run['repository']['full_name']==REPO and run['head_repository']['full_name']==REPO,'wrong GitHub run/head/repository')
    check(commit['sha']==HEAD and commit['commit']['tree']['sha']==TREE and
          commit['commit']['verification']['verified'] is True,'wrong/unverified GitHub commit/tree')
    check(job['id']==JOB and job['run_id']==RUN and job['head_sha']==HEAD and
          job['name']=='Experimental MTP native artifacts (build only)' and
          job['status']=='completed' and job['conclusion']=='success','native job did not succeed at exact head')
    for name in ('Build native evaluation targets with explicit MTP and stub features',
                 'Package selected native files and Cargo witnesses only','Upload build-only MTP artifacts'):
        steps=[s for s in job['steps'] if s['name']==name]
        check(len(steps)==1 and steps[0]['conclusion']=='success','required native step not successful')
    w=artifact['workflow_run']
    check(isinstance(artifact['id'],int) and artifact['id']>0 and artifact['expired'] is False and
          artifact['name']=='mycarlos-mtp-native-'+HEAD and w['id']==RUN and w['head_sha']==HEAD and
          w['repository_id']==run['repository']['id'] and w['head_repository_id']==run['head_repository']['id'],
          'artifact not bound to exact native run/head')
    check(artifact['digest']=='sha256:'+zip_sha and artifact['size_in_bytes']==zip_bytes,'original artifact ZIP API digest/size mismatch')

def zip_preflight(path):
    # Bound central-directory allocation BEFORE constructing ZipFile.
    size=Path(path).stat().st_size
    check(22<=size<1024**3,'ZIP size bound')
    with Path(path).open('rb') as f:
        f.seek(max(0,size-65557));tail=f.read(65557);at=tail.rfind(b'PK\x05\x06')
        check(at>=0 and len(tail)-at>=22,'ZIP EOCD missing')
        signature,disk,cd_disk,disk_count,count,cd_size,cd_offset,comment=struct.unpack_from('<4s4H2IH',tail,at)
        eocd=size-len(tail)+at
        check(signature==b'PK\x05\x06' and disk==cd_disk==0 and disk_count==count==1 and
              0<cd_size<=16384 and comment<=4096 and eocd+22+comment==size and
              cd_offset+cd_size==eocd,'ZIP central-directory bounds/geometry')
        f.seek(0);check(f.read(4)==b'PK\x03\x04','ZIP local header required')
        f.seek(cd_offset);cd=f.read(cd_size)
        check(len(cd)==cd_size and cd[:4]==b'PK\x01\x02' and len(cd)>=46,'ZIP central header missing')
        filename,extra,comment=struct.unpack_from('<HHH',cd,28)
        check(0<filename<=256 and extra<=4096 and comment<=256 and 46+filename+extra+comment==cd_size,
              'ZIP central member count/field bounds')

def cargo_rows(path):
    # Avoid read_bytes/splitlines/all-record lists; preserve only required witnesses.
    kept=[];count=0;total=0;finished=False
    check(Path(path).stat().st_size<=64*1024*1024,'Cargo log bound')
    with Path(path).open('rb') as f:
        while True:
            tick();line=f.readline(1024*1024+1)
            if not line:break
            count+=1;total+=len(line)
            check(count<=10000 and total<=64*1024*1024 and len(line)<=1024*1024 and
                  line.endswith(b'\n') and not finished,'Cargo row/line/terminal bound')
            row=parse(line);check(isinstance(row,dict),'Cargo object row required');reason=row.get('reason')
            if reason=='build-finished':
                check(row.get('success') is True,'Cargo build failed');finished=True;kept.append(row)
            elif reason=='build-script-executed' and 'llama-cpp-sys-2@0.1.160' in row.get('package_id',''):
                kept.append(row)
            elif reason=='compiler-artifact' and (row.get('manifest_path')==str(SOURCE/'src-tauri/Cargo.toml') or
                    any(p in row.get('package_id','') for p in ('llama-cpp-sys-2@0.1.160','llama-cpp-2@0.1.160'))):
                kept.append(row)
            check(len(kept)<=32,'too many required Cargo witnesses')
    check(finished,'Cargo terminal success missing');return kept

CPU_REQUIRED={'-O3','-DNDEBUG','-msse4.2','-mf16c','-mfma','-mbmi2','-mavx','-mavx2'}
CPU_ALLOWED=CPU_REQUIRED|{'-ffunction-sections','-fdata-sections','-fPIC','-m64','-w',
                         '-std=gnu11','-std=gnu++17','-std=c11','-std=c++17',
                         '-fvisibility=hidden','-fvisibility-inlines-hidden','-fno-exceptions','-fno-rtti',
                         '-fno-omit-frame-pointer','-pthread'}
CPU_DEFINES={'-DGGML_AVX','-DGGML_AVX2','-DGGML_BMI2','-DGGML_F16C','-DGGML_FMA','-DGGML_SSE42',
             '-DGGML_SCHED_MAX_COPIES=4','-DGGML_USE_CPU_REPACK','-DGGML_USE_LLAMAFILE',
             '-D_GNU_SOURCE','-D_XOPEN_SOURCE=600'}

def cpu_words(words):
    check(CPU_REQUIRED<=set(words),'required CPU flags missing')
    for word in words:
        # Finite allowlist rejects *all* other optimization, math, ISA and forwarding flags.
        warning=re.fullmatch(r'-W(?:no-)?[A-Za-z0-9_-]+(?:=[A-Za-z0-9_-]+)?',word)
        check(word in CPU_ALLOWED or (warning and not word.startswith(('-Wa,','-Wp,','-Wl,'))),
              'undeclared CPU/optimization/math/forwarding flag: '+word)

class BoundedGzip:
    """TarFile r: preserves bounded direct reads, including PAX header reads, before allocation."""
    def __init__(self,raw):self.raw=raw
    def read(self,n=-1):
        tick();check(0<=n<=2*1024*1024,'unbounded tar metadata read')
        out=self.raw.read(n);check(self.raw.tell()<=MAX+2*1024*1024,'tar decompression bound');return out
    def seek(self,offset,whence=0):
        tick();check(whence==0 and 0<=offset<=MAX+2*1024*1024,'unbounded tar seek');return self.raw.seek(offset)
    def tell(self):return self.raw.tell()

def unpack(zip_path,stage):
    check(not stage.exists() and stage.is_absolute() and stage.parent.resolve()==stage.parent,'new healthy staging directory required')
    stage.mkdir(mode=0o700)
    declared={};total=0;payload_total=0
    zip_preflight(zip_path)
    # Only one gzip tar is uploaded; never extract the ZIP or TAR with extractall().
    with zipfile.ZipFile(zip_path) as z, tempfile.TemporaryFile() as temporary:
        entries=z.infolist();check(len(entries)==1,'one inner TAR required')
        item=entries[0];mode=item.external_attr>>16
        check(item.filename=='mycarlos-mtp-native.tar.gz' and not item.is_dir() and not item.flag_bits&1 and
              (not stat.S_IFMT(mode) or stat.S_ISREG(mode)) and 0<item.file_size<1024**3,'unsafe ZIP member')
        check(item.compress_type in (zipfile.ZIP_STORED,zipfile.ZIP_DEFLATED),'unexpected ZIP compression')
        h=hashlib.sha256();copied=0
        with z.open(item) as inp:
            for block in iter(lambda:inp.read(1024*1024),b''):
                tick();copied+=len(block);check(copied<=item.file_size,'ZIP expanded beyond declared size');temporary.write(block);h.update(block)
        check(copied==item.file_size,'short ZIP member');inner_sha=h.hexdigest();temporary.seek(0)
        with gzip.GzipFile(fileobj=temporary,mode='rb') as gz:
            bounded=BoundedGzip(gz)
            with tarfile.open(fileobj=bounded,mode='r:') as tar:
                count=0
                for member in tar:
                    tick();count+=1;check(count<=len(FILES),'too many TAR members')
                    name=relative(member.name)
                    check(name in FILES and name not in declared and member.isreg() and not member.issparse() and
                          not member.linkname and member.size>=0 and not member.mode&0o7000 and
                          set(member.pax_headers)<=set(('mtime','atime','ctime')),'unsafe/unexpected TAR member')
                    total+=member.size;check(total<=MAX+16384 and member.size<=MAX,'payload size bound')
                    if name=='SHA256SUMS':check(member.size<=16384,'checksum file bound')
                    else:payload_total+=member.size;check(payload_total<=MAX,'exporter payload bound')
                    if name=='bundle/root-library.rlib':check(member.mode==0o400,'root library mode')
                    elif name.startswith('bundle/'):check(member.mode==0o500,'executable bundle mode')
                    else:check(member.size<=64*1024*1024,'metadata file too large')
                    dest=stage/name;dest.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
                    digest=hashlib.sha256();remaining=member.size;inp=tar.extractfile(member)
                    check(inp is not None,'missing TAR file')
                    fd=os.open(dest,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
                    with os.fdopen(fd,'wb') as out:
                        while remaining:
                            tick();block=inp.read(min(1024*1024,remaining));check(block,'short TAR file')
                            out.write(block);digest.update(block);remaining-=len(block)
                    declared[name]={'sha256':digest.hexdigest(),'bytes':member.size}
            # Consume bounded zero padding to EOF so gzip trailer/CRC is checked.
            extra=0
            while True:
                block=bounded.read(16384)
                if not block:break
                extra+=len(block);check(extra<=32768 and not any(block),'unexpected TAR trailer')
    check(set(declared)==FILES,'archive member set differs')
    lines=(stage/'SHA256SUMS').read_text().splitlines();expected={}
    for line in lines:
        check(re.fullmatch(r'[0-9a-f]{64}  [^\r\n]+',line),'checksum line framing')
        digest,name=line.split('  ',1);relative(name);check(name in FILES-{'SHA256SUMS'} and name not in expected,'duplicate/unexpected checksum');expected[name]=digest
    check(set(expected)==FILES-{'SHA256SUMS'} and all(declared[n]['sha256']==v for n,v in expected.items()),'payload checksums mismatch')
    return inner_sha,declared

def native_flags(stage):
    vals={}
    for line in (stage/'native-config/CMakeCache.txt').read_text().splitlines():
        if line and not line.startswith(('#','//')) and '=' in line:
            key,v=line.split('=',1);check(key not in vals,'duplicate CMake key');vals[key]=v
    required={'CMAKE_BUILD_TYPE:STRING':'Release','GGML_AVX:BOOL':'ON','GGML_AVX2:BOOL':'ON',
              'GGML_FMA:BOOL':'ON','GGML_F16C:BOOL':'ON','GGML_BMI2:BOOL':'ON','GGML_SSE42:BOOL':'ON',
              'GGML_NATIVE:BOOL':'OFF','GGML_AVX512:BOOL':'OFF','GGML_AVX_VNNI:BOOL':'OFF','GGML_CPU:BOOL':'ON',
              'GGML_CUDA:BOOL':'OFF','GGML_BLAS:BOOL':'OFF','GGML_OPENMP:BOOL':'OFF'}
    check(all(vals.get(k)==v for k,v in required.items()),'native backend/math configuration mismatch')
    flags=(stage/'native-config/cpu-flags.make').read_text().splitlines()
    for prefix in ('C_FLAGS =','CXX_FLAGS ='):
        lines=[line for line in flags if line.startswith(prefix)];check(len(lines)==1,'CPU flags role missing/duplicate')
        cpu_words(lines[0].split('=',1)[1].split())
    for prefix in ('C_DEFINES =','CXX_DEFINES ='):
        lines=[line for line in flags if line.startswith(prefix)];check(len(lines)==1,'CPU defines role missing/duplicate')
        check(set(lines[0].split('=',1)[1].split())==CPU_DEFINES,'CPU definitions differ from reviewed ISA/math baseline')
    return required

def elf(path,helper_literal=None):
    size=path.stat().st_size;found=False;interpreter=None
    with path.open('rb') as f:
        header=f.read(64);check(len(header)==64 and header[:6]==b'\x7fELF\x02\x01' and
            struct.unpack_from('<H',header,18)[0]==62 and struct.unpack_from('<H',header,16)[0] in (2,3),'ELF64 x86_64 executable required')
        offset=struct.unpack_from('<Q',header,32)[0];entry,count=struct.unpack_from('<HH',header,54)
        check(entry==56 and 0<count<=128 and offset+entry*count<=size,'ELF program headers invalid')
        for i in range(count):
            f.seek(offset+i*entry);kind,flags,start,_,_,length,_,_=struct.unpack('<IIQQQQQQ',f.read(56))
            check(start+length<=size,'ELF segment beyond file')
            if kind==3:
                check(length<=4096,'ELF interpreter bound');f.seek(start);interpreter=f.read(length).rstrip(b'\0').decode()
            if helper_literal and kind==1 and not flags&2:
                f.seek(start);left=length;tail=b''
                while left:
                    tick();block=f.read(min(left,1024*1024));check(block,'short ELF segment');left-=len(block)
                    text=tail+block;found=found or helper_literal in text;tail=text[-len(helper_literal):]
        if helper_literal:check(found,'harness does not embed exact new canonical helper path')
    check(interpreter=='/lib64/ld-linux-x86-64.so.2','unexpected ELF dynamic interpreter')
    return {'class':'ELF64','machine':'x86_64','interpreter':interpreter,'helper_literal_found':found if helper_literal else None,
            'native_execution_qualified':False,'shared_library_ABI_qualified':False}

def payload(stage,expected,declared):
    check(expected['head']==HEAD and expected['tree']==TREE and expected['source_root']==str(SOURCE),'reviewed expected source identity')
    inventory=load(stage/'source-inventory.json');check(inventory['head']==HEAD and inventory['tree']==TREE and inventory['source_root']==str(SOURCE),'source inventory identity')
    def files(rows):
        values={}
        for row in rows:
            rel=relative(row['relative_path']);check(rel not in values and row['path']==str(SOURCE/rel),'duplicate/noncanonical source record');values[rel]=(row['sha256'],row['bytes'])
        return values
    check(files(inventory['files'])==files(expected['files']) and len(inventory['files'])==665,'source inventory not exact reviewed Git tree')
    selection=load(stage/'cargo-artifact-selection.json')
    check(selection['head']==HEAD and selection['tree']==TREE and selection['explicit_features']==['ai-helper-stub','experimental-mtp'] and
          selection['profile_overrides']=={'CARGO_PROFILE_DEV_DEBUG':'0','CARGO_PROFILE_TEST_DEBUG':'0','CARGO_INCREMENTAL':'0'} and
          selection['model_invoked'] is False and selection['native_runtime_qualified'] is False,'provider profile/source declaration differs')
    rows=cargo_rows(stage/'native.jsonl')
    witnesses=selection['compiler_artifacts'];artifacts=selection['artifacts'];roles={'helper':('mycarlos-tauri-poc',False,'bin'),
        'harness':('model_engine',True,'test'),'libtest':('mycarlos_tauri_poc_lib',True,'lib'),'root-library':('mycarlos_tauri_poc_lib',False,'lib')}
    check(set(witnesses)==set(artifacts)==set(roles),'four exact Cargo roles required')
    for role,(name,test,kind) in roles.items():
        matches=[r for r in rows if r.get('reason')=='compiler-artifact' and r.get('manifest_path')==str(SOURCE/'src-tauri/Cargo.toml') and
                 r['target']['name']==name and r['profile']['test'] is test]
        check(len(matches)==1 and matches[0]==witnesses[role],'actual Cargo witness not unique/equal selection')
        r=matches[0];p=r['profile'];check(r['fresh'] is False and sorted(r['features'])==FEATURES and p['opt_level']=='1' and
            p['debuginfo']==0 and p['debug_assertions'] is True and p['overflow_checks'] is True,'actual O1/debug0/assertion/feature witness mismatch')
        check(r['package_id']=='path+file://'+str(SOURCE/'src-tauri')+'#mycarlos-tauri-poc@0.1.0','foreign root package')
        target=r['target'];kinds=target['kind'];check((kind=='lib' and kinds==['staticlib','cdylib','rlib']) or kinds==[kind],'Cargo target kind differs')
        check(target['crate_types']==(['bin'] if role in ('helper','harness') else ['staticlib','cdylib','rlib']),'Cargo crate types differ')
        rel={'helper':'src/main.rs','harness':'tests/model_engine.rs','libtest':'src/lib.rs','root-library':'src/lib.rs'}[role]
        check(target['src_path']==str(SOURCE/'src-tauri'/rel),'foreign root source path')
        a=artifacts[role];archive='bundle/'+('root-library.rlib' if role=='root-library' else role)
        check(a['archive_path']==archive and a['sha256']==declared[archive]['sha256'] and a['bytes']==declared[archive]['bytes'],'artifact content declaration differs')
        compiled=Path(a['compiled_path']);check(compiled.is_absolute() and compiled==Path(os.path.normpath(compiled)) and compiled.is_relative_to(TARGET) and str(compiled) in r['filenames'],'compiled artifact path outside exact target')
        if role=='helper':check(compiled==TARGET/'debug/mycarlos-tauri-poc' and r['executable']==str(compiled),'canonical helper differs')
        elif role!='root-library':check(compiled.parent==TARGET/'debug/deps' and r['executable']==str(compiled),'test executable path differs')
        else:check(compiled.suffix=='.rlib' and r['executable'] is None and (stage/archive).open('rb').read(8)==b'!<arch>\n','non-test root library differs')
    sys_rows=[r for r in rows if r.get('reason')=='build-script-executed' and 'llama-cpp-sys-2@0.1.160' in r.get('package_id','')]
    check(len(sys_rows)==1 and Path(sys_rows[0]['out_dir']).is_relative_to(TARGET),'sys native out_dir differs')
    for package,features in (('llama-cpp-sys-2@0.1.160',['common','default']),('llama-cpp-2@0.1.160',['common'])):
        libs=[r for r in rows if r.get('reason')=='compiler-artifact' and package in r.get('package_id','') and r['target']['kind']==['lib']]
        check(len(libs)==1 and sorted(libs[0]['features'])==features,'native wrapper/sys feature union differs')
    cmds=(stage/'commands.txt').read_text().splitlines()
    cargo=[line.lstrip('+ ') for line in cmds if 'cargo test ' in line]
    check(cargo==['cargo test --lib --test model_engine --no-run --locked --features ai-helper-stub,experimental-mtp --message-format=json'],'CI Cargo recipe differs')
    toolchain=(stage/'toolchain.txt').read_text();check('rustc 1.98.0 (88d9e12ae 2026-08-18)' in toolchain and 'host: x86_64-unknown-linux-gnu' in toolchain,'toolchain/host differs')
    environment=(stage/'native-environment.txt').read_text();check('VERSION_ID="24.04"' in environment and 'ID=ubuntu' in environment,'native provider environment differs')
    native_flags(stage)
    elf_proofs={role:elf(stage/('bundle/'+role),str(TARGET/'debug/mycarlos-tauri-poc').encode() if role=='harness' else None) for role in ('helper','harness','libtest')}
    return {'artifacts':artifacts,'four_fresh_Cargo_witnesses':witnesses,'elf_readonly_inspection':elf_proofs,
            'source_inventory_files':665,'runtime_qualified':False,'extraction_qualified':False,'READY_qualified':False,'model_qualified':False}

def main():
    global DEADLINE
    p=argparse.ArgumentParser(description=__doc__)
    for name in ('zip','artifact-api','run-api','job-api','commit-api','expected-source','staging'):p.add_argument('--'+name,required=True)
    a=p.parse_args();DEADLINE=time.monotonic()+60
    z=Path(a.zip);before=z.lstat();check(stat.S_ISREG(before.st_mode) and 0<before.st_size<1024**3,'bounded original ZIP required')
    outer_sha=sha(z);artifact=load(a.artifact_api);api(artifact,load(a.run_api),load(a.job_api),load(a.commit_api),outer_sha,before.st_size)
    stage=Path(a.staging);inner_sha,declared=unpack(z,stage);proof=payload(stage,load(a.expected_source),declared)
    after=z.lstat();check((before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns)==(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns) and sha(z)==outer_sha,'download changed during qualification')
    report={'schema':'github-ci77f100-artifact-byte-inspection-v1','provider':'GitHubActions/Ubuntu24.04','head':HEAD,'tree':TREE,
            'run_id':RUN,'job_id':JOB,'artifact_id':artifact['id'],'original_zip_sha256':outer_sha,'inner_tar_sha256':inner_sha,
            'files':declared,**proof,'canonical_root_restored':False,'canonical_source_checkout_verified':False,
            'owner_or_runtime_admission_issued':False,'native_binary_executed':False,'old_local_debug2_qualification_borrowed':False,
            'api_authenticity_scope':'Root must independently obtain API JSON and original ZIP through authenticated GitHub; this offline reader checks binding/bytes only.'}
    with (stage/'BYTE-INSPECTION.json').open('x') as f:json.dump(report,f,indent=2);f.write('\n')
    original=load(stage/'source-inventory.json')
    wrapped={'schema':'root-mtp77f100-source-inventory-v1','head':HEAD,'tree':TREE,
             'candidate_head':HEAD,'candidate_tree':TREE,
             'files':[{'path':item['path'],'sha256':item['sha256']} for item in original['files']],
             'raw_CI_inventory':{'path':str(stage/'source-inventory.json'),'sha256':declared['source-inventory.json']['sha256']},
             'provider':'GitHubActions/Ubuntu24.04','run_id':RUN,'job_id':JOB,
             'original_zip_sha256':outer_sha,'byte_inspection_sha256':sha(stage/'BYTE-INSPECTION.json'),
             'actual_canonical_files_verified':False,'runtime_or_owner_admission_issued':False}
    with (stage/'CANONICAL-SOURCE-INVENTORY.UNVERIFIED.json').open('x') as f:json.dump(wrapped,f,indent=2);f.write('\n')
    print(json.dumps({'inspection_report':str(stage/'BYTE-INSPECTION.json'),'head':HEAD,'runtime_qualified':False}))

if __name__=='__main__':main()
