"""Model-free child: exact frozen coordinator bootstrap gate, then distinct native EXEC."""
import signal,time,sys
signal.setitimer(signal.ITIMER_REAL,24)
import os,json,hashlib,argparse
from pathlib import Path
p=argparse.ArgumentParser()
p.add_argument('--binding-sha256',required=True)
p.add_argument('--absolute-expiry-epoch',type=float,required=True)
p.add_argument('--hard-boot',type=float,required=True)
p.add_argument('--work-boot',type=float,required=True)
p.add_argument('--parent-pid',type=int,required=True)
p.add_argument('--parent-start',required=True)
p.add_argument('--start-gate-fd',type=int,required=True)
p.add_argument('--exec-ready-fd',type=int,required=True)
a=p.parse_args()
root=Path(__file__).parent
raw=(root/'BINDING.json').read_bytes()
if hashlib.sha256(raw).hexdigest()!=a.binding_sha256:raise RuntimeError('binding changed')
binding=json.loads(raw)
for name,digest in binding['files'].items():
    if hashlib.sha256((root/name).read_bytes()).hexdigest()!=digest:raise RuntimeError('probe source changed')
loader=type(sys)('_exact_v4_loader');loader.__file__=str(root/'frozen_loader.py')
exec(compile((root/'frozen_loader.py').read_bytes(),loader.__file__,'exec'),loader.__dict__)
phase=loader.load_frozen(binding)
clock=phase.base.Budget(30,a.absolute_expiry_epoch,6,monotonic=phase.boot)
clock.hard_end=min(clock.hard_end,a.hard_boot);clock.work_end=min(clock.work_end,a.work_boot)
phase.parent_death(a.parent_pid,a.parent_start)
clock.check();signal.setitimer(signal.ITIMER_REAL,max(.001,clock.work_end-phase.boot()))
phase.exec_bootstrap_gate(a,clock)
clock.check()
# No model env, documents, GGUF, selectors or native userspace allowed.
argv=binding['expected_argv']
os.execve(argv[0],argv,{'PATH':'/usr/bin:/bin','LANG':'C.UTF-8','LC_ALL':'C.UTF-8'})
