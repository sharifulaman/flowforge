import { Injectable, type OnModuleInit } from '@nestjs/common';
import * as argon2 from 'argon2';

/** OWASP-recommended argon2id parameters (19 MiB, t=2, p=1). */
const ARGON_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

@Injectable()
export class PasswordService implements OnModuleInit {
  /** Hash verified against when the user doesn't exist, so login timing doesn't reveal accounts. */
  private dummyHash = '';

  async onModuleInit(): Promise<void> {
    this.dummyHash = await argon2.hash('flowforge-timing-equalizer', ARGON_OPTIONS);
  }

  hash(password: string): Promise<string> {
    return argon2.hash(password, ARGON_OPTIONS);
  }

  async verify(hash: string | null | undefined, password: string): Promise<boolean> {
    try {
      if (!hash) {
        await argon2.verify(this.dummyHash, password);
        return false;
      }
      return await argon2.verify(hash, password);
    } catch {
      return false;
    }
  }

  needsRehash(hash: string): boolean {
    return argon2.needsRehash(hash, ARGON_OPTIONS);
  }
}
