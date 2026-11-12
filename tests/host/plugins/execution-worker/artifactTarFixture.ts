export function tarEntry(name: string, bytes: Buffer = Buffer.alloc(0), type = "0"): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write("0000600\0", 100); header.write("0000000\0", 108); header.write("0000000\0", 116);
  header.write(bytes.length.toString(8).padStart(11, "0") + "\0", 124); header.write("00000000000\0", 136);
  header.fill(32, 148, 156); header.write(type, 156); header.write("ustar\0", 257); header.write("00", 263);
  header.write(header.reduce((sum, value) => sum + value, 0).toString(8).padStart(6, "0") + "\0 ", 148);
  return Buffer.concat([header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512)]);
}
export function artifactTar(name: string, bytes: Buffer): Buffer {
  return Buffer.concat([tarEntry(".dim-ci-artifacts/", Buffer.alloc(0), "5"), tarEntry(".dim-ci-artifacts/" + name, bytes), Buffer.alloc(1024)]);
}
export function paxRecord(key: string, value: string | Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(key + "="), typeof value === "string" ? Buffer.from(value) : value, Buffer.from("\n")]);
  let length = body.length + 2;
  while (String(length).length + 1 + body.length !== length) length = String(length).length + 1 + body.length;
  return Buffer.concat([Buffer.from(String(length) + " "), body]);
}
