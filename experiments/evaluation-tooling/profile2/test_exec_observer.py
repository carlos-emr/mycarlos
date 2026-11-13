"""UNRUN source-only wrapper for independently authored FAKE kernel controls."""
import exec_observer
import fake_exec_controls


def load_tests(loader, tests, pattern):
    return fake_exec_controls.suite(exec_observer)


if __name__ == '__main__':
    raise SystemExit('No control execution without separate ROOT admission')
