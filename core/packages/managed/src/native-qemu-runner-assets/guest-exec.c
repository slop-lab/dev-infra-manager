#include <errno.h>
#include <grp.h>
#include <limits.h>
#include <stdlib.h>
#include <sys/prctl.h>
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
  if (chroot(argv[1]) != 0 || chdir(argv[2]) != 0) return 70;
  if (setgroups(0, NULL) != 0 || setgid(gid) != 0 || setuid(uid) != 0) return 70;
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) return 70;
  execv(argv[5], &argv[5]);
  return 70;
}
