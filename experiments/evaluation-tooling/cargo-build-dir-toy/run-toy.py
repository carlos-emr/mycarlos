#!/usr/bin/env python3
"""UNRUN source: three offline Cargo phases only after ROOT's <=15s grant."""
from pathlib import Path
import argparse,hashlib,json,os,shutil,signal,subprocess,sys,time
SOURCE=Path(__file__).resolve().parent
RUN=None
TOOLCHAIN=None
active=None
TOUCH_FILES=['src/lib.rs','src/main.rs','tests/contract.rs','build.rs']

def stop_active(signum=None,frame=None):
    global active
    if active is not None:
        try:os.killpg(active.pid,signal.SIGKILL)
        except ProcessLookupError:pass
        active.wait();active=None
    if signum is not None:raise SystemExit(124)

def snapshot(p):
    s=p.stat();link=p.lstat()
    return {'path':str(p),'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'dev':s.st_dev,'inode':s.st_ino,'size':s.st_size,'nlink':s.st_nlink,'mode':s.st_mode&0o777,'is_symlink':p.is_symlink(),'symlink_target':os.readlink(p) if p.is_symlink() else None,'lstat_dev':link.st_dev,'lstat_inode':link.st_ino,'lstat_nlink':link.st_nlink}

def identity(x):return {k:x[k] for k in ['sha256','dev','inode','size','mode','is_symlink','symlink_target','lstat_dev','lstat_inode']}
def file_id(p):
    s=p.stat();return s.st_dev,s.st_ino

def main():
    global active,RUN,TOOLCHAIN
    parser=argparse.ArgumentParser();parser.add_argument('--root-authorized-15s',action='store_true')
    parser.add_argument('--run-dir',type=Path,required=True)
    parser.add_argument('--toolchain-bin',type=Path,required=True)
    args=parser.parse_args()
    RUN=args.run_dir.resolve();TOOLCHAIN=args.toolchain_bin.resolve()
    assert RUN!=SOURCE and not RUN.is_relative_to(SOURCE) and not SOURCE.is_relative_to(RUN),'Scratch must be separate from source'
    assert RUN.parent.is_dir() and all((TOOLCHAIN/n).is_file() for n in ['cargo','rustc','rustdoc']),'Existing parent and explicit Rust toolchain required'
    assert args.root_authorized_15s,'ROOT separate actual-toy scheduling grant required'
    assert os.sched_getaffinity(0)=={0} and os.getpriority(os.PRIO_PROCESS,0)==19,'Require CPU0 nice19'
    assert not RUN.exists(),'Preserve first attempt; never overwrite earlier runtime evidence'
    for rel,h in json.loads((SOURCE/'source-manifest.json').read_text())['files'].items():
        assert hashlib.sha256((SOURCE/rel).read_bytes()).hexdigest()==h,rel
    for d in ['control','cargo-home','shared-build','copies','logs']:(RUN/d).mkdir(parents=True,exist_ok=True)
    # Only disposable toy copies receive mtime changes; prepared source remains pinned.
    old=time.time_ns()-3_600_000_000_000
    source_times={}
    for letter in ['a','b']:
        w=RUN/('workspace-'+letter);shutil.copytree(SOURCE/('workspace-'+letter),w)
        for p in w.rglob('*'):
            if p.is_file():
                stamp=old-(60_000_000_000 if letter=='b' else 0);os.utime(p,ns=(stamp,stamp))
        source_times[letter]={r:(w/r).stat().st_mtime_ns for r in TOUCH_FILES}
    assert (RUN/'workspace-a/tests/contract.rs').read_bytes()==(RUN/'workspace-b/tests/contract.rs').read_bytes()
    env=os.environ.copy()
    for k in list(env):
        if k.startswith('CARGO_') or k.startswith('TOY_') or k in ['RUSTFLAGS','RUSTDOCFLAGS','RUSTC_WRAPPER','RUSTC_WORKSPACE_WRAPPER','RUSTUP_TOOLCHAIN','RUSTC_BOOTSTRAP','RUSTC','RUSTDOC']:env.pop(k,None)
    env.update({'CARGO_HOME':str(RUN/'cargo-home'),'CARGO_NET_OFFLINE':'true','CARGO_INCREMENTAL':'0','CARGO_TERM_COLOR':'never','CARGO_TERM_PROGRESS_WHEN':'never','RUSTC':str(TOOLCHAIN/'rustc'),'RUSTDOC':str(TOOLCHAIN/'rustdoc')})
    started=time.monotonic();deadline=started+13.0;commands=[];artifacts={}
    signal.signal(signal.SIGTERM,stop_active);signal.signal(signal.SIGINT,stop_active)
    result={'status':'RUNNING','scope':'Disposable no-dep toy only; no product/cache adoption claim','shared_build_dir':str(RUN/'shared-build'),'target_dirs':[str(RUN/'target-a'),str(RUN/'target-b')],'compiler_wrapper_used':False,'commands':commands,'artifacts':artifacts,'initial_source_mtimes_ns':source_times,'harness_sources_byte_identical':True,'force_strategy':'touch only B src/lib.rs src/main.rs tests/contract.rs build.rs; repeat identical full Cargo test --no-run recipe'}
    def call(argv,label,extra_env=None,require_success=True):
        global active
        left=deadline-time.monotonic();assert left>0,'Global13s deadline exhausted'
        active=subprocess.Popen(argv,cwd=RUN/'control',env=env|dict(extra_env or {}),stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,start_new_session=True)
        try:out,err=active.communicate(timeout=left)
        except subprocess.TimeoutExpired:
            stop_active();raise TimeoutError('Global13s deadline during '+label)
        rc=active.returncode;active=None
        (RUN/'logs'/(label+'.stdout')).write_text(out);(RUN/'logs'/(label+'.stderr')).write_text(err)
        commands.append({'label':label,'argv':argv,'extra_env':extra_env,'exit_code':rc})
        if require_success:assert rc==0,label+' failed; preserve logs'
        return out,rc
    def aliases(helper):
        ident=file_id(helper)
        return [snapshot(p) for p in (RUN/'shared-build').rglob('*') if p.is_file() and file_id(p)==ident]
    def build(letter,label):
        argv=[str(TOOLCHAIN/'cargo'),'--config','build.build-dir='+json.dumps(str(RUN/'shared-build')),'test','--manifest-path',str(RUN/('workspace-'+letter)/'Cargo.toml'),'--target-dir',str(RUN/('target-'+letter)),'--offline','--locked','--jobs','1','--test','contract','--no-run','--message-format=json']
        out,_=call(argv,label);messages=[json.loads(l) for l in out.splitlines() if l.startswith('{')]
        all_art=[m for m in messages if m.get('reason')=='compiler-artifact']
        bins=[m for m in all_art if m.get('executable')]
        hm=next(m for m in bins if m['target']['name']=='split-helper')
        tm=next(m for m in bins if m['target']['name']=='contract' and 'test' in m['target']['kind'])
        lm=next(m for m in all_art if 'lib' in m['target']['kind'])
        helper=Path(hm['executable']);harness=Path(tm['executable'])
        assert helper==RUN/('target-'+letter)/'debug/split-helper' and helper.is_file()
        assert any((RUN/'shared-build').rglob('*.d')),'Shared intermediates not used'
        copied=RUN/'copies'/label;shutil.copy2(harness,copied);copied.chmod(0o500)
        assert file_id(harness)!=file_id(copied),'Harness copy must have distinct inode'
        artifacts[label]={'workspace':str(RUN/('workspace-'+letter)),'final_helper':snapshot(helper),'reported_harness':snapshot(harness),'copied_harness':snapshot(copied),'helper_shared_cache_aliases':aliases(helper),'harness_under_shared_build_dir':harness.is_relative_to(RUN/'shared-build'),'fresh':{'root_library':lm['fresh'],'helper':hm['fresh'],'harness':tm['fresh']},'all_compiler_artifacts':[{'target':m['target']['name'],'kind':m['target']['kind'],'fresh':m['fresh'],'package_id':m['package_id'],'executable':m.get('executable'),'filenames':m['filenames']} for m in all_art]}
        return helper,copied
    def run_harness(p,letter,label,required=True):
        extra={'TOY_EXPECT_HELPER':str(RUN/('target-'+letter)/'debug/split-helper'),'TOY_EXPECT_VARIANT':'VARIANT_'+letter.upper()}
        out,rc=call([str(p),'--exact','binds_variant_final_helper','--nocapture','--test-threads=1'],label,extra,required)
        embedded=[l.split('EMBEDDED_HELPER=',1)[1] for l in out.splitlines() if 'EMBEDDED_HELPER=' in l]
        assert len(embedded)==1,'Need actual embedded helper path even when probe assertion fails'
        return {'exit_code':rc,'embedded_helper':embedded[0],'expected_helper':extra['TOY_EXPECT_HELPER'],'matches_new_target':embedded[0]==extra['TOY_EXPECT_HELPER']}
    try:
        cv,_=call([str(TOOLCHAIN/'cargo'),'--version'],'cargo-version');assert cv.strip()=='cargo 1.98.0 (797e8a9bc 2026-08-05)'
        ah,ac=build('a','build-a');result['a_initial_binding']=run_harness(ac,'a','copied-a-before-b')
        before={'final_helper':snapshot(ah),'copied_harness':snapshot(ac)}
        (RUN/'a-before-b.json').write_text(json.dumps(before,indent=2)+'\n')
        original_alias_paths=[Path(x['path']) for x in aliases(ah)]
        def check_A(label):
            now={'final_helper':snapshot(ah),'copied_harness':snapshot(ac)}
            known=[snapshot(p) if p.exists() else {'path':str(p),'exists':False} for p in original_alias_paths]
            receipt={'A':now,'original_A_cache_paths_now':known,'identity_preserved':{k:identity(before[k])==identity(now[k]) for k in before},'nlink_change':now['final_helper']['nlink']-before['final_helper']['nlink']}
            result[label]=receipt;(RUN/(label+'.json')).write_text(json.dumps(receipt,indent=2)+'\n')
            assert all(receipt['identity_preserved'].values()),'Old A bytes/inodes changed; do not repair'
        bh,probe=build('b','build-b-reuse-probe')
        result['b_reuse_binding_probe']=run_harness(probe,'b','copied-b-reuse-probe',False)
        result['b_reuse_direct_helper_stdout']=call([str(bh)],'b-reuse-direct-helper')[0].strip()
        check_A('a-after-b-reuse')
        # A test-only compiler extraarg would not qualify the root library/helper.
        # Touch only disposable B's four relevant source files, then use SAME full recipe.
        touched={}
        for rel in TOUCH_FILES:
            p=RUN/'workspace-b'/rel;os.utime(p,None);touched[rel]=p.stat().st_mtime_ns
        result['B_force_touch_mtimes_ns']=touched
        bh,bc=build('b','build-b-forced-full')
        assert all(v is False for v in artifacts['build-b-forced-full']['fresh'].values()),'Require fresh:false for root library/helper/harness'
        result['b_forced_binding']=run_harness(bc,'b','copied-b-forced')
        check_A('a-after-b-forced')
        assert file_id(bh)!=file_id(ah),'New final helper must not share old A inode'
        new_aliases=aliases(bh);assert new_aliases,'Need observed new shared-deps alias'
        assert all((a['dev'],a['inode'])!=file_id(ah) for a in new_aliases),'New shared-deps alias must not share old A inode'
        assert snapshot(ah)['sha256']!=snapshot(bh)['sha256']
        assert call([str(ah)],'final-a-after-b')[0].strip()=='VARIANT_A'
        assert call([str(bh)],'final-b-after-b')[0].strip()=='VARIANT_B'
        result['a_final_binding']=run_harness(ac,'a','copied-a-after-b')
        result.update(status='PASS',cargo_version=cv.strip(),old_A_final_helper_and_copied_harness_bytes_inodes_preserved=True,new_final_and_deps_inodes_differ_from_old_A=True,no_A_Cargo_repair_after_B=True)
    except BaseException as e:
        stop_active();result.update(status='INCOMPLETE_OR_FAIL',failure=type(e).__name__+': '+str(e))
    finally:
        result['elapsed_seconds']=round(time.monotonic()-started,6);result['no_active_owned_subprocess']=active is None
        (RUN/'RESULT.json').write_text(json.dumps(result,indent=2)+'\n')
        print(json.dumps({'status':result['status'],'elapsed_seconds':result['elapsed_seconds'],'result':str(RUN/'RESULT.json')}))
    return 0 if result['status']=='PASS' else 1
if __name__=='__main__':sys.exit(main())
