"""Synthetic new-native prerequisite and exact instrumentation controls only."""
import copy
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import interfaces
import phase
import safety
import timer2
from test_timer2 import fixture, authority, ref


def ready_fixture():
    h = dict(path='/FAKE/new-timer-harness', sha256='a'*64, device=1, inode=2, bytes=3, mtime_ns=4)
    a = dict(schema='candidate12f874-runtime-approval-v1', candidate_head=interfaces.HEAD,
             candidate_tree=interfaces.TREE, native_runtime_passed=True, harness_no_run_passed=True,
             independently_root_verified=True, harness=h, exact_readiness_native_exec_actual=ref('ready-proof'))
    record = dict(actual_argv=[h['path'],'--list'], kernel_exe_sha256=h['sha256'],
                  kernel_exe_identity=[1,2,3,4], kernel_exec_stop_before_userspace=True, hash_read_from_kernel_exe_fd=True)
    proof = dict(status='independently_verified_pass', actual_bash_exit=0, all_owned_gone=True,
                 bash_child_count=0, model_or_test_executed=False, result=ref('ready-result'), strict_record=record)
    raw = dict(status='diagnostic-observed-and-owned-cleaned', error=None, model_or_test_executed=False,
               target_userspace_permitted=False, python_ready_before_seize_required=True,
               cleanup=dict(cleanup_complete=True,kernel_no_children=True,no_unbound_children=True),
               observation={'strict_record':copy.deepcopy(record)})
    return a,proof,raw


class TimerPrerequisites(unittest.TestCase):
    def invoke(self, values):
        a,p,r=values
        with patch.object(phase,'read_json_ref',side_effect=[a,p,r]):
            g,plan=fixture();phase.m8_gate(SimpleNamespace(grant=g,profile_plan=plan,clock=object()))

    def test_fresh_timer_runtime_and_exact_ready_admit_diagnostic_only(self):
        self.invoke(ready_fixture())

    def test_unqualified_or_foreign_native_runtime_refused(self):
        for key,value in [('candidate_head','old'),('candidate_tree','old'),('schema','candidate6595-runtime-approval-v1'),
                          ('native_runtime_passed',False),('harness_no_run_passed',False),('independently_root_verified',False)]:
            a,p,r=ready_fixture();a[key]=value
            with self.subTest(key=key),self.assertRaises(safety.Refusal):self.invoke((a,p,r))

    def test_missing_actual_exit_or_owned_cleanup_refused(self):
        for key,value in [('actual_bash_exit',1),('actual_bash_exit',False),('all_owned_gone',False),
                          ('bash_child_count',1),('model_or_test_executed',True)]:
            a,p,r=ready_fixture();p[key]=value
            with self.subTest(key=key),self.assertRaises(safety.Refusal):self.invoke((a,p,r))

    def test_old_ready_image_hash_instance_or_argv_refused(self):
        for key,value in [('kernel_exe_sha256','b'*64),('kernel_exe_identity',[1,99,3,4]),
                          ('actual_argv',['/FAKE/old-harness','--list'])]:
            a,p,r=ready_fixture();p['strict_record'][key]=value;r['observation']['strict_record'][key]=value
            with self.subTest(key=key),self.assertRaises(safety.Refusal):self.invoke((a,p,r))

    def test_failed_or_resumed_ready_raw_result_refused(self):
        for key,value in [('status','failed'),('error','failure'),('target_userspace_permitted',True),
                          ('python_ready_before_seize_required',False)]:
            a,p,r=ready_fixture();r[key]=value
            with self.subTest(key=key),self.assertRaises(safety.Refusal):self.invoke((a,p,r))

    def test_historical_h10_or_abba_plan_cannot_substitute(self):
        for key,value in [('h10_completion',ref('old-H10')),('h10_verification',ref('old-proof')),
                          ('sequence',[{'leg':'A1','cpus':[1,2,3,4]},{'leg':'B1','cpus':[1,2,4]}])]:
            g,p=fixture();p[key]=value
            with self.subTest(key=key),self.assertRaises(safety.Refusal):authority(g,p)


class TimerCounters(unittest.TestCase):
    def fixture(self,capped=False):
        return dict(answerMs=1,answerTokens=2,capped=capped,
                    answerTiming=dict(pickUs=100,pickCalls=2 if capped else 3,emitUs=20,decodeUs=900,decodeCalls=2))

    def test_eog_and_capped_counter_contracts(self):
        for capped in (True,False):timer2.validate_timing(self.fixture(capped))

    def test_missing_extra_boolean_or_negative_buckets_refused(self):
        for mutation in ('missing','extra','bool','negative'):
            s=self.fixture();t=s['answerTiming']
            if mutation=='missing':t.pop('decodeUs')
            elif mutation=='extra':t['unknown']=0
            elif mutation=='bool':t['pickCalls']=True
            else:t['emitUs']=-1
            with self.subTest(mutation=mutation),self.assertRaises(safety.Refusal):timer2.validate_timing(s)

    def test_counter_and_wall_bounds_refuse(self):
        for key,value in [('pickCalls',2),('decodeCalls',3),('decodeUs',2000)]:
            s=self.fixture();s['answerTiming'][key]=value
            with self.subTest(key=key),self.assertRaises(safety.Refusal):timer2.validate_timing(s)
