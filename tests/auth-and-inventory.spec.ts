import { test, expect } from '@fixtures/app.fixture';
import { UserBuilder } from '@data/user.builder';
import { ProductBuilder } from '@data/product.builder';

test.describe('Swag Labs Authentication & Inventory (Compiled from Session Tape: saucedemo-login-inventory)', () => {
  test('Standard persona authenticates, views full catalog, and mutates cart state', async ({
    loginPage,
    inventoryPage,
  }) => {
    const standardUser = UserBuilder.standardUser();
    const backpack = ProductBuilder.backpack();

    await loginPage.open();
    await loginPage.loginAs(standardUser);

    await expect(inventoryPage.header.pageTitle).toHaveText(ProductBuilder.catalogTitle());
    await expect(inventoryPage.catalog.items).toHaveCount(ProductBuilder.expectedCatalogCount());

    await inventoryPage.catalog.addItemToCart(backpack.name);
    await expect(inventoryPage.header.cartBadge).toHaveText(ProductBuilder.singleItemBadgeCount());

    await inventoryPage.catalog.removeItemFromCart(backpack.name);
    await expect(inventoryPage.header.cartBadge).toBeHidden();
  });

  test('Locked-out persona is blocked at login with a dismissible error banner', async ({
    loginPage,
  }) => {
    const lockedUser = UserBuilder.lockedOutUser();

    await loginPage.open();
    await loginPage.loginAs(lockedUser);

    await expect(loginPage.form.errorBanner).toBeVisible();
    await expect(loginPage.form.errorBanner).toHaveText(lockedUser.expectedErrorBanner!);

    await loginPage.form.dismissError();
    await expect(loginPage.form.errorBanner).toBeHidden();
  });

  test('Unauthenticated direct navigation to inventory redirects to login error gate', async ({
    loginPage,
    inventoryPage,
  }) => {
    await inventoryPage.openDirect();

    await expect(loginPage.form.errorBanner).toBeVisible();
    await expect(loginPage.form.errorBanner).toHaveText(UserBuilder.unauthenticatedRouteError());
  });
});
