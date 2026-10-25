import { test, expect } from '@fixtures/app.fixture';
import { UserBuilder } from '@data/user.builder';
import { ProductBuilder } from '@data/product.builder';
import { CheckoutBuilder } from '@data/checkout.builder';

test.describe('Swag Labs End-to-End Checkout (Compiled from Session Tape: saucedemo-e2e-checkout)', () => {
  test('Standard persona completes full checkout flow with accurate tax and order confirmation', async ({
    loginPage,
    inventoryPage,
    checkoutPage,
  }) => {
    const standardUser = UserBuilder.standardUser();
    const backpack = ProductBuilder.backpack();
    const customer = CheckoutBuilder.defaultCustomer();
    const expectedSummary = CheckoutBuilder.backpackOrderSummary();

    await loginPage.open();
    await loginPage.loginAs(standardUser);

    await inventoryPage.catalog.addItemToCart(backpack.name);
    await inventoryPage.header.openCart();

    await checkoutPage.cart.proceedToCheckout();
    await checkoutPage.form.submitCustomerInfo(customer);

    await expect(checkoutPage.summary.subtotalLabel).toContainText(expectedSummary.subtotalText);
    await expect(checkoutPage.summary.taxLabel).toContainText(expectedSummary.taxText);
    await expect(checkoutPage.summary.totalLabel).toContainText(expectedSummary.totalText);

    await checkoutPage.summary.finishOrder();

    await expect(checkoutPage.summary.confirmationHeading).toHaveText(
      CheckoutBuilder.confirmationHeading()
    );
    await expect(checkoutPage.header.cartBadge).toBeHidden();
  });
});
