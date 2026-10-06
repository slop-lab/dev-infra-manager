import assert from "node:assert/strict";

export const builtImageReadinessCases = [
  "exact-response",
  "unauthenticated",
  "wrong-token",
  "redirect",
  "malformed-json",
  "overlong-response",
  "wrong-service-json",
  "absent-server",
  "dripping-response"
];

const imageProbeSource = String.raw`
import {spawn} from "node:child_process";
import {readFile} from "node:fs/promises";
import {createServer} from "node:http";

const name=process.env.READINESS_CASE;
const expectedUid=Number(process.env.EXPECTED_UID);
if(process.getuid()!==expectedUid)throw new Error("readiness probe UID mismatch");
const token=(await readFile("/run/secrets/readiness.token","utf8")).slice(0,-1);
const sockets=new Set();
const intervals=new Set();
let server;
if(name!=="absent-server"){
  server=createServer((request,response)=>{
    if(name==="unauthenticated")return response.writeHead(401).end();
    if(name==="wrong-token"){
      const accepted=request.headers.authorization==="Bearer "+token+"-wrong";
      return response.writeHead(accepted?200:404,{"content-type":"application/json","cache-control":"no-store"}).end(accepted?'{"status":"ready","schemaVersion":1}':'');
    }
    if(name==="redirect")return response.writeHead(302,{location:"/readyz"}).end();
    if(name==="malformed-json")return response.writeHead(200,{"content-type":"application/json","cache-control":"no-store"}).end('{"status":');
    if(name==="overlong-response")return response.writeHead(200,{"content-type":"application/json","cache-control":"no-store"}).end("x".repeat(4097));
    if(name==="wrong-service-json")return response.writeHead(200,{"content-type":"application/json","cache-control":"no-store"}).end('{"status":"ready","schemaVersion":1,"service":"foreign"}');
    if(name==="dripping-response"){
      response.writeHead(200,{"content-type":"application/json","cache-control":"no-store"});
      response.write('{"status":"ready"');
      const interval=setInterval(()=>response.write(" "),100);
      intervals.add(interval);
      response.once("close",()=>{clearInterval(interval);intervals.delete(interval);});
      return;
    }
    const exact=request.method==="GET"&&request.url==="/readyz"&&request.headers.authorization==="Bearer "+token&&request.headers.accept==="application/json";
    response.writeHead(exact?200:400,{"content-type":"application/json","cache-control":"no-store"});
    response.end(exact?'{"status":"ready","schemaVersion":1}':'');
  });
  server.on("connection",(socket)=>{sockets.add(socket);socket.once("close",()=>sockets.delete(socket));});
  await new Promise((resolve,reject)=>{server.once("error",reject);server.listen(8080,"127.0.0.1",resolve);});
}
const started=performance.now();
const child=spawn("/usr/local/bin/dim-service",["ready"],{stdio:["ignore","pipe","pipe"]});
let stdout="";
let stderr="";
child.stdout.on("data",(chunk)=>{stdout+=chunk;});
child.stderr.on("data",(chunk)=>{stderr+=chunk;});
const forced=setTimeout(()=>child.kill("SIGKILL"),3500);
const exitCode=await new Promise((resolve,reject)=>{child.once("error",reject);child.once("close",(code,signal)=>resolve(signal===null?code:128));});
clearTimeout(forced);
for(const interval of intervals)clearInterval(interval);
for(const socket of sockets)socket.destroy();
if(server!==undefined)await new Promise((resolve)=>server.close(resolve));
const elapsedMilliseconds=Math.ceil(performance.now()-started);
const expectedExit=name==="exact-response"?0:1;
if(exitCode!==expectedExit||stdout!==""||elapsedMilliseconds>2500){
  process.stderr.write(JSON.stringify({case:name,exitCode,elapsedMilliseconds,stdoutBytes:stdout.length,stderrBytes:stderr.length})+"\n");
  process.exit(2);
}
process.stdout.write(JSON.stringify({exitCode,elapsedMilliseconds})+"\n");
`;

export async function runBuiltImageReadinessMatrix(input) {
  const services = [
    { name: "native-git", image: input.images.nativeGit, user: "10001:10001", uid: "10001" },
    { name: "ordinary-ci", image: input.images.ordinaryCi, user: "10002:10002", uid: "10002" }
  ];
  for (const service of services) {
    for (const testCase of builtImageReadinessCases) {
      const args = [
        "container", "run", "--rm", "--network", "none", "--user", service.user,
        "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
        "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,mode=1777",
        "--mount", `type=bind,src=${input.tokenPath},dst=/run/secrets/readiness.token,readonly`,
        "--env", `READINESS_CASE=${testCase}`, "--env", `EXPECTED_UID=${service.uid}`,
        "--entrypoint", "node", service.image, "--input-type=module", "--eval", imageProbeSource
      ];
      assertSecretsAbsent(args.join("\0"), input.forbiddenValues);
      const result = await input.runner.run({ args, timeoutMilliseconds: 6_000, maximumOutputBytes: 4 * 1024 });
      assertSecretsAbsent(result.stdout + result.stderr, input.forbiddenValues);
      assert.equal(result.exitCode, 0, `built-image readiness service=${service.name} case=${testCase}: ${result.stderr}`);
      assert.equal(result.stderr, "");
      const evidence = JSON.parse(result.stdout);
      assert.equal(evidence.exitCode, testCase === "exact-response" ? 0 : 1);
      assert.equal(Number.isInteger(evidence.elapsedMilliseconds), true);
      assert.equal(evidence.elapsedMilliseconds <= 2_500, true);
      input.writeLine(`built-image-readiness service=${service.name} case=${testCase} exit=${evidence.exitCode} elapsed-ms=${evidence.elapsedMilliseconds} deadline-ms=2500 network=none user=${service.user}`);
    }
  }
}

export async function runDependencyReadinessTransition(input) {
  const nativeId = input.runtime.nativeGit.id;
  const ordinaryId = input.runtime.ordinaryCi.id;
  let nativeStopped = false;
  let ordinaryStopped = false;
  try {
    await lifecycle(input.runner, "stop", nativeId);
    nativeStopped = true;
    const ordinaryWhileNativeStopped = await readiness(input.runner, ordinaryId, "10002:10002");
    assert.equal(ordinaryWhileNativeStopped.exitCode, 0);
    assert.equal(ordinaryWhileNativeStopped.output, "");
    input.writeLine(`dependency-readiness ordinary-with-native-stopped exit=0 elapsed-ms=${ordinaryWhileNativeStopped.elapsedMilliseconds}`);

    await lifecycle(input.runner, "start", nativeId);
    nativeStopped = false;
    await waitReady(input.runner, nativeId, "10001:10001");
    await lifecycle(input.runner, "stop", ordinaryId);
    ordinaryStopped = true;
    const nativeWhileOrdinaryStopped = await readiness(input.runner, nativeId, "10001:10001");
    assert.notEqual(nativeWhileOrdinaryStopped.exitCode, 0);
    assert.equal(nativeWhileOrdinaryStopped.elapsedMilliseconds <= 3_000, true);
    input.writeLine(`dependency-readiness native-with-ordinary-stopped exit=${nativeWhileOrdinaryStopped.exitCode} elapsed-ms=${nativeWhileOrdinaryStopped.elapsedMilliseconds}`);

    await lifecycle(input.runner, "start", ordinaryId);
    ordinaryStopped = false;
    await waitReady(input.runner, ordinaryId, "10002:10002");
    await waitReady(input.runner, nativeId, "10001:10001");
  } finally {
    if (ordinaryStopped) await lifecycle(input.runner, "start", ordinaryId);
    if (nativeStopped) await lifecycle(input.runner, "start", nativeId);
    await waitReady(input.runner, ordinaryId, "10002:10002");
    await waitReady(input.runner, nativeId, "10001:10001");
  }
  assert.deepEqual(await input.captureRuntime(), input.runtime);
  assert.deepEqual(await input.captureVolumes(), input.volumes);
  assert.deepEqual(await input.captureState(), input.state);
  input.writeLine(`dependency-readiness restored healthy=true state=unchanged volumes=unchanged native=${nativeId} ordinary=${ordinaryId}`);
}

async function lifecycle(runner, action, id) {
  const result = await runner.run({
    args: ["container", action, id], timeoutMilliseconds: 30_000, maximumOutputBytes: 4 * 1024
  });
  assert.equal(result.exitCode, 0, `docker container ${action} failed: ${result.stderr}`);
}

async function readiness(runner, id, user) {
  const started = performance.now();
  const result = await runner.run({
    args: ["container", "exec", "--user", user, id, "/usr/local/bin/dim-service", "ready"],
    timeoutMilliseconds: 3_000,
    maximumOutputBytes: 4 * 1024
  });
  return {
    exitCode: result.exitCode,
    output: result.stdout + result.stderr,
    elapsedMilliseconds: Math.ceil(performance.now() - started)
  };
}

async function waitReady(runner, id, user) {
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) {
    const result = await readiness(runner, id, user);
    if (result.exitCode === 0 && result.output === "") return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`service ${id} did not restore readiness`);
}

function assertSecretsAbsent(value, forbiddenValues) {
  for (const secret of forbiddenValues) assert.equal(value.includes(secret), false);
  assert.equal(/Bearer\s+[A-Za-z0-9_-]+/.test(value), false);
}
