import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import type { ReviewerWebConfig } from "./config.js";

type Account = ReviewerWebConfig["accounts"][number];
type SessionConfig = ReviewerWebConfig["session"];
type ScryptOptions = { readonly N: number; readonly r: number; readonly p: number; readonly maxmem: number };
type ScryptInput = { readonly password: string; readonly salt: Buffer; readonly length: number; readonly options: ScryptOptions };
const DUMMY_PASSWORD_HASH = "scrypt$16384$8$1$MDEyMzQ1Njc4OWFiY2RlZg==$U9Hy6q7JRrW6L5R4Sxp4Qz7LJ9hYZ6dBVNUoAX5T6eQ=";
const AUTHENTICATION_BURST = 5;
const AUTHENTICATION_REFILL_MILLISECONDS = 1_000;

export type AuthenticationResult =
  | { readonly kind: "accepted"; readonly accountId: string }
  | { readonly kind: "busy" }
  | { readonly kind: "rejected" };

export type AuthenticationState = {
  readonly derivations: number;
  readonly inFlight: number;
  readonly peakInFlight: number;
};

export type ReviewerSession = {
  readonly id: string;
  readonly accountId: string;
  readonly csrfToken: string;
  readonly createdAt: number;
  lastSeenAt: number;
};

export class SessionStore {
  readonly #sessions = new Map<string, ReviewerSession>();
  constructor(
    private readonly config: SessionConfig,
    private readonly now: () => number,
    private readonly maximumSize: number
  ) {}

  create(accountId: string): ReviewerSession | undefined {
    this.pruneExpired();
    for (const session of this.#sessions.values()) {
      if (session.accountId === accountId) this.#sessions.delete(session.id);
    }
    if (this.#sessions.size >= this.maximumSize) return undefined;
    const timestamp = this.now();
    const session = {
      id: randomBytes(32).toString("base64url"),
      accountId,
      csrfToken: randomBytes(32).toString("base64url"),
      createdAt: timestamp,
      lastSeenAt: timestamp
    };
    this.#sessions.set(session.id, session);
    return session;
  }

  get(id: string): ReviewerSession | undefined {
    const session = this.#sessions.get(id);
    if (session === undefined) return undefined;
    const timestamp = this.now();
    if (timestamp - session.lastSeenAt >= this.config.idleSeconds * 1_000
      || timestamp - session.createdAt >= this.config.absoluteSeconds * 1_000) {
      this.#sessions.delete(id);
      return undefined;
    }
    session.lastSeenAt = timestamp;
    return session;
  }

  delete(id: string): void {
    this.#sessions.delete(id);
  }

  pruneExpired(): void {
    const timestamp = this.now();
    for (const session of this.#sessions.values()) {
      if (this.expired(session, timestamp)) this.#sessions.delete(session.id);
    }
  }

  size(): number {
    return this.#sessions.size;
  }

  private expired(session: ReviewerSession, timestamp: number): boolean {
    return timestamp - session.lastSeenAt >= this.config.idleSeconds * 1_000
      || timestamp - session.createdAt >= this.config.absoluteSeconds * 1_000;
  }
}

export class AccountAuthenticator {
  #derivations = 0;
  #inFlight = 0;
  #peakInFlight = 0;
  #tokens = AUTHENTICATION_BURST;
  #lastRefillAt: number;

  constructor(
    private readonly accounts: readonly Account[],
    private readonly maximumInFlight: number,
    private readonly now: () => number
  ) {
    this.#lastRefillAt = now();
  }

  async authenticate(username: string, password: string): Promise<AuthenticationResult> {
    if (this.#inFlight >= this.maximumInFlight) return { kind: "busy" };
    this.refill();
    if (this.#tokens < 1) return { kind: "busy" };
    this.#tokens -= 1;
    this.#inFlight += 1;
    this.#derivations += 1;
    this.#peakInFlight = Math.max(this.#peakInFlight, this.#inFlight);
    try {
      const account = this.accounts.find((candidate) => candidate.username === username);
      const encoded = account?.passwordHash ?? DUMMY_PASSWORD_HASH;
      const [, cost, blockSize, parallelization, saltText, expectedText] = encoded.split("$");
      if (cost === undefined || blockSize === undefined || parallelization === undefined || saltText === undefined || expectedText === undefined) {
        return { kind: "rejected" };
      }
      const expected = Buffer.from(expectedText, "base64");
      const actual = await derive({
        password,
        salt: Buffer.from(saltText, "base64"),
        length: expected.length,
        options: { N: Number(cost), r: Number(blockSize), p: Number(parallelization), maxmem: 32 * 1024 * 1024 }
      });
      const matches = timingSafeEqual(actual, expected);
      return account !== undefined && matches
        ? { kind: "accepted", accountId: account.username }
        : { kind: "rejected" };
    } finally {
      this.#inFlight -= 1;
    }
  }

  state(): AuthenticationState {
    return { derivations: this.#derivations, inFlight: this.#inFlight, peakInFlight: this.#peakInFlight };
  }

  private refill(): void {
    const timestamp = this.now();
    const elapsed = Math.max(0, timestamp - this.#lastRefillAt);
    this.#tokens = Math.min(AUTHENTICATION_BURST, this.#tokens + elapsed / AUTHENTICATION_REFILL_MILLISECONDS);
    this.#lastRefillAt = Math.max(this.#lastRefillAt, timestamp);
  }
}

function derive(input: ScryptInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(input.password, input.salt, input.length, input.options, (error, key) => {
      if (error !== null) reject(error);
      else resolve(key);
    });
  });
}
