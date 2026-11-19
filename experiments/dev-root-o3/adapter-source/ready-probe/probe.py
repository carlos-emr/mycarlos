"""UNRUN Root-only identity diagnostic. NO target userspace, model or tests.

Root pins source SHA and independently grants original <=30s/6s diagnostic.
"""
import sys
import time
import signal
START=time.clock_gettime(time.CLOCK_BOOTTIME)
WALL=time.time()
HARD=None
WORK=None
OWNER=None

def alarm(*unused):
    if OWNER is not None:
        for entry in list(OWNER.entries.values()):
            try:signal.pidfd_send_signal(entry['fd'],signal.SIGKILL,None,0)
            except OSError:pass
    raise TimeoutError('original diagnostic deadline/cancellation')

if __name__=='__main__':
    # Minimal interpreter/bootstrap is covered by independent Root supervision.
    # These entry signals protect all later imports and source/ELF operations.
    for number in (signal.SIGALRM,signal.SIGHUP,signal.SIGTERM,signal.SIGINT):signal.signal(number,alarm)
    signal.setitimer(signal.ITIMER_REAL,24)

import argparse
import ctypes
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import stat
import subprocess

PACKAGE=Path(__file__).parent
GRANT='root-reviewed-o3-current-source-ready-native-EXEC-stop-only'
class CapturedStop(Exception):pass

def require(ok,reason):
    if not ok:raise RuntimeError(reason)

def source(path,digest):
    data=path.read_bytes()
    require(len(data)<=2*1024*1024 and hashlib.sha256(data).hexdigest()==digest,'diagnostic source changed')
    return data

def load(name,path,digest):
    data=source(path,digest);module=type(sys)(name);module.__file__=str(path)
    exec(compile(data,str(path),'exec'),module.__dict__);return module

def proc_bytes(pid,leaf,maximum=65536):
    fd=os.open('/proc/'+str(pid)+'/'+leaf,os.O_RDONLY|os.O_CLOEXEC|os.O_NONBLOCK)
    try:
        data=os.read(fd,maximum+1);require(len(data)<=maximum,'proc read cap');return data
    finally:os.close(fd)

def main():
    global HARD,WORK,OWNER
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--grant',required=True);p.add_argument('--binding-sha256',required=True)
    p.add_argument('--absolute-expiry-epoch',type=float,required=True)
    p.add_argument('--sentinel-pid',type=int,required=True);p.add_argument('--sentinel-start',required=True)
    p.add_argument('--window',type=Path,required=True);args=p.parse_args()
    require(args.grant==GRANT,'separate Root diagnostic grant required')
    left=args.absolute_expiry_epoch-WALL;require(math.isfinite(left) and 6<left<=30,'fixed <=30s incl6 cleanup')
    HARD=START+left;WORK=HARD-6
    signal.setitimer(signal.ITIMER_REAL,max(.001,WORK-time.clock_gettime(time.CLOCK_BOOTTIME)))
    require(os.isatty(0) and os.isatty(1),'original Root PTY required')
    tty_before=[(os.fstat(fd).st_dev,os.fstat(fd).st_ino,os.fstat(fd).st_rdev) for fd in (0,1)]
    require(tty_before[0]==tty_before[1],'same PTY fds required')
    raw=(PACKAGE/'BINDING.json').read_bytes();require(hashlib.sha256(raw).hexdigest()==args.binding_sha256,'binding differs')
    binding=json.loads(raw)
    for name,digest in binding['files'].items():source(PACKAGE/name,digest)
    loader=load('_exact_v4_loader',PACKAGE/'frozen_loader.py',binding['files']['frozen_loader.py'])
    phase=loader.load_frozen(binding);base=phase.base
    b=base.Budget(30,args.absolute_expiry_epoch,6,monotonic=phase.boot);b.started=START;b.hard_end=HARD;b.work_end=WORK
    def hook():
        parent=base.proc(args.sentinel_pid,budget=None)
        require(os.getppid()==args.sentinel_pid and parent and parent['start']==args.sentinel_start and parent['state'] not in {'Z','X'},'Root parent changed')
        data=proc_bytes(os.getpid(),'status');require(b'TracerPid:\t0' in data,'diagnostic parent already traced')
        memory=Path('/proc/meminfo').read_text()
        require(next(int(x.split()[1])*1024 for x in memory.splitlines() if x.startswith('MemAvailable:'))>=4*base.GIB,'stop memory floor4GiB')
    b.work_hook=hook;b.check()
    require(next(int(x.split()[1])*1024 for x in Path('/proc/meminfo').read_text().splitlines() if x.startswith('MemAvailable:'))>=8*base.GIB,'fresh admission8GiB')
    os.sched_setaffinity(0,{0});os.setpriority(os.PRIO_PROCESS,0,19)
    require(args.window.is_absolute() and args.window.parent==Path('/workspace') and args.window.name.startswith('codex-root-native-exec-diag-'),'fresh private window required')
    args.window.mkdir(mode=0o700)
    expected=binding['expected_harness'];target=Path(expected['path'])
    s=target.lstat();require([s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns,s.st_nlink,stat.S_IMODE(s.st_mode)]==[expected[k] for k in ['device','inode','bytes','mtime_ns','nlink']]+[0o500],'current exact qualified harness metadata differs')
    require(base.digest(target,b,4*base.GIB)==expected['sha256'],'exact canonical qualified harness hash differs')
    libc=ctypes.CDLL(None,use_errno=True);require(libc.prctl(36,1,0,0,0)==0,'diagnostic subreaper required')
    owner=phase.StrictOwned(b);OWNER=owner
    observer=None;child=None;gate_r=gate_w=diag_r=diag_w=None;record=None;error=None;snapshot=None;ready_frame=None;ready_bytes=b''
    def captured_stop(role, actual):
        nonlocal record
        require(role=='harness','unexpected helper role')
        require(actual['actual_argv']==binding['expected_argv'],'exact native argv differs')
        require(actual['kernel_exec_stop_before_userspace'] and actual['hash_read_from_kernel_exe_fd'], 'actual strict capture required')
        record={'schema':'v4-exact-readiness-native-exec-stop-v1','strict_record':actual,
            'python_ready_ack_before_seize':ready_frame,'target_userspace_permitted':False,
            'model_or_test_executed':False,'exact_frozen_phase_helpers':True,
            'strict_identity_matches':True,'strict_hash_matches':True,'strict_argv_matches':True}
        base.immutable_json(args.window/'observed-with-hash.json',record,b)
        # Exact frozen DiagnosticExecObserver and unchanged strict parent capture
        # call this before records/CONT/DETACH. Always raise to hold native EXEC.
        raise CapturedStop('qualified actual native EXEC held; kill before userspace')
    def seize_ready(bound_child,key):
        nonlocal observer,ready_frame,child
        child=bound_child
        ready_frame=bound_child._exec_ready_proof
        require((ready_frame['pid'],ready_frame['start'])==key and ready_frame['ready_eof']
            and ready_frame['bootstrap_only_not_native_exec'], 'exact bound READY required')
        base.immutable_json(args.window/'python-ready-before-seize.json',ready_frame,b)
        observer=phase.DiagnosticExecObserver(owner,b,base,{'harness':expected,'helper':expected},key,
            phase.proc_bytes,on_exec=captured_stop)
        observer.event('exec-bootstrap-ready-before-seize',**ready_frame)
        observer.seize(bound_child,key)
    try:
        # One original deadline covers full bootstrap, exact R+EOF, SEIZE, G and EXEC.
        dispatch_deadline=min(phase.boot()+60,b.work_end)
        parent=base.proc(os.getpid(),b)
        argv=[sys.executable,'-I','-B',str(PACKAGE/'gated_exec.py'),
            '--binding-sha256',args.binding_sha256,'--absolute-expiry-epoch',str(args.absolute_expiry_epoch),
            '--hard-boot',str(HARD),'--work-boot',str(WORK),
            '--parent-pid',str(os.getpid()),'--parent-start',parent['start']]
        child,key=phase.spawn_gated(argv,b,owner,subprocess.DEVNULL,on_bound=seize_ready,
            exec_ready_deadline=dispatch_deadline)
        while phase.boot()<dispatch_deadline:
            b.check();owner.reap();time.sleep(.005)
        raise TimeoutError('no native EXEC before original dispatch deadline')
    except CapturedStop:pass
    except BaseException as exc:error=type(exc).__name__+': '+str(exc)
    finally:
        b.enter_final();signal.setitimer(signal.ITIMER_REAL,max(.001,HARD-time.clock_gettime(time.CLOCK_BOOTTIME)))
        for fd in [gate_r,gate_w,diag_w]:
            if fd is not None:
                try:os.close(fd)
                except OSError:pass
        try:
            end=min(HARD-.25,time.clock_gettime(time.CLOCK_BOOTTIME)+5)
            while time.clock_gettime(time.CLOCK_BOOTTIME)<end:
                b.check(final=True)
                for entry in owner.entries.values():
                    try:signal.pidfd_send_signal(entry['fd'],signal.SIGKILL,None,0)
                    except ProcessLookupError:pass
                owner.reap()
                if owner.no_children:break
                time.sleep(.01)
            snapshot=owner.snapshot()
            require(snapshot['cleanup_complete'] and snapshot['kernel_no_children'] and not owner.invalid_observations,'owned diagnostic cleanup incomplete')
            require(record is not None,'no diagnostic EXEC observation')
            tty_after=[(os.fstat(fd).st_dev,os.fstat(fd).st_ino,os.fstat(fd).st_rdev) for fd in (0,1)]
            require(tty_after==tty_before,'PTY changed')
            hook() if b.phase=='work' else None
        except BaseException as exc:error=(error+'; ' if error else '')+type(exc).__name__+': '+str(exc)
        frames=ready_bytes
        if diag_r is not None:
            try:
                while len(frames)<8192:
                    piece=os.read(diag_r,8192-len(frames))
                    if not piece:break
                    frames+=piece
            except BlockingIOError:pass
            os.close(diag_r)
        result={'schema':'native-exec-stop-diagnostic-result-v1','status':'diagnostic-observed-and-owned-cleaned' if error is None else 'failed',
            'error':error,'observation':record,'cleanup':snapshot,'child_actual_exit':None if child is None else child.returncode,
            'python_entry_observation_bytes':frames.decode('utf-8','replace'),'observer_events':None if observer is None else observer.events,'coordinator_freeze':binding['coordinator_files']['FREEZE.json'],'python_ready_before_seize_required':True,
            'target_userspace_permitted':False,'model_or_test_executed':False,'no_model_qualification_or_retry_authority':True}
        try:base.immutable_json(args.window/'result.json',result,b)
        finally:
            if observer is not None:observer.close()
            owner.close();OWNER=None
    return 0 if error is None else 1

if __name__=='__main__':
    try:raise SystemExit(main())
    finally:signal.setitimer(signal.ITIMER_REAL,0)
