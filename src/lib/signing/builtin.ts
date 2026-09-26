import "server-only";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import path from "node:path";
import { stableStringify } from "@/core/stable-json";
import type { SignatureEvidence, SigningProvider } from "./provider";

type Keys = { priv: KeyObject; pub: KeyObject; keyId: string; pubPem: string };
let cached: Keys | null = null;

function dataDir() {
  return process.env.DATA_DIR || path.join(process.cwd(), "data");
}

const pem = (s: string) => s.replace(/\\n/g, "\n").trim();

/** Ed25519 key: env SIGNING_PRIVATE_KEY/SIGNING_PUBLIC_KEY (PEM) or generated once to ${DATA_DIR}/signing-key.pem (0600). */
export function loadKeys(): Keys {
  if (cached) return cached;
  let priv: KeyObject;
  if (process.env.SIGNING_PRIVATE_KEY) {
    priv = createPrivateKey(pem(process.env.SIGNING_PRIVATE_KEY));
  } else {
    const file = path.join(dataDir(), "signing-key.pem");
    if (existsSync(file)) {
      priv = createPrivateKey(readFileSync(file, "utf8"));
    } else {
      mkdirSync(dataDir(), { recursive: true });
      const kp = generateKeyPairSync("ed25519");
      const out = kp.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
      try {
        writeFileSync(file, out, { mode: 0o600, flag: "wx" });
        chmodSync(file, 0o600);
        priv = kp.privateKey;
      } catch (e) {
        // another process created it concurrently — use theirs
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        priv = createPrivateKey(readFileSync(file, "utf8"));
      }
    }
  }
  if (priv.asymmetricKeyType !== "ed25519") throw new Error("SIGNING_PRIVATE_KEY must be an Ed25519 key");
  const pub = process.env.SIGNING_PUBLIC_KEY ? createPublicKey(pem(process.env.SIGNING_PUBLIC_KEY)) : createPublicKey(priv);
  const der = pub.export({ format: "der", type: "spki" });
  const derived = createPublicKey(priv).export({ format: "der", type: "spki" });
  if (!Buffer.from(der).equals(Buffer.from(derived))) throw new Error("SIGNING_PUBLIC_KEY does not match SIGNING_PRIVATE_KEY");
  const keyId = "ed25519:" + createHash("sha256").update(der).digest("hex").slice(0, 32);
  cached = { priv, pub, keyId, pubPem: pub.export({ format: "pem", type: "spki" }).toString() };
  return cached;
}

export function sealEvidence(e: SignatureEvidence): string {
  const k = loadKeys();
  return sign(null, Buffer.from(stableStringify(e), "utf8"), k.priv).toString("base64");
}

export function verifySeal(e: SignatureEvidence, seal: string): { valid: boolean; detail: string; keyId: string } {
  const k = loadKeys();
  if (e.keyId && e.keyId !== k.keyId) return { valid: false, detail: `Sealed with key ${e.keyId}, current key is ${k.keyId}`, keyId: k.keyId };
  try {
    const ok = verify(null, Buffer.from(stableStringify(e), "utf8"), k.pub, Buffer.from(seal, "base64"));
    return { valid: ok, detail: ok ? `Ed25519 seal valid (${k.keyId})` : "Seal does not match the evidence", keyId: k.keyId };
  } catch (err) {
    return { valid: false, detail: `Seal could not be verified: ${(err as Error).message}`, keyId: k.keyId };
  }
}

export const builtinProvider: SigningProvider = {
  id: "builtin",
  label: "Volt built-in (Ed25519 evidence seal)",
  async request(input) {
    return { providerRef: `builtin:${input.signatureId}`, redirectUrl: input.returnUrl };
  },
  async complete({ evidence }) {
    const k = loadKeys();
    if (evidence.keyId !== k.keyId) throw new Error("Evidence keyId mismatch");
    return { seal: sealEvidence(evidence) };
  },
  async verify({ evidence, seal }) {
    return verifySeal(evidence, seal);
  },
  async publicInfo() {
    const k = loadKeys();
    return { keyId: k.keyId, algorithm: "Ed25519", publicKeyPem: k.pubPem };
  },
};
