"""Pure metadata controls. Does not call the issuance entry or any live controller."""
import copy
import unittest
import finalize_h10 as f


class Gates(unittest.TestCase):
    def proof(self):
        return dict(status='independently_verified_pass', result_sha256='a'*64,
                    original_bash_actual_exit=0, remaining_owned=[], bash_child_count=0)

    def result(self):
        return dict(head=f.HEAD, stage='runtime', status='passed', error=None,
                    cleanup=dict(cleanup_complete=True, kernel_no_children=True,
                                 remaining_live_owned=[], unreaped_owned=[],
                                 root_children=[dict(reaped=True, exit=0)]))

    def test_actual_pass_with_reaped_root_children(self):
        f.proof_pass(self.proof(), 'a'*64)
        f.native_pass(self.result(), 'runtime')

    def test_foreign_or_negative_result_refused(self):
        for key, value in [('head','old'),('stage','build'),('status','failed'),('error','failure')]:
            x=self.result();x[key]=value
            with self.subTest(key=key), self.assertRaises(RuntimeError):f.native_pass(x,'runtime')

    def test_missing_independent_exit_or_wrong_hash_refused(self):
        for key,value in [('status','failed'),('result_sha256','b'*64),('original_bash_actual_exit',1),
                          ('original_bash_actual_exit',False),('remaining_owned',[123]),('bash_child_count',1)]:
            x=self.proof();x[key]=value
            with self.subTest(key=key,value=value),self.assertRaises(RuntimeError):f.proof_pass(x,'a'*64)

    def test_cleanup_failures_refused(self):
        for key,value in [('cleanup_complete',False),('kernel_no_children',False),
                          ('remaining_live_owned',[123]),('unreaped_owned',[123])]:
            x=self.result();x['cleanup'][key]=value
            with self.subTest(key=key),self.assertRaises(RuntimeError):f.native_pass(x,'runtime')

    def test_unreaped_or_failed_direct_child_refused(self):
        for child in [dict(reaped=False,exit=0),dict(reaped=True,exit=-9),dict(reaped=True,exit=False)]:
            x=self.result();x['cleanup']['root_children']=[child]
            with self.subTest(child=child),self.assertRaises(RuntimeError):f.native_pass(x,'runtime')


if __name__ == '__main__':
    unittest.main()
