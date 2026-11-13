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
CASES=('A-positive','B-positive','wrong-helper-hash','wrong-helper-argv','second-helper')
GRANT='root-reviewed-v13-helper-affinity-fixture-five-controls-only'
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
    os.sched_setaffinity(0,{0});
    if os.getpriority(os.PRIO_PROCESS,0)!=0:raise RuntimeError('bootstrap must inherit nice0 before child spawn')
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
    if binding.get('state')!='V13-HELPER-AFFINITY-FIXTURE-SOURCE-REVIEWED' or not isinstance(binding.get('a1_final_freeze_sha256'),str) or len(binding['a1_final_freeze_sha256'])!=64:
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
    for name in ('phase.py','safety.py','interfaces.py','profile2.py','exec_observer.py','helper_affinity.py'):
        ref=binding['candidate_sources'][name]
        if (ref['sha256']!=binding['files'][name] or
                hashlib.sha256(bounded(ref['path'],2*1024*1024)).hexdigest()!=ref['sha256']):
            raise RuntimeError('reviewed teardown candidate differs: '+name)
    expected={'live_controls.py','outer_supervisor.py','guard_support.py','exec_observer.py','trace_fixture.py',
              'phase.py','safety.py','interfaces.py','profile2.py','helper_affinity.py'}
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
    module('profile2');module('helper_affinity');module('interfaces');module('safety');PHASE=module('phase')
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
    return [python,'-I','-B',str(PACKAGE/'trace_fixture.py'),mode,'--gate-fd',str(gate),'--report-fd',str(report_fd),
        '--hold-fd',str(hold),'--nonce',nonce,'--absolute-expiry-epoch',str(expiry),'--python',python,
        '--scenario',scenario,'--threads','2' if scenario=='wrong-argv' and mode=='confined' else '3']


def qualify_python(s,clock):
    path=Path(sys.executable).resolve()
    fd,parent,leaf,info=s.checked_source(path.parent,path.name,clock)
    try:
        digest=s.digest_fd(fd,64*1024*1024,clock)
        s.require(s.identity(os.fstat(fd))==s.identity(info)==s.identity(os.stat(leaf,dir_fd=parent,follow_symlinks=False)),'Python qualified FD changed')
        s.require(stat.S_ISREG(info.st_mode) and info.st_mode & 0o111,'qualified regular executable Python required')
        return str(path),{'device':info.st_dev,'inode':info.st_ino,'bytes':info.st_size,'sha256':digest}
    finally:os.close(fd);os.close(parent)



def fixture_grant(name):
    profile=sys.modules['profile2']
    leg='A1' if name=='A-positive' else 'B1'
    return {'schema':profile.GRANT_SCHEMA,'purpose':profile.PURPOSE,'stage':'P2',
        'affinity_scope':profile.SCOPE,'helper_affinity_at_exec_authorized':True,
        'profile_leg':leg,'threads':3,'nice':10,'bootstrap_harness_cpus':[1,2,3,4],
        'workload_helper_cpus':profile.MASKS[leg],'cpus':profile.MASKS[leg]}


def worker(args,s,module):
    clock=budget(s,process_hook(s,args.parent_pid,args.parent_start));subreaper()
    os.set_blocking(args.launch_gate_fd,True)
    s.require(os.read(args.launch_gate_fd,1)==b'W','controller binding gate absent')
    os.close(args.launch_gate_fd)
    owner=audit_owner(s,clock);observer=None;fds=[];value={'case':args.worker,'status':'failed'}
    try:
        s.require(available()>=8*GIB,'fresh worker memory below8GiB')
        caps=module.status_fields(s.read_path('/proc/'+str(os.getpid())+'/status',16384,clock))
        s.require(not int(caps[b'CapEff'],16)&((1<<19)|(1<<23)),'tiny requires no CAP_SYS_PTRACE/CAP_SYS_NICE')
        value['cap_eff']=caps[b'CapEff'].decode()
        python,qualified=qualify_python(s,clock)
        gate_r,gate_w=pipe();read_r,read_w=pipe();hold_r,hold_w=pipe()
        fds=[gate_r,gate_w,read_r,read_w,hold_r,hold_w]
        for fd in (gate_r,read_w,hold_r):os.set_blocking(fd,True)
        scenario='wrong-argv' if args.worker=='wrong-helper-argv' else 'wrong-hash' if args.worker=='wrong-helper-hash' else 'second' if args.worker=='second-helper' else 'normal'
        expiry=min(args.case_expiry_epoch,time.time()+14)
        command=fixture_command(python,'gated',gate_r,read_w,hold_r,args.nonce,expiry,scenario)
        child,key=spawn(owner,s,command,(gate_r,read_w,hold_r),{'PATH':'/usr/bin:/bin','LANG':'C.UTF-8','LC_ALL':'C.UTF-8','PYTHONDONTWRITEBYTECODE':'1'}, {})
        # H inherits nice0 and independently demotes itself to10 before its gate.
        # G only demotes after H has been spawned; no19->10 operation exists.
        os.setpriority(os.PRIO_PROCESS,0,19)
        for fd in (gate_r,read_w,hold_r):os.close(fd);fds.remove(fd)
        frames=Frames(read_r,args.nonce)
        until(clock,frames.drain,lambda:any(f['event']=='gated-ready' for f in frames.records))
        s.require(sorted(os.sched_getaffinity(0))==[0] and os.getpriority(os.PRIO_PROCESS,0)==19,'G placement differs')
        approval={'harness':dict(qualified),'helper':dict(qualified)}
        if args.worker=='wrong-helper-hash':approval['helper']['sha256']='0'*64
        expected={role:fixture_command(python,mode,gate_r,read_w,hold_r,args.nonce,expiry,scenario)
                  for role,mode in [('harness','harness'),('helper','confined')]}
        # Wrong-argv fixture executes literal2, while adapter admission stays literal3.
        if args.worker=='wrong-helper-argv':expected['helper'][-1]='3'
        affinity=sys.modules['helper_affinity'];grant=fixture_grant(args.worker)
        def validate(role,record):
            s.require(record['actual_argv']==expected[role],'fixture full actual argv mismatch')
            s.require(record['kernel_exec_stop_before_userspace'] is True and record['ptrace_event']==module.EXEC,'fixture actual EXEC required')
            s.require(sorted(os.sched_getaffinity(record['pid']))==[1,2,3,4] and os.getpriority(os.PRIO_PROCESS,record['pid'])==10,'fixture bootstrap placement differs')
            if role=='helper':affinity.apply_at_exec(observer,record,grant,clock)
        observer=module.ExecObserver(owner,clock,s,approval,key,lambda pid,name:s.read_path('/proc/'+str(pid)+'/'+name,65536,clock),on_exec=validate)
        observer.seize(child,key);write_byte(gate_w,b'G')
        def tick():observer.drain();frames.drain()
        negative=args.worker not in ('A-positive','B-positive')
        if negative:
            messages={'wrong-helper-hash':'kernel EXEC fd bytes not qualified','wrong-helper-argv':'fixture full actual argv mismatch','second-helper':'second helper affinity transition refused'}
            try:until(clock,tick,lambda:False)
            except s.Refusal as error:
                s.require(str(error)==messages[args.worker],'unexpected negative refusal')
                value['actual_expected_refusal']=str(error)
            else:raise RuntimeError('negative did not refuse')
            frames.drain()
            refused=[t for t in observer.tracees.values() if t.get('stopped_status') is not None and t['key']!=key]
            s.require(refused,'refusal lacks stopped helper')
            refused_pids={t['key'][0] for t in refused}
            s.require(not any(f['event']=='confined-userspace-dumpable0' and f['identity']['pid'] in refused_pids for f in frames.records),'refused helper reached fixture userspace')
            value['refused_helper_pids']=sorted(refused_pids)
            transitions=[e for e in observer.events if e['kind']=='helper-affinity-at-exec-stop']
            s.require(len(transitions)==(1 if args.worker=='second-helper' else 0),'negative callback/setter count differs')
            value['actual_transition_count']=len(transitions)
            # Kill only the authenticated refused EXEC instance; keep H alive so
            # its genuine parent waits consume those deaths before normal H exit.
            for tracee in refused:
                bound=owner.entries[tracee['key']]
                s.require(not owner.exited(bound['fd']),'denied helper unexpectedly exited')
                signal.pidfd_send_signal(bound['fd'],signal.SIGKILL,None,0)
            if args.worker=='second-helper':write_byte(hold_w,b'R')
            until(clock,tick,lambda:child.returncode is not None and owner.no_children)
            terminal=[f for f in frames.records if f['event']=='fixture-child-terminal-wait']
            expected_codes=[-signal.SIGKILL,0] if args.worker=='second-helper' else [-signal.SIGKILL]
            s.require(child.returncode==0 and sorted(f['actual_exit_code'] for f in terminal)==expected_codes,'negative H must wait all children then exit0')
            value['actual_harness_exit_code']=child.returncode
            value['actual_parent_waits']=terminal

        else:
            until(clock,tick,lambda:any(f['event']=='confined-userspace-dumpable0' for f in frames.records))
            ready=next(f for f in frames.records if f['event']=='confined-userspace-dumpable0')
            helper_key=(ready['identity']['pid'],ready['identity']['start']);record=observer.record(helper_key)
            selected=grant['workload_helper_cpus'];entry=owner.entries[helper_key]
            ht=PHASE.observe_tasks(key[0],key[1],owner.entries[key]['fd'],clock,[1,2,3,4])
            tasks=PHASE.observe_tasks(helper_key[0],helper_key[1],entry['fd'],clock,selected)
            workers=[f for f in frames.records if f['event']=='helper-worker-ready']
            s.require(len(workers)==3 and len({f['tid'] for f in workers})==3 and len(tasks)==4,'three held inherited helper workers required')
            s.require(all(f['cpus']==selected and f['nice']==10 for f in workers) and ready['fixture_main_cpus']==selected and ready['nice']==10,'fixture inherited placement differs')
            s.require({f['tid'] for f in workers}<={t['tid'] for t in tasks},'actual helper task observations differ')
            value.update(actual_kernel_exec=record,helper_tasks=tasks,harness_tasks=ht,worker_frames=workers,fixture_main=ready,controller_cpus=[0],controller_nice=19)
            write_byte(hold_w,b'R')
            until(clock,tick,lambda:child.returncode is not None and owner.no_children)
            s.require(child.returncode==0 and any(f['event']=='fixture-child-terminal-wait' and type(f.get('actual_exit_code')) is int and f['actual_exit_code']==0 for f in frames.records),'normal H/helper exits missing')
            value['actual_harness_exit_code']=child.returncode
            s.require(sum(e['kind']=='helper-affinity-at-exec-stop' for e in observer.events)==1,'positive must use one setter')
        value.update(status='passed',frames=frames.records,observer=observer.snapshot(),fixture_argv_scope_only=True,full_production_argv_callback_executed=False,source_binding_sha256=args.binding_sha256)
    except BaseException as error:value.update(status='failed',error=type(error).__name__+': '+str(error))
    finally:
        value['cleanup']=cleanup(owner,s,clock)
        if not value['cleanup']['cleanup_complete']:value['status']='failed'
        if observer is not None:observer.close()
        for fd in fds:
            try:os.close(fd)
            except OSError:pass
        if time.monotonic()<HARD:s.immutable_json(args.result,value,clock)
        owner.close()
    return 0 if value['status']=='passed' else 1


def controller(args,s):
    clock=budget(s,process_hook(s,args.parent_pid,args.parent_start));subreaper()
    os.set_blocking(args.launch_gate_fd,True);s.require(os.read(args.launch_gate_fd,1)==b'G','outer binding gate absent');os.close(args.launch_gate_fd)
    owner=audit_owner(s,clock);pending=[];fds=[];outcomes=[];summary={'schema':'v13-helper-affinity-fixture-controls-v1','status':'failed'}
    try:
        # All case Gs inherit nice0 before C demotes. Each blocks before any H spawn.
        for index,name in enumerate(CASES):
            clock.check();gate_r,gate_w=pipe();fds.extend((gate_r,gate_w));os.set_blocking(gate_r,True)
            result=args.window/('case-'+str(index)+'.json');parent=s.proc(os.getpid(),clock)
            command=[sys.executable,'-I','-B',str(PACKAGE/'live_controls.py'),'--worker',name,
                '--absolute-expiry-epoch',str(args.absolute_expiry_epoch),'--case-expiry-epoch',str(args.absolute_expiry_epoch-2),
                '--binding-sha256',args.binding_sha256,'--explicit-grant',GRANT,'--launch-gate-fd',str(gate_r),
                '--nonce','v12helper'+str(index)+'0'*20,'--parent-pid',str(os.getpid()),'--parent-start',parent['start'],
                '--window',str(args.window),'--result',str(result)]
            child,key=spawn(owner,s,command,(gate_r,),{'PATH':'/usr/bin:/bin','LANG':'C.UTF-8','LC_ALL':'C.UTF-8','PYTHONDONTWRITEBYTECODE':'1'}, {})
            os.close(gate_r);fds.remove(gate_r);pending.append((name,child,gate_w,result))
        os.setpriority(os.PRIO_PROCESS,0,19)
        for name,child,gate,result in pending:
            clock.check();write_byte(gate,b'W')
            until(clock,lambda:(owner.discover(),owner.reap()),lambda:child.returncode is not None,seconds=4)
            value=s.committed_json(result,clock,maximum=131072)
            s.require(child.returncode==0 and value['case']==name and value['status']=='passed' and value['cleanup']['cleanup_complete'] is True,'case failure or cleanup incomplete')
            value['actual_tracer_worker_exit_code']=child.returncode;outcomes.append(value)
        summary.update(status='passed',control_names=list(CASES),control_count=len(CASES),cases=outcomes,source_binding_sha256=args.binding_sha256,
            scope='Exact V13 observer/apply_at_exec/observe_tasks; interpreter ELF and actual fixture argv only',full_production_argv_callback_executed=False,model_loaded=False,
            positive_cpu124_qualification=True,phase_sha256=BINDING['files']['phase.py'],observer_sha256=BINDING['files']['exec_observer.py'])
    except BaseException as error:summary.update(status='failed',error=type(error).__name__+': '+str(error),cases=outcomes)
    finally:
        summary['cleanup']=cleanup(owner,s,clock)
        if not summary['cleanup']['cleanup_complete']:summary['status']='failed'
        for fd in fds:
            try:os.close(fd)
            except OSError:pass
        if time.monotonic()<HARD:s.immutable_json(args.result,summary,clock)
        owner.close()
    return 0 if summary['status']=='passed' else 1


def cli():
    parser=argparse.ArgumentParser(description=__doc__)
    for name in ('explicit-grant','binding-sha256','parent-start'):parser.add_argument('--'+name,required=True)
    for name in ('absolute-expiry-epoch','case-expiry-epoch'):parser.add_argument('--'+name,type=float,required=name=='absolute-expiry-epoch')
    for name in ('parent-pid','launch-gate-fd'):parser.add_argument('--'+name,type=int,required=True)
    for name in ('window','result'):parser.add_argument('--'+name,type=Path,required=True)
    parser.add_argument('--worker',choices=CASES);parser.add_argument('--nonce');args=parser.parse_args()
    if args.explicit_grant!=GRANT:raise SystemExit('separate Root tiny grant required')
    try:
        arm(args,worker=bool(args.worker));s,module=load_bound(args)
        return worker(args,s,module) if args.worker else controller(args,s)
    except BaseException:
        kill_bound();return 124
    finally:signal.setitimer(signal.ITIMER_REAL,0)

if __name__=='__main__':raise SystemExit(cli())
