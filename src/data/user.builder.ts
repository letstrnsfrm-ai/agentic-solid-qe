export interface UserPersona {
  readonly role: 'standard' | 'locked_out' | 'problem' | 'performance_glitch' | 'unauthenticated';
  readonly username: string;
  readonly password?: string;
  readonly expectedErrorBanner?: string;
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

/**
 * Typed Data Builder (DIP) centralizing persona credentials and expected validation messages.
 * Specs must reference UserBuilder methods rather than hardcoding magic strings.
 * Passwords are never hardcoded here: they come from TEST_PASSWORD (see .env.example) when set,
 * or are read at runtime from the login page's visible demo credentials panel by LoginPage.
 */
export class UserBuilder {
  static standardUser(): UserPersona {
    return {
      role: 'standard',
      username: process.env.TEST_USERNAME || 'standard_user',
      password: optionalEnv('TEST_PASSWORD'),
    };
  }

  static lockedOutUser(): UserPersona {
    return {
      role: 'locked_out',
      username: 'locked_out_user',
      password: optionalEnv('TEST_PASSWORD'),
      expectedErrorBanner: 'Epic sadface: Sorry, this user has been locked out.',
    };
  }

  static problemUser(): UserPersona {
    return {
      role: 'problem',
      username: 'problem_user',
      password: optionalEnv('TEST_PASSWORD'),
    };
  }

  static performanceGlitchUser(): UserPersona {
    return {
      role: 'performance_glitch',
      username: 'performance_glitch_user',
      password: optionalEnv('TEST_PASSWORD'),
    };
  }

  static unauthenticatedRouteError(): string {
    return "Epic sadface: You can only access '/inventory.html' when you are logged in.";
  }
}
