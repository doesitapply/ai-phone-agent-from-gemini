console.log(
  [
    "Railway auth setup:",
    "1. Open https://railway.app/account/tokens",
    "2. Create/copy a Railway token",
    "3. Fast path: printf '%s' '<token>' | npm run -s bootstrap:railway-auth",
    "4. bootstrap:railway-auth will save the token and immediately run npm run check:ship-live",
    "5. Alternative: printf '%s' '<token>' | npm run -s save:railway-auth",
    "6. Then run: npm run -s check:ship-live",
  ].join("\n"),
);
