import "server-only";
import { createHash, createPrivateKey, createPublicKey, createSign, randomUUID, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { PlannerError } from "./quest-types";

/**
 * Snowflake through its SQL REST API (POST /api/v2/statements) with key-pair JWT login.
 * No driver dependency, no connection to keep open: suits serverless functions. Only server
 * code imports this; credentials never reach the browser.
 */

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*(\.[A-Za-z_][A-Za-z0-9_$]*){0,2}$/;
const MODEL_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ACCOUNT = /^[A-Za-z0-9_.-]{1,255}$/;

interface SnowflakeConfig {
  account: string;
  user: string;
  role?: string;
  warehouse?: string;
  database?: string;
  schema?: string;
  aiModel: string;
  locationsProcedure: string;
  timeoutS: number;
  privateKey: KeyObject;
}

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function configError(message: string): PlannerError {
  return new PlannerError("CONFIGURATION_ERROR", "The quest planner isn't set up correctly.", message);
}

const BASE64 = /^[A-Za-z0-9+/]{100,}={0,2}$/;
const PEM_BLOCK = /-----BEGIN ([A-Z ]+)-----([\s\S]*?)-----END \1-----/;

/**
 * Rebuild a PEM block however a host's form mangled it: literal \n, line breaks turned into
 * spaces, surrounding quotes, Windows line endings, missing BEGIN/END lines, or the whole .p8
 * file base64-encoded onto one line. Only the framing changes; the key bytes are untouched.
 */
export function normalizePem(pem: string): string {
  const text = pem.trim().replace(/^['"]|['"]$/g, "").replaceAll("\\n", "\n");
  let label: string;
  let body: string;
  const match = PEM_BLOCK.exec(text);
  if (match) {
    label = match[1];
    body = match[2].replace(/\s+/g, "");
  } else {
    const compact = text.replace(/\s+/g, "");
    if (!BASE64.test(compact)) {
      throw new Error(
        "SNOWFLAKE_PRIVATE_KEY is not a PEM key (expected -----BEGIN ... KEY----- ... -----END ... KEY-----, " +
          "or the .p8 file as one line of base64)",
      );
    }
    const decoded = Buffer.from(compact, "base64").toString("latin1");
    if (decoded.includes("-----BEGIN")) return normalizePem(decoded); // the whole .p8 file, base64-encoded
    label = "PRIVATE KEY"; // only the key body, without the BEGIN/END lines
    body = compact;
  }
  const lines = body.match(/.{1,64}/g) ?? [];
  return [`-----BEGIN ${label}-----`, ...lines, `-----END ${label}-----`, ""].join("\n");
}

let cachedConfig: SnowflakeConfig | undefined;

function loadConfig(): SnowflakeConfig {
  if (cachedConfig) return cachedConfig;
  const account = env("SNOWFLAKE_ACCOUNT");
  const user = env("SNOWFLAKE_USER");
  if (!account || !user) throw configError("SNOWFLAKE_ACCOUNT and SNOWFLAKE_USER are required");
  if (!ACCOUNT.test(account)) throw configError("SNOWFLAKE_ACCOUNT has unexpected characters");

  const aiModel = env("SNOWFLAKE_AI_MODEL") ?? "llama3.3-70b";
  if (!MODEL_NAME.test(aiModel)) throw configError("SNOWFLAKE_AI_MODEL is not a valid model name");
  const locationsProcedure = env("SNOWFLAKE_LOCATIONS_PROCEDURE") ?? "LOCAL_QUEST.APP.FIND_QUEST_LOCATIONS";
  if (!IDENTIFIER.test(locationsProcedure)) throw configError("SNOWFLAKE_LOCATIONS_PROCEDURE must be a plain identifier");
  const timeoutS = Number(env("SNOWFLAKE_QUERY_TIMEOUT_S") ?? 40);
  if (!Number.isInteger(timeoutS) || timeoutS < 1 || timeoutS > 300) {
    throw configError("SNOWFLAKE_QUERY_TIMEOUT_S must be a whole number of seconds from 1 to 300");
  }

  // Key text (hosted) wins over a key file (local development).
  const keyText = env("SNOWFLAKE_PRIVATE_KEY");
  const keyPath = env("SNOWFLAKE_PRIVATE_KEY_PATH");
  let pem: string;
  try {
    if (keyText) pem = normalizePem(keyText);
    else if (keyPath) pem = readFileSync(keyPath, "utf8");
    else throw new Error("set SNOWFLAKE_PRIVATE_KEY (key text) or SNOWFLAKE_PRIVATE_KEY_PATH (key file)");
  } catch (error) {
    throw configError(`Snowflake private key: ${error instanceof Error ? error.message : "unreadable"}`);
  }
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey({ key: pem, format: "pem", passphrase: env("SNOWFLAKE_PRIVATE_KEY_PASSPHRASE") });
  } catch {
    // The message never contains key material.
    throw configError("Snowflake private key could not be read (wrong format or passphrase)");
  }

  cachedConfig = {
    account,
    user,
    role: env("SNOWFLAKE_ROLE"),
    warehouse: env("SNOWFLAKE_WAREHOUSE"),
    database: env("SNOWFLAKE_DATABASE"),
    schema: env("SNOWFLAKE_SCHEMA"),
    aiModel,
    locationsProcedure,
    timeoutS,
    privateKey,
  };
  return cachedConfig;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

let cachedToken: { value: string; expiresAt: number } | undefined;

/** Key-pair JWT for Snowflake's REST APIs. Valid for 59 minutes; reused for 50. */
function keyPairJwt(config: SnowflakeConfig, now = Date.now()): string {
  if (cachedToken && cachedToken.expiresAt > now) return cachedToken.value;
  const account = config.account.toUpperCase().replaceAll(".", "-");
  const user = config.user.toUpperCase();
  const publicKeyDer = createPublicKey(config.privateKey).export({ type: "spki", format: "der" });
  const fingerprint = `SHA256:${createHash("sha256").update(publicKeyDer).digest("base64")}`;
  const iat = Math.floor(now / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({ iss: `${account}.${user}.${fingerprint}`, sub: `${account}.${user}`, iat, exp: iat + 59 * 60 }),
  );
  const signature = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(config.privateKey);
  const value = `${header}.${payload}.${base64url(signature)}`;
  cachedToken = { value, expiresAt: now + 50 * 60_000 };
  return value;
}

type Bind = string | number;
export type Row = Record<string, string | null>;

interface StatementResponse {
  resultSetMetaData?: { rowType?: { name: string }[] };
  data?: (string | null)[][];
  statementStatusUrl?: string;
  message?: string;
  code?: string;
}

const POLL_INTERVAL_MS = 1000;

/** Run one statement with `?` bind parameters and return its rows keyed by column name. */
async function runStatement(statement: string, binds: Bind[], what: "snowflake" | "cortex"): Promise<Row[]> {
  const config = loadConfig();
  const host = `https://${config.account.toLowerCase()}.snowflakecomputing.com`;
  const bindings = Object.fromEntries(
    binds.map((value, i) => [
      String(i + 1),
      typeof value === "number" ? { type: "REAL", value: String(value) } : { type: "TEXT", value },
    ]),
  );
  // Client-side limit a little past Snowflake's own statement timeout, including polling.
  const deadline = AbortSignal.timeout((config.timeoutS + 10) * 1000);
  const headers = {
    authorization: `Bearer ${keyPairJwt(config)}`,
    "x-snowflake-authorization-token-type": "KEYPAIR_JWT",
    "content-type": "application/json",
    accept: "application/json",
    "user-agent": "local-quest-web/1.0",
  };

  try {
    let res = await fetch(`${host}/api/v2/statements?requestId=${randomUUID()}`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        statement,
        timeout: config.timeoutS,
        role: config.role,
        warehouse: config.warehouse,
        database: config.database,
        schema: config.schema,
        bindings,
      }),
      signal: deadline,
      cache: "no-store",
    });
    let body = (await res.json().catch(() => ({}))) as StatementResponse;
    // 202: still running. Poll the status URL until it finishes.
    while (res.status === 202 && body.statementStatusUrl) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      res = await fetch(`${host}${body.statementStatusUrl}`, { headers, signal: deadline, cache: "no-store" });
      body = (await res.json().catch(() => ({}))) as StatementResponse;
    }
    if (!res.ok) {
      console.warn(`[snowflake] ${what} statement failed: HTTP ${res.status} ${body.code ?? ""} ${(body.message ?? "").slice(0, 300)}`);
      // 000630: statement reached its timeout.
      if (res.status === 408 || body.code === "000630") {
        throw new PlannerError("UPSTREAM_TIMEOUT", "Planning took too long. Please try again.", { upstream: what });
      }
      throw new PlannerError("UPSTREAM_UNAVAILABLE", "The quest planner is unavailable right now.", { upstream: what });
    }
    const columns = body.resultSetMetaData?.rowType?.map((c) => c.name) ?? [];
    return (body.data ?? []).map((values) => Object.fromEntries(columns.map((name, i) => [name, values[i] ?? null])));
  } catch (error) {
    if (error instanceof PlannerError) throw error;
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new PlannerError("UPSTREAM_TIMEOUT", "Planning took too long. Please try again.", { upstream: what });
    }
    console.warn(`[snowflake] ${what} request failed: ${error instanceof Error ? error.message.slice(0, 300) : "unknown"}`);
    throw new PlannerError("UPSTREAM_UNAVAILABLE", "The quest planner is unavailable right now.", { upstream: what });
  }
}

function firstValue(rows: Row[]): string | null {
  const row = rows[0];
  return row ? (Object.values(row)[0] ?? null) : null;
}

/** Candidate places from LOCAL_QUEST.APP.FIND_QUEST_LOCATIONS (snowflake/README.md). Untrusted JSON. */
export async function findLocations(preferences: object, address: string): Promise<unknown> {
  const { locationsProcedure } = loadConfig();
  const rows = await runStatement(`CALL ${locationsProcedure}(PARSE_JSON(?), ?)`, [JSON.stringify(preferences), address], "snowflake");
  const value = firstValue(rows);
  if (!value) throw new PlannerError("UPSTREAM_INVALID_RESPONSE", "The place search returned nothing.", { upstream: "snowflake" });
  try {
    return JSON.parse(value);
  } catch {
    throw new PlannerError("UPSTREAM_INVALID_RESPONSE", "The place search returned unreadable data.", { upstream: "snowflake" });
  }
}

/** One Cortex AI_COMPLETE call. Returns the model's reply text. */
export async function complete(prompt: string): Promise<string> {
  const { aiModel } = loadConfig();
  const value = firstValue(await runStatement("SELECT AI_COMPLETE(?, ?) AS REPLY", [aiModel, prompt], "cortex"));
  let text = value ?? "";
  if (text.startsWith('"')) {
    try {
      text = String(JSON.parse(text)); // AI_COMPLETE's string can arrive JSON-encoded
    } catch {
      // keep as is
    }
  }
  return text;
}
