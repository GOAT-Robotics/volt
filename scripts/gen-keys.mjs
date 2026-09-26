#!/usr/bin/env node
// Prints fresh secrets for .env: AUTH_SECRET and an Ed25519 signing key pair (PEM, \n-escaped).
import { generateKeyPairSync, randomBytes } from "node:crypto";
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const esc = (s) => s.trim().replace(/\n/g, "\\n");
console.log(`AUTH_SECRET="${randomBytes(32).toString("base64")}"`);
console.log(`SIGNING_PRIVATE_KEY="${esc(privateKey.export({ type: "pkcs8", format: "pem" }))}"`);
console.log(`SIGNING_PUBLIC_KEY="${esc(publicKey.export({ type: "spki", format: "pem" }))}"`);
