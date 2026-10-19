/** Public constructor used from the operator-installed spice-html5 ES module assets. */
declare module "dim-spice" {
  export class SpiceMainConn {
    constructor(options: { uri: string; screen_id: string; message_id: string; onerror(error: Error): void });
    stop(): void;
  }
}
