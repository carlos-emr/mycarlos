#!/usr/bin/env python3
"""No-subprocess synthetic controls only; separately reviewed outer grant required."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import signal
import tempfile
import time
import unittest
from unittest.mock import patch

PACKAGE = Path(__file__).resolve().parent
CONTROL_NAMES = ('test_absolute_expiry_wins', 'test_artifact_binding_negative_controls', 'test_bind_refreshes_real_parent_exit_snapshot', 'test_bind_zombie_parent_requires_exact_birth', 'test_committed_receipt_positive_and_partial_sibling_refusal', 'test_copy_elf_linked_source_produces_independent_destination', 'test_copy_growth_and_cancellation', 'test_destination_never_overwritten', 'test_discovery_defers_only_vanished_owned_parent', 'test_duplicate_json_refused', 'test_empty_registration_without_echild_is_not_cleanup', 'test_foreign_parent_and_child_reuse_stay_strict', 'test_generic_reap_preserves_root_nonzero_exit', 'test_hash_mismatch_removes_only_own_new_copy', 'test_holder_start_requires_canonical_string', 'test_late_adoption_drain_and_nonquiescent_refusal', 'test_linked_readonly_receipt_with_partial_is_refused', 'test_pidfd_binding_rejects_replacement_instance', 'test_pidfd_high_number_poll_live_exit_hup', 'test_pidfd_poll_invalid_and_error_never_claim_exit', 'test_pidfd_signal_has_no_numeric_fallback', 'test_public_inventory_refuses_private_and_config_paths', 'test_readonly_failed_receipt_cannot_override_prior_exit', 'test_receipt_publication_faults_leave_no_accepted_success', 'test_sighup_routes_to_cancellation_and_final_phase', 'test_source_substitution_before_open', 'test_sparse_checksum_conflict', 'test_zero_length_and_dangling_destination')


def load(name):
    spec = importlib.util.spec_from_file_location(name, PACKAGE / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def suite(s, guard, expiry):
    class Controls(unittest.TestCase):
        def budget(self):
            return s.Budget(20, expiry, 3)

        def test_absolute_expiry_wins(self):
            b = s.Budget(600, 110, 3, monotonic=lambda: 50, wall=lambda: 100)
            self.assertEqual(b.hard_end, 60)
            self.assertEqual(b.work_end, 57)
            with self.assertRaises(s.Refusal):
                s.Budget(600, 101, 3, monotonic=lambda: 50, wall=lambda: 100)

        def test_duplicate_json_refused(self):
            with self.assertRaises(s.Refusal):
                json.loads('{"same":1,"same":2}', object_pairs_hook=s.unique_object)

        def test_source_substitution_before_open(self):
            # Replace after lstat, exactly at source-open boundary. No substituted byte may be read.
            for kind in ('symlink', 'fifo', 'regular'):
                with self.subTest(kind=kind), tempfile.TemporaryDirectory(prefix='guard-control-', dir='/workspace') as td:
                    root = Path(td); source = root / 'input'; source.write_bytes(b'approved')
                    (root / 'sentinel').write_bytes(b'FOREIGN-SENTINEL-NEVER-COPY')
                    (root / 'out').mkdir(mode=0o700)
                    original_open = os.open; original_read=os.read; swapped = False
                    forbidden={ (root/'sentinel').stat().st_ino }
                    def boundary(path, flags, *args, **kwargs):
                        nonlocal swapped
                        if path == 'input' and not swapped and not flags & os.O_CREAT:
                            swapped = True
                            source.unlink()
                            if kind == 'symlink': source.symlink_to(root / 'sentinel')
                            elif kind == 'fifo': os.mkfifo(source)
                            else: source.write_bytes(b'FOREIGN-SENTINEL-NEVER-COPY')
                            forbidden.add(source.lstat().st_ino)
                        return original_open(path, flags, *args, **kwargs)
                    def read(fd,size):
                        self.assertNotIn(os.fstat(fd).st_ino,forbidden,'substituted/sentinel descriptor bytes must never be read')
                        return original_read(fd,size)
                    with patch.object(s.os, 'open', side_effect=boundary),patch.object(s.os,'read',side_effect=read):
                        with self.assertRaises((s.Refusal, OSError)):
                            s.stable_copy(root, 'input', root / 'out', 'copy', self.budget(), 100)
                    self.assertFalse((root / 'out/copy').exists())
                    self.assertEqual((root / 'sentinel').read_bytes(), b'FOREIGN-SENTINEL-NEVER-COPY')

        def test_destination_never_overwritten(self):
            with tempfile.TemporaryDirectory(prefix='guard-control-', dir='/workspace') as td:
                root = Path(td);(root/'input').write_bytes(b'input');(root/'out').mkdir()
                (root/'out/existing').write_bytes(b'keep')
                with self.assertRaises(FileExistsError):
                    s.stable_copy(root,'input',root/'out','existing',self.budget(),100)
                self.assertEqual((root/'out/existing').read_bytes(), b'keep')

        def test_hash_mismatch_removes_only_own_new_copy(self):
            with tempfile.TemporaryDirectory(prefix='guard-control-', dir='/workspace') as td:
                root=Path(td);(root/'input').write_bytes(b'input');(root/'out').mkdir()
                with self.assertRaises(s.Refusal):
                    s.stable_copy(root,'input',root/'out','new',self.budget(),100,expected_sha='0'*64)
                self.assertFalse((root/'out/new').exists())

        def test_copy_growth_and_cancellation(self):
            for mode in ('growth','cancellation'):
                with self.subTest(mode=mode),tempfile.TemporaryDirectory(prefix='guard-control-',dir='/workspace') as td:
                    root=Path(td);source=root/'input';source.write_bytes(b'a'*70000);(root/'out').mkdir()
                    b=self.budget();read=os.read;triggered=False
                    def boundary(fd,size):
                        nonlocal triggered
                        result=read(fd,size)
                        if result and not triggered and os.fstat(fd).st_ino==source.stat().st_ino:
                            triggered=True
                            if mode=='growth':
                                with source.open('ab') as writer:writer.write(b'FAKE-SENTINEL')
                            else:b.cancelled='synthetic cancellation'
                        return result
                    with patch.object(s.os,'read',side_effect=boundary):
                        with self.assertRaises(s.Refusal):s.stable_copy(root,'input',root/'out','new',b,70000)
                    self.assertFalse((root/'out/new').exists())

        def test_public_inventory_refuses_private_and_config_paths(self):
            import copy
            source='registry+https://github.com/rust-lang/crates.io-index'
            lock=('[['+'package]]\nname="fake"\nversion="1.0.0"\nsource="'+source+'"\nchecksum="'+'a'*64+'"\n').encode()
            sha=hashlib.sha256(lock).hexdigest()
            pins={'head':'1'*40,'source_root':'/workspace/FAKE-source','source_sha256':{'src-tauri/Cargo.lock':sha}}
            candidate={'registry_instance':'index.crates.io-1949cf8c6b5b557f','state':'regular_file',
                       'relative_path':'fake-1.0.0.crate','lstat':{'device':1,'inode':2,'size_bytes':10,'mtime_ns':3}}
            index=copy.deepcopy(candidate);index['relative_path']='.cache/fa/ke/fake'
            item={'name':'fake','version':'1.0.0','source':source,'lock_expected_archive_sha256':'a'*64,
                  'archive_candidate':candidate,'index_candidate':index}
            value={'schema':'carlos.mycarlos.public-cargo-cache-inventory.v2',
                   'scope':{'source_revision':'1'*40,'lock_path':'src-tauri/Cargo.lock','lock_sha256':sha,
                            'registry_source':source,'crates_io_package_count':1,'lock_package_count':1},
                   'measurement_policy':{k:False for k in ('archive_bytes_read','archive_sha256_measured',
                                          'credential_or_config_read','index_bytes_read','private_registry_traversal')},
                   'packages':[item]}
            with patch.object(s,'read_path',return_value=lock):
                guard.validate_inventory(value,{},s,pins,self.budget())
                for role,field,bad in [('archive_candidate','registry_instance','private-registry-0000000000000000'),
                                       ('archive_candidate','relative_path','credentials.toml'),
                                       ('index_candidate','relative_path','.git/config'),
                                       ('index_candidate','relative_path','../../credentials')]:
                    variant=copy.deepcopy(value);variant['packages'][0][role][field]=bad
                    with self.subTest(field=field,bad=bad),self.assertRaises(s.Refusal):
                        guard.validate_inventory(variant,{},s,pins,self.budget())

        def test_sparse_checksum_conflict(self):
            item={'name':'fake','version':'1.0.0','lock_expected_archive_sha256':'a'*64}
            def index(checksum):
                record=json.dumps({'name':'fake','vers':'1.0.0','cksum':checksum}).encode()
                return b'\x03\x02\x00\x00\x00etag: "fake"\x001.0.0\x00'+record+b'\x00'
            guard.verify_sparse_index(index('a'*64),[item],s,self.budget())
            with self.assertRaises(s.Refusal):
                guard.verify_sparse_index(index('b'*64),[item],s,self.budget())

        def test_copy_elf_linked_source_produces_independent_destination(self):
            import stat
            with tempfile.TemporaryDirectory(prefix='guard-control-elf-links-', dir='/workspace') as td:
                root = Path(td)
                target = root / 'target' / 'debug'
                (target / 'deps').mkdir(parents=True, mode=0o700)
                bundle = root / 'bundle'
                bundle.mkdir(mode=0o700)
                source = target / 'mycarlos-tauri-poc'
                alias = target / 'deps' / 'mycarlos_tauri_poc-FAKE'
                payload = b'\x7fELF' + b'FAKE-SYNTHETIC-FIXTURE-NOT-A-PROGRAM'
                source.write_bytes(payload)
                source.chmod(0o700)
                os.link(source, alias)
                fields = ('st_dev', 'st_ino', 'st_mode', 'st_nlink', 'st_size', 'st_mtime_ns', 'st_ctime_ns')
                snapshot = lambda path: tuple(getattr(path.stat(), key) for key in fields)
                before_source, before_alias = snapshot(source), snapshot(alias)
                self.assertEqual(source.stat().st_nlink, 2)
                self.assertEqual((source.stat().st_dev, source.stat().st_ino),
                                 (alias.stat().st_dev, alias.stat().st_ino))
                destination = bundle / 'helper'
                with patch.object(s.os, 'link', side_effect=AssertionError('artifact copy must not create hardlinks')):
                    result = guard.copy_elf(source, destination, s, self.budget())
                self.assertEqual(result, {'path': str(destination), 'bytes': len(payload),
                                          'sha256': hashlib.sha256(payload).hexdigest()})
                self.assertEqual(destination.read_bytes(), payload)
                self.assertEqual(stat.S_IMODE(destination.stat().st_mode), 0o500)
                self.assertEqual(destination.stat().st_nlink, 1)
                self.assertNotEqual((destination.stat().st_dev, destination.stat().st_ino),
                                    (source.stat().st_dev, source.stat().st_ino))
                self.assertEqual(snapshot(source), before_source)
                self.assertEqual(snapshot(alias), before_alias)
                self.assertEqual(source.read_bytes(), payload)
                self.assertEqual(alias.read_bytes(), payload)

        def test_artifact_binding_negative_controls(self):
            import copy
            self.assertEqual(guard.LIMITS, {"cache": 600, "build": 5400, "runtime": 180})
            self.assertEqual(len(guard.CONTRACT_TESTS), 22)
            self.assertEqual(len(set(guard.CONTRACT_TESTS)), 22)
            guard.exact_test_pass("test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 7 filtered out; finished in 0.01s", s)
            for text in ("test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 7 filtered out; finished in 0.01s",
                         "test result: ok. 0 passed; 0 failed; 1 ignored; 0 measured; 7 filtered out; finished in 0.01s",
                         "test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 7 filtered out; finished in 0.01s"):
                with self.subTest(summary=text), self.assertRaises(s.Refusal):
                    guard.exact_test_pass(text, s)
            pins={'source_root':'/workspace/FAKE-source'}
            own={'id':'path+file:///workspace/FAKE-source/src-tauri#mycarlos-tauri-poc@0.1.0',
                 'targets':[{'name':'mycarlos-tauri-poc','kind':['bin'],'crate_types':['bin'],
                             'src_path':'/workspace/FAKE-source/src-tauri/src/main.rs'}]}
            artifact={'reason':'compiler-artifact','package_id':own['id'],'target':own['targets'][0],
                      'profile':{'opt_level':'1','debug_assertions':True,'overflow_checks':True,'test':False},
                      'features':['ai-helper-stub','default'],'fresh':False,
                      'executable':'/workspace/FAKE-window/target/debug/mycarlos-tauri-poc',
                      'filenames':['/workspace/FAKE-window/target/debug/mycarlos-tauri-poc']}
            prefix=['/usr/bin/taskset','-c','0','/usr/bin/nice','-n','19']
            command=prefix+['/FAKE-toolchain/cargo','build','--offline','--locked','--jobs','1',
                            '--features','ai-helper-stub','--bin','mycarlos-tauri-poc','--message-format=json']
            def select(messages, override=None):
                data=b'\n'.join(json.dumps(m).encode() for m in messages)+b'\n'
                record={'command':command,'exit':0,'root_reaped':True,
                        'cwd':'/workspace/FAKE-source/src-tauri','stdout_sha256':hashlib.sha256(data).hexdigest()}
                record.update(override or {})
                return guard.select_artifact(data,own,'helper',record,'/workspace/FAKE-window',pins,s,self.budget())
            finish={'reason':'build-finished','success':True}
            self.assertEqual(select([artifact,finish]).name,'mycarlos-tauri-poc')
            variants=[]
            for field,value in [('package_id','registry+https://FAKE-private#mycarlos-tauri-poc@0.1.0'),
                                ('features',[]),('fresh',True)]:
                bad=copy.deepcopy(artifact);bad[field]=value;variants.append([bad,finish])
            for field,value in [('kind',['lib']),('crate_types',['rlib']),('src_path','/FAKE-other/main.rs')]:
                bad=copy.deepcopy(artifact);bad['target'][field]=value;variants.append([bad,finish])
            for field,value in [('opt_level','0'),('test',True),('overflow_checks',False)]:
                bad=copy.deepcopy(artifact);bad['profile'][field]=value;variants.append([bad,finish])
            variants.extend([[artifact],[artifact,finish,finish],[artifact,artifact,finish],
                             [artifact,{'reason':'build-finished','success':False}]])
            for messages in variants:
                with self.subTest(messages=messages),self.assertRaises(s.Refusal):select(messages)
            with self.assertRaises(s.Refusal):select([artifact,finish],{'exit':1})

        def test_bind_refreshes_real_parent_exit_snapshot(self):
            owned=s.Owned(self.budget());owned.entries[(70001,'parent')]={'fd':88,'identity':{},'reaped':False}
            def sample(pid,budget=None):
                if pid==70001:return None
                return next(states)
            states=iter([{'start':'child','ppid':70001,'state':'S'},
                         {'start':'child','ppid':os.getpid(),'state':'S'},
                         {'start':'child','ppid':os.getpid(),'state':'S'}])
            with patch.object(s.os,'pidfd_open',return_value=99),patch.object(s.os,'close') as close, \
                 patch.object(s,'proc',side_effect=sample),patch.object(owned,'exited',side_effect=lambda fd:fd==88):
                self.assertEqual(owned.bind(70002,{'start':'child','ppid':70001}),(70002,'child'))
                close.assert_not_called()
            owned.entries.clear()

        def test_bind_zombie_parent_requires_exact_birth(self):
            for parent_start in ('parent','replacement'):
                owned=s.Owned(self.budget());owned.entries[(70001,'parent')]={'fd':88,'identity':{},'reaped':False}
                def sample(pid,budget=None):
                    return {'start':parent_start,'ppid':os.getpid(),'state':'Z'} if pid==70001 else {'start':'child','ppid':70001,'state':'S'}
                with patch.object(s.os,'pidfd_open',return_value=99),patch.object(s.os,'close') as close, \
                     patch.object(s,'proc',side_effect=sample),patch.object(owned,'exited',side_effect=lambda fd:fd==88):
                    if parent_start=='parent':
                        self.assertEqual(owned.bind(70002,{'start':'child'}),(70002,'child'));close.assert_not_called()
                    else:
                        with self.assertRaises(s.Refusal):owned.bind(70002,{'start':'child'},discovery_defer=True)
                        close.assert_called_once_with(99);self.assertNotIn((70002,'child'),owned.entries)
                owned.entries.clear()

        def test_discovery_defers_only_vanished_owned_parent(self):
            for defer in (False,True):
                owned=s.Owned(self.budget());owned.entries[(70001,'parent')]={'fd':88,'identity':{},'reaped':False}
                def sample(pid,budget=None):return None if pid==70001 else {'start':'child','ppid':70001,'state':'S'}
                with patch.object(s.os,'pidfd_open',return_value=99),patch.object(s.os,'close') as close, \
                     patch.object(s,'proc',side_effect=sample),patch.object(owned,'exited',side_effect=lambda fd:fd==88):
                    if defer:self.assertIsNone(owned.bind(70002,{'start':'child'},discovery_defer=True))
                    else:
                        with self.assertRaises(s.Refusal):owned.bind(70002,{'start':'child'})
                    close.assert_called_once_with(99);self.assertNotIn((70002,'child'),owned.entries)
                    self.assertEqual(owned.binding_event_count,1)
                owned.entries.clear()

        def test_foreign_parent_and_child_reuse_stay_strict(self):
            for changed in (False,True):
                owned=s.Owned(self.budget())
                def sample(pid,budget=None):return {'start':'foreign' if pid==70001 else 'replacement' if changed else 'child','ppid':70001,'state':'S'}
                with patch.object(s.os,'pidfd_open',return_value=99),patch.object(s.os,'close') as close, \
                     patch.object(s,'proc',side_effect=sample),patch.object(owned,'exited',return_value=False):
                    with self.assertRaises(s.Refusal):owned.bind(70002,{'start':'child'},discovery_defer=True)
                    close.assert_called_once_with(99);self.assertEqual(owned.entries,{})

        def test_pidfd_high_number_poll_live_exit_hup(self):
            class FakePoll:
                def __init__(self, events):self.events=events;self.registered=[]
                def register(self,fd,mask):self.registered.append((fd,mask))
                def poll(self,timeout):
                    assert timeout==0
                    return self.events
            for events,expected in (([],False),([(4096,s.select.POLLIN)],True),([(4096,s.select.POLLHUP)],True)):
                watcher=FakePoll(events)
                with patch.object(s.select,'poll',return_value=watcher), \
                     patch.object(s.select,'select',side_effect=AssertionError('FD_SETSIZE fallback forbidden')):
                    self.assertEqual(s.Owned.exited(4096),expected)
                    self.assertEqual(watcher.registered,[(4096,s.select.POLLIN)])

        def test_pidfd_poll_invalid_and_error_never_claim_exit(self):
            class FakePoll:
                def __init__(self,events):self.events=events
                def register(self,fd,mask):pass
                def poll(self,timeout):return self.events
            for events in ([(4096,s.select.POLLNVAL)],[(4096,s.select.POLLERR)],[(4097,s.select.POLLIN)]):
                with patch.object(s.select,'poll',return_value=FakePoll(events)):
                    with self.assertRaises(s.Refusal):s.Owned.exited(4096)

        def test_pidfd_binding_rejects_replacement_instance(self):
            owned=s.Owned(self.budget())
            with patch.object(s.os,'pidfd_open',return_value=99), patch.object(s.os,'close') as close, \
                 patch.object(s,'proc',return_value={'start':'new','ppid':os.getpid()}):
                with self.assertRaises(s.Refusal):owned.bind(12345,{'start':'old'})
            close.assert_called_once_with(99)
            self.assertEqual(owned.entries,{})

        def test_holder_start_requires_canonical_string(self):
            self.assertEqual(s.canonical_start('12345'),'12345')
            for value in (12345,'0012345','0','-1','1.0','',None,True):
                with self.subTest(value=value),self.assertRaises(s.Refusal):s.canonical_start(value)

        def test_sighup_routes_to_cancellation_and_final_phase(self):
            handlers={};b=self.budget()
            with patch.object(guard.signal,'signal',side_effect=lambda number,fn:handlers.__setitem__(number,fn)):
                guard.install_interruption_handlers(b,s)
            self.assertEqual(set(handlers),{signal.SIGINT,signal.SIGTERM,signal.SIGHUP})
            with self.assertRaises(s.Refusal):handlers[signal.SIGHUP](signal.SIGHUP,None)
            self.assertIn(str(signal.SIGHUP),b.cancelled)
            b.enter_final();self.assertIsNone(b.cancelled);b.check(final=True)

        def test_empty_registration_without_echild_is_not_cleanup(self):
            owned=s.Owned(self.budget())
            with patch.object(s.os,'waitpid',return_value=(0,0)):
                snapshot=owned.snapshot()
            self.assertFalse(snapshot['kernel_no_children'])
            self.assertFalse(snapshot['cleanup_complete'])

        def test_generic_reap_preserves_root_nonzero_exit(self):
            from types import SimpleNamespace
            owned=s.Owned(self.budget());child=SimpleNamespace(pid=12345,returncode=None,poll=lambda:None)
            owned.entries[(12345,'old')]={'fd':99,'identity':{'start':'old'},'reaped':False}
            owned.roots=[(child,(12345,'old'))]
            with patch.object(s.os,'waitpid',side_effect=[(12345,7<<8),ChildProcessError()]), \
                 patch.object(owned,'exited',return_value=True):
                owned.reap()
            self.assertEqual(child.returncode,7);self.assertTrue(owned.no_children)
            self.assertTrue(owned.entries[(12345,'old')]['reaped']);owned.entries.clear()

        def test_readonly_failed_receipt_cannot_override_prior_exit(self):
            from types import SimpleNamespace
            with tempfile.TemporaryDirectory(prefix='guard-control-',dir='/workspace') as td:
                root=Path(td);directory=root/'stages/cache';directory.mkdir(parents=True)
                path=directory/'result.json'
                s.immutable_json(path,{'schema':3,'publication':'exclusive-link-unlink-v1','status':'passed'},self.budget())
                stage=SimpleNamespace(window=root,s=s,budget=self.budget(),proof={'previous_stage':{
                    'stage':'cache','actual_exit_code':1,'result_sha256':hashlib.sha256(path.read_bytes()).hexdigest()}})
                with self.assertRaises(s.Refusal):guard.Stage.previous(stage,'cache')

        def test_receipt_publication_faults_leave_no_accepted_success(self):
            for phase in ('file-sync','post-chmod-sync','pre-link-dir-sync','post-link-dir-sync','chmod','alarm-after-bytes'):
                with self.subTest(phase=phase),tempfile.TemporaryDirectory(prefix='guard-control-',dir='/workspace') as td:
                    path=Path(td)/'result.json';count=0;real_sync=os.fsync;real_chmod=os.fchmod;real_write=os.write
                    fail_at={'file-sync':1,'post-chmod-sync':2,'pre-link-dir-sync':3,'post-link-dir-sync':4}.get(phase)
                    def sync(fd):
                        nonlocal count
                        count+=1
                        if count==fail_at:raise OSError('injected sync failure')
                        return real_sync(fd)
                    def chmod(fd,mode):
                        real_chmod(fd,mode)
                        if phase=='chmod':raise OSError('injected after readonly chmod')
                    def write(fd,data):
                        count=real_write(fd,data)
                        if phase=='alarm-after-bytes':raise s.Refusal('injected deadline after complete bytes')
                        return count
                    with patch.object(s.os,'fsync',side_effect=sync),patch.object(s.os,'fchmod',side_effect=chmod),patch.object(s.os,'write',side_effect=write):
                        with self.assertRaises((OSError,s.Refusal)):
                            s.immutable_json(path,{'schema':3,'status':'passed'},self.budget())
                    self.assertFalse(path.exists())
                    partials=list(path.parent.glob('.result.json.partial.*'))
                    self.assertEqual(len(partials),1)
                    self.assertEqual(json.loads(partials[0].read_text())['status'],'passed')
                    with self.assertRaises((FileNotFoundError,s.Refusal)):s.committed_json(path,self.budget())

        def test_linked_readonly_receipt_with_partial_is_refused(self):
            with tempfile.TemporaryDirectory(prefix='guard-control-',dir='/workspace') as td:
                root=Path(td);partial=root/'.result.json.partial.FAKE';partial.write_text('{"status":"passed"}')
                partial.chmod(0o400);os.link(partial,root/'result.json')
                with self.assertRaises(s.Refusal):s.committed_json(root/'result.json',self.budget())

        def test_committed_receipt_positive_and_partial_sibling_refusal(self):
            with tempfile.TemporaryDirectory(prefix='guard-control-',dir='/workspace') as td:
                path=Path(td)/'result.json'
                s.immutable_json(path,{'schema':3,'status':'passed'},self.budget())
                self.assertEqual(path.stat().st_nlink,1)
                self.assertEqual(s.committed_json(path,self.budget())['status'],'passed')
                (path.parent/'.result.json.partial.FAKE').write_text('failed previous publication')
                with self.assertRaises(s.Refusal):s.committed_json(path,self.budget())

        def test_late_adoption_drain_and_nonquiescent_refusal(self):
            from types import SimpleNamespace
            for remains in (False,True):
                with self.subTest(remains=remains),tempfile.TemporaryDirectory(prefix='guard-control-',dir='/workspace') as td:
                    clock=[0.0]
                    b=s.Budget(20,expiry,10,monotonic=lambda:clock[0])
                    late={'visible':False,'killed':False};signals=[]
                    class FakeOwner:
                        no_children=False
                        entries={}
                        def discover(self):
                            if signal.SIGKILL in signals:late['visible']=True
                        def signal_all(self,number):
                            signals.append(number)
                            if number==signal.SIGKILL and late['visible']:late['killed']=True
                        def reap(self):self.no_children=late['killed'] and not remains
                        def snapshot(self):
                            self.reap()
                            return {'cleanup_complete':self.no_children,'kernel_no_children':self.no_children,
                                    'remaining_live_owned':[] if self.no_children else [{'pid':'FAKE-late'}],
                                    'unreaped_owned':[],'root_children':[]}
                        def close(self):pass
                    args=SimpleNamespace(cleanup_margin_seconds=10,stage='cache',package_sha256='p',
                                         source_pins_sha256='s',cache_inventory_sha256='i')
                    with patch.object(guard,'available',return_value=9*s.GIB):
                        stage=guard.Stage(args,s,b,{}, {'head':'FAKE'}, {}, {})
                    stage.directory=Path(td);stage.owner=FakeOwner()
                    with patch.object(guard.time,'monotonic',side_effect=lambda:clock[0]), \
                         patch.object(guard.time,'sleep',side_effect=lambda value:clock.__setitem__(0,clock[0]+0.5)), \
                         patch.object(b,'arm'),patch.object(b,'disarm'):
                        result=stage.finish('passed',None,{})
                    receipt=json.loads((Path(td)/'result.json').read_text())
                    self.assertTrue(late['visible']);self.assertTrue(late['killed'])
                    self.assertEqual(result,1 if remains else 0)
                    self.assertEqual(receipt['status'],'failed' if remains else 'passed')
                    self.assertEqual(receipt['cleanup']['kernel_no_children'],not remains)

        def test_zero_length_and_dangling_destination(self):
            with tempfile.TemporaryDirectory(prefix='guard-control-',dir='/workspace') as td:
                root=Path(td);(root/'empty').write_bytes(b'');(root/'out').mkdir()
                result=s.stable_copy(root,'empty',root/'out','copy',self.budget(),0)
                self.assertEqual(result['sha256'],hashlib.sha256(b'').hexdigest())
                (root/'out/dangling').symlink_to(root/'missing')
                with self.assertRaises(FileExistsError):s.stable_copy(root,'empty',root/'out','dangling',self.budget(),0)
                self.assertTrue((root/'out/dangling').is_symlink())

        def test_pidfd_signal_has_no_numeric_fallback(self):
            owned=s.Owned(self.budget())
            # Closed fake pidfd represents original exited instance; numeric PID is irrelevant.
            owned.entries[(12345,'old')]={'fd':99,'pid':12345,'start':'old'}
            calls=[]
            with patch.object(owned,'exited',return_value=False), patch.object(s.signal,'pidfd_send_signal',side_effect=lambda fd,sig,*a: calls.append((fd,sig))), \
                 patch.object(s.os,'kill',side_effect=AssertionError('numeric signaling forbidden')):
                owned.signal_all(signal.SIGTERM)
            self.assertEqual(calls,[(99,signal.SIGTERM)])
            owned.entries.clear()

    discovered = unittest.defaultTestLoader.getTestCaseNames(Controls)
    if discovered != list(CONTROL_NAMES):
        raise RuntimeError("unexpected control inventory")
    return unittest.TestSuite(Controls(name) for name in CONTROL_NAMES)


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--explicit-scratch-control-grant',required=True)
    parser.add_argument('--absolute-expiry-epoch',required=True,type=float)
    parser.add_argument('--package-sha256',required=True)
    args=parser.parse_args()
    if args.explicit_scratch_control_grant != 'root-reviewed-synthetic-controls-only':
        raise SystemExit('explicit reviewed scratch grant required')
    remaining=args.absolute_expiry_epoch-time.time()
    if not 5 <= remaining <= 30:
        raise SystemExit('finite <=30 second scratch window required')
    os.sched_setaffinity(0,{0});os.setpriority(os.PRIO_PROCESS,0,19)
    def deadline(number,frame):
        raise TimeoutError('scratch control absolute expiry')
    signal.signal(signal.SIGALRM,deadline);signal.setitimer(signal.ITIMER_REAL,remaining)
    def bounded(path,maximum):
        import stat
        info=path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_size>maximum:raise SystemExit('scratch package file type/size')
        fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC)
        try:
            opened=os.fstat(fd)
            identity=lambda v:(v.st_dev,v.st_ino,v.st_size,v.st_mtime_ns)
            if identity(opened)!=identity(info):raise SystemExit('scratch package instance changed')
            data=bytearray()
            while len(data)<info.st_size:
                if time.time()>=args.absolute_expiry_epoch:raise TimeoutError('scratch bootstrap expiry')
                chunk=os.read(fd,min(65536,info.st_size-len(data)))
                if not chunk:raise SystemExit('scratch package short read')
                data.extend(chunk)
            if identity(os.fstat(fd))!=identity(info):raise SystemExit('scratch package changed')
            return bytes(data)
        finally:os.close(fd)
    manifest=bounded(PACKAGE/'package-manifest.json',65536)
    if hashlib.sha256(manifest).hexdigest()!=args.package_sha256:
        raise SystemExit('package manifest differs')
    values=json.loads(manifest)
    expected={'native_guard.py','guard_support.py','scratch_driver.py','policy.json','README.md','CONTROL-TEST-PLAN.md'}
    if values.get('schema')!=3 or set(values.get('files',{}))!=expected:raise SystemExit('scratch package inventory differs')
    for name,sha in values['files'].items():
        if hashlib.sha256(bounded(PACKAGE/name,2*1024*1024)).hexdigest()!=sha:
            raise SystemExit('package source differs')
    try:
        s=load('guard_support');guard=load('native_guard')
        if guard.available()<8*s.GIB:raise SystemExit('scratch admission below8GiB')
        result=unittest.TextTestRunner(verbosity=2).run(suite(s,guard,args.absolute_expiry_epoch))
        return 0 if result.wasSuccessful() else 1
    finally:
        signal.setitimer(signal.ITIMER_REAL,0)


if __name__=='__main__':
    raise SystemExit(main())
