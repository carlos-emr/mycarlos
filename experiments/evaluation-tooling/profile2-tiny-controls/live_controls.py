#!/usr/bin/python3
"""Five bounded own-child EXEC-stop/teardown controls; separate root grant required."""
import argparse
import ctypes
import errno
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
CASES=('exec-before-dumpable0-positive','wrong-helper-hash-denied','tracer-death-exitkill',
       'normal-helper-sigkill-shutdown','adopted-helper-sigkill-shutdown')
GRANT='root-reviewed-profile2-masks-five-controls-only'
TOTAL=30.0
RESERVE=6.0
GIB=1024**3
OWNERS=[]
HARD=None
WORK=None
BASE=None
BINDING=None
PHASE=None
ROLE_RESERVE=RESERVE


class HardDeadline(TimeoutError):pass
class WorkDeadline(TimeoutError):pass


def kill_bound():
    for owner in OWNERS:
        for entry in list(owner.entries.values()):
            try:signal.pidfd_send_signal(entry['fd'],signal.SIGKILL,None,0)
            except (ProcessLookupError,OSError):pass


def alarm(*unused):
    if time.monotonic()>=HARD:
        kill_bound()
        raise HardDeadline('original hard deadline')
    for owner in OWNERS:owner.budget.enter_final()
    signal.setitimer(signal.ITIMER_REAL,max(.001,HARD-time.monotonic()))
    raise WorkDeadline('work ceiling; cleanup reserve remains')


def interrupted(number,*unused):
    for owner in OWNERS:owner.budget.enter_final()
    signal.setitimer(signal.ITIMER_REAL,max(.001,HARD-time.monotonic()))
    raise InterruptedError('signal '+str(number))


def arm(args,worker=False):
    global HARD,WORK,ROLE_RESERVE
    started=time.monotonic();left=args.absolute_expiry_epoch-time.time()
    if not math.isfinite(left) or not RESERVE<left<=TOTAL:raise RuntimeError('original finite<=30s/6s reserve required')
    HARD=started+left;WORK=HARD-RESERVE
    ROLE_RESERVE=1.0 if worker else RESERVE
    if worker:
        if not math.isfinite(args.case_expiry_epoch):raise RuntimeError('finite inherited case expiry required')
        HARD=min(HARD,started+args.case_expiry_epoch-time.time());WORK=HARD-1.0
    if WORK<=started:raise RuntimeError('expired work ceiling')
    signal.signal(signal.SIGALRM,alarm)
    for number in (signal.SIGINT,signal.SIGTERM,signal.SIGHUP):signal.signal(number,interrupted)
    signal.setitimer(signal.ITIMER_REAL,max(.001,WORK-started))
    os.sched_setaffinity(0,{0});os.setpriority(os.PRIO_PROCESS,0,19)
    return started


def bounded(path,maximum):
    path=Path(path);before=path.lstat()
    if not stat.S_ISREG(before.st_mode) or before.st_size>maximum:raise RuntimeError('bounded regular source required')
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC)
    identity=lambda s:(s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns)
    try:
        if identity(os.fstat(fd))!=identity(before):raise RuntimeError('source replaced before read')
        data=bytearray()
        while True:
            if time.monotonic()>=WORK:raise WorkDeadline('source bootstrap deadline')
            block=os.read(fd,min(65536,maximum-len(data)+1))
            if not block:break
            data.extend(block)
            if len(data)>maximum:raise RuntimeError('source grew')
        if identity(os.fstat(fd))!=identity(before) or identity(path.lstat())!=identity(before):raise RuntimeError('source changed')
        return bytes(data)
    finally:os.close(fd)


def load_bound(args):
    global BASE,BINDING,PHASE
    raw=bounded(PACKAGE/'BINDING.json',65536)
    if hashlib.sha256(raw).hexdigest()!=args.binding_sha256:raise RuntimeError('explicit source binding hash differs')
    binding=json.loads(raw)
    if binding.get('state')!='TEARDOWN-CANDIDATE-SOURCE-REVIEWED' or not isinstance(binding.get('a1_final_freeze_sha256'),str) or len(binding['a1_final_freeze_sha256'])!=64:
        raise RuntimeError('SOURCE-API-BOUND ONLY: final A1 frozen-source rebind/review required')
    final=binding['a1_final']
    if binding['a1_final_freeze_sha256']!=final['freeze']['sha256']:raise RuntimeError('final freeze reference mismatch')
    for name,key in (('FREEZE.json','freeze'),('source-manifest.json','source_manifest'),('PACKAGE-MANIFEST.json','package_manifest')):
        ref=final[key];data=bounded(ref['path'],2*1024*1024)
        if hashlib.sha256(data).hexdigest()!=ref['sha256']:raise RuntimeError('final A1 metadata changed: '+name)
    if final['observer']['path']!=str(Path(binding['a1_source_origin'])/'exec_observer.py'):
        raise RuntimeError('final A1 observer reference differs')
    if hashlib.sha256(bounded(final['observer']['path'],2*1024*1024)).hexdigest()!=final['observer']['sha256']:
        raise RuntimeError('final A1 observer source differs from retained bytes')
    for name in ('phase.py','safety.py','interfaces.py','profile2.py','exec_observer.py'):
        ref=binding['candidate_sources'][name]
        if (ref['sha256']!=binding['files'][name] or
                hashlib.sha256(bounded(ref['path'],2*1024*1024)).hexdigest()!=ref['sha256']):
            raise RuntimeError('reviewed teardown candidate differs: '+name)
    expected={'live_controls.py','outer_supervisor.py','guard_support.py','exec_observer.py','trace_fixture.py',
              'phase.py','safety.py','interfaces.py','profile2.py'}
    if set(binding.get('files',{}))!=expected:raise RuntimeError('exact source payload inventory required')
    sources={}
    for name,digest in binding['files'].items():
        source=bounded(PACKAGE/name,2*1024*1024)
        if hashlib.sha256(source).hexdigest()!=digest:raise RuntimeError('bound source bytes changed: '+name)
        sources[name]=source
    def module(name):
        result=types.ModuleType(name);result.__file__=str(PACKAGE/(name+'.py'))
        sys.modules[name]=result
        exec(compile(sources[name+'.py'],result.__file__,'exec'),result.__dict__)
        return result
    BASE=module('guard_support');observer=module('exec_observer')
    module('profile2');module('interfaces');module('safety');PHASE=module('phase')
    BINDING=binding
    return BASE,observer


def available():
    with open('/proc/meminfo','rb',buffering=0) as stream:data=stream.read(16384)
    return next(int(line.split()[1])*1024 for line in data.splitlines() if line.startswith(b'MemAvailable:'))


def subreaper():
    libc=ctypes.CDLL(None,use_errno=True);value=ctypes.c_int()
    if libc.prctl(36,1,0,0,0)!=0 or libc.prctl(37,ctypes.byref(value),0,0,0)!=0 or value.value!=1:
        raise RuntimeError('checked subreaper unavailable')


def audit_owner(s,clock):
    class AuditOwned(s.Owned):
        def __init__(self,clock):
            super().__init__(clock);self.invalid_observations=[];self.unbound_root_children=[];self.actual_waits=[]
        def reap(self):
            self.no_children=False
            while True:
                self.budget.check()
                try:event=os.waitid(os.P_ALL,0,os.WEXITED|os.WNOHANG|os.WNOWAIT)
                except ChildProcessError:self.no_children=True;return
                if event is None:return
                info=s.proc(event.si_pid,self.budget);matches=[]
                for key,entry in self.entries.items():
                    if info and key==(event.si_pid,info['start']):
                        try:
                            if self.exited(entry['fd']):matches.append(key)
                        except BaseException as error:
                            self.invalid_observations.append({'kind':'pidfd-readiness-error-before-consume','pid':event.si_pid,'start':key[1],'error':str(error)})
                if len(matches)!=1:self.invalid_observations.append({'kind':'unknown-before-consume','pid':event.si_pid,'info':info})
                pid,status=os.waitpid(event.si_pid,os.WNOHANG)
                s.require(pid==event.si_pid,'WNOWAIT terminal changed')
                record={'pid':pid,'start':info['start'] if info else None,'actual_exit_code':os.waitstatus_to_exitcode(status),'birth_pidfd_proved_before_consume':len(matches)==1}
                self.actual_waits.append(record)
                for child,key in self.roots:
                    if child.pid==pid:child.returncode=record['actual_exit_code']
                for key in matches:self.entries[key]['reaped']=True
        def signal_all(self,number):
            failures=[]
            for key,entry in self.entries.items():
                try:
                    self.budget.check()
                    if not self.exited(entry['fd']):signal.pidfd_send_signal(entry['fd'],number,None,0)
                except ProcessLookupError:pass
                except BaseException as error:failures.append({'key':list(key),'error':str(error)})
            if failures:
                self.invalid_observations.extend(failures)
                raise RuntimeError('owned signal failure; every bound FD attempted')
    result=AuditOwned(clock);OWNERS.append(result);return result


def budget(s,hook):
    b=s.Budget(TOTAL,time.time()+HARD-time.monotonic(),ROLE_RESERVE)
    b.hard_end=HARD;b.work_end=WORK;b.work_hook=hook
    return b


def process_hook(s,parent_pid,parent_start):
    def hook():
        parent=s.proc(parent_pid)
        s.require(os.getppid()==parent_pid and parent and parent['start']==parent_start and parent['state'] not in {'Z','X'},'actual direct parent lost')
        s.require(available()>=4*GIB,'memory below4GiB')
    return hook


def pipe():return os.pipe2(os.O_CLOEXEC|os.O_NONBLOCK)


def write_byte(fd,byte):
    if os.write(fd,byte)!=1:raise RuntimeError('short literal gate write')


def report(fd,value):
    data=(json.dumps(value,sort_keys=True)+'\n').encode()
    if len(data)>2048 or os.write(fd,data)!=len(data):raise RuntimeError('bounded atomic report write')


class Frames:
    def __init__(self,fd,nonce=None):self.fd=fd;self.buffer=b'';self.records=[];self.nonce=nonce
    def drain(self):
        try:
            while True:
                chunk=os.read(self.fd,4096)
                if not chunk:break
                self.buffer+=chunk
                if len(self.buffer)>16384:raise RuntimeError('report buffer cap')
        except BlockingIOError:pass
        while b'\n' in self.buffer:
            line,self.buffer=self.buffer.split(b'\n',1);value=json.loads(line)
            if self.nonce is not None and (value.get('nonce')!=self.nonce or value.get('schema')!='owned-exec-stop-fake-fixture-v1'):
                raise RuntimeError('fixture nonce/schema mismatch')
            self.records.append(value)
            if len(self.records)>32:raise RuntimeError('report count cap')
        return self.records


def spawn(owner,s,argv,pass_fds,environment,record):
    child=subprocess.Popen(argv,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,
        env=environment,close_fds=True,pass_fds=pass_fds,start_new_session=True)
    record.update(pid=child.pid,start=None,pidfd_bound=False)
    try:
        info=s.proc(child.pid,owner.budget);s.require(info and info['ppid']==os.getpid(),'owned child start unavailable')
        record['start']=info['start'];key=owner.bind(child.pid,info)
        s.require(key is not None,'owned child binding failed');record['pidfd_bound']=True
        owner.roots.append((child,key));return child,key
    except BaseException:
        owner.unbound_root_children.append(dict(record));raise


def until(clock,callback,predicate,seconds=4):
    end=min(WORK,time.monotonic()+seconds)
    while time.monotonic()<end:
        clock.check();callback()
        if predicate():return
        time.sleep(.005)
    raise TimeoutError('bounded own-control observation did not arrive')


def cleanup(owner,s,clock):
    clock.enter_final();signal.setitimer(signal.ITIMER_REAL,max(.001,HARD-time.monotonic()))
    errors=[];until_time=min(HARD-.15,time.monotonic()+1)
    while time.monotonic()<until_time:
        for action in (owner.discover,lambda:owner.signal_all(signal.SIGKILL),owner.reap):
            try:action()
            except BaseException as error:errors.append(type(error).__name__+': '+str(error))
        if owner.no_children and all(owner.exited(e['fd']) for e in owner.entries.values()):break
        time.sleep(.005)
    snapshot=owner.snapshot()
    snapshot.update(invalid_observations=owner.invalid_observations,unbound_root_children=owner.unbound_root_children,actual_waits=owner.actual_waits,cleanup_errors=errors)
    snapshot['cleanup_complete']=snapshot['cleanup_complete'] and not errors and not owner.invalid_observations and not owner.unbound_root_children
    return snapshot


def fixture_command(python,mode,gate,report_fd,hold,nonce,expiry,scenario='normal'):
    return [python,'-B',str(PACKAGE/'trace_fixture.py'),mode,'--gate-fd',str(gate),'--report-fd',str(report_fd),
        '--hold-fd',str(hold),'--nonce',nonce,'--absolute-expiry-epoch',str(expiry),'--python',python,
        '--scenario',scenario]


def qualify_python(s,clock):
    path=Path(sys.executable).resolve()
    fd,parent,leaf,info=s.checked_source(path.parent,path.name,clock)
    try:
        digest=s.digest_fd(fd,64*1024*1024,clock)
        s.require(s.identity(os.fstat(fd))==s.identity(info)==s.identity(os.stat(leaf,dir_fd=parent,follow_symlinks=False)),'Python qualified FD changed')
        s.require(stat.S_ISREG(info.st_mode) and info.st_mode & 0o111,'qualified regular executable Python required')
        return str(path),{'device':info.st_dev,'inode':info.st_ino,'bytes':info.st_size,'sha256':digest}
    finally:os.close(fd);os.close(parent)



def postdump_metadata(s,clock,key,pidfd,expected_argv):
    """The same postconfine API families used by final A1, with control CPU0/nice19."""
    pid,start=key
    before=s.proc(pid,clock)
    s.require(before and before['start']==start and not s.Owned.exited(pidfd),'postdump process birth unavailable')
    raw=s.read_path('/proc/'+str(pid)+'/cmdline',65536,clock)
    argv=[v.decode('utf-8','strict') for v in raw.split(b'\0') if v]
    s.require(argv==expected_argv,'postdump full cmdline differs')
    names=sorted(os.listdir('/proc/'+str(pid)+'/task'))
    s.require(0<len(names)<=512 and all(name.isdigit() for name in names),'bounded actual task set required')
    tasks=[]
    def task(tid):
        stat_bytes=s.read_path('/proc/'+str(pid)+'/task/'+str(tid)+'/stat',4096,clock)
        fields=stat_bytes.rsplit(b') ',1)[1].split()
        status=s.read_path('/proc/'+str(pid)+'/task/'+str(tid)+'/status',16384,clock)
        tgid=[line for line in status.splitlines() if line.startswith(b'Tgid:')]
        s.require(len(tgid)==1 and int(tgid[0].split()[1])==pid,'postdump task TGID differs')
        return {'tid':tid,'start':fields[19].decode('ascii'),'tgid':pid}
    for name in names:
        clock.check();tid=int(name);first=task(tid)
        mask=sorted(os.sched_getaffinity(tid));priority=os.getpriority(os.PRIO_PROCESS,tid)
        after=task(tid)
        s.require(first==after and mask==[0] and priority==19,'postdump task birth/actual control CPU/nice differs')
        tasks.append({**first,'cpus':mask,'nice':priority,'birth_tgid_bracketed':True})
    after=s.proc(pid,clock)
    s.require(after and after['start']==start and after['ppid']==before['ppid']
              and not s.Owned.exited(pidfd) and tasks,'postdump process ended across metadata observation')
    return {'actual_cmdline':argv,'tasks':tasks,'process_pid':pid,'process_start':start,
            'process_pidfd_live_before_after':True,'actual_control_cpus':[0],'actual_control_nice':19,
            'model_cpu_values_not_claimed':True}


def worker(args,s,module):
    clock=budget(s,process_hook(s,args.parent_pid,args.parent_start));clock.check();subreaper()
    s.require(available()>=8*GIB,'fresh worker admission below8GiB')
    s.require(os.read(args.launch_gate_fd,1)==b'W','controller bind gate not released')
    os.close(args.launch_gate_fd)
    owner=audit_owner(s,clock);observer=None;fds=[];case_result={'case':args.worker,'status':'failed'}
    child=None;root_record={};expected_failure=False
    try:
        python,qualified=qualify_python(s,clock)
        gate_r,gate_w=pipe();read_r,read_w=pipe();hold_r,hold_w=pipe();fds=[gate_r,gate_w,read_r,read_w,hold_r,hold_w]
        # Fixture blocking read gates; report reader remains nonblocking for bounded dispatcher.
        os.set_blocking(gate_r,True);os.set_blocking(hold_r,True);os.set_blocking(read_w,True)
        nonce=args.nonce;expiry=min(args.case_expiry_epoch,time.time()+14)
        scenario='kill-wait' if args.worker==CASES[3] else 'orphan' if args.worker==CASES[4] else 'normal'
        command=fixture_command(python,'gated',gate_r,read_w,hold_r,nonce,expiry,scenario)
        child,key=spawn(owner,s,command,(gate_r,read_w,hold_r),{'PATH':'/usr/bin:/bin','LANG':'C.UTF-8','LC_ALL':'C.UTF-8','PYTHONDONTWRITEBYTECODE':'1'},root_record)
        for fd in (gate_r,read_w,hold_r):os.close(fd);fds.remove(fd)
        frames=Frames(read_r,nonce)
        until(clock,frames.drain,lambda:any(f['event']=='gated-ready' for f in frames.records))
        caps=module.status_fields(s.read_path('/proc/'+str(os.getpid())+'/status',16384,clock))
        s.require(not int(caps[b'CapEff'],16)&(1<<19),'must actually lack CAP_SYS_PTRACE')
        approval={'harness':dict(qualified),'helper':dict(qualified)}
        if args.worker==CASES[1]:approval['helper']['sha256']='0'*64
        expected_argv={'harness':fixture_command(python,'harness',command[command.index('--gate-fd')+1],command[command.index('--report-fd')+1],command[command.index('--hold-fd')+1],nonce,expiry,scenario),
                       'helper':fixture_command(python,'confined',command[command.index('--gate-fd')+1],command[command.index('--report-fd')+1],command[command.index('--hold-fd')+1],nonce,expiry,scenario)}
        def authority(role,record):
            s.require(role in expected_argv and record['actual_argv']==expected_argv[role],'FAKE Authority fixed fullargv mismatch')
            s.require(record['ptrace_event']==module.EXEC and record['kernel_exec_stop_before_userspace'] is True,'true exec stop proof required')
        observer=module.ExecObserver(owner,clock,s,approval,key,lambda pid,name:s.read_path('/proc/'+str(pid)+'/'+name,65536,clock),on_exec=authority)
        observer.seize(child,key)
        case_result.update(seize_before_gate=observer.seized,observer_cap_sys_ptrace_absent=True,observer_cap_eff=caps[b'CapEff'].decode(),no_application_or_privilege_changes=True)
        if args.worker==CASES[2]:
            report(args.ready_fd,{'event':'tracer-seized-gated-root','root':root_record,'options':module.OPTIONS,'nonce':nonce})
            # Controller will kill this actual tracer pidfd; never opens G or detaches root.
            until(clock,lambda:observer.drain(),lambda:False,seconds=4)
        write_byte(gate_w,b'G')
        def tick():observer.drain();frames.drain()
        if args.worker==CASES[1]:
            try:
                until(clock,tick,lambda:False)
            except s.Refusal as error:
                s.require(str(error)=='kernel EXEC fd bytes not qualified','wrong-hash expected precise DUT refusal')
                expected_failure=True;case_result['expected_dut_refusal']=str(error)
            frames.drain()
            s.require(expected_failure and not any(f['event']=='confined-userspace-dumpable0' for f in frames.records),'wrong hash reached confined userspace')
        else:
            until(clock,tick,lambda:any(f['event']=='confined-userspace-dumpable0' for f in frames.records))
            ready=next(f for f in frames.records if f['event']=='confined-userspace-dumpable0')
            ident=ready['identity'];helper_key=(ident['pid'],ident['start'])
            s.require(ready.get('dumpable')==0 and type(ready.get('dumpable')) is int and ready.get('main_reached') is True,'actual dump0 userspace ACK required')
            record=observer.record(helper_key);actual=s.proc(helper_key[0],clock)
            s.require(actual and actual['start']==helper_key[1] and actual['ppid']==key[0] and not owner.exited(owner.entries[helper_key]['fd']),'confined child lost exact live birth')
            metadata=postdump_metadata(s,clock,helper_key,owner.entries[helper_key]['fd'],record['actual_argv'])
            try:
                denied=os.open('/proc/'+str(helper_key[0])+'/exe',os.O_RDONLY|os.O_CLOEXEC)
            except OSError as error:
                s.require(error.errno in (errno.EACCES,errno.EPERM),'new proc open failed for wrong reason')
                case_result['later_proc_denial_errno']=error.errno
            else:
                os.close(denied);raise RuntimeError('postdump proc exe unexpectedly readable')
            fd=observer.exe_fds[helper_key];os.lseek(fd,0,os.SEEK_SET)
            s.require(s.digest_fd(fd,64*1024*1024,clock)==qualified['sha256'],'retained actual EXEC FD hash changed after denial')
            workers=[f for f in frames.records if f['event']=='worker-thread-userspace']
            s.require(len(workers)==1 and workers[0]['spawn_tid']!=key[0]
                and any(e['kind']=='kernel-new-tracee' and e.get('event')==module.CLONE
                        and e.get('child_tid')==workers[0]['spawn_tid'] for e in observer.events),
                'actual nonleader worker CLONE/thread-pidfd registration absent')
            observer.record(helper_key)
            if scenario=='normal':
                write_byte(hold_w,b'R')
                until(clock,tick,lambda:child.returncode is not None and owner.no_children)
                s.require(child.returncode==0 and any(f['event']=='fixture-child-terminal-wait' and type(f.get('actual_exit_code')) is int and f['actual_exit_code']==0 for f in frames.records),'actual fixture parent wait0/root0 missing')
            else:
                helper_fd=owner.entries[helper_key]['fd']
                PHASE.observe_helper_argv(helper_key[0],helper_key[1],helper_fd,record['actual_argv'],clock)
                # This tiny fixture intentionally uses CPU0/nice19. The exact
                # model task observer must still reject those live constraints.
                for expected_cpus in ((1,2,3,4),(1,2,4)):
                    try:
                        PHASE.observe_tasks(helper_key[0],helper_key[1],helper_fd,clock,expected_cpus)
                    except PHASE.Refusal as error:
                        s.require(str(error)=='actual helper task CPU/nice differs','live task refusal differs')
                        label=','.join(map(str,expected_cpus))
                        case_result.setdefault('exact_phase_live_task_masks_refused',{})[label]=True
                    else:
                        raise RuntimeError('exact phase accepted wrong live task constraints')
                case_result['exact_phase_live_task_constraints_refused']=True
                write_byte(hold_w,b'K' if scenario=='kill-wait' else b'O')
                if scenario=='orphan':
                    def adopted():
                        current=s.proc(helper_key[0],clock)
                        return child.returncode==0 and current is not None and current['start']==helper_key[1] and current['ppid']==os.getpid()
                    until(clock,tick,adopted)
                    signal.pidfd_send_signal(helper_fd,signal.SIGKILL,None,0)
                # Keep dispatching ptrace stops while the fixture parent performs
                # its real kill/wait; do not stall that parent inside our probe.
                until(clock,tick,lambda:owner.exited(helper_fd))
                try:
                    PHASE.await_bound_exit(helper_key[0],helper_key[1],helper_fd,clock)
                except PHASE.InstanceExited:
                    case_result['exact_phase_bound_exit_proved']=True
                else:
                    raise RuntimeError('exact phase exit observer did not prove exit')
                try:
                    PHASE.observe_helper_argv(helper_key[0],helper_key[1],helper_fd,record['actual_argv'],clock)
                except PHASE.InstanceExited:
                    case_result['exact_phase_argv_after_exit_proved']=True
                else:
                    raise RuntimeError('exact phase argv observer accepted exited process')
                until(clock,tick,lambda:child.returncode is not None and owner.no_children)
                s.require(child.returncode==0,'actual fixture harness exit0 missing')
                # The actual parent/observer has reaped this bound helper. Its
                # missing task directory must now resolve through the same FD.
                for expected_cpus in ((1,2,3,4),(1,2,4)):
                    try:
                        PHASE.observe_tasks(helper_key[0],helper_key[1],helper_fd,clock,expected_cpus)
                    except PHASE.InstanceExited:
                        label=','.join(map(str,expected_cpus))
                        case_result.setdefault('exact_phase_reaped_task_masks_exit',{})[label]=True
                    else:
                        raise RuntimeError('exact phase task observer accepted reaped helper')
                case_result['exact_phase_tasks_after_reap_exit_proved']=True
                if scenario=='kill-wait':
                    s.require(any(f['event']=='fixture-child-terminal-wait' and f.get('child_pid')==helper_key[0] and f.get('actual_exit_code')==-signal.SIGKILL for f in frames.records),'actual harness helper SIGKILL wait missing')
                    case_result['normal_parent_waited_helper_sigkill']=True
                else:
                    events=[e for e in observer.events if e['kind']=='adopted-helper-terminal-kernel-wait' and e.get('tid')==helper_key[0] and e.get('start')==helper_key[1]]
                    s.require(len(events)==1 and events[0]['exit']==-signal.SIGKILL and events[0]['preconsume_direct_child_birth_verified'] is True,'actual adopted helper preconsume signal proof missing')
                    case_result['adopted_helper_wait']=events[0]
            case_result.update(actual_kernel_exec=record,retained_fd_hash_after_denial=True,root_actual_exit_code=child.returncode,actual_thread_clone=True,actual_worker_tid=workers[0]['spawn_tid'],actual_thread_pidfd_required_by_captured_observer=True,post_dump_metadata_and_affinity=metadata,dumpable0_acknowledged=True,helper_detached_before_userspace=any(e['kind']=='helper-detached-before-userspace' and e.get('pid')==helper_key[0] for e in observer.events))
        case_result.update(frames=frames.records,observer=observer.snapshot(),expected_dut_failure=expected_failure)
        case_result['status']='passed'
    except BaseException as error:
        case_result.update(status='failed',error=type(error).__name__+': '+str(error))
    finally:
        snapshot=cleanup(owner,s,clock)
        case_result['cleanup']=snapshot
        if not snapshot['cleanup_complete']:case_result['status']='failed'
        if observer is not None:observer.close()
        for fd in fds:
            try:os.close(fd)
            except OSError:pass
        if time.monotonic()<HARD:
            s.immutable_json(args.result,case_result,clock)
        owner.close()
    return 0 if case_result['status']=='passed' else 1


def controller(args,s):
    clock=budget(s,process_hook(s,args.parent_pid,args.parent_start));clock.check();subreaper()
    os.set_blocking(args.launch_gate_fd,True)
    s.require(os.read(args.launch_gate_fd,1)==b'G','outer pidfd bind gate missing')
    os.close(args.launch_gate_fd)
    owner=audit_owner(s,clock);outcomes=[];fds=[];summary={'schema':'owned-exec-stop-five-controls-v1','status':'failed'}
    try:
        s.require(available()>=8*GIB,'fresh controller admission below8GiB')
        for index,name in enumerate(CASES):
            clock.check();s.require(clock.phase=='work','no new case after cleanup')
            s.require(available()>=8*GIB and clock.remaining()>=6,'fresh8GiB and full case budget required')
            nonce=('ownedexec'+str(index)+'0'*20)
            gate_r,gate_w=pipe();ready_r,ready_w=pipe();fds.extend((gate_r,gate_w,ready_r,ready_w))
            os.set_blocking(gate_r,True);os.set_blocking(ready_w,True)
            result=args.window/('case-'+str(index)+'.json')
            case_expiry=min(args.absolute_expiry_epoch-RESERVE,time.time()+6)
            parent=s.proc(os.getpid(),clock)
            command=[sys.executable,'-B',str(PACKAGE/'live_controls.py'),'--worker',name,
                '--absolute-expiry-epoch',str(args.absolute_expiry_epoch),'--case-expiry-epoch',str(case_expiry),
                '--binding-sha256',args.binding_sha256,'--explicit-grant',GRANT,'--launch-gate-fd',str(gate_r),
                '--ready-fd',str(ready_w),'--nonce',nonce,'--parent-pid',str(os.getpid()),'--parent-start',parent['start'],
                '--window',str(args.window),'--result',str(result)]
            record={};child,key=spawn(owner,s,command,(gate_r,ready_w),{'PATH':'/usr/bin:/bin','LANG':'C.UTF-8','LC_ALL':'C.UTF-8','PYTHONDONTWRITEBYTECODE':'1'},record)
            for fd in (gate_r,ready_w):os.close(fd);fds.remove(fd)
            write_byte(gate_w,b'W');messages=Frames(ready_r)
            if name!=CASES[2]:
                def tick():owner.discover();owner.reap()
                until(clock,tick,lambda:child.returncode is not None,seconds=7)
                s.require(child.returncode==0,'actual worker exit0 required before next case')
                value=s.committed_json(result,clock,maximum=32768)
                s.require(value.get('case')==name and value.get('status')=='passed' and value.get('cleanup',{}).get('cleanup_complete') is True,'actual passing case/cleanup receipt required')
                value['actual_tracer_worker_exit_code']=child.returncode
                outcomes.append(value)
            else:
                # Controller-owned sibling is outside the tracer ancestry and never seized.
                sibling_r,sibling_w=pipe();sr,sw=pipe();fds.extend((sibling_r,sibling_w,sr,sw))
                os.set_blocking(sibling_r,True);os.set_blocking(sw,True)
                python,_=qualify_python(s,clock);sibling_record={}
                sibling_command=fixture_command(python,'sibling',sibling_r,sw,sibling_r,nonce+'S',min(time.time()+10,args.absolute_expiry_epoch))
                sibling,sibling_key=spawn(owner,s,sibling_command,(sibling_r,sw),{'PATH':'/usr/bin:/bin','LANG':'C.UTF-8','LC_ALL':'C.UTF-8','PYTHONDONTWRITEBYTECODE':'1'},sibling_record)
                for fd in (sibling_r,sw):os.close(fd);fds.remove(fd)
                sibling_frames=Frames(sr,nonce+'S')
                until(clock,sibling_frames.drain,lambda:any(f['event']=='untraced-sibling-ready' for f in sibling_frames.records))
                until(clock,messages.drain,lambda:any(m.get('event')=='tracer-seized-gated-root' for m in messages.records))
                ready=next(m for m in messages.records if m.get('event')=='tracer-seized-gated-root')
                s.require(ready.get('nonce')==nonce and ready.get('options')==2|4|8|16|0x00100000,'actual seize/EXITKILL ready evidence differs')
                root=ready['root'];info=s.proc(root['pid'],clock)
                s.require(info and info['start']==root['start'] and info['ppid']==child.pid,'gated tracee ancestry changed before outer binding')
                fixture_key=owner.bind(root['pid'],info);s.require(fixture_key is not None,'gated tracee independent pidfd binding failed')
                s.require(not owner.exited(owner.entries[sibling_key]['fd']),'untraced sibling not live before tracer death')
                # Only tracer is signaled. Kernel EXITKILL must account for tracee death.
                signal.pidfd_send_signal(owner.entries[key]['fd'],signal.SIGKILL,None,0)
                def death_tick():owner.reap()
                until(clock,death_tick,lambda:child.returncode is not None and any(w['pid']==fixture_key[0] and w['start']==fixture_key[1] for w in owner.actual_waits),seconds=.75)
                fixture_wait=next(w for w in owner.actual_waits if w['pid']==fixture_key[0] and w['start']==fixture_key[1])
                s.require(child.returncode==-signal.SIGKILL and fixture_wait['actual_exit_code']==-signal.SIGKILL and fixture_wait['birth_pidfd_proved_before_consume'] is True,'actual EXITKILL signal deaths/reap proof missing')
                current=s.proc(sibling_key[0],clock)
                s.require(current and current['start']==sibling_key[1] and not owner.exited(owner.entries[sibling_key]['fd']),'untraced sibling failed survival')
                write_byte(sibling_w,b'R')
                until(clock,lambda:(sibling_frames.drain(),owner.reap()),lambda:sibling.returncode is not None)
                s.require(sibling.returncode==0,'sibling explicit release/wait0 missing')
                outcomes.append({'case':name,'status':'passed','tracer_actual_exit_code':child.returncode,'fixture_actual_wait':fixture_wait,'fixture_pidfd_bound_before_tracer_death':True,'only_tracer_signaled_for_exitkill_observation':True,'untraced_sibling_survived':True,'sibling_actual_exit_code':sibling.returncode,'cleanup':{'cleanup_complete':True},'ready':ready})
            s.require(not owner.invalid_observations and not owner.unbound_root_children,'no next case after ambiguous wait/binding')
        positive=outcomes[0]
        checks={'seize_before_gate':positive['seize_before_gate'] is True,
            'fork_from_nonleader_thread':positive['actual_thread_clone'] is True,
            'pidfd_thread_supported':positive['actual_thread_pidfd_required_by_captured_observer'] is True,
            'actual_exec_fd_hash':positive['actual_kernel_exec']['hash_read_from_kernel_exe_fd'] is True,
            'dumpable0_acknowledged':positive['dumpable0_acknowledged'] is True,
            'retained_fd_after_dumpable0':positive['retained_fd_hash_after_denial'] is True,
            'post_dump_metadata_and_affinity':bool(positive['post_dump_metadata_and_affinity']['tasks']),
            'actual_normal_exits':positive['root_actual_exit_code']==0 and positive['actual_tracer_worker_exit_code']==0 and outcomes[2]['sibling_actual_exit_code']==0,
            'owned_kernel_cleanup':all(c['cleanup']['cleanup_complete'] is True for c in outcomes),
            'no_application_or_privilege_changes':positive['no_application_or_privilege_changes'] is True and positive['observer_cap_sys_ptrace_absent'] is True}
        s.require(all(checks.values()) and positive['helper_detached_before_userspace'] is True,'all final A1 observer qualification checks required')
        summary['qualification_checks']=checks
        teardown={'normal_parent_waited_helper_sigkill':outcomes[3].get('normal_parent_waited_helper_sigkill') is True,
            'adopted_helper_preconsume_signal_proof':outcomes[4].get('adopted_helper_wait',{}).get('preconsume_direct_child_birth_verified') is True,
            'exact_phase_bound_exit_and_argv':all(c.get('exact_phase_bound_exit_proved') is True and c.get('exact_phase_argv_after_exit_proved') is True for c in outcomes[3:]),
            'exact_phase_live_task_constraints_refused':all(c.get('exact_phase_live_task_constraints_refused') is True and c.get('exact_phase_live_task_masks_refused')=={'1,2,3,4':True,'1,2,4':True} for c in outcomes[3:]),
            'exact_phase_tasks_after_reap_exit':all(c.get('exact_phase_tasks_after_reap_exit_proved') is True and c.get('exact_phase_reaped_task_masks_exit')=={'1,2,3,4':True,'1,2,4':True} for c in outcomes[3:])}
        s.require(all(teardown.values()),'all actual teardown checks required')
        summary['teardown_checks']=teardown
        summary['task_expected_masks_tested']=[[1,2,3,4],[1,2,4]]
        summary['positive_cpu124_qualification']=False
        summary.update(status='passed',control_names=list(CASES),control_count=len(CASES),cases=outcomes,source_binding_sha256=args.binding_sha256,observer_sha256=BINDING['files']['exec_observer.py'],phase_sha256=BINDING['files']['phase.py'],source_api_bound_only=False)
    except BaseException as error:
        summary.update(status='failed',error=type(error).__name__+': '+str(error),cases=outcomes)
    finally:
        snapshot=cleanup(owner,s,clock);summary['cleanup']=snapshot
        if not snapshot['cleanup_complete']:summary['status']='failed'
        for fd in fds:
            try:os.close(fd)
            except OSError:pass
        if time.monotonic()<HARD:s.immutable_json(args.result,summary,clock)
        owner.close()
    return 0 if summary['status']=='passed' else 1


def cli():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--explicit-grant',required=True);parser.add_argument('--binding-sha256',required=True)
    parser.add_argument('--absolute-expiry-epoch',type=float,required=True);parser.add_argument('--window',type=Path,required=True)
    parser.add_argument('--parent-pid',type=int,required=True);parser.add_argument('--parent-start',required=True)
    parser.add_argument('--launch-gate-fd',type=int,required=True);parser.add_argument('--result',type=Path,required=True)
    parser.add_argument('--worker',choices=CASES);parser.add_argument('--ready-fd',type=int)
    parser.add_argument('--nonce');parser.add_argument('--case-expiry-epoch',type=float)
    args=parser.parse_args()
    if args.explicit_grant!=GRANT:raise SystemExit('explicit reviewed tiny-control grant required')
    try:
        arm(args,worker=bool(args.worker));s,module=load_bound(args)
        return worker(args,s,module) if args.worker else controller(args,s)
    except BaseException:
        kill_bound()
        return 124
    finally:
        signal.setitimer(signal.ITIMER_REAL,0)


if __name__=='__main__':raise SystemExit(cli())
