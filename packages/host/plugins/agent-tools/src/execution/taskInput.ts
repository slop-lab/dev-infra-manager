export async function readTaskInput(stream: AsyncIterable<Uint8Array>, maximum = 16384): Promise<unknown> {
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of stream) {
    bytes += chunk.byteLength;
    if (bytes > maximum) throw Error("Task input limit");
    chunks.push(Buffer.from(chunk));
  }
  const source = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  const value: unknown = JSON.parse(source); return value;
}
