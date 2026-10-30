import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { normalizePem } from "./snowflake";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const BODY = PEM.split("\n").filter((l) => l && !l.startsWith("-----")).join("");

describe("normalizePem", () => {
  it("keeps a well-formed key unchanged", () => {
    expect(normalizePem(PEM)).toBe(PEM);
  });

  it("repairs keys mangled by hosting dashboards", () => {
    expect(normalizePem(PEM.replaceAll("\n", "\\n"))).toBe(PEM); // literal \n
    expect(normalizePem(PEM.replaceAll("\n", " "))).toBe(PEM); // line breaks became spaces
    expect(normalizePem(`"${PEM.replaceAll("\n", "\r\n")}"`)).toBe(PEM); // quotes, Windows line endings
    expect(normalizePem(BODY)).toBe(PEM); // body only
    expect(normalizePem(Buffer.from(PEM).toString("base64"))).toBe(PEM); // whole file base64-encoded
  });

  it("rejects text that isn't a key, without echoing it", () => {
    expect(() => normalizePem("hunter2")).toThrow(/not a PEM key/);
    expect(() => normalizePem("hunter2")).not.toThrow(/hunter2/);
  });
});
