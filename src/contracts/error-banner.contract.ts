import type { Locator } from '@playwright/test';
import type { IdentifiableComponent } from './identifiable-component.contract';

/**
 * Liskov Substitution contract for any form or container that surfaces dismissible validation banners.
 */
export interface ErrorBannerContract extends IdentifiableComponent {
  readonly errorBanner: Locator;
  readonly dismissErrorButton: Locator;
  dismissError(): Promise<void>;
}
