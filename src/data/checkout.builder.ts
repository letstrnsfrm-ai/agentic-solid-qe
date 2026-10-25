export interface CustomerCheckoutInfo {
  readonly firstName: string;
  readonly lastName: string;
  readonly postalCode: string;
}

export interface OrderSummaryExpectation {
  readonly subtotalText: string;
  readonly taxText: string;
  readonly totalText: string;
}

/**
 * Typed Data Builder (DIP) for customer checkout inputs and expected order summary values.
 */
export class CheckoutBuilder {
  static defaultCustomer(): CustomerCheckoutInfo {
    return {
      firstName: 'Ada',
      lastName: 'Lovelace',
      postalCode: '94107',
    };
  }

  static backpackOrderSummary(): OrderSummaryExpectation {
    return {
      subtotalText: 'Item total: $29.99',
      taxText: 'Tax: $2.40',
      totalText: 'Total: $32.39',
    };
  }

  static confirmationHeading(): string {
    return 'Thank you for your order!';
  }
}
