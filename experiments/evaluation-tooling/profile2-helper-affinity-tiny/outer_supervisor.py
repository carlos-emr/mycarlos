#!/usr/bin/python3
"""UNRUN finite independent outer; final A1 bound; exact source review and separate ROOT grant still required."""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import signal
import stat
import subprocess
import sys
import time
import types

PACKAGE=Path(__file__).resolve().parent
GIB=1024**3
TOTAL_LIMIT=30.0
CLEANUP_RESERVE=6.0
MAX_RESULT=524288
STOP_REQUESTED=None

def deadline_phase(now, work_end, hard_end):
    if now < work_end:
        return "work"
    if now < hard_end:
        return "cleanup"
    return "expired"

def stop_reason(now, work_end, hard_end, signal_number, sentinel_ok, available):
    if signal_number is not None:
        return "received signal " + str(signal_number)
    if deadline_phase(now, work_end, hard_end) != "work":
        return "work deadline; cleanup reserve entered"
    if not sentinel_ok:
        return "root sentinel lost"
    if available < 4 * GIB:
        return "available memory below 4 GiB"
    return None

def proc(pid):
    try:
        raw = Path(f"/proc/{pid}/stat").read_text()
    except FileNotFoundError:
        return None
    tail = raw.rsplit(") ", 1)[1].split()
    return {"state": tail[0], "ppid": int(tail[1]), "start": tail[19]}

def available_bytes():
    lines = Path("/proc/meminfo").read_text().splitlines()
    return next(int(line.split()[1]) * 1024 for line in lines if line.startswith("MemAvailable:"))

def tty_snapshot():
    values = []
    for fd in (0, 1):
        if not os.isatty(fd):
            return None
        item = os.fstat(fd)
        if not stat.S_ISCHR(item.st_mode):
            return None
        values.append((item.st_dev, item.st_ino, item.st_rdev))
    return values[0], values[1]

def same_pty(before, after):
    return before is not None and after is not None and before == after

def deadlines(started, now_wall, absolute_expiry):
    remaining = absolute_expiry - now_wall
    if not math.isfinite(remaining) or not 1 <= remaining <= TOTAL_LIMIT:
        raise ValueError("absolute expiry must be within the <=30-second total window")
    hard_end = started + remaining
    work_end = hard_end - CLEANUP_RESERVE
    if work_end <= started:
        raise ValueError("insufficient work time after reserved cleanup/finalization")
    return hard_end, work_end

def sentinel_matches(expected_pid, expected_start, current_ppid, observed):
    return (current_ppid == expected_pid and observed is not None
            and observed["start"] == expected_start and observed["state"] not in {"Z", "X"})

def same_sentinel(pid, start):
    return sentinel_matches(pid, start, os.getppid(), proc(pid))

def atomic_receipt(window, record, hard_end):
    final = window / "outer-result.json"
    temporary = window / ".outer-result.tmp"
    data = (json.dumps(record, sort_keys=True, indent=2) + "\n").encode()
    if len(data) > MAX_RESULT:
        raise RuntimeError("outer receipt size cap exceeded")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        view = memoryview(data)
        while view:
            if STOP_REQUESTED is not None:
                raise InterruptedError("signal during outer receipt write")
            if deadline_phase(time.monotonic(), hard_end - CLEANUP_RESERVE, hard_end) == "expired":
                raise TimeoutError("deadline during outer receipt write")
            view = view[os.write(fd, view):]
        if STOP_REQUESTED is not None:
            raise InterruptedError("signal before outer receipt sync")
        if deadline_phase(time.monotonic(), hard_end - CLEANUP_RESERVE, hard_end) == "expired":
            raise TimeoutError("deadline before outer receipt sync")
        os.fsync(fd)
        os.fchmod(fd, 0o400)
        os.fsync(fd)
    finally:
        os.close(fd)
    if deadline_phase(time.monotonic(), hard_end - CLEANUP_RESERVE, hard_end) == "expired":
        raise TimeoutError("deadline before outer receipt commit")
    if STOP_REQUESTED is not None:
        raise InterruptedError("signal before outer receipt commit")
    os.link(temporary, final, follow_symlinks=False)
    os.unlink(temporary)
    dfd = os.open(window, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        os.fsync(dfd)
    finally:
        os.close(dfd)
    if deadline_phase(time.monotonic(), hard_end - CLEANUP_RESERVE, hard_end) == "expired":
        raise TimeoutError("deadline after outer receipt sync")
    if STOP_REQUESTED is not None:
        raise InterruptedError("signal during outer receipt commit")
    return final


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--explicit-grant',required=True);parser.add_argument('--binding-sha256',required=True)
    parser.add_argument('--absolute-expiry-epoch',type=float,required=True)
    parser.add_argument('--sentinel-pid',type=int,required=True);parser.add_argument('--sentinel-start',required=True)
    parser.add_argument('--window',type=Path,required=True);args=parser.parse_args()
    # First timer covers metadata verification and launch, not only the live cases.
    started=time.monotonic();left=args.absolute_expiry_epoch-time.time()
    if not math.isfinite(left) or not CLEANUP_RESERVE<left<=TOTAL_LIMIT:return 124
    hard,work=deadlines(started,time.time(),args.absolute_expiry_epoch)
    active=[]
    def stop(*unused):
        if time.monotonic()>=hard:
            for owner in active:
                for entry in list(owner.entries.values()):
                    try:signal.pidfd_send_signal(entry['fd'],signal.SIGKILL,None,0)
                    except OSError:pass
            raise TimeoutError('outer original hard deadline')
        for owner in active:owner.budget.enter_final()
        signal.setitimer(signal.ITIMER_REAL,max(.001,hard-time.monotonic()))
        raise TimeoutError('outer work/cancellation; cleanup reserve remains')
    signal.signal(signal.SIGALRM,stop)
    for number in (signal.SIGINT,signal.SIGTERM,signal.SIGHUP):signal.signal(number,stop)
    signal.setitimer(signal.ITIMER_REAL,max(.001,work-time.monotonic()))
    live=None;owner=None;clock=None;child=None;window=None;opened=[];accepted=False;payload=None;error=None
    try:
        os.sched_setaffinity(0,{0})
        if os.getpriority(os.PRIO_PROCESS,0)!=0:raise RuntimeError('outer bootstrap must inherit nice0')
        if not same_sentinel(args.sentinel_pid,args.sentinel_start):raise RuntimeError('root actual parent differs')
        tty_before=tty_snapshot()
        if tty_before is None:raise RuntimeError('same actual root PTY required')
        # Verify live_controls bytes before executing even its definitions.
        binding_path=PACKAGE/'BINDING.json';info=binding_path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_size>65536:raise RuntimeError('binding metadata cap')
        fd=os.open(binding_path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC)
        try:
            initial=os.fstat(fd)
            identity=lambda st:(st.st_dev,st.st_ino,st.st_size,st.st_mtime_ns)
            if identity(initial)!=identity(info):raise RuntimeError('binding replaced')
            raw=os.read(fd,65537)
            if len(raw)>65536 or identity(os.fstat(fd))!=identity(info) or identity(binding_path.lstat())!=identity(info):raise RuntimeError('binding changed')
        finally:os.close(fd)
        if hashlib.sha256(raw).hexdigest()!=args.binding_sha256:raise RuntimeError('root binding hash differs')
        binding=json.loads(raw);path=PACKAGE/'live_controls.py';before=path.lstat()
        if not stat.S_ISREG(before.st_mode) or before.st_size>2*1024*1024:raise RuntimeError('live source metadata cap')
        fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC)
        try:
            opened_info=os.fstat(fd)
            if identity(opened_info)!=identity(before):raise RuntimeError('live source replaced')
            source=bytearray()
            while True:
                block=os.read(fd,65536)
                if not block:break
                source.extend(block)
                if len(source)>2*1024*1024:raise RuntimeError('live source grew')
            if identity(os.fstat(fd))!=identity(before) or identity(path.lstat())!=identity(before):raise RuntimeError('live source changed')
        finally:os.close(fd)
        if hashlib.sha256(source).hexdigest()!=binding['files']['live_controls.py']:raise RuntimeError('live source not bound')
        live=types.ModuleType('owned_live_controls');live.__file__=str(path)
        exec(compile(bytes(source),str(path),'exec'),live.__dict__)
        if args.explicit_grant!=live.GRANT:raise RuntimeError('explicit separately reviewed root grant required')
        live.HARD=hard;live.WORK=work
        s,module=live.load_bound(args)
        if available_bytes()<8*GIB:raise RuntimeError('fresh outer admission below8GiB')
        live.subreaper();clock=live.budget(s,live.process_hook(s,args.sentinel_pid,args.sentinel_start))
        owner=live.audit_owner(s,clock);active.append(owner)
        window=args.window
        if not window.is_absolute() or window.parent!=Path('/workspace') or not window.name.startswith('codex-root-exec-stop-window-') or os.path.lexists(window):raise RuntimeError('new private control window required')
        window.mkdir(mode=0o700)
        if stat.S_IMODE(window.stat().st_mode)!=0o700 or window.stat().st_uid!=os.geteuid():raise RuntimeError('private owned0700 window required')
        result=window/'control-result.json';gate_r,gate_w=live.pipe();opened=[gate_r,gate_w]
        os.set_blocking(gate_r,True)
        outer=s.proc(os.getpid(),clock);record={}
        command=[sys.executable,'-I','-B',str(PACKAGE/'live_controls.py'),'--explicit-grant',live.GRANT,
            '--binding-sha256',args.binding_sha256,'--absolute-expiry-epoch',str(args.absolute_expiry_epoch),
            '--window',str(window),'--result',str(result),'--parent-pid',str(os.getpid()),'--parent-start',outer['start'],
            '--launch-gate-fd',str(gate_r)]
        child,key=live.spawn(owner,s,command,(gate_r,),{'PATH':'/usr/bin:/bin','LANG':'C.UTF-8','LC_ALL':'C.UTF-8','PYTHONDONTWRITEBYTECODE':'1'},record)
        os.close(gate_r);opened.remove(gate_r);os.setpriority(os.PRIO_PROCESS,0,19);live.write_byte(gate_w,b'G')
        while child.returncode is None:
            clock.check();owner.discover();owner.reap();time.sleep(.005)
        payload=s.committed_json(result,clock,maximum=MAX_RESULT)
        if (child.returncode!=0 or payload.get('schema')!='v13-helper-affinity-fixture-controls-v1'
                or payload.get('status')!='passed' or payload.get('control_names')!=list(live.CASES)
                or payload.get('control_count')!=len(live.CASES) or payload.get('source_binding_sha256')!=args.binding_sha256
                or payload.get('observer_sha256')!=binding['files']['exec_observer.py']
                or payload.get('phase_sha256')!=binding['files']['phase.py']
                or payload.get('cleanup',{}).get('cleanup_complete') is not True
                or [c.get('case') for c in payload.get('cases',[])]!=list(live.CASES)
                or any(c.get('status')!='passed' or c.get('cleanup',{}).get('cleanup_complete') is not True for c in payload.get('cases',[]))):
            raise RuntimeError('actual helper-affinity five controls/cleanup incomplete')
        accepted=True
    except BaseException as exc:error=type(exc).__name__+': '+str(exc)
    finally:
        if live is not None and clock is not None and owner is not None:
            live.HARD=hard;live.WORK=work
            try:cleanup=live.cleanup(owner,s,clock)
            except BaseException as exc:
                live.kill_bound();cleanup={'cleanup_complete':False};error=error or str(exc)
            accepted=accepted and cleanup.get('cleanup_complete') is True
        else:cleanup={'cleanup_complete':False};accepted=False
        for fd in opened:
            try:os.close(fd)
            except OSError:pass
        if time.monotonic()<hard and window is not None and live is not None:
            signal.setitimer(signal.ITIMER_REAL,max(.001,hard-time.monotonic()))
            try:
                sentinel_after=same_sentinel(args.sentinel_pid,args.sentinel_start);tty_after=tty_snapshot()
                accepted=accepted and sentinel_after and same_pty(tty_before,tty_after)
                qualification=None
                if accepted:
                    references=[]
                    for artifact in (window/'control-result.json',*(window/('case-'+str(i)+'.json') for i in range(5)),PACKAGE/'BINDING.json'):
                        references.append({'path':str(artifact),'sha256':s.digest(artifact,clock,MAX_RESULT)})
                    affinity=sys.modules['helper_affinity']
                    qualification={'schema':affinity.QUALIFICATION_SCHEMA,'qualification_scope':affinity.QUALIFICATION_SCOPE,
                        'fixture_kind':affinity.FIXTURE_KIND,'live_functions':affinity.LIVE_FUNCTIONS,
                        'fixture_full_argv_preserved':True,'production_native_helper_argv_live_qualified':False,
                        'full_production_phase_live_qualified':False,'native_model_live_qualified':False,
                        'model_loaded':False,'native_compilation_performed':False,
                        'root_accepted':False,'actual_exit_code':None,'actual_live_controls':True,
                        'coordinator_package':binding['a1_final']['source_manifest'],
                        'sources':{name:binding['candidate_sources'][name] for name in ('phase.py','profile2.py','helper_affinity.py','exec_observer.py')},
                        'affinity_scope':sys.modules['profile2'].SCOPE,
                        'kernel_no_children':cleanup['kernel_no_children'],
                        'no_unbound_children':not cleanup['invalid_observations'] and not cleanup['unbound_root_children'],
                        'checks':{name:True for name in affinity.QUALIFICATION_CHECKS},'actual_artifacts':references,
                        'root_must_add_actual_outer_exit0_and_outer_receipt_and_independent_Bash_proof':True}
                receipt={'schema':'helper-affinity-fixture-five-control-outer-v1','status':'passed' if accepted else 'failed',
                    'error':error,'source_binding_sha256':args.binding_sha256,'hard_end_monotonic':hard,'work_end_monotonic':work,
                    'sentinel':{'pid':args.sentinel_pid,'start':args.sentinel_start,'same_instance_after':sentinel_after},
                    'pty':{'before':tty_before,'after':tty_after,'same_after':same_pty(tty_before,tty_after)},
                    'child_actual_exit_code':child.returncode if child else None,'cleanup':cleanup,'control_result':payload,
                    'qualification_candidate_requires_independent_root_acceptance':qualification,
                    'root_action':'retain actual holder/HOLD; accept only matching receipt plus root-observed outer actualexit0'}
                atomic_receipt(window,receipt,hard)
                print(json.dumps({'status':receipt['status'],'receipt':str(window/'outer-result.json')}),flush=True)
                if time.monotonic()>=hard:accepted=False
            except BaseException:accepted=False
        if owner is not None:owner.close()
        signal.setitimer(signal.ITIMER_REAL,0)
    return 0 if accepted else 124


if __name__=='__main__':raise SystemExit(main())
