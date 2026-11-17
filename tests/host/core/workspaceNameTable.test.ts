import { expect, it } from "vitest";
import { flattenNameTable, parseNameTable, reconcileNameTable, type WorkspaceNameTable } from "@slop-lab/dim-host-core/workspace";

const mirrors = { name: "npm.cache.dim.internal", upstream: "http://127.0.0.1:4873/" };
const other = { name: "other.dim.internal", upstream: "http://127.0.0.1:9999/" };

it("namespaces registrations by owner and replaces a caller's complete set each call", () => {
  let table: WorkspaceNameTable = {};
  table = reconcileNameTable(table, "host-mirrors", [mirrors]);
  expect(table).toEqual({ "host-mirrors": [mirrors] });
  table = reconcileNameTable(table, "host-llm-router", [other]);
  expect(table).toEqual({ "host-mirrors": [mirrors], "host-llm-router": [other] });
  // Replacing one owner's set is idempotent and leaves the other owner untouched.
  const next = reconcileNameTable(table, "host-mirrors", [mirrors]);
  expect(next).toEqual(table);
});

it("removes an owner's entry entirely when it reconciles an empty set", () => {
  let table: WorkspaceNameTable = reconcileNameTable({}, "host-mirrors", [mirrors]);
  table = reconcileNameTable(table, "host-mirrors", []);
  expect(table).toEqual({});
});

it("rejects a second plugin clobbering a name already owned by another", () => {
  const table = reconcileNameTable({}, "host-mirrors", [mirrors]);
  expect(() => reconcileNameTable(table, "host-llm-router", [mirrors])).toThrow(/already registered/);
});

it("rejects duplicate names within the same owner's own set and invalid owners", () => {
  expect(() => reconcileNameTable({}, "host-mirrors", [mirrors, mirrors])).toThrow(/duplicate/);
  expect(() => reconcileNameTable({}, "Host-Mirrors", [mirrors])).toThrow(/invalid workspace name owner/);
});

it("flattens the full table to a single name -> upstream map", () => {
  const table = reconcileNameTable(reconcileNameTable({}, "host-mirrors", [mirrors]), "host-llm-router", [other]);
  expect(flattenNameTable(table)).toEqual(new Map([[mirrors.name, mirrors.upstream], [other.name, other.upstream]]));
});

it("parses a persisted table and rejects malformed shapes", () => {
  const table = reconcileNameTable({}, "host-mirrors", [mirrors]);
  expect(parseNameTable(JSON.parse(JSON.stringify(table)))).toEqual(table);
  expect(parseNameTable(undefined)).toEqual({});
  for (const bad of [null, [], { "host-mirrors": "not-an-array" }, { "Bad Owner": [] }]) expect(() => parseNameTable(bad)).toThrow();
});
