#!/usr/bin/env python3
"""UNRUN owned Python fixture. No observer or import-time process/control action."""
import argparse
import ctypes
import json
import math
import os
from pathlib import Path
import signal
import stat
import sys
import time
import threading

SCHEMA = 'owned-exec-stop-fake-fixture-v1'
MODES = ('gated', 'harness', 'confined', 'sibling')


def require(value, message):
    if not value:
        raise RuntimeError(message)


def birth(pid):
    with open('/proc/'+str(pid)+'/stat','rb',buffering=0) as source:
        data=source.read(8192)
    require(len(data)<8192, 'bounded fixture proc stat')
    tail=data[data.rfind(b') ')+2:].split()
    return {'pid':pid,'start':tail[19].decode(),'ppid':int(tail[1])}


def frame(fd, nonce, event, **values):
    record={'schema':SCHEMA,'nonce':nonce,'event':event,'identity':birth(os.getpid()),**values}
    payload=(json.dumps(record,sort_keys=True)+'\n').encode()
    require(len(payload)<=2048,'one bounded atomic fixture frame required')
    require(os.write(fd,payload)==len(payload),'short fixture report write')


def inherited_pipe(fd):
    require(type(fd) is int and fd>=3 and stat.S_ISFIFO(os.fstat(fd).st_mode), 'inherited pipe required')


def argv(args, mode):
    return [args.python,'-I','-B',str(Path(__file__).resolve()),mode,
        '--gate-fd',str(args.gate_fd),'--report-fd',str(args.report_fd),'--hold-fd',str(args.hold_fd),
        '--nonce',args.nonce,'--absolute-expiry-epoch',str(args.absolute_expiry_epoch),'--python',args.python,
        '--scenario',args.scenario,'--threads','2' if args.scenario=='wrong-argv' and mode=='confined' else '3']


def reexec(args, mode):
    # No shell, search PATH, environment inheritance, app executable or model data.
    for fd in (args.report_fd,args.hold_fd):os.set_inheritable(fd,True)
    os.execve(args.python,argv(args,mode),{'PATH':'/usr/bin:/bin','LANG':'C.UTF-8',
        'LC_ALL':'C.UTF-8','PYTHONDONTWRITEBYTECODE':'1'})
    raise RuntimeError('exec unexpectedly returned')


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('mode',choices=MODES)
    for name in ('gate-fd','report-fd','hold-fd'):parser.add_argument('--'+name,type=int,required=True)
    parser.add_argument('--nonce',required=True);parser.add_argument('--absolute-expiry-epoch',type=float,required=True)
    parser.add_argument('--scenario',choices=('normal','wrong-hash','wrong-argv','second'),default='normal')
    parser.add_argument('--python',required=True);parser.add_argument('--threads',required=True);args=parser.parse_args()
    remaining=args.absolute_expiry_epoch-time.time()
    require(math.isfinite(remaining) and 0<remaining<=15,'original finite <=15s fixture deadline required')
    require(16<=len(args.nonce)<=64 and args.nonce.isascii() and args.nonce.isalnum(),'fixed private nonce required')
    require(Path(args.python).is_absolute() and str(Path(args.python).resolve())==args.python
            and str(Path(sys.executable).resolve())==args.python,'exact canonical current Python required')
    # Local timer is only a final fixture limit; parent owns original30/6 budget and pidfd cleanup.
    def expired(*unused):raise TimeoutError('owned fake fixture deadline')
    signal.signal(signal.SIGALRM,expired);signal.setitimer(signal.ITIMER_REAL,remaining)
    inherited_pipe(args.report_fd);inherited_pipe(args.hold_fd)
    try:
        if args.mode=='gated':
            os.sched_setaffinity(0,{1,2,3,4});os.setpriority(os.PRIO_PROCESS,0,10)
            require(sorted(os.sched_getaffinity(0))==[1,2,3,4] and os.getpriority(os.PRIO_PROCESS,0)==10,'harness initial placement')
            inherited_pipe(args.gate_fd)
            frame(args.report_fd,args.nonce,'gated-ready')
            require(os.read(args.gate_fd,1)==b'G','only literal G opens initial exec gate')
            os.close(args.gate_fd)
            reexec(args,'harness')
        if args.mode=='sibling':
            frame(args.report_fd,args.nonce,'untraced-sibling-ready')
            require(os.read(args.hold_fd,1)==b'R','only literal R releases controller-owned sibling')
            frame(args.report_fd,args.nonce,'untraced-sibling-release-accepted')
            return 0
        if args.mode=='harness':
            frame(args.report_fd,args.nonce,'harness-userspace')
            # Real libtest-like nonleader worker creates a process via posix_spawn.
            # No Python code runs in a multithreaded fork child before exec.
            for fd in (args.report_fd,args.hold_fd):os.set_inheritable(fd,True)
            spawned=[];failures=[]
            def launch():
                try:
                    frame(args.report_fd,args.nonce,'worker-thread-userspace',spawn_tid=threading.get_native_id())
                    child=os.posix_spawn(args.python,argv(args,'confined'),{'PATH':'/usr/bin:/bin',
                        'LANG':'C.UTF-8','LC_ALL':'C.UTF-8','PYTHONDONTWRITEBYTECODE':'1'})
                    spawned.append(child)
                    frame(args.report_fd,args.nonce,'spawn-returned',child_pid=child,spawn_tid=threading.get_native_id())
                except BaseException as error:
                    failures.append(type(error).__name__+': '+str(error))
            worker=threading.Thread(target=launch,name='owned-fake-spawn-worker')
            worker.start();worker.join()
            require(not failures and len(spawned)==1,'owned worker spawn failed: '+repr(failures))
            child=spawned[0]
            if args.scenario == 'second':
                other=os.posix_spawn(args.python,argv(args,'confined'),{'PATH':'/usr/bin:/bin','LANG':'C.UTF-8','LC_ALL':'C.UTF-8','PYTHONDONTWRITEBYTECODE':'1'})
                frame(args.report_fd,args.nonce,'second-helper-spawned',child_pid=other)
            # H remains the actual parent for every denied child; G never races
            # it by killing H during expected negative-case teardown.
            children=[child]+([other] if args.scenario=='second' else [])
            codes=[]
            for expected_pid in children:
                while True:
                    waited,status=os.waitpid(expected_pid,0)
                    if os.WIFEXITED(status) or os.WIFSIGNALED(status):break
                require(waited==expected_pid,'owned fixture wait identity')
                code=os.waitstatus_to_exitcode(status);codes.append(code)
                frame(args.report_fd,args.nonce,'fixture-child-terminal-wait',child_pid=waited,actual_exit_code=code)
            expected_codes=[-signal.SIGKILL,0] if args.scenario=='second' else [-signal.SIGKILL] if args.scenario in ('wrong-hash','wrong-argv') else [0]
            require(sorted(codes)==expected_codes,'unexpected actual fixture child exits')
            return 0
        libc=ctypes.CDLL(None,use_errno=True)
        libc.prctl.argtypes=[ctypes.c_int,ctypes.c_ulong,ctypes.c_ulong,ctypes.c_ulong,ctypes.c_ulong]
        libc.prctl.restype=ctypes.c_int
        require(libc.prctl(4,0,0,0,0)==0,'fake child PR_SET_DUMPABLE0 failed')
        require(libc.prctl(3,0,0,0,0)==0,'fake child PR_GET_DUMPABLE is not0')
        selected=sorted(os.sched_getaffinity(0))
        release=threading.Event();ready=threading.Barrier(4)
        def helper_worker():
            frame(args.report_fd,args.nonce,'helper-worker-ready',tid=threading.get_native_id(),cpus=sorted(os.sched_getaffinity(0)),nice=os.getpriority(os.PRIO_PROCESS,0))
            ready.wait(timeout=3);release.wait(timeout=5)
        workers=[threading.Thread(target=helper_worker) for _ in range(3)]
        for worker in workers:worker.start()
        ready.wait(timeout=3)
        frame(args.report_fd,args.nonce,'confined-userspace-dumpable0',dumpable=0,main_reached=True,fixture_main_cpus=selected,nice=os.getpriority(os.PRIO_PROCESS,0))
        require(os.read(args.hold_fd,1)==b'R','only literal R releases confined fake child')
        release.set()
        for worker in workers:worker.join(timeout=1);require(not worker.is_alive(),'worker did not finish')
        frame(args.report_fd,args.nonce,'confined-release-accepted')
        return 0
    finally:
        signal.setitimer(signal.ITIMER_REAL,0)


if __name__=='__main__':
    raise SystemExit(main())
