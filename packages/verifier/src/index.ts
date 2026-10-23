import crypto from "crypto";
import { ZodTypeAny } from "zod";

export function hashBytes(data: Uint8Array | string): Uint8Array {
  const hash = crypto.createHash("sha256");
  if (typeof data === "string") {
    hash.update(Buffer.from(data, "utf8"));
  } else {
    hash.update(Buffer.from(data));
  }
  return new Uint8Array(hash.digest());
}

export function hashBytesToHex(data: Uint8Array | string): string {
  return Buffer.from(hashBytes(data)).toString("hex");
}

export function verifyResponseHash(
  data: Uint8Array | string,
  expectedHash: Uint8Array | number[] | string
): boolean {
  const actual = hashBytes(data);
  let expected: Uint8Array;

  if (typeof expectedHash === "string") {
    expected = new Uint8Array(Buffer.from(expectedHash, "hex"));
  } else if (Array.isArray(expectedHash)) {
    expected = new Uint8Array(expectedHash);
  } else {
    expected = expectedHash;
  }

  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

export function verifyJsonSchema(
  data: unknown,
  schema: ZodTypeAny
): { valid: boolean; error?: string } {
  const result = schema.safeParse(data);
  if (result.success) {
    return { valid: true };
  } else {
    return {
      valid: false,
      error: result.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join("; "),
    };
  }
}
