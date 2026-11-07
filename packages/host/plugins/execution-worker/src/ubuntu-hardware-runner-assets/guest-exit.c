#include <errno.h>
#include <stdlib.h>
#include <sys/io.h>

int main(int argc, char **argv) {
  char *end = NULL;
  long status;
  if (argc != 2) return 64;
  errno = 0;
  status = strtol(argv[1], &end, 10);
  if (errno != 0 || end == argv[1] || *end != '\0' || status < 0 || status > 255) return 64;
  if (ioperm(0xf4, 4, 1) != 0) return 70;
  outl(status == 0 ? 42 : 43, 0xf4);
  return 70;
}
