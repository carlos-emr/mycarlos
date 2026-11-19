"""Load only exact frozen coordinator runtime modules, never test modules or entry main."""
import hashlib,json,sys,types,stat
from pathlib import Path

def load_frozen(binding):
    root=Path(binding['coordinator_directory'])
    for name,digest in binding['coordinator_files'].items():
        path=root/name
        data=path.read_bytes()
        if stat.S_IMODE(path.lstat().st_mode)!=0o400 or hashlib.sha256(data).hexdigest()!=digest:
            raise RuntimeError('frozen coordinator source changed: '+name)
    for name in ('guard_support','exec_observer','interfaces','safety','phase'):
        path=root/(name+'.py')
        module=types.ModuleType(name);module.__file__=str(path)
        sys.modules[name]=module
        data=path.read_bytes()
        if hashlib.sha256(data).hexdigest()!=binding['coordinator_files'][name+'.py']:
            raise RuntimeError('coordinator import bytes changed')
        exec(compile(data,str(path),'exec'),module.__dict__)
    return sys.modules['phase']
