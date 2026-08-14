import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem("fruit-truck.onboarding.e2e-initialized")) return;
    localStorage.removeItem("fruit-truck.dev-key");
    localStorage.removeItem("fruit-truck.onboarding.complete.v1");
    localStorage.setItem("fruit-truck.language", "en");
    sessionStorage.setItem("fruit-truck.onboarding.e2e-initialized", "true");
  });
  await page.route("https://openrouter.ai/api/v1/**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ data: [], endpoints: [] }),
    });
  });
  await page.goto("/");
});

test("first-time setup connects OpenRouter once and then opens the workspace", async ({ page }) => {
  const shell = page.locator(".app-shell");
  await expect(page.getByRole("heading", { name: "One workspace, from prompt to final frame." })).toBeVisible();
  await expect(shell).toHaveAttribute("inert", "");

  await page.getByRole("button", { name: "Set up Fruit Truck" }).click();
  await expect(page.getByRole("group", { name: "OPENROUTER CONNECTION" })).toBeVisible();
  await expect(page.getByRole("link", { name: /Create an API key on OpenRouter/ }))
    .toHaveAttribute("href", "https://openrouter.ai/settings/keys");

  await page.getByRole("textbox", { name: "API key" }).fill("sk-or-v1-onboarding-e2e-key-1234567890");
  await expect(page.getByText("Key ready to save")).toBeVisible();
  await page.getByRole("button", { name: "Save key and start" }).click();

  await expect(page.getByRole("heading", { name: "You're ready to create." })).toBeVisible();
  await expect(page.locator(".onboarding-dialog")).toHaveCount(0, { timeout: 3_000 });
  await expect(shell).not.toHaveAttribute("inert", "");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("fruit-truck.onboarding.complete.v1"))).toBe("true");

  await page.reload();
  await expect(page.locator(".onboarding-dialog")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Settings" })).toBeVisible();
});

test("first-time setup provides the same connection flow in Korean", async ({ page }) => {
  await page.evaluate(() => localStorage.setItem("fruit-truck.language", "ko"));
  await page.reload();

  await expect(page.getByRole("heading", { name: "프롬프트부터 마지막 프레임까지, 한곳에서." })).toBeVisible();
  await page.getByRole("button", { name: "Fruit Truck 설정하기" }).click();
  await expect(page.getByRole("group", { name: "OPENROUTER 연결" })).toBeVisible();
  await expect(page.getByRole("link", { name: /OpenRouter에서 API 키 만들기/ }))
    .toHaveAttribute("href", "https://openrouter.ai/settings/keys");

  await page.getByRole("textbox", { name: "API 키" }).fill("sk-or-v1-onboarding-ko-e2e-key-1234567890");
  await expect(page.getByText("키를 저장할 준비가 됐습니다")).toBeVisible();
  await page.getByRole("button", { name: "키 저장하고 시작하기" }).click();

  await expect(page.getByRole("heading", { name: "이제 만들 준비가 됐습니다." })).toBeVisible();
  await expect(page.locator(".onboarding-dialog")).toHaveCount(0, { timeout: 3_000 });
  await expect(page.getByRole("button", { name: "설정" })).toBeVisible();
});
