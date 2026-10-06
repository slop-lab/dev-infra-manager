import { DatabaseSync } from "node:sqlite";

const [databasePath] = process.argv.slice(2);
if (databasePath === undefined) throw new TypeError("WAL writer fixture requires a database path");

const database = new DatabaseSync(databasePath);
database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL");
const update = database.prepare(
  "UPDATE bundle_activation SET activation_token_sha256 = ? WHERE generation_id = ?"
);
const generation = "a".repeat(64);
const tokens = ["b".repeat(64), "c".repeat(64)];
let transactions = 0;
let stopping = false;

function writeBatch() {
  if (stopping) return;
  for (let index = 0; index < 10; index += 1) {
    database.exec("BEGIN IMMEDIATE");
    update.run(tokens[transactions % tokens.length], generation);
    database.exec("COMMIT");
    transactions += 1;
  }
  if (transactions === 10) process.stdout.write("ready\n");
  setImmediate(writeBatch);
}

process.once("SIGTERM", () => {
  stopping = true;
  database.close();
  process.stdout.write(`${JSON.stringify({ transactions })}\n`);
});

writeBatch();
