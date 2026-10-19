#define _GNU_SOURCE
#include <errno.h>
#include <grp.h>
#include <linux/capability.h>
#include <limits.h>
#include <sched.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/mount.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <unistd.h>

static int parse_id(const char *text, unsigned int *result) {
  char *end = NULL;
  unsigned long value;
  errno = 0;
  value = strtoul(text, &end, 10);
  if (errno != 0 || end == text || *end != '\0' || value > UINT_MAX) return -1;
  *result = (unsigned int)value;
  return 0;
}

int main(int argc, char **argv) {
  unsigned int uid;
  unsigned int gid;
  if (argc != 9 || parse_id(argv[3], &uid) != 0 || parse_id(argv[4], &gid) != 0) return 64;
  /* Root may install ordinary OS dependencies, but cannot reach the boot
     process' root or remove the inherited PID limit through its writable sysfs. */
  if (unshare(CLONE_NEWPID | CLONE_NEWNS) != 0 || mount(NULL, "/", NULL, MS_REC | MS_PRIVATE, NULL) != 0) return 70;
  pid_t child = fork();
  if (child < 0) return 70;
  if (child > 0) {
    int status;
    while (waitpid(child, &status, 0) < 0) if (errno != EINTR) return 70;
    return WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
  }
  char proc[PATH_MAX];
  if (snprintf(proc, sizeof(proc), "%s/proc", argv[1]) >= (int)sizeof(proc) ||
      mount("proc", proc, "proc", MS_RDONLY | MS_NOSUID | MS_NODEV | MS_NOEXEC, NULL) != 0) return 70;
  if (chroot(argv[1]) != 0 || chdir(argv[2]) != 0) return 70;
  const uint64_t allowed = (UINT64_C(1) << CAP_CHOWN) | (UINT64_C(1) << CAP_DAC_OVERRIDE) |
    (UINT64_C(1) << CAP_FOWNER) | (UINT64_C(1) << CAP_FSETID) | (UINT64_C(1) << CAP_KILL) |
    (UINT64_C(1) << CAP_SETGID) | (UINT64_C(1) << CAP_SETUID) | (UINT64_C(1) << CAP_SETPCAP) |
    (UINT64_C(1) << CAP_NET_BIND_SERVICE) | (UINT64_C(1) << CAP_NET_RAW) |
    (UINT64_C(1) << CAP_AUDIT_WRITE) | (UINT64_C(1) << CAP_SETFCAP);
  for (unsigned int cap = 0; cap <= CAP_LAST_CAP; cap++) {
    if ((allowed & (UINT64_C(1) << cap)) == 0 && prctl(PR_CAPBSET_DROP, cap, 0, 0, 0) != 0 && errno != EINVAL) return 70;
  }
  if (setgroups(0, NULL) != 0 || setgid(gid) != 0 || setuid(uid) != 0) return 70;
  struct __user_cap_header_struct header = { _LINUX_CAPABILITY_VERSION_3, 0 };
  struct __user_cap_data_struct caps[2] = { {0}, {0} };
  if (uid == 0) {
    caps[0].effective = caps[0].permitted = (uint32_t)allowed;
    caps[1].effective = caps[1].permitted = (uint32_t)(allowed >> 32);
  }
  if (syscall(SYS_capset, &header, caps) != 0) return 70;
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) return 70;
  execv(argv[5], &argv[5]);
  return 70;
}
