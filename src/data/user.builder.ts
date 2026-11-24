export interface UserPersona {
  readonly role: 'standard' | 'locked_out' | 'problem' | 'performance_glitch' | 'unauthenticated';
  readonly username: string;
  readonly password: string;
  readonly expectedErrorBanner?: string;
}

const SAUCEDEMO_DEMO_SECRET = process.env.SAUCEDEMO_PASSWORD ?? 'secret_sauce';
const DEFAULT_SECRET = process.env.TEST_PASSWORD || SAUCEDEMO_DEMO_SECRET;

/**
 * Typed Data Builder (DIP) centralizing persona credentials and expected validation messages.
 * Specs must reference UserBuilder methods rather than hardcoding magic strings.
 */
export class UserBuilder {
  static standardUser(): UserPersona {
    return {
      role: 'standard',
      username: process.env.TEST_USERNAME || 'standard_user',
      password: DEFAULT_SECRET,
    };
  }

  static lockedOutUser(): UserPersona {
    return {
      role: 'locked_out',
      username: 'locked_out_user',
      password: DEFAULT_SECRET,
      expectedErrorBanner: 'Epic sadface: Sorry, this user has been locked out.',
    };
  }

  static problemUser(): UserPersona {
    return {
      role: 'problem',
      username: 'problem_user',
      password: DEFAULT_SECRET,
    };
  }

  static performanceGlitchUser(): UserPersona {
    return {
      role: 'performance_glitch',
      username: 'performance_glitch_user',
      password: DEFAULT_SECRET,
    };
  }

  static unauthenticatedRouteError(): string {
    return "Epic sadface: You can only access '/inventory.html' when you are logged in.";
  }
}
