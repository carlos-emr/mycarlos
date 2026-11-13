"""UNRUN source-only tests. Caller supplies independently verified observer module.

No module imports target code, ctypes backend, real signals, timers or ptrace.
"""
import errno
import signal
import types
import unittest
from unittest.mock import Mock, patch


def suite(module):
    class Controls(unittest.TestCase):
        def observer(self):
            def require(value, message):
                if not value:
                    raise RuntimeError(message)
            owner = types.SimpleNamespace(entries={(10, '100'): {'fd': 70}},
                roots=[], unbound_root_children=[], invalid_observations=[], no_children=False,
                exited=lambda fd: False, reap=Mock(), bind=Mock())
            clock = types.SimpleNamespace(check=Mock(), clock=lambda:100.0)
            base = types.SimpleNamespace(require=require, proc=Mock(return_value={
                'pid':10,'start':'100','ppid':module.os.getpid(),'state':'t'}))
            kernel = types.SimpleNamespace(call=Mock(), message=Mock(return_value=20), peek=Mock(), consume=Mock())
            result = module.ExecObserver(owner,clock,base,{},(10,'100'),Mock(),on_exec=Mock(),kernel=kernel)
            result.tracees[10]={'start':'100','tgid':10,'key':(10,'100'),
                                'thread_fd':None,'initial_stop':False}
            return result,kernel,owner

        def status(self,event,number=signal.SIGTRAP):
            return (event << 16) | (number << 8) | 0x7f

        def test_exact_options_include_thread_fork_exec_and_exitkill_only(self):
            self.assertEqual(module.OPTIONS,2|4|8|16|0x00100000)
            self.assertFalse(module.OPTIONS & 1)  # no syscall trace option

        def test_required_callback_cannot_be_omitted_before_backend_or_seize(self):
            observer,kernel,owner=self.observer()
            with self.assertRaisesRegex(RuntimeError,'callback'):
                module.ExecObserver(owner,observer.clock,observer.base,{},(10,'100'),Mock(),kernel=kernel)
            kernel.call.assert_not_called()

        def test_unknown_consumed_exit_never_matches_historical_numeric_pid(self):
            observer,kernel,owner=self.observer()
            owner.entries[(20,'old')]={'fd':71}
            child=types.SimpleNamespace(pid=20,returncode=None)
            owner.roots=[(child,(20,'old'))]
            owner.exited=Mock(side_effect=AssertionError('historical fd must not attribute consumed wait'))
            observer.exited(20,0)
            self.assertEqual(owner.invalid_observations[0]['kind'],'unknown-kernel-wait-exit')
            self.assertIsNone(child.returncode)
            owner.exited.assert_not_called()

        def test_cleanup_exec_stop_is_held_without_capture_or_userspace_release(self):
            observer,kernel,owner=self.observer()
            observer.clock.phase='final'
            observer.stopped=lambda tid:observer.tracees[tid]
            observer.capture=Mock()
            observer.resume=Mock()
            observer.handle_stop(10,self.status(module.EXEC))
            observer.capture.assert_not_called()
            observer.resume.assert_not_called()
            kernel.call.assert_not_called()

        def test_group_stopped_state_requires_actual_stop_and_tracer_proof(self):
            observer,kernel,owner=self.observer()
            observer.base.proc.return_value={'start':'100','ppid':module.os.getpid(),'state':'T'}
            observer.fields=lambda tid:{b'Tgid':b'10',b'TracerPid':str(module.os.getpid()).encode()}
            observer.tracees[10]['stopped_status']=self.status(module.STOP,signal.SIGSTOP)
            self.assertEqual(observer.stopped(10)['tgid'],10)
            observer.tracees[10]['stopped_status']=None
            with self.assertRaises(RuntimeError):observer.stopped(10)

        def test_seize_is_gated_root_bound_before_release(self):
            observer,kernel,owner=self.observer();observer.tracees.clear()
            observer.register=Mock()
            observer.seize(types.SimpleNamespace(pid=10),(10,'100'))
            kernel.call.assert_called_once_with(module.SEIZE,10,module.OPTIONS)
            observer.register.assert_called_once_with(10)
            self.assertTrue(observer.seized)
            self.assertEqual(owner.reap,observer.drain)
            with self.assertRaises(RuntimeError):
                observer.seize(types.SimpleNamespace(pid=11),(11,'101'))

        def test_child_stop_before_fork_event_waits_for_registered_lineage(self):
            observer,kernel,owner=self.observer()
            observer.stopped=lambda tid:observer.tracees[tid]
            observer.resume=Mock()
            def register(tid,parent):
                observer.tracees[tid]={'start':'200','tgid':tid,'key':(tid,'200'),
                                      'thread_fd':None,'initial_stop':True}
            observer.register=register
            kernel.peek.side_effect=[types.SimpleNamespace(si_pid=20,si_code=module.os.CLD_TRAPPED), types.SimpleNamespace(si_pid=10,si_code=module.os.CLD_TRAPPED), None]
            kernel.consume.side_effect=[(20,self.status(module.STOP)),(10,self.status(module.FORK))]
            observer.drain()
            self.assertEqual(observer.pending,{})
            self.assertEqual(observer.resume.call_args_list,[unittest.mock.call(10),unittest.mock.call(20)])
            self.assertFalse(owner.no_children)

        def test_group_stop_listens_ordinary_sigtrap_is_preserved(self):
            observer,kernel,owner=self.observer();observer.stopped=lambda tid:observer.tracees[tid]
            observer.resume=Mock()
            observer.handle_stop(10,self.status(module.STOP,signal.SIGSTOP))
            observer.resume.assert_called_once_with(10,listen=True)
            observer.resume.reset_mock()
            observer.handle_stop(10,self.status(0,signal.SIGTRAP))
            observer.resume.assert_called_once_with(10,signal.SIGTRAP)

        def test_listen_wakeup_is_resumed_only_after_recorded_group_stop(self):
            observer,kernel,owner=self.observer();observer.stopped=lambda tid:observer.tracees[tid]
            observer.handle_stop(10,self.status(module.STOP,signal.SIGSTOP))
            self.assertTrue(observer.tracees[10]['listening'])
            observer.handle_stop(10,self.status(module.STOP,signal.SIGTRAP))
            self.assertEqual(kernel.call.call_args_list,
                [unittest.mock.call(module.LISTEN,10,0),unittest.mock.call(module.CONT,10,0)])
            self.assertFalse(observer.tracees[10]['listening'])

        def test_helper_detaches_at_exec_harness_threads_remain_traced(self):
            observer,kernel,owner=self.observer()
            observer.tracees[20]={'start':'200','tgid':20,'key':(20,'200'),
                                  'thread_fd':None,'initial_stop':False}
            observer.stopped=lambda tid:observer.tracees[tid]
            observer.capture=Mock(return_value={'start':'200'})
            observer.resume=Mock()
            observer.handle_stop(20,self.status(module.EXEC))
            kernel.call.assert_called_once_with(module.DETACH,20,0)
            self.assertNotIn(20,observer.tracees);self.assertIn(10,observer.tracees)
            observer.resume.assert_not_called()

        def test_capture_failure_never_resumes_or_detaches(self):
            observer,kernel,owner=self.observer();observer.stopped=lambda tid:observer.tracees[tid]
            observer.capture=Mock(side_effect=RuntimeError('wrong qualified ELF'))
            observer.resume=Mock()
            with self.assertRaisesRegex(RuntimeError,'wrong qualified ELF'):
                observer.handle_stop(10,self.status(module.EXEC))
            observer.resume.assert_not_called();kernel.call.assert_not_called()

        def test_terminal_thread_wait_does_not_invent_process_or_root_exit(self):
            observer,kernel,owner=self.observer()
            observer.tracees[11]={'start':'110','tgid':10,'key':(10,'100'),
                                 'thread_fd':90,'initial_stop':False}
            with patch.object(module.os,'close') as close:
                observer.exited(11,0)
            close.assert_called_once_with(90)
            self.assertNotIn(11,observer.tracees);self.assertIn(10,observer.tracees)
            self.assertNotIn('reaped',owner.entries[(10,'100')])
            self.assertEqual(owner.invalid_observations,[])

        def test_kernel_echild_requires_empty_trace_and_pending_ledgers(self):
            observer,kernel,owner=self.observer();kernel.peek.side_effect=ChildProcessError()
            with self.assertRaisesRegex(RuntimeError,'ECHILD contradicted'):
                observer.drain()
            self.assertFalse(owner.no_children)
            observer.tracees.clear();observer.drain();self.assertTrue(owner.no_children)

        def test_missing_pidfd_thread_support_refuses_before_thread_registration(self):
            observer,kernel,owner=self.observer()
            observer.base.proc.return_value={'start':'110','ppid':10,'state':'t'}
            observer.fields=lambda tid:{b'Tgid':b'10',b'TracerPid':str(module.os.getpid()).encode()}
            parent=observer.tracees[10]
            with patch.object(module.os,'pidfd_open',side_effect=OSError(errno.EINVAL,'no thread pidfd')) as opened:
                with self.assertRaises(OSError):observer.register(11,parent)
            opened.assert_called_once_with(11,module.os.O_EXCL)
            self.assertNotIn(11,observer.tracees)

    return unittest.defaultTestLoader.loadTestsFromTestCase(Controls)
