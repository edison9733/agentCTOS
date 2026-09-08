# IDL

`api/demo.ts` imports `x402_scoring.json` from this directory.

It cannot come from `target/idl/` because `target/` is gitignored, so the
build output does not exist on a Vercel deployment. Copy it here and commit it:

```bash
anchor build
npm run sync-idl
git add idl/x402_scoring.json
```

Re-run this whenever the program's interface changes — otherwise the deployed
page calls an older account shape than the chain expects.
