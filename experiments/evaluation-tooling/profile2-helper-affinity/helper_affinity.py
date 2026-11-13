"""Narrow one authenticated helper while its leader remains at kernel EXEC stop."""
import os
import signal

from exec_observer import EXEC
from guard_support import require
import profile2

QUALIFICATION_SCHEMA = 'root-profile2-helper-affinity-qualification-v1'
QUALIFICATION_CHECKS = {
    'same_bound_single_leader_at_exec_stop', 'exact_executable_and_argv',
    'same_affinity_syscall_in_A_and_B', 'actual_A1234_and_B124_readbacks',
    'before_first_instruction_and_detach', 'three_worker_tasks_inherit_selected_mask',
    'harness_tasks_remain1234', 'controller_cpu0_nice19',
    'wrong_argv_image_and_second_helper_refused', 'actual_normal_exits',
    'owned_kernel_cleanup', 'no_application_model_or_privilege_changes'}


def apply_at_exec(observer, record, grant, clock):
    """Called only after exact native fd/hash/argv qualification, before DETACH.

    The sole wait consumer holds this same live tracee at EXEC throughout the
    numeric-TID affinity syscall. A pidfd alone would not justify that syscall.
    Both A and B execute exactly one setter; A deliberately sets the same mask.
    No harness thread is stopped, resumed or mutated by this function.
    """
    profile2.validate_helper_scope(grant)
    clock.check()
    pid, start = record['pid'], record['start']
    key = (pid, start)
    root_key = observer.root_key
    require(key != root_key and record['ppid'] == root_key[0]
            and record['pidfd_bound'] is True
            and record['kernel_exec_stop_before_userspace'] is True
            and record['hash_read_from_kernel_exe_fd'] is True
            and record['ptrace_event'] == EXEC, 'only a qualified direct helper EXEC may change affinity')
    argv = record['actual_argv']
    require(argv.count('--threads') == 1 and argv.index('--threads') + 1 < len(argv)
            and argv[argv.index('--threads') + 1] == '3', 'helper startup argv must contain --threads 3')
    require(root_key in observer.records and not any(k != root_key for k in observer.records)
            and 'helper_affinity_transition' not in record, 'second helper affinity transition refused')
    entry = observer.owner.entries.get(key)
    root_entry = observer.owner.entries.get(root_key)
    require(entry is not None and root_entry is not None, 'helper and harness must remain pidfd bound')
    bound_fd, root_fd = entry['fd'], root_entry['fd']
    initial = list(grant['bootstrap_harness_cpus'])
    selected = list(grant['workload_helper_cpus'])

    def check_stopped(expected_mask):
        clock.check()
        tracee = observer.stopped(pid)
        status = tracee['stopped_status']
        require(tracee['key'] == key and tracee['start'] == start and tracee['tgid'] == pid
                and tracee['thread_fd'] is None and type(status) is int
                and os.WIFSTOPPED(status) and os.WSTOPSIG(status) == signal.SIGTRAP
                and status >> 16 == EXEC, 'same single leader must remain at actual EXEC stop')
        require(observer.owner.entries.get(key) is entry and entry['fd'] == bound_fd
                and observer.owner.entries.get(root_key) is root_entry and root_entry['fd'] == root_fd
                and not observer.owner.exited(bound_fd) and not observer.owner.exited(root_fd),
                'bound helper or harness instance changed or exited')
        require(os.listdir('/proc/' + str(pid) + '/task') == [str(pid)],
                'helper EXEC affinity requires exactly one leader task')
        info = observer.base.proc(pid, clock)
        require(info is not None and info['start'] == start and info['ppid'] == root_key[0],
                'helper birth or direct harness parent changed')
        require(sorted(os.sched_getaffinity(pid)) == expected_mask
                and os.getpriority(os.PRIO_PROCESS, pid) == 10,
                'helper EXEC affinity readback or nice differs')
        return tracee

    before = check_stopped(initial)
    # No event dispatch or wait occurs between these checks and the syscall.
    os.sched_setaffinity(pid, set(selected))
    after = check_stopped(selected)
    require(after is before, 'helper tracee binding changed across affinity syscall')
    record['helper_affinity_transition'] = {
        'pid': pid, 'start': start, 'initial_cpus': initial, 'selected_cpus': selected,
        'bootstrap_harness_cpus': list(grant['bootstrap_harness_cpus']), 'nice': 10,
        'setter_calls': 1, 'same_live_pidfd_bound_exec_stop': True,
        'single_leader_before_and_after': True, 'before_first_instruction_and_detach': True,
        'harness_affinity_mutated': False, 'observed_boot': clock.clock()}
    observer.event('helper-affinity-at-exec-stop', **record['helper_affinity_transition'])
