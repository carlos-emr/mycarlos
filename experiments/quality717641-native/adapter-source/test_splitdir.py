import os
"""Pure synthetic splitdir admission controls; authored UNRUN, no real processes."""
import copy,json,struct
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
import native_guard as guard

def require(ok,message):
    if not ok:raise ValueError(message)
S=SimpleNamespace(require=require,unique_object=lambda pairs:dict(pairs),GIB=1024**3,
                  read_path=lambda path,maximum,budget:Path(path).read_bytes())
B=SimpleNamespace(check=lambda:None)

class SplitDirectoryControls(unittest.TestCase):
    def fixture(self):
        tmp=TemporaryDirectory();self.addCleanup(tmp.cleanup);w=Path(tmp.name);shared=w/'shared';final=w/'new'
        (shared/'debug/deps').mkdir(parents=True);(final/'target/debug').mkdir(parents=True)
        path=shared/'debug/deps/libmycarlos_tauri_poc_lib.rlib';path.write_bytes(b'SYNTHETIC root library')
        target={'name':'mycarlos_tauri_poc_lib','src_path':'/FAKE/timer/src-tauri/src/lib.rs','kind':['staticlib','cdylib','rlib'],'crate_types':['staticlib','cdylib','rlib']}
        row={'reason':'compiler-artifact','package_id':'FAKE-timer-own','target':target,'profile':{'opt_level':'1','debuginfo':2,'debug_assertions':True,'overflow_checks':True,'test':False},'features':['ai-helper-stub','default'],'fresh':False,'executable':None,'filenames':[str(path)]}
        return w,shared,final,{'id':'FAKE-timer-own','targets':[target]},{'source_root':'/FAKE/timer'},row
    def select(self,fixture,rows=None):
        w,shared,final,own,pins,row=fixture
        raw=b''.join(json.dumps(v).encode()+b'\n' for v in (rows if rows is not None else [row,{'reason':'build-finished','success':True}]))
        return guard.select_non_test_root_library(raw,own,pins,final,shared,S,B)
    def test_exact_fresh_non_test_library_is_fourth_witness(self):
        f=self.fixture();result=self.select(f);self.assertIs(result['fresh'],False);self.assertIs(result['profile']['test'],False)
    def test_fresh_true_root_library_refused(self):
        f=self.fixture();f[-1]['fresh']=True
        with self.assertRaises(ValueError):self.select(f)
    def test_libtest_or_wrong_package_never_substitutes(self):
        for key,value in [('package_id','FOREIGN'),('executable','/FAKE/libtest')]:
            f=self.fixture();f[-1][key]=value
            with self.assertRaises(ValueError):self.select(f)
        f=self.fixture();f[-1]['profile']['test']=True
        with self.assertRaises(ValueError):self.select(f)
    def test_root_library_profile_changes_refused(self):
        for key,value in [('opt_level','3'),('debug_assertions',False),('overflow_checks',False),('debuginfo',0)]:
            f=self.fixture();f[-1]['profile'][key]=value
            with self.assertRaises(ValueError):self.select(f)
    def test_missing_or_duplicate_or_trailing_library_evidence_refused(self):
        f=self.fixture();row=f[-1];end={'reason':'build-finished','success':True}
        for rows in ([row],[row,row,end],[row,end,row],[{'reason':'build-finished','success':False}]):
            with self.assertRaises(ValueError):self.select(f,rows)
    def test_library_external_path_and_missing_file_refused(self):
        f=self.fixture();f[-1]['filenames']=['/FAKE/unapproved/lib.rlib']
        with self.assertRaises(ValueError):self.select(f)
        f=self.fixture();Path(f[-1]['filenames'][0]).unlink()
        with self.assertRaises(ValueError):self.select(f)
    def test_helper_only_new_final_and_tests_only_shared_deps(self):
        f=self.fixture();_,shared,final,*_=f
        self.assertTrue(guard.artifact_path_allowed(final/'target/debug/mycarlos-tauri-poc','helper',final,shared))
        self.assertFalse(guard.artifact_path_allowed(shared/'debug/mycarlos-tauri-poc','helper',final,shared))
        for role in ('harness','libtest'):
            self.assertTrue(guard.artifact_path_allowed(shared/'debug/deps/example',role,final,shared))
            self.assertFalse(guard.artifact_path_allowed(final/'target/debug/deps/example',role,final,shared))
    def elf(self,payload):
        data=bytearray(256+len(payload));data[:6]=b'\x7fELF\x02\x01';struct.pack_into('<Q',data,32,64);struct.pack_into('<HH',data,54,56,1);struct.pack_into('<IIQQQQQQ',data,64,1,4,256,0,0,len(payload),len(payload),1);data[256:]=payload
        tmp=TemporaryDirectory();self.addCleanup(tmp.cleanup);p=Path(tmp.name)/'harness';p.write_bytes(data);return p
    def test_loaded_new_helper_literal_passes_without_live_exec_claim(self):
        p=self.elf(b'/NEW/helper');v=guard.inspect_harness_helper_literals(p,'/NEW/helper','/OLD/helper',S,B);self.assertIs(v['live_native_helper_EXEC_qualified'],False)
    def test_missing_new_or_stale_old_helper_literal_refused(self):
        for payload in (b'no helper',b'/NEW/helper /OLD/helper'):
            with self.assertRaises(ValueError):guard.inspect_harness_helper_literals(self.elf(payload),'/NEW/helper','/OLD/helper',S,B)
    def test_nonelf_or_invalid_header_refused(self):
        p=self.elf(b'/NEW/helper');p.write_bytes(b'FAKE not ELF')
        with self.assertRaises(ValueError):guard.inspect_harness_helper_literals(p,'/NEW/helper','/OLD/helper',S,B)
    def protected(self):
        return [{'role':['compiletime_helper','harness','helper','libtest'][i],'path':'/FAKE/'+str(i),'sha256':'a'*64,'device':1,'inode':i+1,'bytes':10,'mode':0o500,'nlink':2,'known_shared_deps_aliases':['/FAKE/shared/alias'+str(i)]} for i in range(4)]
    def test_preserved315_safe_link_decrease_allowed(self):
        before=self.protected();after=copy.deepcopy(before)
        for row in after:row['nlink']=1
        guard.require_protected315_unchanged(before,after,S)
    def test_preserved315_bytes_inode_mode_or_link_growth_refused(self):
        for key,value in [('sha256','b'*64),('inode',99),('mode',0o700),('nlink',3),('path','/FOREIGN')]:
            before=self.protected();after=copy.deepcopy(before);after[0][key]=value
            with self.assertRaises(ValueError):guard.require_protected315_unchanged(before,after,S)

class SplitAuthorityControls(unittest.TestCase):
    def fixture(self):
        args=SimpleNamespace(window='/FAKE/new',package_sha256='p',source_pins_sha256='s',cache_inventory_sha256='i')
        pins={'head':'TIMER','tree':'TREE'};proof={'holder_pid':2,'holder_start':'100','absolute_expiry_epoch':1234.0}
        split={'final_window':'/FAKE/new'};policy={'split_build':split}
        value={'schema':'root-quality717641-splitdir-native-admission-v1','root_accepted':True,'window':args.window,'package_sha256':'p','source_pins_sha256':'s','cache_inventory_sha256':'i','candidate_head':'TIMER','candidate_tree':'TREE',**proof}
        for key in ('existing_ABBA_closed','no_previous_native_or_model_processes','sole_heavy_build_authorized','candidate_mtime_touch_authorized','dependency_cache_adoption_only_no_old_model_evidence'):value[key]=True
        return value,args,policy,pins,proof
    def test_missing_or_old_candidate_or_package_authority_refused(self):
        for key,bad in [('schema','OLD315'),('root_accepted',False),('candidate_head','OLD315'),('package_sha256','FOREIGN')]:
            value,*rest=self.fixture();value[key]=bad
            with self.assertRaises(ValueError):guard.validate_split_certificate(value,*rest,S,B)
    def test_every_closed315_and_sole_slot_scope_flag_is_exact_true(self):
        for key in ('existing_ABBA_closed','no_previous_native_or_model_processes','sole_heavy_build_authorized','candidate_mtime_touch_authorized','dependency_cache_adoption_only_no_old_model_evidence'):
            for bad in (False,1,None):
                value,*rest=self.fixture();value[key]=bad
                with self.assertRaisesRegex(ValueError,'explicit closedABBA/split scope'):guard.validate_split_certificate(value,*rest,S,B)
    def test_foreign_owner_or_deadline_refused_before_any_cache_access(self):
        for key,bad in [('holder_pid',99),('holder_start','OTHER'),('absolute_expiry_epoch',9999.0)]:
            value,*rest=self.fixture();value[key]=bad
            with self.assertRaisesRegex(ValueError,'owner/deadline'):guard.validate_split_certificate(value,*rest,S,B)

class ProtectedAliasControls(unittest.TestCase):
    def test_replaced_or_added_alias_refused_even_if_link_count_decreases(self):
        for aliases in (['/FAKE/shared/replacement'],['/FAKE/shared/alias0','/FAKE/shared/addition']):
            before=SplitDirectoryControls().protected();after=copy.deepcopy(before)
            after[0]['nlink']=1;after[0]['known_shared_deps_aliases']=aliases
            with self.assertRaises(ValueError):guard.require_protected315_unchanged(before,after,S)

class PrebuildIndependenceControls(unittest.TestCase):
    def rows(self):
        rows=SplitDirectoryControls().protected()
        for row in rows[1:]:row['nlink']=1;row['known_shared_deps_aliases']=[]
        return rows
    def test_old_bundle_link_alias_or_duplicate_inode_refused_before_build(self):
        guard.require_independent315_bundles(self.rows(),S)
        for index in (1,2,3):
            for key,bad in [('nlink',2),('known_shared_deps_aliases',['/FAKE/shared/alias']),('inode',1)]:
                rows=self.rows();rows[index][key]=bad
                with self.subTest(index=index,key=key),self.assertRaises(ValueError):guard.require_independent315_bundles(rows,S)
    def test_new_helper_or_test_inode_must_be_disjoint_from_all_protected315_files(self):
        tmp=TemporaryDirectory();self.addCleanup(tmp.cleanup);root=Path(tmp.name);selections={}
        for role in ('helper','harness','libtest'):
            path=root/role;path.write_bytes(b'SYNTHETIC ELF metadata only');selections[role]={'path':str(path)}
        protected=[{'device':999,'inode':100+i} for i in range(4)]
        guard.reject_protected_artifact_aliases(selections,protected,S)
        for role in selections:
            info=Path(selections[role]['path']).stat();changed=copy.deepcopy(protected);changed[0]={'device':info.st_dev,'inode':info.st_ino}
            with self.subTest(role=role),self.assertRaises(ValueError):guard.reject_protected_artifact_aliases(selections,changed,S)

class ActualPinnedCacheManifestControls(unittest.TestCase):
    def test_actual_pinned_cache_manifest_uses_deduplicated_index_paths(self):
        manifest=Path(os.environ['NATIVE_BACKUP_CACHE_MANIFEST'])
        inventory=Path(__file__).parent/'public-cache-inventory-v2.json'
        value=json.loads(manifest.read_text());source=json.loads(inventory.read_text())
        home=os.environ['NATIVE_BACKUP_CARGO_HOME']
        counts=guard.validate_unique_cache_copies(value['measured_copies'],source,home,S)
        self.assertEqual(counts,{'unique_copies':1200,'archives':642,'unique_indices':558})
        for rows in (value['measured_copies'][:-1],value['measured_copies']+[value['measured_copies'][0]]):
            with self.assertRaises(ValueError):guard.validate_unique_cache_copies(rows,source,home,S)

class DualProtectedGroupsControls(unittest.TestCase):
    def test_two_complete_groups_preserve_all_eight_and_refuse_missing_duplicate_or_overlap(self):
        rows=[]
        for g, group in enumerate(('315','mtp')):
            for i, role in enumerate(('compiletime_helper','harness','helper','libtest')):
                rows.append({'group':group,'role':role,'path':'/FAKE/'+group+'/'+role,'sha256':'a'*64,'device':1,'inode':g*4+i+1,'bytes':10,'mode':0o500,'nlink':1,'known_shared_deps_aliases':[]})
        guard.require_independent315_bundles(rows,S)
        guard.require_protected315_unchanged(rows,copy.deepcopy(rows),S)
        for bad in (rows[:-1], rows+[rows[0]]):
            with self.assertRaises(ValueError):guard.require_independent315_bundles(bad,S)
        for key, value in (('role','helper'),('group','315'),('inode',1)):
            bad=copy.deepcopy(rows);bad[-1][key]=value
            with self.assertRaises(ValueError):guard.require_independent315_bundles(bad,S)
        bad=copy.deepcopy(rows);bad[-1]['sha256']='b'*64
        with self.assertRaises(ValueError):guard.require_protected315_unchanged(rows,bad,S)
