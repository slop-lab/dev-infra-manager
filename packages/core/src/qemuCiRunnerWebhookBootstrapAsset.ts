export const QEMU_CI_WEBHOOK_BOOTSTRAP = `def request_shutdown(_signal_number, _frame):
    shutdown.set()

signal.signal(signal.SIGTERM, request_shutdown)
signal.signal(signal.SIGINT, request_shutdown)
sweep_run_residue()
server = ThreadingHTTPServer(("0.0.0.0", 8080), Handler)
worker_thread = threading.Thread(target=worker)
if scheduler_endpoint:
    worker_thread = threading.Thread(target=shared_worker)
server_thread = threading.Thread(target=server.serve_forever)
worker_thread.start()
server_thread.start()
shutdown.wait()
server.shutdown()
server.server_close()
server_thread.join(timeout=5)
if server_thread.is_alive():
    raise TimeoutError("timed out stopping QEMU webhook server")
worker_thread.join(timeout=20)
if worker_thread.is_alive():
    raise TimeoutError("timed out stopping QEMU scheduler worker")
`;
