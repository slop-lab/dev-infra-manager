#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <sys/wait.h>
#include <unistd.h>

int main(void) {
  pid_t children[256];
  size_t count = 0;
  while (count < 256) {
    pid_t child = fork();
    if (child == 0) {
      pause();
      _exit(0);
    }
    if (child < 0) {
      int failure = errno;
      for (size_t index = 0; index < count; index++) kill(children[index], SIGKILL);
      for (size_t index = 0; index < count; index++) waitpid(children[index], NULL, 0);
      if (failure != EAGAIN) return 71;
      printf("forked=%zu rejection=EAGAIN\n", count);
      return 0;
    }
    children[count++] = child;
  }
  for (size_t index = 0; index < count; index++) kill(children[index], SIGKILL);
  for (size_t index = 0; index < count; index++) waitpid(children[index], NULL, 0);
  return 72;
}
