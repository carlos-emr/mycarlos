"""Synthetic file/metadata controls only; authored UNRUN. No process operations."""
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import copy
import hashlib
import json
import unittest
import native_guard as guard

class ContinuationControls(unittest.TestCase):
    def fixture(self):
        tmp=TemporaryDirectory();self.addCleanup(tmp.cleanup);w=Path(tmp.name)
        for name in ('target','cargo-home','stages','stages/build'):(w/name).mkdir(mode=0o700)
        cleanup={'cleanup_complete':True,'kernel_no_children':True,'remaining_live_owned':[],'unreaped_owned':[]}
        args=SimpleNamespace(window=str(w),package_sha256='a'*64,source_pins_sha256='b'*64,cache_inventory_sha256='c'*64,stage='build',worker=None)
        pins={'head':'0929f4ac398bfb027021379a9dff448eb2814c21'};proof={'holder_pid':2,'holder_start':'100','absolute_expiry_epoch':1234.0}
        old={'status':'failed','stage':'build','head':pins['head'],'package_sha256':guard.ORIGINAL_PACKAGE_SHA,'source_pins_sha256':args.source_pins_sha256,'cache_inventory_sha256':args.cache_inventory_sha256,'cleanup':cleanup}
        r=w/'stages/build/result.json';r.write_text(json.dumps(old));q=w/'root-cleanup.json';q.write_text('{}')
        ref=lambda p:{'path':str(p),'sha256':hashlib.sha256(p.read_bytes()).hexdigest()}
        v={'schema':'root-prompt0929-native-continuation-v1','root_accepted':True,'window':str(w),'new_package_sha256':args.package_sha256,'original_package_sha256':guard.ORIGINAL_PACKAGE_SHA,'source_pins_sha256':args.source_pins_sha256,'cache_inventory_sha256':args.cache_inventory_sha256,'cache_result_sha256':guard.ORIGINAL_CACHE_RESULT_SHA,**proof,'source_head':pins['head'],'old_build_actual_exit_code':1,'old_build_cleanup_complete':True,'old_build_kernel_no_children':True,'old_build_no_live_or_unreaped_owned':True,'original_build_paths_preserved':True,'retained_target_unqualified':True,'old_build_result':ref(r),'root_independent_cleanup':ref(q),'retained_directory_identities':{n:[(w/n).stat().st_dev,(w/n).stat().st_ino] for n in ('target','cargo-home')}}
        def require(ok,msg):
            if not ok:raise ValueError(msg)
        s=SimpleNamespace(require=require,digest=lambda p,*a:hashlib.sha256(Path(p).read_bytes()).hexdigest(),load_json=lambda p,*a:json.loads(Path(p).read_text()))
        budget=SimpleNamespace(check=lambda:None)
        return v,args,s,budget,pins,proof
    def test_exact_failed_clean_lineage_accepts(self):
        values=self.fixture();self.assertEqual(guard.validate_continuation(*values),values[0])
    def test_every_root_cleanup_boolean_is_exact_true(self):
        for key in ('root_accepted','old_build_cleanup_complete','old_build_kernel_no_children','old_build_no_live_or_unreaped_owned','original_build_paths_preserved','retained_target_unqualified'):
            for bad in (False,1,None):
                v,*rest=self.fixture();v[key]=bad
                with self.subTest(key=key,bad=bad),self.assertRaises(ValueError):guard.validate_continuation(v,*rest)
    def test_success_or_boolean_exit_never_authorizes_retry(self):
        for bad in (0,False,True,None):
            v,*rest=self.fixture();v['old_build_actual_exit_code']=bad
            with self.assertRaises(ValueError):guard.validate_continuation(v,*rest)
    def test_package_cache_source_holder_or_expiry_substitution_refused(self):
        for key in ('new_package_sha256','original_package_sha256','source_pins_sha256','cache_inventory_sha256','cache_result_sha256','holder_pid','holder_start','absolute_expiry_epoch','source_head','window'):
            v,*rest=self.fixture();v[key]='WRONG'
            with self.subTest(key=key),self.assertRaises(ValueError):guard.validate_continuation(v,*rest)
    def test_changed_actual_evidence_refused(self):
        for key in ('old_build_result','root_independent_cleanup'):
            v,*rest=self.fixture();v[key]['sha256']='0'*64
            with self.assertRaises(ValueError):guard.validate_continuation(v,*rest)
    def test_replaced_retained_directory_refused(self):
        for key in ('target','cargo-home'):
            v,*rest=self.fixture();v['retained_directory_identities'][key][1]+=1
            with self.assertRaises(ValueError):guard.validate_continuation(v,*rest)
    def test_prior_bundle_or_manifest_refused_for_new_build(self):
        for name in ('bundle','helper-manifest.json'):
            v,args,*rest=self.fixture();(Path(args.window)/name).touch()
            with self.assertRaises(ValueError):guard.validate_continuation(v,args,*rest)
    def test_attempt_directories_and_jobs_are_fixed(self):
        self.assertEqual(guard.stage_directory('cache'),'cache');self.assertEqual(guard.stage_directory('build'),'build-attempt2');self.assertEqual(guard.stage_directory('runtime'),'runtime-attempt2')
        self.assertEqual(guard.build_command('cargo')[guard.build_command('cargo').index('--jobs')+1],'2')
