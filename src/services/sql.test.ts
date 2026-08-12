import { describe, expect, it } from "vitest";
import { splitStatements } from "./sql";

describe("splitStatements", () => {
  it("splits on semicolons", () => {
    expect(splitStatements("SELECT 1; SELECT 2;")).toEqual(["SELECT 1", "SELECT 2"]);
  });

  it("drops the empty fragment after a trailing semicolon", () => {
    expect(splitStatements("SELECT 1;\n\n")).toEqual(["SELECT 1"]);
  });

  it("keeps a statement with no trailing semicolon", () => {
    expect(splitStatements("SELECT 1")).toEqual(["SELECT 1"]);
  });

  it("does not split on a semicolon inside a string", () => {
    const out = splitStatements("INSERT INTO t VALUES ('a;b'); SELECT 2;");
    expect(out).toEqual(["INSERT INTO t VALUES ('a;b')", "SELECT 2"]);
  });

  it("treats '' as an escaped quote rather than the end of a string", () => {
    const out = splitStatements("INSERT INTO t VALUES ('it''s; fine'); SELECT 2;");
    expect(out).toEqual(["INSERT INTO t VALUES ('it''s; fine')", "SELECT 2"]);
  });

  it("strips line comments, including a semicolon inside one", () => {
    const out = splitStatements("SELECT 1; -- a comment; with a semicolon\nSELECT 2;");
    expect(out).toEqual(["SELECT 1", "SELECT 2"]);
  });

  it("drops a comment-only script entirely", () => {
    expect(splitStatements("-- nothing here\n-- nor here\n")).toEqual([]);
  });

  it("keeps a hyphen that is not a comment", () => {
    expect(splitStatements("SELECT 1 - 2;")).toEqual(["SELECT 1 - 2"]);
  });

  it("does not treat -- inside a string as a comment", () => {
    const out = splitStatements("INSERT INTO t VALUES ('a -- b; c'); SELECT 2;");
    expect(out).toEqual(["INSERT INTO t VALUES ('a -- b; c')", "SELECT 2"]);
  });
});
