import { test, expect } from '@fixtures/app.fixture';
import { UserBuilder } from '@data/user.builder';
import { ProductBuilder } from '@data/product.builder';

test.describe('Swag Labs Authentication & Inventory [@p0 @smoke @auth] (Compiled from Session Tape: saucedemo-login-inventory)', () => {
  test('Standard persona authenticates, views full catalog, and mutates cart state @p0 @smoke', async ({
    loginPage,
    inventoryPage,
  }) => {
    const standardUser = UserBuilder.standardUser();
    const backpack = ProductBuilder.backpack();

    await test.step('Authenticate as standard customer and view product catalog', async () => {
      await loginPage.open();
      await loginPage.loginAs(standardUser);

      await expect(inventoryPage.header.pageTitle).toHaveText(ProductBuilder.catalogTitle());
      await expect(inventoryPage.catalog.items).toHaveCount(ProductBuilder.expectedCatalogCount());
    });

    await test.step('Add product to shopping cart and verify cart badge updates', async () => {
      await inventoryPage.catalog.addItemToCart(backpack.name);
      await expect(inventoryPage.header.cartBadge).toHaveText(ProductBuilder.singleItemBadgeCount());
    });

    await test.step('Remove product from shopping cart and verify cart is empty', async () => {
      await inventoryPage.catalog.removeItemFromCart(backpack.name);
      await expect(inventoryPage.header.cartBadge).toBeHidden();
    });
  });

  test('Locked-out persona is blocked at login with a dismissible error banner @p1 @regression', async ({
    loginPage,
  }) => {
    const lockedUser = UserBuilder.lockedOutUser();

    await test.step('Attempt authentication as locked-out customer', async () => {
      await loginPage.open();
      await loginPage.loginAs(lockedUser);
    });

    await test.step('Verify locked-out account error is displayed and can be dismissed', async () => {
      await expect(loginPage.form.errorBanner).toBeVisible();
      await expect(loginPage.form.errorBanner).toHaveText(lockedUser.expectedErrorBanner!);

      await loginPage.form.dismissError();
      await expect(loginPage.form.errorBanner).toBeHidden();
    });
  });

  test('Unauthenticated direct navigation to inventory redirects to login error gate @p1 @regression', async ({
    loginPage,
    inventoryPage,
  }) => {
    await test.step('Attempt unauthenticated access to product inventory', async () => {
      await inventoryPage.openDirect();
    });

    await test.step('Verify access is gated with an authentication error', async () => {
      await expect(loginPage.form.errorBanner).toBeVisible();
      await expect(loginPage.form.errorBanner).toHaveText(UserBuilder.unauthenticatedRouteError());
    });
  });
});
