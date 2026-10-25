export interface ProductItemData {
  readonly name: string;
  readonly priceText: string;
}

/**
 * Typed Data Builder (DIP) for catalog items and expected UI state constants.
 */
export class ProductBuilder {
  static catalogTitle(): string {
    return 'Products';
  }

  static expectedCatalogCount(): number {
    return 6;
  }

  static singleItemBadgeCount(): string {
    return '1';
  }

  static backpack(): ProductItemData {
    return {
      name: 'Sauce Labs Backpack',
      priceText: '$29.99',
    };
  }

  static bikeLight(): ProductItemData {
    return {
      name: 'Sauce Labs Bike Light',
      priceText: '$9.99',
    };
  }
}
